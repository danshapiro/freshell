import { createSlice, PayloadAction, createAsyncThunk } from '@reduxjs/toolkit'
import type { Tab, TerminalStatus, TabMode, ShellType, CodingCliProviderName } from './types'
import { nanoid } from 'nanoid'
import { closePane, initLayout, removeLayout, restoreLayout, updatePaneContent } from './panesSlice'
import { clearTabAttention, clearPaneAttention } from './turnCompletionSlice.js'
import type { PaneNode } from './paneTypes'
import { findTabIdForSession } from '@/lib/session-utils'
import { getProviderLabel } from '@/lib/coding-cli-utils'
import { buildResumeContent } from '@/lib/session-type-utils'
import { isAgentChatProviderName, getAgentChatProviderConfig, getAgentChatProviderLabel } from '@/lib/agent-chat-utils'
import { recordClosedTabSnapshot, pushReopenEntry, popReopenEntry, clearClosedTabSnapshot } from './tabRegistrySlice'
import { clearDraft } from '@/lib/draft-store'
import {
  bootstrapLegacyTabTitleSource,
  type DurableTitleSource,
} from '@/lib/title-source'
import {
  buildClosedTabRegistryRecord,
  countPaneLeaves,
  shouldKeepClosedTab,
} from '@/lib/tab-registry-snapshot'
import { UNKNOWN_SERVER_INSTANCE_ID } from './tabRegistryConstants'
import type { RootState } from './store'
import { parsePersistedTabsRaw } from './persistedState.js'
import { TABS_STORAGE_KEY } from './storage-keys'
import { createLogger } from '@/lib/client-logger'
import { mergeSessionMetadataByKey } from '@/lib/session-metadata'
import { buildExactSessionRef } from '@/lib/exact-session-ref'


const log = createLogger('TabsSlice')

type TabUpdateFields = Partial<Tab> & {
  source?: DurableTitleSource
}

function setTabTitleSource(tab: Tab, source: DurableTitleSource | undefined) {
  if (source) {
    tab.titleSource = source
  } else {
    delete tab.titleSource
  }
  tab.titleSetByUser = source === 'user'
}

function normalizeLoadedTab(tab: Tab): Tab {
  const legacyClaudeSessionId = (tab as any).claudeSessionId as string | undefined
  const titleSource = tab.titleSource ?? bootstrapLegacyTabTitleSource({
    title: tab.title,
    titleSetByUser: tab.titleSetByUser,
    mode: tab.mode,
    shell: tab.shell,
  })

  return {
    ...tab,
    codingCliSessionId: tab.codingCliSessionId || legacyClaudeSessionId,
    codingCliProvider: tab.codingCliProvider || (legacyClaudeSessionId ? 'claude' : undefined),
    createdAt: tab.createdAt || Date.now(),
    createRequestId: (tab as any).createRequestId || tab.id,
    status: tab.status || 'creating',
    mode: tab.mode || 'shell',
    shell: tab.shell || 'system',
    lastInputAt: tab.lastInputAt,
    titleSource,
    titleSetByUser: titleSource === 'user',
  }
}

function resolveAddTabTitleSource(payload: AddTabPayload): DurableTitleSource {
  if (payload.titleSource) return payload.titleSource
  if (payload.titleSetByUser) return 'user'
  return 'derived'
}

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
    const raw = localStorage.getItem(TABS_STORAGE_KEY)
    if (!raw) return defaultState
    const parsed = parsePersistedTabsRaw(raw)
    if (!parsed) return defaultState
    const tabsState = parsed.tabs as Partial<TabsState> | undefined
    if (!Array.isArray(tabsState?.tabs)) return defaultState

    log.debug('Loaded initial state from localStorage:', tabsState.tabs.map((t) => t.id))

    const mappedTabs = tabsState.tabs.map((t: Tab) => normalizeLoadedTab(t))
    const desired = tabsState.activeTabId
    const has = desired && mappedTabs.some((t) => t.id === desired)

    return {
      tabs: mappedTabs,
      activeTabId: has ? desired! : (mappedTabs[0]?.id ?? null),
      renameRequestTabId: null,
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
  titleSource?: DurableTitleSource
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
        sessionMetadataByKey: payload.sessionMetadataByKey,
        createdAt: Date.now(),
        titleSource: resolveAddTabTitleSource(payload),
        titleSetByUser: false,
        lastInputAt: undefined,
      }
      setTabTitleSource(tab, tab.titleSource)
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
    setTabTitle: (state, action: PayloadAction<{ id: string; title: string; source: DurableTitleSource }>) => {
      const tab = state.tabs.find((t) => t.id === action.payload.id)
      if (!tab) return
      tab.title = action.payload.title
      setTabTitleSource(tab, action.payload.source)
    },
    updateTab: (state, action: PayloadAction<{ id: string; updates: TabUpdateFields }>) => {
      const tab = state.tabs.find((t) => t.id === action.payload.id)
      if (!tab) return

      const updates = action.payload.updates
      const nextSource = tab.titleSource

      const hasTitle = Object.prototype.hasOwnProperty.call(updates, 'title')
      const hasExplicitSource = Object.prototype.hasOwnProperty.call(updates, 'source')
        || Object.prototype.hasOwnProperty.call(updates, 'titleSource')
      const explicitSource = Object.prototype.hasOwnProperty.call(updates, 'source')
        ? updates.source
        : updates.titleSource

      if (hasTitle) {
        tab.title = updates.title as string
      }

      const { title: _title, titleSource: _titleSource, titleSetByUser: legacyTitleSetByUser, source: _source, ...rest } = updates
      Object.assign(tab, rest)

      if (hasExplicitSource) {
        setTabTitleSource(tab, explicitSource)
        return
      }

      if (legacyTitleSetByUser === true) {
        setTabTitleSource(tab, 'user')
        return
      }

      if (legacyTitleSetByUser === false && nextSource === 'user') {
        setTabTitleSource(tab, 'derived')
        return
      }

      if (hasTitle) {
        setTabTitleSource(tab, nextSource)
      }
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
      state.tabs = (action.payload.tabs || []).map((t) => normalizeLoadedTab(t))
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
  setTabTitle,
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
    dispatch(addTab({
      id: newTabId,
      title: entry.tab.title,
      titleSource: entry.tab.titleSource,
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
      mergeSessionMetadataByKey(existing, resolvedProvider, sessionId, sessionMetadataInput)

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
          if (!state.panes.layouts[existingTab.id]) {
            dispatch(initLayout({
              tabId: existingTab.id,
              content: desiredRunningResumeContent,
            }))
          } else {
            repairExistingTabLayout(existingTab, desiredRunningResumeContent)
          }
          dispatch(setActiveTab(existingTab.id))
          return
        }
      }
      // Running terminals are always terminal panes (agent-chat uses SDK, not PTY)
      const tabId = nanoid()
      dispatch(addTab({
        id: tabId,
        title: title || getProviderLabel(resolvedProvider, extensions),
        titleSource: title ? 'stable' : 'derived',
        terminalId,
        status: 'running',
        mode: resolvedProvider,
        codingCliProvider: resolvedProvider,
        initialCwd: cwd,
        resumeSessionId: sessionId,
        sessionMetadataByKey: buildSessionMetadataByKey(),
      }))
      dispatch(initLayout({
        tabId,
        content: desiredRunningResumeContent,
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
        titleSource: title ? 'stable' : 'derived',
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

    const tabId = nanoid()
    dispatch(addTab({
      id: tabId,
      title: title || getProviderLabel(resolvedProvider, extensions),
      titleSource: title ? 'stable' : 'derived',
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
  }
)

export default tabsSlice.reducer
