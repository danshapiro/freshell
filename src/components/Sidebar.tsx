import { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal, History, Settings, LayoutGrid, Search, Play } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { addTab, setActiveTab } from '@/store/tabsSlice'
import { selectAllSessionActivity } from '@/store/sessionActivitySlice'
import { getWsClient } from '@/lib/ws-client'
import type { BackgroundTerminal, ClaudeSession, ProjectGroup } from '@/store/types'

export type AppView = 'terminal' | 'sessions' | 'overview' | 'settings'

interface SessionItem {
  id: string
  sessionId: string
  title: string
  subtitle?: string
  projectPath?: string
  projectColor?: string
  timestamp: number
  cwd?: string
  hasTab: boolean
  tabLastInputAt?: number
  ratchetedActivity?: number
  // Running state (derived from terminals)
  isRunning: boolean
  runningTerminalId?: string
}

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

function getProjectName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || path
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
  const projects = useAppSelector((s) => s.sessions.projects)
  const tabs = useAppSelector((s) => s.tabs.tabs)
  const activeTabId = useAppSelector((s) => s.tabs.activeTabId)
  const sessionActivity = useAppSelector(selectAllSessionActivity)

  const ws = useMemo(() => getWsClient(), [])
  const [terminals, setTerminals] = useState<BackgroundTerminal[]>([])
  const [filter, setFilter] = useState('')
  const [searchTier, setSearchTier] = useState<'title' | 'userMessages' | 'fullText'>('title')
  const requestIdRef = useRef<string | null>(null)

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
  const sessionItems = useMemo(() => {
    const items: SessionItem[] = []
    const terminalsArray = terminals ?? []
    const projectsArray = projects ?? []

    // Build map: sessionId -> running terminalId
    const runningSessionMap = new Map<string, string>()
    terminalsArray.forEach((t) => {
      if (t.mode === 'claude' && t.status === 'running' && t.resumeSessionId) {
        runningSessionMap.set(t.resumeSessionId, t.terminalId)
      }
    })

    // Build map: sessionId -> tab info
    const tabSessionMap = new Map<string, { hasTab: boolean; lastInputAt?: number }>()
    tabs.forEach((t) => {
      if (!t.resumeSessionId) return
      const existing = tabSessionMap.get(t.resumeSessionId)
      if (!existing) {
        tabSessionMap.set(t.resumeSessionId, { hasTab: true, lastInputAt: t.lastInputAt })
        return
      }
      const existingTime = existing.lastInputAt ?? 0
      const nextTime = t.lastInputAt ?? 0
      if (nextTime > existingTime) {
        tabSessionMap.set(t.resumeSessionId, { hasTab: true, lastInputAt: t.lastInputAt })
      }
    })

    // Add sessions with running, tab, and ratcheted activity state
    projectsArray.forEach((project) => {
      project.sessions.forEach((session) => {
        const runningTerminalId = runningSessionMap.get(session.sessionId)
        const tabInfo = tabSessionMap.get(session.sessionId)
        const ratchetedActivity = sessionActivity[session.sessionId]
        items.push({
          id: `session-${session.sessionId}`,
          sessionId: session.sessionId,
          title: session.title || session.sessionId.slice(0, 8),
          subtitle: getProjectName(project.projectPath),
          projectPath: project.projectPath,
          projectColor: project.color,
          timestamp: session.updatedAt,
          cwd: session.cwd,
          hasTab: tabInfo?.hasTab ?? false,
          tabLastInputAt: tabInfo?.lastInputAt,
          ratchetedActivity,
          isRunning: !!runningTerminalId,
          runningTerminalId,
        })
      })
    })

    return items
  }, [terminals, projects, tabs, sessionActivity])

  // Filter items
  const filteredItems = useMemo(() => {
    if (!filter.trim()) return sessionItems
    const q = filter.toLowerCase()
    return sessionItems.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.subtitle?.toLowerCase().includes(q) ||
        item.projectPath?.toLowerCase().includes(q)
    )
  }, [sessionItems, filter])

  // Sort items based on settings
  const sortedItems = useMemo(() => {
    const sortMode = settings.sidebar?.sortMode || 'activity'
    const items = [...filteredItems]

    if (sortMode === 'recency') {
      return items.sort((a, b) => b.timestamp - a.timestamp)
    }

    if (sortMode === 'activity') {
      const withTabs = items.filter((i) => i.hasTab)
      const withoutTabs = items.filter((i) => !i.hasTab)

      withTabs.sort((a, b) => {
        const aTime = a.tabLastInputAt ?? a.timestamp
        const bTime = b.tabLastInputAt ?? b.timestamp
        return bTime - aTime
      })

      withoutTabs.sort((a, b) => {
        const aHasRatcheted = typeof a.ratchetedActivity === 'number'
        const bHasRatcheted = typeof b.ratchetedActivity === 'number'
        if (aHasRatcheted !== bHasRatcheted) return aHasRatcheted ? -1 : 1
        const aTime = a.ratchetedActivity ?? a.timestamp
        const bTime = b.ratchetedActivity ?? b.timestamp
        return bTime - aTime
      })

      return [...withTabs, ...withoutTabs]
    }

    if (sortMode === 'project') {
      return items.sort((a, b) => {
        const projA = a.projectPath || a.subtitle || ''
        const projB = b.projectPath || b.subtitle || ''
        if (projA !== projB) return projA.localeCompare(projB)
        return b.timestamp - a.timestamp
      })
    }

    return items
  }, [filteredItems, settings.sidebar?.sortMode])

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
          mode: 'claude'
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
      <div className="flex-1 overflow-y-auto px-2">
        <div className="space-y-0.5">
          {sortedItems.length === 0 ? (
            <div className="px-2 py-8 text-center text-sm text-muted-foreground">
              No sessions yet
            </div>
          ) : (
            sortedItems.map((item) => {
              const activeTab = tabs.find((t) => t.id === activeTabId)
              const isActive = item.isRunning
                ? item.runningTerminalId === activeTab?.terminalId
                : item.sessionId === activeTab?.resumeSessionId

              return (
                <SidebarItem
                  key={item.id}
                  item={item}
                  isActiveTab={isActive}
                  showProjectBadge={settings.sidebar?.showProjectBadges}
                  onClick={() => handleItemClick(item)}
                />
              )
            })
          )}
        </div>
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
