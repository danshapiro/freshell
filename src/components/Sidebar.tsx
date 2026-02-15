import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Terminal, History, Settings, LayoutGrid, Search, Loader2, X, Archive } from 'lucide-react'
import { List, type RowComponentProps } from 'react-window'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { useAppDispatch, useAppSelector, useAppStore } from '@/store/hooks'
import { openSessionTab, setActiveTab } from '@/store/tabsSlice'
import { addPane, setActivePane } from '@/store/panesSlice'
import { findPaneForSession } from '@/lib/session-utils'
import { getWsClient } from '@/lib/ws-client'
import { searchSessions, type SearchResult } from '@/lib/api'
import { getProviderLabel } from '@/lib/coding-cli-utils'
import type { BackgroundTerminal, CodingCliProviderName } from '@/store/types'
import { makeSelectSortedSessionItems, type SidebarSessionItem } from '@/store/selectors/sidebarSelectors'
import { ContextIds } from '@/components/context-menu/context-menu-constants'
import { ProviderIcon } from '@/components/icons/provider-icons'
import { getActiveSessionRefForTab } from '@/lib/session-utils'

export type AppView = 'terminal' | 'tabs' | 'sessions' | 'overview' | 'settings'

type SessionItem = SidebarSessionItem

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

function getProjectName(projectPath: string): string {
  const parts = projectPath.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || projectPath
}

export default function Sidebar({
  view,
  onNavigate,
  width = 288,
  fullWidth = false,
}: {
  view: AppView
  onNavigate: (v: AppView) => void
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

  const ws = useMemo(() => getWsClient(), [])
  const [terminals, setTerminals] = useState<BackgroundTerminal[]>([])
  const [filter, setFilter] = useState('')
  const [searchTier, setSearchTier] = useState<'title' | 'userMessages' | 'fullText'>('title')
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null)
  const [isSearching, setIsSearching] = useState(false)
  const requestIdRef = useRef<string | null>(null)
  const listContainerRef = useRef<HTMLDivElement | null>(null)
  const [listHeight, setListHeight] = useState(0)

  // Fetch background terminals
  const refresh = useCallback(() => {
    const requestId = `list-${Date.now()}`
    requestIdRef.current = requestId
    ws.send({ type: 'terminal.list', requestId })
  }, [ws])

  useEffect(() => {
    ws.connect().catch(() => {})

    // Register message handler BEFORE calling refresh to avoid race condition
    const unsub = ws.onMessage((msg) => {
      if (msg.type === 'terminal.list.response' && msg.requestId === requestIdRef.current) {
        setTerminals(msg.terminals || [])
      }
      if (['terminal.detached', 'terminal.attached', 'terminal.exit', 'terminal.list.updated'].includes(msg.type)) {
        refresh()
      }
    })

    refresh()
    const interval = window.setInterval(refresh, 10000)
    return () => {
      unsub()
      window.clearInterval(interval)
    }
  }, [ws, refresh])

  // Backend search for non-title tiers
  useEffect(() => {
    if (!filter.trim() || searchTier === 'title') {
      setSearchResults(null)
      setIsSearching(false)
      return
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(async () => {
      setIsSearching(true)
      try {
        const response = await searchSessions({
          query: filter.trim(),
          tier: searchTier,
        })
        if (!controller.signal.aborted) {
          setSearchResults(response.results)
        }
      } catch (err) {
        console.error('Search failed:', err)
        if (!controller.signal.aborted) {
          setSearchResults([])
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsSearching(false)
        }
      }
    }, 300) // Debounce 300ms

    return () => {
      controller.abort()
      clearTimeout(timeoutId)
      setIsSearching(false)
    }
  }, [filter, searchTier])

  // Build session list with selector for local filtering (title tier)
  const localFilteredItems = useAppSelector((state) => selectSortedItems(state, terminals, filter))
  const allItems = useAppSelector((state) => selectSortedItems(state, terminals, ''))
  const itemsByKey = useMemo(() => {
    const map = new Map<string, SidebarSessionItem>()
    for (const item of allItems) {
      map.set(`${item.provider}:${item.sessionId}`, item)
    }
    return map
  }, [allItems])

  // Combine local and backend search results
  const sortedItems = useMemo(() => {
    // If we have backend search results, convert them to SessionItems
    if (searchResults !== null) {
      return searchResults.map((result): SessionItem => {
        const provider = (result.provider || 'claude') as CodingCliProviderName
        const key = `${provider}:${result.sessionId}`
        const existing = itemsByKey.get(key)
        return {
          id: `search-${provider}-${result.sessionId}`,
          sessionId: result.sessionId,
          provider,
          title: result.title || result.sessionId.slice(0, 8),
          subtitle: getProjectName(result.projectPath),
          projectPath: result.projectPath,
          projectColor: existing?.projectColor,
          timestamp: result.updatedAt,
          archived: result.archived,
          cwd: result.cwd,
          hasTab: existing?.hasTab ?? false,
          ratchetedActivity: existing?.ratchetedActivity,
          isRunning: existing?.isRunning ?? false,
          runningTerminalId: existing?.runningTerminalId,
        }
      })
    }

    // Otherwise use local filtering for title tier
    return localFilteredItems
  }, [itemsByKey, localFilteredItems, searchResults])

  useEffect(() => {
    const container = listContainerRef.current
    if (!container) return

    const updateHeight = () => {
      const nextHeight = container.clientHeight
      if (nextHeight > 0) {
        setListHeight(nextHeight)
      }
    }

    updateHeight()

    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => updateHeight())
    ro.observe(container)
    return () => ro.disconnect()
  }, [])

  const handleItemClick = useCallback((item: SessionItem) => {
    const provider = item.provider as CodingCliProviderName
    const state = store.getState()
    const runningTerminalId = item.isRunning ? item.runningTerminalId : undefined

    // 1. Dedup: if session is already open in a pane, focus it
    const existing = findPaneForSession(state, provider, item.sessionId)
    if (existing) {
      dispatch(setActiveTab(existing.tabId))
      if (existing.paneId) {
        dispatch(setActivePane({ tabId: existing.tabId, paneId: existing.paneId }))
      }
      onNavigate('terminal')
      return
    }

    // 2. Fallback: no active tab or active tab has no layout → create new tab
    const activeLayout = activeTabId ? state.panes.layouts[activeTabId] : undefined
    if (!activeTabId || !activeLayout) {
      dispatch(openSessionTab({
        sessionId: item.sessionId,
        title: item.title,
        cwd: item.cwd,
        provider,
        terminalId: runningTerminalId,
      }))
      onNavigate('terminal')
      return
    }

    // 3. Normal: split a new pane in the current tab
    dispatch(addPane({
      tabId: activeTabId,
      newContent: {
        kind: 'terminal',
        mode: provider,
        resumeSessionId: item.sessionId,
        initialCwd: item.cwd,
        terminalId: runningTerminalId,
        status: runningTerminalId ? 'running' : 'creating',
      },
    }))
    onNavigate('terminal')
  }, [dispatch, onNavigate, activeTabId, store])

  const nav = [
    { id: 'terminal' as const, label: 'Coding Agents', icon: Terminal, shortcut: 'T' },
    { id: 'tabs' as const, label: 'Tabs', icon: Archive, shortcut: 'A' },
    { id: 'overview' as const, label: 'Panes', icon: LayoutGrid, shortcut: 'O' },
    { id: 'sessions' as const, label: 'Projects', icon: History, shortcut: 'P' },
    { id: 'settings' as const, label: 'Settings', icon: Settings, shortcut: ',' },
  ]

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const activeSessionKey = activeSessionKeyFromPanes
  const activeTerminalId = activeTab?.terminalId
  const effectiveListHeight = listHeight > 0
    ? listHeight
    : Math.min(sortedItems.length * SESSION_ITEM_HEIGHT, SESSION_LIST_MAX_HEIGHT)

  const rowProps = useMemo(() => ({
    items: sortedItems,
    activeSessionKey,
    activeTerminalId,
    showProjectBadge: settings.sidebar?.showProjectBadges,
    onItemClick: handleItemClick,
  }), [sortedItems, activeSessionKey, activeTerminalId, settings.sidebar?.showProjectBadges, handleItemClick])

  const Row = ({ index, style, ariaAttributes, ...data }: RowComponentProps<typeof rowProps>) => {
    const item = data.items[index]
    const isActive = item.isRunning
      ? item.runningTerminalId === data.activeTerminalId
      : `${item.provider}:${item.sessionId}` === data.activeSessionKey
    return (
      <div style={{ ...style, paddingBottom: 2 }} {...ariaAttributes}>
        <SidebarItem
          item={item}
          isActiveTab={isActive}
          showProjectBadge={data.showProjectBadge}
          onClick={() => data.onItemClick(item)}
        />
      </div>
    )
  }

  return (
    <div
      className={cn(
        'h-full flex flex-col bg-card flex-shrink-0 transition-[width] duration-150',
        fullWidth && 'w-full'
      )}
      style={fullWidth ? undefined : { width: `${width}px` }}
    >
      {/* Header */}
      <div className="px-4 py-4">
        <span className="text-sm font-medium tracking-tight">Coding Agents</span>
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
        {isSearching && (
          <div className="flex items-center justify-center py-8" data-testid="search-loading">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">Searching...</span>
          </div>
        )}
        {!isSearching && sortedItems.length === 0 ? (
          <div className="px-2 py-8 text-center text-sm text-muted-foreground">
            {filter.trim() && searchTier !== 'title'
              ? 'No results found'
              : filter.trim()
              ? 'No matching sessions'
              : 'No sessions yet'}
          </div>
        ) : !isSearching ? (
          <List
            defaultHeight={effectiveListHeight}
            rowCount={sortedItems.length}
            rowHeight={SESSION_ITEM_HEIGHT}
            rowComponent={Row}
            rowProps={rowProps}
            className="overflow-y-auto"
            style={{ height: effectiveListHeight, width: '100%' }}
          />
        ) : null}
      </div>

    </div>
  )
}

function SidebarItem({
  item,
  isActiveTab,
  showProjectBadge,
  onClick,
}: {
  item: SessionItem
  isActiveTab?: boolean
  showProjectBadge?: boolean
  onClick: () => void
}) {
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
          data-running-terminal-id={item.runningTerminalId}
          data-has-tab={item.hasTab ? 'true' : 'false'}
        >
          {/* Provider icon */}
          <div className="flex-shrink-0">
            <div className={cn('relative', item.hasTab && 'animate-pulse-subtle')}>
              <ProviderIcon
                provider={item.provider}
                className={cn(
                  'h-3.5 w-3.5',
                  item.hasTab ? 'text-success' : 'text-muted-foreground'
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
        <div>{getProviderLabel(item.provider)}: {item.title}</div>
        <div className="text-muted-foreground">{item.subtitle || item.projectPath || getProviderLabel(item.provider)}</div>
      </TooltipContent>
    </Tooltip>
  )
}
