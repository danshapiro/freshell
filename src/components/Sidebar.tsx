import { memo, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { Terminal, Folder, Settings, LayoutGrid, Search, Loader2, X, Archive, PanelLeftClose, AlertCircle } from 'lucide-react'
import { List, type RowComponentProps } from 'react-window'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { useAppDispatch, useAppSelector, useAppStore } from '@/store/hooks'
import { openSessionTab, setActiveTab } from '@/store/tabsSlice'
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

const EMPTY_TERMINALS: BackgroundTerminal[] = []

/** Compare two BackgroundTerminal arrays by sidebar-relevant fields only.
 *  Ignores lastActivityAt since it changes frequently but doesn't affect rendering. */
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

export type AppView = 'terminal' | 'tabs' | 'sessions' | 'overview' | 'settings'

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
      ai.timestamp !== bi.timestamp
    ) return false
  }
  return true
}

const SESSION_ITEM_HEIGHT = 56
const SESSION_LIST_MAX_HEIGHT = 600

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
    a.ratchetedActivity === b.ratchetedActivity &&
    a.hasTitle === b.hasTitle &&
    a.isSubagent === b.isSubagent &&
    a.isNonInteractive === b.isNonInteractive &&
    a.firstUserMessage === b.firstUserMessage
  )
}

interface SidebarRowProps {
  items: SessionItem[]
  activeSessionKey: string | null
  activeTerminalId: string | undefined
  showProjectBadge: boolean | undefined
  onItemClick: (item: SessionItem) => void
  timestampTick: number
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

/** Row component defined at module scope for stable identity — prevents react-window
 *  from unmounting/remounting all visible rows on every parent re-render. */
export const SidebarRow = ({ index, style, ariaAttributes, ...data }: RowComponentProps<SidebarRowProps>) => {
  const item = data.items[index]
  const sessionKey = `${item.provider}:${item.sessionId}`
  const isActive = computeIsActive({
    isRunning: item.isRunning,
    runningTerminalId: item.runningTerminalId,
    sessionKey,
    activeSessionKey: data.activeSessionKey,
    activeTerminalId: data.activeTerminalId,
  })

  // Stable click handler: store latest callback + item in a ref so the
  // onClick function identity never changes, but always invokes current data.
  // This avoids breaking SidebarItem's React.memo on every parent re-render.
  const callbackRef = useRef({ onItemClick: data.onItemClick, item })
  callbackRef.current = { onItemClick: data.onItemClick, item }
  const onClick = useStableCallback(callbackRef)

  return (
    <div style={{ ...style, paddingBottom: 2 }} {...ariaAttributes}>
      <SidebarItem
        item={item}
        isActiveTab={isActive}
        showProjectBadge={data.showProjectBadge}
        onClick={onClick}
        timestampTick={data.timestampTick}
      />
    </div>
  )
}

/** Returns a stable function that always calls the latest onItemClick(item) from the ref. */
function useStableCallback(
  ref: MutableRefObject<{ onItemClick: (item: SessionItem) => void; item: SessionItem }>
) {
  return useCallback(() => ref.current.onItemClick(ref.current.item), [ref])
}

export default function Sidebar({
  view,
  onNavigate,
  onToggleSidebar,
  currentVersion = null,
  updateAvailable = false,
  latestVersion = null,
  onBrandClick,
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

  const hasMore = useAppSelector((s) => s.sessions.hasMore)
  const loadingMore = useAppSelector((s) => s.sessions.loadingMore)
  const oldestLoadedTimestamp = useAppSelector((s) => s.sessions.oldestLoadedTimestamp)
  const oldestLoadedSessionId = useAppSelector((s) => s.sessions.oldestLoadedSessionId)
  const sidebarWindow = useAppSelector((s) => s.sessions.windows?.sidebar)
  const topLevelSessionCount = useAppSelector((s) => s.sessions.projects?.length ?? 0)
  const terminals = useAppSelector((state) => (
    (state as any).terminalDirectory?.windows?.sidebar?.items ?? EMPTY_TERMINALS
  )) as BackgroundTerminal[]
  const [filter, setFilter] = useState('')
  const [searchTier, setSearchTier] = useState<'title' | 'userMessages' | 'fullText'>('title')
  const lastMarkedSearchQueryRef = useRef<string | null>(null)
  const listContainerRef = useRef<HTMLDivElement | null>(null)
  const [listHeight, setListHeight] = useState(0)

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
      if (sidebarWindow && lastMarkedSearchQueryRef.current !== null) {
        lastMarkedSearchQueryRef.current = null
        void dispatch(fetchSessionWindow({
          surface: 'sidebar',
          priority: 'visible',
        }) as any)
      }
      return
    }

    if (!sidebarWindow && topLevelSessionCount > 0 && searchTier === 'title') {
      return
    }

    const timeoutId = setTimeout(async () => {
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
  }, [dispatch, filter, searchTier, sidebarWindow, topLevelSessionCount])

  const localFilteredItems = useAppSelector((state) => selectSortedItems(state, terminals, sidebarWindow ? '' : filter))
  const computedItems = useMemo(() => localFilteredItems, [localFilteredItems])

  // Stabilize the array reference so react-window doesn't rebuild all row
  // elements when the selector produces new objects with identical field
  // values (e.g. an active session's updatedAt changed but no visible fields
  // differ). Individual SidebarItem updates still go through when a field
  // value actually changes — the custom memo comparator on SidebarItem
  // handles that independently.
  const sortedItems = useStableArray(computedItems, isSessionItemEqual)

  useEffect(() => {
    const container = listContainerRef.current
    if (!container) return

    const updateHeight = () => {
      const nextHeight = container.clientHeight
      if (nextHeight > 0) {
        setListHeight(() => nextHeight)
      }
    }

    updateHeight()

    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => updateHeight())
    ro.observe(container)
    return () => ro.disconnect()
  }, [])

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
    const activeLayout = currentActiveTabId ? state.panes.layouts[currentActiveTabId] : undefined
    if (!currentActiveTabId || !activeLayout) {
      dispatch(openSessionTab({
        sessionId: item.sessionId,
        title: item.title,
        cwd: item.cwd,
        provider,
        sessionType,
        terminalId: runningTerminalId,
      }))
      onNavigate('terminal')
      return
    }

    // 3. Normal: split a new pane in the current tab
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
  const effectiveListHeight = listHeight > 0
    ? listHeight
    : Math.min(sortedItems.length * SESSION_ITEM_HEIGHT, SESSION_LIST_MAX_HEIGHT)

  const loadMoreInFlightRef = useRef(false)
  const loadMoreTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleRowsRendered = useCallback(
    (_visibleRows: { startIndex: number; stopIndex: number }, allRows: { startIndex: number; stopIndex: number }) => {
      if (
        !hasMore ||
        loadMoreInFlightRef.current ||
        oldestLoadedTimestamp == null ||
        oldestLoadedSessionId == null ||
        filter.trim() // Don't load more while filtering
      ) return
      const nearBottom = allRows.stopIndex >= sortedItems.length - 10
      if (!nearBottom) return
      loadMoreInFlightRef.current = true
      void dispatch(fetchSessionWindow({
        surface: 'sidebar',
        priority: 'visible',
        append: true,
      }) as any)
      // Safety timeout: reset if response never arrives
      if (loadMoreTimeoutRef.current) clearTimeout(loadMoreTimeoutRef.current)
      loadMoreTimeoutRef.current = setTimeout(() => {
        loadMoreInFlightRef.current = false
      }, 15_000)
    },
    [hasMore, oldestLoadedTimestamp, oldestLoadedSessionId, sortedItems.length, filter, dispatch],
  )
  // Reset in-flight guard when loadingMore clears (response received)
  useEffect(() => {
    if (!loadingMore) {
      loadMoreInFlightRef.current = false
      if (loadMoreTimeoutRef.current) { clearTimeout(loadMoreTimeoutRef.current); loadMoreTimeoutRef.current = null }
    }
  }, [loadingMore])
  // Clear timeout on unmount
  useEffect(() => () => {
    if (loadMoreTimeoutRef.current) clearTimeout(loadMoreTimeoutRef.current)
  }, [])

  const rowProps: SidebarRowProps = useMemo(() => ({
    items: sortedItems,
    activeSessionKey,
    activeTerminalId,
    showProjectBadge: settings.sidebar?.showProjectBadges,
    onItemClick: handleItemClick,
    timestampTick,
  }), [sortedItems, activeSessionKey, activeTerminalId, settings.sidebar?.showProjectBadges, handleItemClick, timestampTick])

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
            className="w-full h-8 pl-8 pr-8 text-sm bg-muted/50 border-0 rounded-md placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-border"
          />
          {filter && (
            <button
              aria-label="Clear search"
              onClick={() => setFilter('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 min-h-11 min-w-11 md:min-h-0 md:min-w-0 flex items-center justify-center rounded hover:bg-muted text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
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
      <div ref={listContainerRef} className="flex-1 px-2">
        {sidebarWindow?.loading && filter.trim() && (
          <div className="flex items-center justify-center py-8" data-testid="search-loading">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">Searching...</span>
          </div>
        )}
        {!sidebarWindow?.loading && sortedItems.length === 0 ? (
          <div className="px-2 py-8 text-center text-sm text-muted-foreground">
            {filter.trim() && searchTier !== 'title'
              ? 'No results found'
              : filter.trim()
              ? 'No matching sessions'
              : 'No sessions yet'}
          </div>
        ) : !sidebarWindow?.loading ? (
          <List
            defaultHeight={effectiveListHeight}
            rowCount={sortedItems.length}
            rowHeight={SESSION_ITEM_HEIGHT}
            rowComponent={SidebarRow}
            rowProps={rowProps}
            onRowsRendered={handleRowsRendered}
            className="overflow-y-auto"
            style={{ height: effectiveListHeight, width: '100%' }}
          />
        ) : null}
      </div>

    </div>
  )
}

interface SidebarItemProps {
  item: SessionItem
  isActiveTab?: boolean
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
    a.projectPath === b.projectPath
  )
}

export const SidebarItem = memo(function SidebarItem(props: SidebarItemProps) {
  const { item, isActiveTab, showProjectBadge, onClick } = props
  const extensionEntries = useAppSelector((s) => s.extensions?.entries)
  const terminalIds = item.runningTerminalIds
  const isBusy = useAppSelector((s) => {
    if (!item.hasTab || !terminalIds?.length) return false
    const byTerminalId = s.codexActivity?.byTerminalId
    if (!byTerminalId) return false
    return terminalIds.some((tid) => byTerminalId[tid]?.phase === 'busy')
  })
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
