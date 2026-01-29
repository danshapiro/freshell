import { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal, History, Settings, LayoutGrid, Search, Plus, Play } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { addTab, setActiveTab } from '@/store/tabsSlice'
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
}: {
  view: AppView
  onNavigate: (v: AppView) => void
}) {
  const dispatch = useAppDispatch()
  const settings = useAppSelector((s) => s.settings.settings)
  const projects = useAppSelector((s) => s.sessions.projects)
  const tabs = useAppSelector((s) => s.tabs.tabs)
  const activeTabId = useAppSelector((s) => s.tabs.activeTabId)

  const ws = useMemo(() => getWsClient(), [])
  const [terminals, setTerminals] = useState<BackgroundTerminal[]>([])
  const [filter, setFilter] = useState('')
  const requestIdRef = useRef<string | null>(null)

  // Fetch background terminals
  const refresh = () => {
    const requestId = `list-${Date.now()}`
    requestIdRef.current = requestId
    ws.send({ type: 'terminal.list', requestId })
  }

  useEffect(() => {
    let unsub = () => {}
    ws.connect().catch(() => {})
    refresh()

    unsub = ws.onMessage((msg) => {
      if (msg.type === 'terminal.list.response' && msg.requestId === requestIdRef.current) {
        setTerminals(msg.terminals || [])
      }
      if (['terminal.detached', 'terminal.attached', 'terminal.exit', 'terminal.list.updated'].includes(msg.type)) {
        refresh()
      }
    })

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

    // Add sessions with running state
    projectsArray.forEach((project) => {
      project.sessions.forEach((session) => {
        const runningTerminalId = runningSessionMap.get(session.sessionId)
        items.push({
          id: `session-${session.sessionId}`,
          sessionId: session.sessionId,
          title: session.title || session.sessionId.slice(0, 8),
          subtitle: getProjectName(project.projectPath),
          projectPath: project.projectPath,
          projectColor: project.color,
          timestamp: session.updatedAt,
          cwd: session.cwd,
          isRunning: !!runningTerminalId,
          runningTerminalId,
        })
      })
    })

    return items
  }, [terminals, projects])

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
    const sortMode = settings.sidebar?.sortMode || 'hybrid'
    const items = [...filteredItems]

    if (sortMode === 'recency') {
      return items.sort((a, b) => b.timestamp - a.timestamp)
    }

    if (sortMode === 'activity') {
      return items.sort((a, b) => {
        if (a.isRunning && !b.isRunning) return -1
        if (!a.isRunning && b.isRunning) return 1
        return b.timestamp - a.timestamp
      })
    }

    if (sortMode === 'project') {
      return items.sort((a, b) => {
        const projA = a.projectPath || a.subtitle || ''
        const projB = b.projectPath || b.subtitle || ''
        if (projA !== projB) return projA.localeCompare(projB)
        return b.timestamp - a.timestamp
      })
    }

    // Hybrid: running sessions first, then recency
    const running = items.filter((i) => i.isRunning)
    const rest = items.filter((i) => !i.isRunning)
    running.sort((a, b) => b.timestamp - a.timestamp)
    rest.sort((a, b) => b.timestamp - a.timestamp)
    return [...running, ...rest]
  }, [filteredItems, settings.sidebar?.sortMode])

  // Separate running sessions for hybrid display
  const runningSessions = sortedItems.filter((i) => i.isRunning)
  const otherItems = settings.sidebar?.sortMode === 'hybrid'
    ? sortedItems.filter((i) => !i.isRunning)
    : sortedItems

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
    <div className="w-72 h-full flex flex-col bg-card border-r border-border/50">
      {/* Header */}
      <div className="px-4 py-4 flex items-center justify-between">
        <span className="text-sm font-medium tracking-tight">Sessions</span>
        <button
          onClick={() => {
            dispatch(addTab({ mode: 'shell' }))
            onNavigate('terminal')
          }}
          className="p-1.5 rounded-md hover:bg-muted transition-colors"
          title="New terminal"
        >
          <Plus className="h-4 w-4 text-muted-foreground" />
        </button>
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
      <div className="flex-1 overflow-y-auto px-2">
        {/* Running sessions section (hybrid mode) */}
        {settings.sidebar?.sortMode === 'hybrid' && runningSessions.length > 0 && (
          <div className="mb-3">
            <div className="px-2 py-1.5 text-2xs font-medium text-muted-foreground uppercase tracking-wider">
              Running
            </div>
            <div className="space-y-0.5">
              {runningSessions.map((item) => {
                const activeTab = tabs.find((t) => t.id === activeTabId)
                const isActive = item.runningTerminalId === activeTab?.terminalId

                return (
                  <SidebarItem
                    key={item.id}
                    item={item}
                    isActiveTab={isActive}
                    showProjectBadge={settings.sidebar?.showProjectBadges}
                    onClick={() => handleItemClick(item)}
                  />
                )
              })}
            </div>
          </div>
        )}

        {/* Recent items */}
        <div>
          {settings.sidebar?.sortMode === 'hybrid' && runningSessions.length > 0 && otherItems.length > 0 && (
            <div className="px-2 py-1.5 text-2xs font-medium text-muted-foreground uppercase tracking-wider">
              Recent
            </div>
          )}
          <div className="space-y-0.5">
            {otherItems.length === 0 && runningSessions.length === 0 ? (
              <div className="px-2 py-8 text-center text-sm text-muted-foreground">
                No sessions yet
              </div>
            ) : (
              otherItems.map((item) => {
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

      {/* Footer */}
      <div className="px-3 py-3 border-t border-border/50">
        <button
          onClick={() => {
            dispatch(addTab({ mode: 'shell' }))
            onNavigate('terminal')
          }}
          className="w-full h-8 flex items-center justify-center gap-2 text-sm font-medium rounded-md bg-foreground text-background hover:opacity-90 transition-opacity"
        >
          <Plus className="h-3.5 w-3.5" />
          New Terminal
        </button>
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
        {item.isRunning ? (
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
          <span className={cn(
            'text-sm truncate',
            isActiveTab ? 'font-medium' : ''
          )}>
            {item.title}
          </span>
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
  )
}
