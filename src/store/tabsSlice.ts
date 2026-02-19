import { createSlice, PayloadAction, createAsyncThunk } from '@reduxjs/toolkit'
import type { Tab, TerminalStatus, TabMode, ShellType, CodingCliProviderName } from './types'
import { nanoid } from 'nanoid'
import { closePane, removeLayout } from './panesSlice'
import { clearTabAttention, clearPaneAttention } from './turnCompletionSlice.js'
import type { PaneNode } from './paneTypes'
import { findTabIdForSession } from '@/lib/session-utils'
import { getProviderLabel } from '@/lib/coding-cli-utils'
import { recordClosedTabSnapshot } from './tabRegistrySlice'
import {
  buildClosedTabRegistryRecord,
  countPaneLeaves,
  shouldKeepClosedTab,
} from '@/lib/tab-registry-snapshot'
import { UNKNOWN_SERVER_INSTANCE_ID } from './tabRegistryConstants'
import type { RootState } from './store'

export interface TabsState {
  tabs: Tab[]
  activeTabId: string | null
  // Ephemeral UI signal: request TabBar to enter inline rename mode for a tab.
  // This must never be persisted.
  renameRequestTabId: string | null
}

// Load persisted tabs state directly at module initialization time
// This ensures the initial state includes persisted data BEFORE the store is created
function loadInitialTabsState(): TabsState {
  const defaultState: TabsState = {
    tabs: [],
    activeTabId: null,
    renameRequestTabId: null,
  }

  try {
    const raw = localStorage.getItem('freshell.tabs.v1')
    if (!raw) return defaultState
    const parsed = JSON.parse(raw)
    // The persisted format is { tabs: TabsState }
    const tabsState = parsed?.tabs as Partial<TabsState> | undefined
    if (!Array.isArray(tabsState?.tabs)) return defaultState

    if (import.meta.env.MODE === 'development') {
      console.log('[TabsSlice] Loaded initial state from localStorage:', tabsState.tabs.map((t) => t.id))
    }

    // Apply same transformations as hydrateTabs to ensure consistency
    const mappedTabs = tabsState.tabs.map((t: Tab) => {
      const legacyClaudeSessionId = (t as any).claudeSessionId as string | undefined
      return {
        ...t,
        codingCliSessionId: t.codingCliSessionId || legacyClaudeSessionId,
        codingCliProvider: t.codingCliProvider || (legacyClaudeSessionId ? 'claude' : undefined),
        createdAt: t.createdAt || Date.now(),
        createRequestId: (t as any).createRequestId || t.id,
        status: t.status || 'creating',
        mode: t.mode || 'shell',
        shell: t.shell || 'system',
        lastInputAt: t.lastInputAt,
      }
    })
    const desired = tabsState.activeTabId
    const has = desired && mappedTabs.some((t) => t.id === desired)

    return {
      tabs: mappedTabs,
      activeTabId: has ? desired! : (mappedTabs[0]?.id ?? null),
      renameRequestTabId: null,
    }
  } catch (err) {
    if (import.meta.env.MODE === 'development') {
      console.error('[TabsSlice] Failed to load from localStorage:', err)
    }
    return defaultState
  }
}

const initialState: TabsState = loadInitialTabsState()

type AddTabPayload = {
  id?: string
  title?: string
  description?: string
  terminalId?: string
  codingCliSessionId?: string
  codingCliProvider?: CodingCliProviderName
  claudeSessionId?: string
  status?: TerminalStatus
  mode?: TabMode
  shell?: ShellType
  initialCwd?: string
  resumeSessionId?: string
  forceNew?: boolean
  createRequestId?: string
}

export const tabsSlice = createSlice({
  name: 'tabs',
  initialState,
  reducers: {
    addTab: (state, action: PayloadAction<AddTabPayload | undefined>) => {
      // Dedupe by session is handled in openSessionTab using pane state.
      const payload = action.payload || {}

      const id = payload.id || nanoid()
      const legacyClaudeSessionId = payload.claudeSessionId
      const codingCliSessionId = payload.codingCliSessionId || legacyClaudeSessionId
      const codingCliProvider =
        payload.codingCliProvider || (legacyClaudeSessionId ? 'claude' : undefined)
      const tab: Tab = {
        id,
        createRequestId: payload.createRequestId || id,
        title: payload.title || `Tab ${state.tabs.length + 1}`,
        description: payload.description,
        terminalId: payload.terminalId,
        codingCliSessionId,
        codingCliProvider,
        claudeSessionId: payload.claudeSessionId,
        status: payload.status || 'creating',
        mode: payload.mode || 'shell',
        shell: payload.shell || 'system',
        initialCwd: payload.initialCwd,
        resumeSessionId: payload.resumeSessionId,
        createdAt: Date.now(),
        lastInputAt: undefined,
      }
      state.tabs.push(tab)
      state.activeTabId = id
    },
    setActiveTab: (state, action: PayloadAction<string>) => {
      state.activeTabId = action.payload
    },
    requestTabRename: (state, action: PayloadAction<string>) => {
      state.renameRequestTabId = action.payload
    },
    clearTabRenameRequest: (state) => {
      state.renameRequestTabId = null
    },
    updateTab: (state, action: PayloadAction<{ id: string; updates: Partial<Tab> }>) => {
      const tab = state.tabs.find((t) => t.id === action.payload.id)
      if (tab) Object.assign(tab, action.payload.updates)
    },
    removeTab: (state, action: PayloadAction<string>) => {
      const removedTabId = action.payload
      const removedIndex = state.tabs.findIndex((t) => t.id === removedTabId)
      const wasActive = state.activeTabId === removedTabId

      state.tabs = state.tabs.filter((t) => t.id !== removedTabId)

      if (wasActive) {
        if (state.tabs.length === 0) {
          state.activeTabId = null
          return
        }

        const nextIndex = removedIndex > 0 ? removedIndex - 1 : 0
        state.activeTabId = state.tabs[nextIndex]?.id ?? state.tabs[0].id
      }
    },
    hydrateTabs: (state, action: PayloadAction<TabsState>) => {
      // Basic sanity: ensure dates exist, status defaults.
      state.tabs = (action.payload.tabs || []).map((t) => {
        const legacyClaudeSessionId = (t as any).claudeSessionId as string | undefined
        return {
          ...t,
          codingCliSessionId: t.codingCliSessionId || legacyClaudeSessionId,
          codingCliProvider: t.codingCliProvider || (legacyClaudeSessionId ? 'claude' : undefined),
          createdAt: t.createdAt || Date.now(),
          createRequestId: (t as any).createRequestId || t.id,
          status: t.status || 'creating',
          mode: t.mode || 'shell',
          shell: t.shell || 'system',
        }
      })
      const desired = action.payload.activeTabId
      const has = desired && state.tabs.some((t) => t.id === desired)
      state.activeTabId = has ? desired! : (state.tabs[0]?.id ?? null)
      state.renameRequestTabId = null
    },
    reorderTabs: (
      state,
      action: PayloadAction<{ fromIndex: number; toIndex: number }>
    ) => {
      const { fromIndex, toIndex } = action.payload
      if (fromIndex === toIndex) return
      const [removed] = state.tabs.splice(fromIndex, 1)
      state.tabs.splice(toIndex, 0, removed)
    },
    switchToNextTab: (state) => {
      if (state.tabs.length <= 1) return
      const currentIndex = state.tabs.findIndex((t) => t.id === state.activeTabId)
      const nextIndex = (currentIndex + 1) % state.tabs.length
      state.activeTabId = state.tabs[nextIndex].id
    },
    switchToPrevTab: (state) => {
      if (state.tabs.length <= 1) return
      const currentIndex = state.tabs.findIndex((t) => t.id === state.activeTabId)
      const prevIndex = (currentIndex - 1 + state.tabs.length) % state.tabs.length
      state.activeTabId = state.tabs[prevIndex].id
    },
  },
})

export const {
  addTab,
  setActiveTab,
  requestTabRename,
  clearTabRenameRequest,
  updateTab,
  removeTab,
  hydrateTabs,
  reorderTabs,
  switchToNextTab,
  switchToPrevTab,
} = tabsSlice.actions

function collectPaneIds(node: PaneNode | undefined): string[] {
  if (!node) return []
  if (node.type === 'leaf') return [node.id]
  return [...collectPaneIds(node.children[0]), ...collectPaneIds(node.children[1])]
}

/**
 * Close a pane and clean up its attention state.
 * If the target pane is the tab's only pane, closes the tab instead.
 * Otherwise only clears attention if closePane actually removed the pane (i.e. layout changed).
 */
export const closePaneWithCleanup = createAsyncThunk(
  'tabs/closePaneWithCleanup',
  async ({ tabId, paneId }: { tabId: string; paneId: string }, { dispatch, getState }) => {
    const before = (getState() as RootState).panes.layouts[tabId]
    if (before?.type === 'leaf' && before.id === paneId) {
      await dispatch(closeTab(tabId))
      return
    }
    dispatch(closePane({ tabId, paneId }))
    const after = (getState() as RootState).panes.layouts[tabId]
    if (before !== after) {
      dispatch(clearPaneAttention({ paneId }))
      dispatch(clearTabAttention({ tabId }))
    }
  }
)

export const closeTab = createAsyncThunk(
  'tabs/closeTab',
  async (tabId: string, { dispatch, getState }) => {
    const stateBeforeClose = getState() as RootState
    const tab = stateBeforeClose.tabs.tabs.find((item) => item.id === tabId)
    const layout = stateBeforeClose.panes.layouts[tabId]
    const tabRegistryState = (stateBeforeClose as { tabRegistry?: RootState['tabRegistry'] }).tabRegistry
    const serverInstanceId = stateBeforeClose.connection?.serverInstanceId || UNKNOWN_SERVER_INSTANCE_ID
    if (tab && layout && tabRegistryState) {
      const paneCount = countPaneLeaves(layout)
      const openDurationMs = Math.max(0, Date.now() - (tab.createdAt || Date.now()))
      const keep = shouldKeepClosedTab({
        openDurationMs,
        paneCount,
        titleSetByUser: !!tab.titleSetByUser,
      })
      if (keep) {
        dispatch(recordClosedTabSnapshot(buildClosedTabRegistryRecord({
          tab,
          layout,
          serverInstanceId,
          paneTitles: stateBeforeClose.panes.paneTitles[tabId],
          deviceId: tabRegistryState.deviceId,
          deviceLabel: tabRegistryState.deviceLabel,
          revision: 0,
          updatedAt: Date.now(),
        })))
      }
    }

    // Collect all pane IDs before removing the layout
    const currentLayout = (getState() as RootState).panes.layouts[tabId]
    const paneIds = collectPaneIds(currentLayout)

    dispatch(removeTab(tabId))
    dispatch(removeLayout({ tabId }))

    // Clean up attention for the tab and all its panes
    dispatch(clearTabAttention({ tabId }))
    for (const paneId of paneIds) {
      dispatch(clearPaneAttention({ paneId }))
    }
  }
)

export const openSessionTab = createAsyncThunk(
  'tabs/openSessionTab',
  async (
    { sessionId, title, cwd, provider, terminalId, forceNew }: { sessionId: string; title?: string; cwd?: string; provider?: CodingCliProviderName; terminalId?: string; forceNew?: boolean },
    { dispatch, getState }
  ) => {
    const resolvedProvider = provider || 'claude'
    const state = getState() as RootState

    if (terminalId) {
      if (!forceNew) {
        const existingTab = state.tabs.tabs.find((t) => t.terminalId === terminalId)
        if (existingTab) {
          dispatch(setActiveTab(existingTab.id))
          return
        }
      }
      dispatch(addTab({
        title: title || getProviderLabel(resolvedProvider),
        terminalId,
        status: 'running',
        mode: resolvedProvider,
        codingCliProvider: resolvedProvider,
        initialCwd: cwd,
        resumeSessionId: sessionId,
      }))
      return
    }

    if (!forceNew) {
      const existingTabId = findTabIdForSession(state, resolvedProvider, sessionId)
      if (existingTabId) {
        dispatch(setActiveTab(existingTabId))
        return
      }
    }
    dispatch(addTab({
      title: title || getProviderLabel(resolvedProvider),
      mode: resolvedProvider,
      codingCliProvider: resolvedProvider,
      initialCwd: cwd,
      resumeSessionId: sessionId,
    }))
  }
)

export default tabsSlice.reducer
