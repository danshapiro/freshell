import { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal, History, Settings, LayoutGrid, Search, Play } from 'lucide-react'
import { List, type RowComponentProps } from 'react-window'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { addTab, setActiveTab } from '@/store/tabsSlice'
import { getWsClient } from '@/lib/ws-client'
import type { BackgroundTerminal } from '@/store/types'
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

  // Build session list with running state from terminals
  const sortedItems = useAppSelector((state) => selectSortedItems(state, terminals, filter))

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
          mode: 'claude',
          resumeSessionId: item.sessionId,
        }))
      }
    } else {
      // Session not running - check if tab with this session already exists
      const existingTab = tabs.find((t) => t.resumeSessionId === item.sessionId)
      if (existingTab) {
        dispatch(setActiveTab(existingTab.id))
      } else {
        // Create new tab to resume the session
        dispatch(addTab({
          title: item.title,
          mode: 'claude',
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
  const activeResumeSessionId = activeTab?.resumeSessionId
  const activeTerminalId = activeTab?.terminalId
  const effectiveListHeight = listHeight > 0
    ? listHeight
    : Math.min(sortedItems.length * SESSION_ITEM_HEIGHT, SESSION_LIST_MAX_HEIGHT)

  const rowProps = useMemo(() => ({
    items: sortedItems,
    activeResumeSessionId,
    activeTerminalId,
    showProjectBadge: settings.sidebar?.showProjectBadges,
    onItemClick: handleItemClick,
  }), [sortedItems, activeResumeSessionId, activeTerminalId, settings.sidebar?.showProjectBadges, handleItemClick])

  const Row = ({ index, style, ariaAttributes, ...data }: RowComponentProps<typeof rowProps>) => {
    const item = data.items[index]
    const isActive = item.isRunning
      ? item.runningTerminalId === data.activeTerminalId
      : item.sessionId === data.activeResumeSessionId
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
            className="w-full h-8 pl-8 pr-3 text-sm bg-muted/50 border-0 rounded-md placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-border"
          />
        </div>
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
        {sortedItems.length === 0 ? (
          <div className="px-2 py-8 text-center text-sm text-muted-foreground">
            No sessions yet
          </div>
        ) : (
          <List
            defaultHeight={effectiveListHeight}
            rowCount={sortedItems.length}
            rowHeight={SESSION_ITEM_HEIGHT}
            rowComponent={Row}
            rowProps={rowProps}
            className="overflow-y-auto"
            style={{ height: effectiveListHeight, width: '100%' }}
          />
        )}
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
