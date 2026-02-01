import { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal, History, Settings, LayoutGrid, Search, Play, Loader2, X } from 'lucide-react'
import { List, type RowComponentProps } from 'react-window'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { addTab, setActiveTab } from '@/store/tabsSlice'
import { getWsClient } from '@/lib/ws-client'
import { searchSessions, type SearchResult } from '@/lib/api'
import { getProviderLabel } from '@/lib/coding-cli-utils'
import type { BackgroundTerminal, CodingCliProviderName } from '@/store/types'
import { makeSelectSortedSessionItems, type SidebarSessionItem } from '@/store/selectors/sidebarSelectors'

export type AppView = 'terminal' | 'sessions' | 'overview' | 'settings'

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
}: {
  view: AppView
  onNavigate: (v: AppView) => void
  width?: number
}) {
  const dispatch = useAppDispatch()
  const settings = useAppSelector((s) => s.settings.settings)
  const tabs = useAppSelector((s) => s.tabs.tabs)
  const activeTabId = useAppSelector((s) => s.tabs.activeTabId)
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
  const refresh = () => {
    const requestId = `list-${Date.now()}`
    requestIdRef.current = requestId
    ws.send({ type: 'terminal.list', requestId })
  }

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
  }, [ws])

  // Backend search for non-title tiers
  useEffect(() => {
    if (!filter.trim() || searchTier === 'title') {
      setSearchResults(null)
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
          cwd: result.cwd,
          hasTab: existing?.hasTab ?? false,
          tabLastInputAt: existing?.tabLastInputAt,
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

  const handleItemClick = (item: SessionItem) => {
    const provider = item.provider as CodingCliProviderName
    if (item.isRunning && item.runningTerminalId) {
      // Session is running - check if tab with this terminal already exists
      const existingTab = tabs.find((t) => t.terminalId === item.runningTerminalId)
      if (existingTab) {
        dispatch(setActiveTab(existingTab.id))
      } else {
        // Create new tab to attach to the running terminal
        dispatch(addTab({
          title: item.title,
          terminalId: item.runningTerminalId,
          status: 'running',
          mode: provider,
          codingCliProvider: provider,
          resumeSessionId: item.sessionId,
        }))
      }
    } else {
      // Session not running - check if tab with this session already exists
      const existingTab = tabs.find((t) =>
        t.resumeSessionId === item.sessionId && (t.codingCliProvider || t.mode) === provider
      )
      if (existingTab) {
        dispatch(setActiveTab(existingTab.id))
      } else {
        // Create new tab to resume the session
        dispatch(addTab({
          title: item.title,
          mode: provider,
          codingCliProvider: provider,
          initialCwd: item.cwd,
          resumeSessionId: item.sessionId
        }))
      }
    }
    onNavigate('terminal')
  }

  const nav = [
    { id: 'terminal' as const, label: 'Terminal', icon: Terminal, shortcut: 'T' },
    { id: 'sessions' as const, label: 'Sessions', icon: History, shortcut: 'S' },
    { id: 'overview' as const, label: 'Overview', icon: LayoutGrid, shortcut: 'O' },
    { id: 'settings' as const, label: 'Settings', icon: Settings, shortcut: ',' },
  ]

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const activeProvider = activeTab?.codingCliProvider || (activeTab?.mode !== 'shell' ? activeTab?.mode : undefined)
  const activeSessionKey = activeTab?.resumeSessionId && activeProvider
    ? `${activeProvider}:${activeTab.resumeSessionId}`
    : null
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
      className="h-full flex flex-col bg-card flex-shrink-0 transition-[width] duration-150"
      style={{ width: `${width}px` }}
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
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
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
                  'flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs transition-colors',
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
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2 px-2 py-2 rounded-md text-left transition-colors group',
        isActiveTab
          ? 'bg-muted'
          : 'hover:bg-muted/50'
      )}
    >
      {/* Status indicator */}
      <div className="flex-shrink-0">
        {item.hasTab ? (
          <div className="relative">
            <Play className="h-2.5 w-2.5 fill-success text-success" />
            <div className="absolute inset-0 h-2.5 w-2.5 rounded-full bg-success/30 animate-pulse-subtle" />
          </div>
        ) : (
          <div
            className="h-2 w-2 rounded-sm"
            style={{ backgroundColor: item.projectColor || '#6b7280' }}
          />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  'text-sm truncate',
                  isActiveTab ? 'font-medium' : ''
                )}
              >
                {item.title}
              </span>
            </TooltipTrigger>
            <TooltipContent>{item.title}</TooltipContent>
          </Tooltip>
          <span className="text-2xs text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded">
            {getProviderLabel(item.provider)}
          </span>
        </div>
        {item.subtitle && showProjectBadge && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="text-2xs text-muted-foreground truncate">
                {item.subtitle}
              </div>
            </TooltipTrigger>
            <TooltipContent>{item.subtitle}</TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Timestamp */}
      <span className="text-2xs text-muted-foreground/60 flex-shrink-0">
        {formatRelativeTime(item.timestamp)}
      </span>
    </button>
  )
}
