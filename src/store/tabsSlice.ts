import { createSlice, PayloadAction, createAsyncThunk } from '@reduxjs/toolkit'
import { getCodingCliSessionKey, makeCodingCliSessionKey } from '@/lib/coding-cli-session-key'
import type { Tab, TerminalStatus, TabMode, ShellType, CodingCliProviderName } from './types'
import { nanoid } from 'nanoid'
import { closePane, initLayout, removeLayout, updatePaneContent } from './panesSlice'
import { clearTabAttention, clearPaneAttention } from './turnCompletionSlice.js'
import type { PaneNode } from './paneTypes'
import { findTabIdForSession } from '@/lib/session-utils'
import { getProviderLabel } from '@/lib/coding-cli-utils'
import { buildResumeContent } from '@/lib/session-type-utils'
import { isAgentChatProviderName, getAgentChatProviderConfig, getAgentChatProviderLabel } from '@/lib/agent-chat-utils'
import { recordClosedTabSnapshot, pushReopenEntry, popReopenEntry, clearClosedTabSnapshot } from './tabRegistrySlice'
import { clearDraft } from '@/lib/draft-store'
import {
  buildClosedTabRegistryRecord,
  countPaneLeaves,
  shouldKeepClosedTab,
} from '@/lib/tab-registry-snapshot'
import { UNKNOWN_SERVER_INSTANCE_ID } from './tabRegistryConstants'
import type { RootState } from './store'
import { createLogger } from '@/lib/client-logger'
import { mergeSessionMetadataByKey } from '@/lib/session-metadata'
import { buildExactSessionRef } from '@/lib/exact-session-ref'
import {
  createPaneBackedTab,
  hydrateWorkspaceSnapshot,
  restorePaneBackedTab,
} from './workspaceActions'
import { loadPersistedTabs } from './workspacePersistence'


const log = createLogger('TabsSlice')

export interface TabsState {
  tabs: Tab[]
  activeTabId: string | null
  // Ephemeral UI signal: request TabBar to enter inline rename mode for a tab.
  // This must never be persisted.
  renameRequestTabId: string | null
}

function createDefaultTabsState(): TabsState {
  return {
    tabs: [],
    activeTabId: null,
    renameRequestTabId: null,
  }
}

type TabInput = AddTabPayload & Partial<Pick<Tab, 'createdAt' | 'lastInputAt'>>

function normalizeTabInput(payload: TabInput | undefined, fallbackTitle: string): Tab {
  const input = payload || {}
  const id = input.id || nanoid()
  const legacyClaudeSessionId = input.claudeSessionId
  const codingCliSessionId = input.codingCliSessionId || legacyClaudeSessionId
  const codingCliProvider =
    input.codingCliProvider || (legacyClaudeSessionId ? 'claude' : undefined)

  return {
    id,
    createRequestId: input.createRequestId || id,
    title: input.title || fallbackTitle,
    description: input.description,
    terminalId: input.terminalId,
    codingCliSessionId,
    codingCliProvider,
    claudeSessionId: input.claudeSessionId,
    status: input.status || 'creating',
    mode: input.mode || 'shell',
    shell: input.shell || 'system',
    initialCwd: input.initialCwd,
    resumeSessionId: input.resumeSessionId,
    sessionMetadataByKey: input.sessionMetadataByKey,
    createdAt: input.createdAt || Date.now(),
    titleSetByUser: input.titleSetByUser,
    lastInputAt: input.lastInputAt,
  }
}

function applyHydratedTabsState(state: TabsState, incoming: TabsState) {
  state.tabs = (incoming.tabs || []).map((tab, index) =>
    normalizeTabInput(tab, tab.title || `Tab ${index + 1}`),
  )
  const desired = incoming.activeTabId
  const has = desired && state.tabs.some((tab) => tab.id === desired)
  state.activeTabId = has ? desired! : (state.tabs[0]?.id ?? null)
  state.renameRequestTabId = null
}

function appendTab(state: TabsState, payload: TabInput | undefined) {
  const tab = normalizeTabInput(payload, payload?.title || `Tab ${state.tabs.length + 1}`)
  state.tabs.push(tab)
  state.activeTabId = tab.id
}

// Load persisted tabs state directly at module initialization time
// This ensures the initial state includes persisted data BEFORE the store is created
function loadInitialTabsState(): TabsState {
  const defaultState = createDefaultTabsState()

  try {
    const persisted = loadPersistedTabs()
    const tabsState = persisted?.tabs as Partial<TabsState> | undefined
    if (!Array.isArray(tabsState?.tabs)) return defaultState

    log.debug('Loaded initial state from localStorage:', tabsState.tabs.map((t) => t.id))
    const loadedState = createDefaultTabsState()
    applyHydratedTabsState(loadedState, {
      tabs: tabsState.tabs as Tab[],
      activeTabId: tabsState.activeTabId ?? null,
      renameRequestTabId: null,
    })
    return loadedState
  } catch (err) {
    log.error('Failed to load from localStorage:', err)
    return defaultState
  }
}

const initialState: TabsState = loadInitialTabsState()

type AddTabPayload = {
  id?: string
  title?: string
  titleSetByUser?: boolean
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
  sessionMetadataByKey?: Tab['sessionMetadataByKey']
  forceNew?: boolean
  createRequestId?: string
}

export const tabsSlice = createSlice({
  name: 'tabs',
  initialState,
  reducers: {
    addTab: (state, action: PayloadAction<AddTabPayload | undefined>) => {
      // Dedupe by session is handled in openSessionTab using pane state.
      appendTab(state, action.payload)
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
      applyHydratedTabsState(state, action.payload)
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
  extraReducers: (builder) => {
    builder
      .addCase(createPaneBackedTab, (state, action) => {
        appendTab(state, action.payload.tab)
      })
      .addCase(restorePaneBackedTab, (state, action) => {
        appendTab(state, action.payload.tab)
      })
      .addCase(hydrateWorkspaceSnapshot, (state, action) => {
        applyHydratedTabsState(state, action.payload.tabs)
      })
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
      clearDraft(paneId)
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

    // Always push to reopen stack (Alt+H should reopen any closed tab)
    if (tab && layout) {
      dispatch(pushReopenEntry({
        tab: { ...tab },
        layout: JSON.parse(JSON.stringify(layout)),
        paneTitles: { ...(stateBeforeClose.panes.paneTitles[tabId] || {}) },
        closedAt: Date.now(),
      }))
    }

    // Collect all pane IDs before removing the layout
    const currentLayout = (getState() as RootState).panes.layouts[tabId]
    const paneIds = collectPaneIds(currentLayout)

    dispatch(removeTab(tabId))
    dispatch(removeLayout({ tabId }))

    // Clean up attention and drafts for the tab and all its panes
    dispatch(clearTabAttention({ tabId }))
    for (const paneId of paneIds) {
      dispatch(clearPaneAttention({ paneId }))
      clearDraft(paneId)
    }
  }
)

export const reopenClosedTab = createAsyncThunk(
  'tabs/reopenClosedTab',
  async (_, { dispatch, getState }) => {
    const state = getState() as RootState
    const stack = state.tabRegistry.reopenStack
    if (stack.length === 0) return

    const entry = stack[stack.length - 1]
    dispatch(popReopenEntry())

    // Remove from localClosed registry if present (prevents stale "recently closed" entry)
    const deviceId = state.tabRegistry.deviceId
    const closedTabKey = `${deviceId}:${entry.tab.id}`
    dispatch(clearClosedTabSnapshot(closedTabKey))

    const newTabId = nanoid()
    dispatch(restorePaneBackedTab({
      tab: {
        id: newTabId,
        title: entry.tab.title,
        titleSetByUser: entry.tab.titleSetByUser,
        mode: entry.tab.mode,
        shell: entry.tab.shell,
        initialCwd: entry.tab.initialCwd,
        codingCliSessionId: entry.tab.codingCliSessionId,
        codingCliProvider: entry.tab.codingCliProvider,
        resumeSessionId: entry.tab.resumeSessionId,
        sessionMetadataByKey: entry.tab.sessionMetadataByKey,
      },
      layout: entry.layout,
      paneTitles: entry.paneTitles,
    }))
  }
)

export const openSessionTab = createAsyncThunk(
  'tabs/openSessionTab',
  async (
    { sessionId, title, cwd, provider, sessionType, terminalId, forceNew, firstUserMessage, isSubagent, isNonInteractive }: {
      sessionId: string
      title?: string
      cwd?: string
      provider?: CodingCliProviderName
      sessionType?: string
      terminalId?: string
      forceNew?: boolean
      firstUserMessage?: string
      isSubagent?: boolean
      isNonInteractive?: boolean
    },
    { dispatch, getState }
  ) => {
    const resolvedProvider = provider || 'claude'
    const resolvedSessionType = sessionType || resolvedProvider
    const state = getState() as RootState
    const localServerInstanceId = (state as Partial<RootState>).connection?.serverInstanceId
    const extensions = (state as Partial<RootState>).extensions?.entries ?? []
    const agentConfig = getAgentChatProviderConfig(resolvedSessionType)
    const providerSettings = agentConfig
      ? state.settings?.settings.agentChat?.providers?.[agentConfig.name]
      : undefined
    const exactSessionRef = buildExactSessionRef({
      provider: resolvedProvider,
      sessionId,
      serverInstanceId: localServerInstanceId,
    })
    const sessionMetadataInput = {
      sessionType: resolvedSessionType,
      firstUserMessage,
      isSubagent,
      isNonInteractive,
    }

    const buildSessionMetadataByKey = (existing?: Tab['sessionMetadataByKey']) =>
      mergeSessionMetadataByKey(existing, resolvedProvider, sessionId, sessionMetadataInput, cwd)

    const desiredResumeContent = buildResumeContent({
      sessionType: resolvedSessionType,
      sessionId,
      cwd,
      sessionRef: exactSessionRef,
      agentChatProviderSettings: providerSettings,
    })
    const desiredRunningResumeContent = buildResumeContent({
      sessionType: resolvedProvider,
      sessionId,
      cwd,
      terminalId,
      sessionRef: exactSessionRef,
    })

    const updateExistingTabMetadata = (tab: Tab | undefined) => {
      if (!tab) return
      const sessionMetadataByKey = buildSessionMetadataByKey(tab.sessionMetadataByKey)
      if (sessionMetadataByKey === tab.sessionMetadataByKey) return
      dispatch(updateTab({
        id: tab.id,
        updates: { sessionMetadataByKey },
      }))
    }

    const repairExistingTabLayout = (tab: Tab | undefined, desiredContent = desiredResumeContent) => {
      if (!tab) return
      const layout = state.panes.layouts[tab.id]
      if (!layout) return

      const targetSessionKey = makeCodingCliSessionKey(resolvedProvider, sessionId, cwd)
      const matchingLeaves: Array<{ id: string; content: any }> = []
      const visit = (node: PaneNode) => {
        if (node.type === 'leaf') {
          const content = node.content
          const contentInitialCwd =
            content.kind === 'terminal' || content.kind === 'agent-chat'
              ? content.initialCwd
              : undefined
          const sessionRef = (content as { sessionRef?: { provider?: unknown; sessionId?: unknown; cwd?: unknown } }).sessionRef
          const explicitSessionKey =
            typeof sessionRef?.provider === 'string' && typeof sessionRef?.sessionId === 'string'
              ? getCodingCliSessionKey({
                provider: sessionRef.provider,
                sessionId: sessionRef.sessionId,
                cwd: typeof sessionRef.cwd === 'string' ? sessionRef.cwd : contentInitialCwd,
              })
              : undefined
          const matchesExplicitSessionRef =
            explicitSessionKey === targetSessionKey
          const implicitProvider = content.kind === 'terminal'
            ? content.mode
            : resolvedProvider === 'claude'
              ? 'claude'
              : undefined
          const implicitSessionId = content.kind === 'terminal' || content.kind === 'agent-chat'
            ? content.resumeSessionId
            : undefined
          const matchesImplicitSessionRef =
            typeof implicitProvider === 'string'
            && implicitProvider !== 'shell'
            && typeof implicitSessionId === 'string'
            && makeCodingCliSessionKey(implicitProvider, implicitSessionId, contentInitialCwd) === targetSessionKey
          if (matchesExplicitSessionRef || matchesImplicitSessionRef) {
            matchingLeaves.push({ id: node.id, content })
          }
          return
        }
        visit(node.children[0])
        visit(node.children[1])
      }

      visit(layout)

      if (matchingLeaves.length !== 1) return
      const [{ id: paneId, content }] = matchingLeaves
      const sessionRefMatches = (
        ('sessionRef' in content ? content.sessionRef : undefined)?.provider
          === ('sessionRef' in desiredContent ? desiredContent.sessionRef : undefined)?.provider
        && ('sessionRef' in content ? content.sessionRef : undefined)?.sessionId
          === ('sessionRef' in desiredContent ? desiredContent.sessionRef : undefined)?.sessionId
        && ('sessionRef' in content ? content.sessionRef : undefined)?.serverInstanceId
          === ('sessionRef' in desiredContent ? desiredContent.sessionRef : undefined)?.serverInstanceId
      )

      const needsRepair = desiredContent.kind === 'agent-chat'
        ? content.kind !== 'agent-chat'
          || content.provider !== desiredContent.provider
          || content.resumeSessionId !== desiredContent.resumeSessionId
          || !sessionRefMatches
        : content.kind !== 'terminal'
          || content.mode !== desiredContent.mode
          || content.terminalId !== desiredContent.terminalId
          || content.resumeSessionId !== desiredContent.resumeSessionId
          || !sessionRefMatches

      if (!needsRepair) return

      dispatch(updatePaneContent({
        tabId: tab.id,
        paneId,
        content: desiredContent,
      }))
    }

    if (terminalId) {
      if (!forceNew) {
        const existingTab = state.tabs.tabs.find((t) => t.terminalId === terminalId)
        if (existingTab) {
          updateExistingTabMetadata(existingTab)
          if (state.panes.layouts[existingTab.id]) {
            repairExistingTabLayout(existingTab, desiredRunningResumeContent)
          }
          dispatch(setActiveTab(existingTab.id))
          return
        }
      }
      // Running terminals are always terminal panes (agent-chat uses SDK, not PTY)
      const tabId = nanoid()
      dispatch(createPaneBackedTab({
        tab: {
          id: tabId,
          title: title || getProviderLabel(resolvedProvider, extensions),
          terminalId,
          status: 'running',
          mode: resolvedProvider,
          codingCliProvider: resolvedProvider,
          initialCwd: cwd,
          resumeSessionId: sessionId,
          sessionMetadataByKey: buildSessionMetadataByKey(),
        },
        content: desiredRunningResumeContent,
      }))
      return
    }

    if (!forceNew) {
      const existingTabId = findTabIdForSession(
        state,
        { provider: resolvedProvider, sessionId, cwd },
        localServerInstanceId,
      )
      if (existingTabId) {
        const existingTab = state.tabs.tabs.find((tab) => tab.id === existingTabId)
        updateExistingTabMetadata(existingTab)
        repairExistingTabLayout(existingTab)
        dispatch(setActiveTab(existingTabId))
        return
      }
    }

    // For agent-chat sessions, create a tab then immediately set up agent-chat layout
    // so TabContent's fallback initLayout (which always creates terminal panes) doesn't win
    if (isAgentChatProviderName(resolvedSessionType)) {
      const tabId = nanoid()
      dispatch(createPaneBackedTab({
        tab: {
          id: tabId,
          title: title || getAgentChatProviderLabel(resolvedSessionType),
          mode: resolvedProvider,
          codingCliProvider: resolvedProvider,
          initialCwd: cwd,
          resumeSessionId: sessionId,
          sessionMetadataByKey: buildSessionMetadataByKey(),
        },
        content: desiredResumeContent,
      }))
      return
    }

    const tabId = nanoid()
    dispatch(createPaneBackedTab({
      tab: {
        id: tabId,
        title: title || getProviderLabel(resolvedProvider, extensions),
        mode: resolvedProvider,
        codingCliProvider: resolvedProvider,
        initialCwd: cwd,
        resumeSessionId: sessionId,
        sessionMetadataByKey: buildSessionMetadataByKey(),
      },
      content: desiredResumeContent,
    }))
  }
)

export default tabsSlice.reducer
