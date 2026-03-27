import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Terminal, Folder, Settings, LayoutGrid, Search, Loader2, X, Archive, PanelLeftClose, AlertCircle } from 'lucide-react'
import NetworkQuickAccess from '@/components/NetworkQuickAccess'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { useAppDispatch, useAppSelector, useAppStore } from '@/store/hooks'
import { shallowEqual } from 'react-redux'
import { openSessionTab, setActiveTab, updateTab } from '@/store/tabsSlice'
import { addPane, setActivePane } from '@/store/panesSlice'
import { findPaneForSession } from '@/lib/session-utils'
import { resolveSessionTypeConfig, buildResumeContent } from '@/lib/session-type-utils'
import { getAgentChatProviderConfig } from '@/lib/agent-chat-utils'
import type { BackgroundTerminal, CodingCliProviderName } from '@/store/types'
import { makeSelectSortedSessionItems, type SidebarSessionItem } from '@/store/selectors/sidebarSelectors'
import { ContextIds } from '@/components/context-menu/context-menu-constants'
import { getActiveSessionRefForTab } from '@/lib/session-utils'
import { useStableArray } from '@/hooks/useStableArray'
import { getInstalledPerfAuditBridge } from '@/lib/perf-audit-bridge'
import { fetchSessionWindow } from '@/store/sessionsThunks'
import { mergeSessionMetadataByKey } from '@/lib/session-metadata'
import { collectBusySessionKeys } from '@/lib/pane-activity'
import type { ChatSessionState } from '@/store/agentChatTypes'
import type { PaneRuntimeActivityRecord } from '@/store/paneRuntimeActivitySlice'

const EMPTY_TERMINALS: BackgroundTerminal[] = []
const EMPTY_LAYOUTS: Record<string, never> = {}
const EMPTY_CODEX_ACTIVITY_BY_ID = {}
const EMPTY_AGENT_CHAT_SESSIONS: Record<string, ChatSessionState> = {}
const EMPTY_PANE_RUNTIME_ACTIVITY_BY_ID: Record<string, PaneRuntimeActivityRecord> = {}

/** Compare two BackgroundTerminal arrays by sidebar-relevant fields only.
 *  Ignores terminal `lastActivityAt` since it changes frequently but doesn't affect rendering. */
export function areTerminalsEqual(a: BackgroundTerminal[], b: BackgroundTerminal[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const ai = a[i], bi = b[i]
    if (
      ai.terminalId !== bi.terminalId ||
      ai.title !== bi.title ||
      ai.createdAt !== bi.createdAt ||
      ai.cwd !== bi.cwd ||
      ai.status !== bi.status ||
      ai.hasClients !== bi.hasClients ||
      ai.mode !== bi.mode ||
      ai.resumeSessionId !== bi.resumeSessionId
    ) return false
  }
  return true
}

export type AppView = 'terminal' | 'tabs' | 'sessions' | 'overview' | 'settings' | 'extensions'

type SessionItem = SidebarSessionItem

/** Compare two SessionItem arrays by sidebar-relevant fields.
 *  Used by tests to verify render stability guarantees. */
export function areSessionItemsEqual(a: SessionItem[], b: SessionItem[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const ai = a[i], bi = b[i]
    if (
      ai.sessionId !== bi.sessionId ||
      ai.provider !== bi.provider ||
      ai.sessionType !== bi.sessionType ||
      ai.title !== bi.title ||
      ai.subtitle !== bi.subtitle ||
      ai.hasTab !== bi.hasTab ||
      ai.isRunning !== bi.isRunning ||
      ai.runningTerminalId !== bi.runningTerminalId ||
      !areTerminalIdsEqual(ai.runningTerminalIds, bi.runningTerminalIds) ||
      ai.archived !== bi.archived ||
      ai.projectColor !== bi.projectColor ||
      ai.cwd !== bi.cwd ||
      ai.projectPath !== bi.projectPath ||
      ai.isFallback !== bi.isFallback ||
      ai.timestamp !== bi.timestamp
    ) return false
  }
  return true
}

const SESSION_ITEM_HEIGHT = 56

function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  if (hours < 24) return `${hours}h`
  if (days < 7) return `${days}d`
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Structural equality for a single session item — returns true when all
 *  fields that affect rendering, sorting, or filtering are identical. Used by
 *  useStableArray to prevent react-window from rebuilding all row elements
 *  when the selector produces new object references for unchanged sessions. */
function areTerminalIdsEqual(a?: string[], b?: string[]): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function isSessionItemEqual(a: SessionItem, b: SessionItem): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.provider === b.provider &&
    a.sessionType === b.sessionType &&
    a.title === b.title &&
    a.subtitle === b.subtitle &&
    a.timestamp === b.timestamp &&
    a.hasTab === b.hasTab &&
    a.isRunning === b.isRunning &&
    a.runningTerminalId === b.runningTerminalId &&
    areTerminalIdsEqual(a.runningTerminalIds, b.runningTerminalIds) &&
    a.archived === b.archived &&
    a.projectColor === b.projectColor &&
    a.cwd === b.cwd &&
    a.projectPath === b.projectPath &&
    a.isFallback === b.isFallback &&
    a.ratchetedActivity === b.ratchetedActivity &&
    a.hasTitle === b.hasTitle &&
    a.isSubagent === b.isSubagent &&
    a.isNonInteractive === b.isNonInteractive &&
    a.firstUserMessage === b.firstUserMessage
  )
}

/**
 * Determine whether a sidebar session item should be highlighted as active.
 * Prefers activeSessionKey (derived from the active pane's content) when
 * available. Falls back to activeTerminalId only when no session key exists
 * (e.g. a fresh terminal not yet associated with a session).
 * This prevents double-highlighting when activeTerminalId is stale.
 */
export function computeIsActive(params: {
  isRunning: boolean
  runningTerminalId: string | undefined
  sessionKey: string
  activeSessionKey: string | null
  activeTerminalId: string | undefined
}): boolean {
  // When we have a session key from the active pane, use it for all items
  if (params.activeSessionKey != null) {
    return params.sessionKey === params.activeSessionKey
  }
  // No session key available — fall back to terminal ID matching for running sessions
  if (params.isRunning) {
    return params.runningTerminalId === params.activeTerminalId
  }
  return false
}

export default function Sidebar({
  view,
  onNavigate,
  onToggleSidebar,
  currentVersion = null,
  updateAvailable = false,
  latestVersion = null,
  onBrandClick,
  onSharePanel,
  width = 288,
  fullWidth = false,
}: {
  view: AppView
  onNavigate: (v: AppView) => void
  onToggleSidebar?: () => void
  currentVersion?: string | null
  updateAvailable?: boolean
  latestVersion?: string | null
  onBrandClick?: () => void
  onSharePanel?: () => void
  width?: number
  fullWidth?: boolean
}) {
  const dispatch = useAppDispatch()
  const store = useAppStore()
  const settings = useAppSelector((s) => s.settings.settings)
  const tabs = useAppSelector((s) => s.tabs.tabs)
  const activeTabId = useAppSelector((s) => s.tabs.activeTabId)
  const activeSessionKeyFromPanes = useAppSelector((s) => {
    const tabId = s.tabs.activeTabId
    if (!tabId) return null
    const ref = getActiveSessionRefForTab(s, tabId)
    if (!ref) return null
    return `${ref.provider}:${ref.sessionId}`
  })
  const selectSortedItems = useMemo(() => makeSelectSortedSessionItems(), [])

  const sidebarWindow = useAppSelector((s) => s.sessions.windows?.sidebar)
  const terminals = useAppSelector((state) => (
    (state as any).terminalDirectory?.windows?.sidebar?.items ?? EMPTY_TERMINALS
  )) as BackgroundTerminal[]
  const [filter, setFilter] = useState('')
  const [searchTier, setSearchTier] = useState<'title' | 'userMessages' | 'fullText'>('title')
  const lastMarkedSearchQueryRef = useRef<string | null>(null)
  const wasSearchingRef = useRef(false)
  const listRef = useRef<HTMLDivElement | null>(null)
  const listContentRef = useRef<HTMLDivElement | null>(null)
  const listMetricsRef = useRef({ clientHeight: 0, scrollHeight: 0 })

  // Tick counter that increments every 15s to keep relative timestamps fresh.
  // The custom comparator on SidebarItem ensures only the timestamp text node
  // updates — no DOM flicker despite the frequent ticks.
  const [timestampTick, setTimestampTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTimestampTick((t) => t + 1), 15_000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    const query = filter.trim()
    if (!query) {
      if (wasSearchingRef.current) {
        wasSearchingRef.current = false
        lastMarkedSearchQueryRef.current = null
        void dispatch(fetchSessionWindow({
          surface: 'sidebar',
          priority: 'visible',
        }) as any)
      }
      return
    }

    const timeoutId = setTimeout(async () => {
      wasSearchingRef.current = true
      void dispatch(fetchSessionWindow({
        surface: 'sidebar',
        priority: 'visible',
        query,
        searchTier,
      }) as any)
    }, 300) // Debounce 300ms

    return () => {
      clearTimeout(timeoutId)
    }
  }, [dispatch, filter, searchTier])

  const localFilteredItems = useAppSelector((state) => selectSortedItems(state, terminals, ''))
  const computedItems = useMemo(() => localFilteredItems, [localFilteredItems])

  // Stabilize the array reference so react-window doesn't rebuild all row
  // elements when the selector produces new objects with identical field
  // values (e.g. an active session's lastActivityAt changed but no visible fields
  // differ). Individual SidebarItem updates still go through when a field
  // value actually changes — the custom memo comparator on SidebarItem
  // handles that independently.
  const sortedItems = useStableArray(computedItems, isSessionItemEqual)
  const busySessionKeys = useAppSelector((state) => collectBusySessionKeys({
    tabs: state.tabs.tabs,
    paneLayouts: state.panes?.layouts ?? EMPTY_LAYOUTS,
    codexActivityByTerminalId: state.codexActivity?.byTerminalId ?? EMPTY_CODEX_ACTIVITY_BY_ID,
    paneRuntimeActivityByPaneId: state.paneRuntimeActivity?.byPaneId ?? EMPTY_PANE_RUNTIME_ACTIVITY_BY_ID,
    agentChatSessions: state.agentChat?.sessions ?? EMPTY_AGENT_CHAT_SESSIONS,
  }), shallowEqual)
  const busySessionKeySet = useMemo(() => new Set(busySessionKeys), [busySessionKeys])

  // Read activeTabId from the store at call time (not closure) so that
  // handleItemClick has a stable reference and doesn't cause SidebarItem
  // re-renders when the active tab changes.
  const handleItemClick = useCallback((item: SessionItem) => {
    const provider = item.provider as CodingCliProviderName
    const state = store.getState()
    const currentActiveTabId = state.tabs.activeTabId
    const runningTerminalId = item.isRunning ? item.runningTerminalId : undefined
    const localServerInstanceId = state.connection.serverInstanceId

    // 1. Dedup: if session is already open in a pane, focus it
    const existing = findPaneForSession(
      state,
      { provider, sessionId: item.sessionId },
      localServerInstanceId,
    )
    if (existing) {
      dispatch(setActiveTab(existing.tabId))
      if (existing.paneId) {
        dispatch(setActivePane({ tabId: existing.tabId, paneId: existing.paneId }))
      }
      onNavigate('terminal')
      return
    }

    // Resolve provider settings for agent-chat panes
    const sessionType = item.sessionType || provider
    const agentConfig = getAgentChatProviderConfig(sessionType)
    const providerSettings = agentConfig
      ? state.settings.settings.agentChat?.providers?.[agentConfig.name]
      : undefined

    // 2. Fallback: no active tab or active tab has no layout → create new tab
    const paneLayouts = state.panes?.layouts ?? EMPTY_LAYOUTS
    const activeLayout = currentActiveTabId ? paneLayouts[currentActiveTabId] : undefined
    if (!currentActiveTabId || !activeLayout) {
      dispatch(openSessionTab({
        sessionId: item.sessionId,
        title: item.title,
        cwd: item.cwd,
        provider,
        sessionType,
        terminalId: runningTerminalId,
        firstUserMessage: item.firstUserMessage,
        isSubagent: item.isSubagent,
        isNonInteractive: item.isNonInteractive,
      }))
      onNavigate('terminal')
      return
    }

    // 3. Normal: open in new tab or split, based on user preference
    const sessionOpenMode = state.settings.settings.panes?.sessionOpenMode ?? 'tab'
    if (sessionOpenMode === 'tab') {
      dispatch(openSessionTab({
        sessionId: item.sessionId,
        title: item.title,
        cwd: item.cwd,
        provider,
        sessionType,
        terminalId: runningTerminalId,
        firstUserMessage: item.firstUserMessage,
        isSubagent: item.isSubagent,
        isNonInteractive: item.isNonInteractive,
      }))
      onNavigate('terminal')
      return
    }

    dispatch(addPane({
      tabId: currentActiveTabId,
      newContent: buildResumeContent({
        sessionType,
        sessionId: item.sessionId,
        cwd: item.cwd,
        terminalId: runningTerminalId,
        agentChatProviderSettings: providerSettings,
      }),
    }))
    const activeTab = state.tabs.tabs.find((tab) => tab.id === currentActiveTabId)
    const sessionMetadataByKey = mergeSessionMetadataByKey(
      activeTab?.sessionMetadataByKey,
      provider,
      item.sessionId,
      {
        sessionType,
        firstUserMessage: item.firstUserMessage,
        isSubagent: item.isSubagent,
        isNonInteractive: item.isNonInteractive,
      },
    )
    if (activeTab && sessionMetadataByKey !== activeTab.sessionMetadataByKey) {
      dispatch(updateTab({
        id: currentActiveTabId,
        updates: { sessionMetadataByKey },
      }))
    }
    onNavigate('terminal')
  }, [dispatch, onNavigate, store])

  const nav = [
    { id: 'terminal' as const, label: 'Coding Agents', icon: Terminal, shortcut: 'T' },
    { id: 'tabs' as const, label: 'Tabs', icon: Archive, shortcut: 'A' },
    { id: 'overview' as const, label: 'Panes', icon: LayoutGrid, shortcut: 'O' },
    { id: 'sessions' as const, label: 'Projects', icon: Folder, shortcut: 'P' },
    { id: 'settings' as const, label: 'Settings', icon: Settings, shortcut: ',' },
  ]

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const activeSessionKey = activeSessionKeyFromPanes
  const activeTerminalId = activeTab?.terminalId
  const requestedSearchTier = sidebarWindow?.searchTier ?? searchTier
  const appliedQuery = (sidebarWindow?.appliedQuery ?? '').trim()
  const appliedSearchTier = sidebarWindow?.appliedSearchTier ?? 'title'
  const hasLoadedSidebarWindow = typeof sidebarWindow?.lastLoadedAt === 'number'
  const sidebarWindowHasItems = (sidebarWindow?.projects ?? []).some((project) => (project.sessions?.length ?? 0) > 0)
  const requestedQuery = (sidebarWindow?.query ?? filter).trim()
  const visibleQuery = appliedQuery || requestedQuery
  const visibleSearchTier = appliedQuery ? appliedSearchTier : requestedSearchTier
  const loadingKind = sidebarWindow?.loadingKind
  const showBlockingLoad = !!sidebarWindow?.loading
    && loadingKind === 'initial'
    && !hasLoadedSidebarWindow
    && !sidebarWindowHasItems
  const showSearchLoading = !!sidebarWindow?.loading && loadingKind === 'search'
  const showDeepSearchPending = !!sidebarWindow?.deepSearchPending
  const sidebarHasMore = sidebarWindow?.hasMore ?? false
  const sidebarOldestLoadedTimestamp = sidebarWindow?.oldestLoadedTimestamp
  const sidebarOldestLoadedSessionId = sidebarWindow?.oldestLoadedSessionId
  const hasAppliedQuery = appliedQuery.length > 0

  const loadMoreInFlightRef = useRef(false)
  const loadMoreTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestSidebarAppend = useCallback(() => {
    if (!sidebarHasMore || sidebarWindow?.loading || loadMoreInFlightRef.current) return
    if (sidebarOldestLoadedTimestamp == null || sidebarOldestLoadedSessionId == null) return
    if (hasAppliedQuery) return

    loadMoreInFlightRef.current = true
    void dispatch(fetchSessionWindow({
      surface: 'sidebar',
      priority: 'visible',
      append: true,
    }) as any)
    if (loadMoreTimeoutRef.current) clearTimeout(loadMoreTimeoutRef.current)
    loadMoreTimeoutRef.current = setTimeout(() => {
      loadMoreInFlightRef.current = false
    }, 15_000)
  }, [
    dispatch,
    hasAppliedQuery,
    sidebarHasMore,
    sidebarOldestLoadedSessionId,
    sidebarOldestLoadedTimestamp,
    sidebarWindow?.loading,
  ])

  const getListMetrics = useCallback(() => {
    const list = listRef.current
    if (!list) return null

    const clientHeight = list.clientHeight > 0
      ? list.clientHeight
      : listMetricsRef.current.clientHeight
    const measuredScrollHeight = list.scrollHeight > 0
      ? list.scrollHeight
      : listMetricsRef.current.scrollHeight
    const estimatedScrollHeight = sortedItems.length * SESSION_ITEM_HEIGHT
    const scrollHeight = Math.max(measuredScrollHeight, estimatedScrollHeight)

    if (clientHeight > 0 || scrollHeight > 0) {
      listMetricsRef.current = { clientHeight, scrollHeight }
    }

    return {
      list,
      clientHeight,
      scrollHeight,
    }
  }, [sortedItems.length])

  const maybeBackfillViewport = useCallback(() => {
    const metrics = getListMetrics()
    if (!metrics) return
    if (metrics.clientHeight <= 0 || metrics.scrollHeight <= 0) return
    const underfilledViewport = metrics.scrollHeight <= metrics.clientHeight
    if (!underfilledViewport) return
    requestSidebarAppend()
  }, [getListMetrics, requestSidebarAppend])

  const handleListScroll = useCallback(() => {
    const metrics = getListMetrics()
    if (!metrics) return
    const remaining = metrics.scrollHeight - (metrics.list.scrollTop + metrics.clientHeight)
    const nearBottom = remaining <= SESSION_ITEM_HEIGHT * 10
    if (!nearBottom) return
    requestSidebarAppend()
  }, [getListMetrics, requestSidebarAppend])

  useEffect(() => {
    if (!sidebarWindow?.loading) {
      loadMoreInFlightRef.current = false
      if (loadMoreTimeoutRef.current) { clearTimeout(loadMoreTimeoutRef.current); loadMoreTimeoutRef.current = null }
    }
  }, [sidebarWindow?.loading])

  useEffect(() => {
    maybeBackfillViewport()
  }, [
    maybeBackfillViewport,
    sortedItems.length,
    sidebarWindow?.lastLoadedAt,
    sidebarWindow?.oldestLoadedTimestamp,
    sidebarWindow?.oldestLoadedSessionId,
    sidebarWindow?.hasMore,
    sidebarWindow?.loading,
  ])

  useEffect(() => {
    const resizeTarget = listContentRef.current ?? listRef.current
    if (!resizeTarget || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => maybeBackfillViewport())
    observer.observe(resizeTarget)
    return () => observer.disconnect()
  }, [maybeBackfillViewport, showBlockingLoad, sortedItems.length])

  useEffect(() => () => {
    if (loadMoreTimeoutRef.current) clearTimeout(loadMoreTimeoutRef.current)
  }, [])

  useEffect(() => {
    const query = filter.trim()
    if (!query) return
    if (sidebarWindow?.loading) return
    if (sortedItems.length === 0) return
    if (lastMarkedSearchQueryRef.current === query) return
    getInstalledPerfAuditBridge()?.mark('sidebar.search_results_visible', {
      query,
      resultCount: sortedItems.length,
    })
    lastMarkedSearchQueryRef.current = query
  }, [filter, sidebarWindow?.loading, sortedItems.length])

  return (
    <div
      className={cn(
        'h-full flex flex-col bg-card flex-shrink-0 transition-[width] duration-150',
        fullWidth && 'w-full'
      )}
      style={fullWidth ? undefined : { width: `${width}px` }}
    >
      {/* Header */}
      <div className="px-3 py-3">
        <div className="flex items-center gap-1.5">
          <button
            onClick={onToggleSidebar}
            className="p-1.5 rounded-md hover:bg-muted transition-colors min-h-11 min-w-11 md:min-h-0 md:min-w-0 flex items-center justify-center"
            title="Hide sidebar"
            aria-label="Hide sidebar"
          >
            <PanelLeftClose className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
          {currentVersion ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    'font-mono min-w-0 text-sm font-semibold tracking-tight whitespace-nowrap rounded px-1 -mx-1 border-0 p-0 bg-transparent inline-flex items-center gap-1 transition-colors',
                    updateAvailable
                      ? 'text-amber-700 dark:text-amber-400 bg-amber-100/60 dark:bg-amber-950/40 hover:bg-amber-200/70 dark:hover:bg-amber-900/60 cursor-pointer'
                      : 'cursor-default'
                  )}
                  onClick={onBrandClick}
                  aria-label={
                    updateAvailable
                      ? `Freshell v${currentVersion}. Update available${latestVersion ? `: v${latestVersion}` : ''}. Click for update instructions.`
                      : `Freshell v${currentVersion}. Up to date.`
                  }
                  data-testid="app-brand-status"
                >
                  <span className="truncate">🐚🔥freshell</span>
                  {updateAvailable && <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {updateAvailable ? (
                  <div>
                    <div>v{currentVersion} - {latestVersion ? `v${latestVersion} available` : 'update available'}</div>
                    <div className="text-muted-foreground">Click for update instructions</div>
                  </div>
                ) : (
                  <div>v{currentVersion} (up to date)</div>
                )}
              </TooltipContent>
            </Tooltip>
          ) : (
            <span className="font-mono min-w-0 text-sm font-semibold tracking-tight whitespace-nowrap truncate">🐚🔥freshell</span>
          )}
          <div className="ml-auto">
            <NetworkQuickAccess onSharePanel={onSharePanel} />
          </div>
        </div>
      </div>

      {/* Search */}
      <div className="px-3 pb-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-busy={showSearchLoading}
            className="w-full h-8 pl-8 pr-36 text-sm bg-muted/50 border-0 rounded-md placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-border"
          />
          <div className="absolute right-2 top-1/2 flex w-28 -translate-y-1/2 items-center justify-end gap-1">
            {showSearchLoading ? (
              <span
                role="status"
                data-testid="search-loading"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground"
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                <span>Searching...</span>
              </span>
            ) : null}
            {filter ? (
              <button
                aria-label="Clear search"
                onClick={() => setFilter('')}
                className="p-0.5 min-h-11 min-w-11 md:min-h-0 md:min-w-0 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </div>
        {filter.trim() && (
          <div className="mt-2">
            <select
              aria-label="Search tier"
              value={searchTier}
              onChange={(e) => setSearchTier(e.target.value as typeof searchTier)}
              className="w-full h-7 px-2 text-xs bg-muted/50 border-0 rounded-md focus:outline-none focus:ring-1 focus:ring-border"
            >
              <option value="title">Title</option>
              <option value="userMessages">User Msg</option>
              <option value="fullText">Full Text</option>
            </select>
            {showDeepSearchPending && sidebarWindowHasItems && (
              <div role="status" aria-live="polite" className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                <span>Scanning files...</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Navigation */}
      <div className="px-3 pb-2">
        <div className="flex gap-1">
          {nav.map((item) => {
            const Icon = item.icon
            const active = view === item.id
            return (
              <button
                key={item.id}
                onClick={() => onNavigate(item.id)}
                className={cn(
                  'flex-1 flex items-center justify-center gap-1.5 py-2.5 md:py-1.5 min-h-11 md:min-h-0 rounded-md text-xs transition-colors',
                  active
                    ? 'bg-foreground text-background font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                )}
                title={`${item.label} (Ctrl+B ${item.shortcut})`}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            )
          })}
        </div>
      </div>

      {/* Session List */}
      <div className="flex flex-1 min-h-0 flex-col">
        <div className="flex-1 min-h-0 px-2">
          {showBlockingLoad ? (
            <div
              className="flex items-center justify-center py-8"
              data-testid={requestedQuery ? 'search-loading' : undefined}
            >
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">
                {requestedQuery ? 'Searching...' : 'Loading sessions...'}
              </span>
            </div>
          ) : sortedItems.length === 0 ? (
          showDeepSearchPending ? (
            <div className="flex items-center justify-center py-8" role="status" aria-live="polite">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
              <span className="ml-2 text-sm text-muted-foreground">Scanning files...</span>
            </div>
          ) : (
          <div className="px-2 py-8 text-center text-sm text-muted-foreground">
            {visibleQuery && visibleSearchTier !== 'title'
              ? 'No results found'
              : visibleQuery
              ? 'No matching sessions'
              : 'No sessions yet'}
          </div>
          )
          ) : (
            <div
              ref={listRef}
              data-testid="sidebar-session-list"
              className="h-full overflow-y-auto"
              onScroll={handleListScroll}
            >
              <div ref={listContentRef}>
                {sortedItems.map((item) => {
                  const sessionKey = `${item.provider}:${item.sessionId}`
                  const isActive = computeIsActive({
                    isRunning: item.isRunning,
                    runningTerminalId: item.runningTerminalId,
                    sessionKey,
                    activeSessionKey,
                    activeTerminalId,
                  })

                  return (
                    <div key={sessionKey} className="pb-0.5">
                      <SidebarItem
                        item={item}
                        isActiveTab={isActive}
                        isBusy={busySessionKeySet.has(sessionKey)}
                        showProjectBadge={settings.sidebar?.showProjectBadges}
                        onClick={() => handleItemClick(item)}
                        timestampTick={timestampTick}
                      />
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>

    </div>
  )
}

interface SidebarItemProps {
  item: SessionItem
  isActiveTab?: boolean
  isBusy?: boolean
  showProjectBadge?: boolean
  onClick: () => void
  /** Changing tick value breaks memo equality to refresh relative timestamps. */
  timestampTick?: number
}

/** Custom comparator for React.memo: compares item fields by value instead of
 *  reference. Ignores `onClick` because: (1) handleItemClick is stable (reads
 *  activeTabId from store at call time), and (2) all item fields used by the
 *  click handler are compared here (sessionId, provider, title, cwd, etc.). */
function areSidebarItemPropsEqual(prev: SidebarItemProps, next: SidebarItemProps): boolean {
  if (prev.isActiveTab !== next.isActiveTab) return false
  if (prev.isBusy !== next.isBusy) return false
  if (prev.showProjectBadge !== next.showProjectBadge) return false
  if (prev.timestampTick !== next.timestampTick) return false

  const a = prev.item, b = next.item
  return (
    a.sessionId === b.sessionId &&
    a.provider === b.provider &&
    a.sessionType === b.sessionType &&
    a.title === b.title &&
    a.subtitle === b.subtitle &&
    a.timestamp === b.timestamp &&
    a.hasTab === b.hasTab &&
    a.isRunning === b.isRunning &&
    a.runningTerminalId === b.runningTerminalId &&
    areTerminalIdsEqual(a.runningTerminalIds, b.runningTerminalIds) &&
    a.archived === b.archived &&
    a.projectColor === b.projectColor &&
    a.cwd === b.cwd &&
    a.projectPath === b.projectPath &&
    a.isFallback === b.isFallback
  )
}

export const SidebarItem = memo(function SidebarItem(props: SidebarItemProps) {
  const { item, isActiveTab, isBusy = false, showProjectBadge, onClick } = props
  const extensionEntries = useAppSelector((s) => s.extensions?.entries)
  const { icon: SessionIcon, label: sessionLabel } = resolveSessionTypeConfig(item.sessionType, extensionEntries)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          className={cn(
            'w-full flex items-center gap-2 px-2 py-3 md:py-2 rounded-md text-left transition-colors group',
            isActiveTab
              ? 'bg-muted'
              : 'hover:bg-muted/50'
          )}
          data-context={ContextIds.SidebarSession}
          data-session-id={item.sessionId}
          data-provider={item.provider}
          data-session-type={item.sessionType}
          data-running-terminal-id={item.runningTerminalId}
          data-has-tab={item.hasTab ? 'true' : 'false'}
        >
          {/* Provider icon */}
          <div className="flex-shrink-0">
            <div className="relative">
              <SessionIcon
                className={cn(
                  'h-3.5 w-3.5',
                  isBusy ? 'text-blue-500' : item.hasTab ? 'text-success' : 'text-muted-foreground'
                )}
              />
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'text-sm truncate',
                  isActiveTab ? 'font-medium' : ''
                )}
              >
                {item.title}
              </span>
              {item.archived && (
                <Archive className="h-3 w-3 text-muted-foreground/70" aria-label="Archived session" />
              )}
            </div>
            {item.subtitle && showProjectBadge && (
              <div className="text-2xs text-muted-foreground truncate">
                {item.subtitle}
              </div>
            )}
          </div>

          {/* Timestamp */}
          <span className="text-2xs text-muted-foreground/60 flex-shrink-0">
            {formatRelativeTime(item.timestamp)}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <div>{sessionLabel}: {item.title}</div>
        <div className="text-muted-foreground">{item.subtitle || item.projectPath || sessionLabel}</div>
      </TooltipContent>
    </Tooltip>
  )
}, areSidebarItemPropsEqual)
