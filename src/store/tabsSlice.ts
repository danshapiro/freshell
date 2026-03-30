import { createSlice, PayloadAction, createAsyncThunk } from '@reduxjs/toolkit'
import type { Tab, TerminalStatus, TabMode, ShellType, CodingCliProviderName } from './types'
import { nanoid } from 'nanoid'
import { closePane, initLayout, restoreLayout, removeLayout, updatePaneContent } from './panesSlice'
import { clearTabAttention, clearPaneAttention } from './turnCompletionSlice.js'
import type { PaneNode } from './paneTypes'
import { findTabIdForSession } from '@/lib/session-utils'
import { getProviderLabel } from '@/lib/coding-cli-utils'
import { buildResumeContent } from '@/lib/session-type-utils'
import { isAgentChatProviderName, getAgentChatProviderConfig, getAgentChatProviderLabel } from '@/lib/agent-chat-utils'
import { recordClosedTabSnapshot, pushReopenEntry, popReopenEntry } from './tabRegistrySlice'
import { clearDraft } from '@/lib/draft-store'
import {
  buildClosedTabRegistryRecord,
  countPaneLeaves,
  shouldKeepClosedTab,
} from '@/lib/tab-registry-snapshot'
import { UNKNOWN_SERVER_INSTANCE_ID } from './tabRegistryConstants'
import type { RootState } from './store'
import { selectTabIdByTerminalId } from './selectors/paneTerminalSelectors'
import { loadPersistedLayout } from './persistMiddleware'
import { createLogger } from '@/lib/client-logger'
import { mergeSessionMetadataByKey } from '@/lib/session-metadata'


const log = createLogger('TabsSlice')

export type Tombstone = { id: string; deletedAt: number }

export interface TabsState {
  tabs: Tab[]
  activeTabId: string | null
  // Ephemeral UI signal: request TabBar to enter inline rename mode for a tab.
  // This must never be persisted.
  renameRequestTabId: string | null
  // IDs of tabs that were explicitly closed. Prevents resurrection during cross-tab merge.
  tombstones: Tombstone[]
}

function migrateTabFields(t: Tab): Tab {
  const legacyClaudeSessionId = (t as any).claudeSessionId as string | undefined
  // Strip legacy terminalId field from persisted data
  const { terminalId: _legacyTerminalId, ...rest } = t as Tab & { terminalId?: unknown }
  return {
    ...rest,
    codingCliSessionId: t.codingCliSessionId || legacyClaudeSessionId,
    codingCliProvider: t.codingCliProvider || (legacyClaudeSessionId ? 'claude' : undefined),
    createdAt: t.createdAt || Date.now(),
    createRequestId: (t as any).createRequestId || t.id,
    status: t.status || 'creating',
    mode: t.mode || 'shell',
    shell: t.shell || 'system',
    lastInputAt: t.lastInputAt,
  }
}

// Load persisted tabs state directly at module initialization time
// This ensures the initial state includes persisted data BEFORE the store is created
function loadInitialTabsState(): TabsState {
  const defaultState: TabsState = {
    tabs: [],
    activeTabId: null,
    renameRequestTabId: null,
    tombstones: [],
  }

  try {
    const layout = loadPersistedLayout()
    if (!layout) return defaultState

    const tabsState = layout.tabs?.tabs as Partial<TabsState> | undefined
    if (!Array.isArray(tabsState?.tabs)) return defaultState

    log.debug('Loaded initial state from localStorage:', tabsState.tabs.map((t: Tab) => t.id))

    const mappedTabs = tabsState.tabs.map(migrateTabFields)
    const desired = tabsState.activeTabId
    const has = desired && mappedTabs.some((t: Tab) => t.id === desired)

    return {
      tabs: mappedTabs,
      activeTabId: has ? desired! : (mappedTabs[0]?.id ?? null),
      renameRequestTabId: null,
      tombstones: Array.isArray(layout.tombstones) ? layout.tombstones : [],
    }
  } catch (err) {
    log.error('Failed to load from localStorage:', err)
    return defaultState
  }
}

const initialState: TabsState = loadInitialTabsState()

type AddTabPayload = {
  id?: string
  title?: string
  description?: string
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
  titleSetByUser?: boolean
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
        codingCliSessionId,
        codingCliProvider,
        claudeSessionId: payload.claudeSessionId,
        status: payload.status || 'creating',
        mode: payload.mode || 'shell',
        shell: payload.shell || 'system',
        initialCwd: payload.initialCwd,
        resumeSessionId: payload.resumeSessionId,
        sessionMetadataByKey: payload.sessionMetadataByKey,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        titleSetByUser: payload.titleSetByUser,
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
      if (tab) {
        Object.assign(tab, action.payload.updates)
        tab.updatedAt = Date.now()
      }
    },
    removeTab: (state, action: PayloadAction<string>) => {
      const removedTabId = action.payload
      const removedIndex = state.tabs.findIndex((t) => t.id === removedTabId)
      const wasActive = state.activeTabId === removedTabId

      state.tabs = state.tabs.filter((t) => t.id !== removedTabId)
      if (!state.tombstones) state.tombstones = []
      state.tombstones.push({ id: removedTabId, deletedAt: Date.now() })

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
      const remoteTabs = (action.payload.tabs || []).map(migrateTabFields)
      const remoteTombstones: Tombstone[] = Array.isArray(action.payload.tombstones) ? action.payload.tombstones : []

      // Union tombstones from both sides, deduped by ID
      const tombstoneMap = new Map<string, number>()
      for (const t of (state.tombstones || [])) tombstoneMap.set(t.id, Math.max(tombstoneMap.get(t.id) ?? 0, t.deletedAt))
      for (const t of remoteTombstones) tombstoneMap.set(t.id, Math.max(tombstoneMap.get(t.id) ?? 0, t.deletedAt))
      state.tombstones = Array.from(tombstoneMap, ([id, deletedAt]) => ({ id, deletedAt }))

      const tombstoned = new Set(tombstoneMap.keys())
      const localById = new Map(state.tabs.map((t) => [t.id, t]))
      const remoteById = new Map(remoteTabs.map((t) => [t.id, t]))

      // Build merged list: remote order for shared tabs, then local-only tabs appended
      const merged: Tab[] = []
      const seen = new Set<string>()

      for (const remoteTab of remoteTabs) {
        if (tombstoned.has(remoteTab.id)) continue
        seen.add(remoteTab.id)
        const localTab = localById.get(remoteTab.id)
        if (localTab) {
          // Both sides have this tab — resolve by updatedAt (remote wins ties)
          merged.push((localTab.updatedAt ?? 0) > (remoteTab.updatedAt ?? 0) ? localTab : remoteTab)
        } else {
          merged.push(remoteTab)
        }
      }

      // Append local-only tabs (not in remote, not tombstoned)
      for (const localTab of state.tabs) {
        if (seen.has(localTab.id) || tombstoned.has(localTab.id)) continue
        if (!remoteById.has(localTab.id)) {
          merged.push(localTab)
        }
      }

      state.tabs = merged

      // Prefer local activeTabId if it still exists in merged set
      const localActive = state.activeTabId
      const mergedIds = new Set(merged.map((t) => t.id))
      if (localActive && mergedIds.has(localActive)) {
        // keep local
      } else {
        const desired = action.payload.activeTabId
        state.activeTabId = (desired && mergedIds.has(desired)) ? desired : (merged[0]?.id ?? null)
      }

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

    // Push to the reopen stack so Alt+H can restore this tab
    if (tab && layout) {
      dispatch(pushReopenEntry({
        tab: { ...tab },
        layout,
        paneTitles: stateBeforeClose.panes.paneTitles[tabId] || {},
        paneTitleSetByUser: stateBeforeClose.panes.paneTitleSetByUser?.[tabId] || {},
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

    const newTabId = nanoid()
    dispatch(addTab({
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
    }))
    dispatch(restoreLayout({
      tabId: newTabId,
      layout: entry.layout,
      paneTitles: entry.paneTitles,
      paneTitleSetByUser: entry.paneTitleSetByUser,
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
    const sessionMetadataInput = {
      sessionType: resolvedSessionType,
      firstUserMessage,
      isSubagent,
      isNonInteractive,
    }

    const buildSessionMetadataByKey = (existing?: Tab['sessionMetadataByKey']) =>
      mergeSessionMetadataByKey(existing, resolvedProvider, sessionId, sessionMetadataInput)

    const desiredResumeContent = buildResumeContent({
      sessionType: resolvedSessionType,
      sessionId,
      cwd,
      agentChatProviderSettings: providerSettings,
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

    const repairExistingTabLayout = (tab: Tab | undefined) => {
      if (!tab) return
      const layout = state.panes.layouts[tab.id]
      if (!layout) return

      const matchingLeaves: Array<{ id: string; content: any }> = []
      const visit = (node: PaneNode) => {
        if (node.type === 'leaf') {
          const content = node.content
          const sessionRef = (content as { sessionRef?: { provider?: unknown; sessionId?: unknown } }).sessionRef
          const matchesExplicitSessionRef =
            typeof sessionRef?.provider === 'string'
            && typeof sessionRef?.sessionId === 'string'
            && sessionRef.provider === resolvedProvider
            && sessionRef.sessionId === sessionId
          const matchesImplicitSessionRef = (
            content.kind === 'terminal'
            && content.mode === resolvedProvider
            && content.resumeSessionId === sessionId
          ) || (
            content.kind === 'agent-chat'
            && resolvedProvider === 'claude'
            && content.resumeSessionId === sessionId
          )
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
      if (content.kind === 'terminal' && content.terminalId) return

      const needsRepair = desiredResumeContent.kind === 'agent-chat'
        ? content.kind !== 'agent-chat' || content.provider !== desiredResumeContent.provider
        : content.kind !== 'terminal' || content.mode !== desiredResumeContent.mode

      if (!needsRepair) return

      dispatch(updatePaneContent({
        tabId: tab.id,
        paneId,
        content: desiredResumeContent,
      }))
    }

    if (terminalId) {
      if (!forceNew) {
        const existingTabId = selectTabIdByTerminalId(state, terminalId)
        const existingTab = existingTabId
          ? state.tabs.tabs.find((t) => t.id === existingTabId)
          : undefined
        if (existingTab) {
          updateExistingTabMetadata(existingTab)
          dispatch(setActiveTab(existingTab.id))
          return
        }
      }
      // Running terminals are always terminal panes (agent-chat uses SDK, not PTY)
      const tabId = nanoid()
      dispatch(addTab({
        id: tabId,
        title: title || getProviderLabel(resolvedProvider, extensions),
        status: 'running',
        mode: resolvedProvider,
        codingCliProvider: resolvedProvider,
        initialCwd: cwd,
        resumeSessionId: sessionId,
        sessionMetadataByKey: buildSessionMetadataByKey(),
      }))
      dispatch(initLayout({
        tabId,
        content: {
          kind: 'terminal',
          mode: resolvedProvider,
          terminalId,
          resumeSessionId: sessionId,
          initialCwd: cwd,
          status: 'running',
        },
      }))
      return
    }

    if (!forceNew) {
      const existingTabId = findTabIdForSession(
        state,
        { provider: resolvedProvider, sessionId },
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
      dispatch(addTab({
        id: tabId,
        title: title || getAgentChatProviderLabel(resolvedSessionType),
        mode: resolvedProvider,
        codingCliProvider: resolvedProvider,
        initialCwd: cwd,
        resumeSessionId: sessionId,
        sessionMetadataByKey: buildSessionMetadataByKey(),
      }))
      dispatch(initLayout({
        tabId,
        content: desiredResumeContent,
      }))
      return
    }

    dispatch(addTab({
      title: title || getProviderLabel(resolvedProvider, extensions),
      mode: resolvedProvider,
      codingCliProvider: resolvedProvider,
      initialCwd: cwd,
      resumeSessionId: sessionId,
      sessionMetadataByKey: buildSessionMetadataByKey(),
    }))
  }
)

export default tabsSlice.reducer
