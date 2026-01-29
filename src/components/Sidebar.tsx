import { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal, History, Settings, LayoutGrid, Search, Plus, Moon, Sun, Circle, Play } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { addTab, setActiveTab } from '@/store/tabsSlice'
import { updateSettingsLocal, markSaved } from '@/store/settingsSlice'
import { getWsClient } from '@/lib/ws-client'
import { api } from '@/lib/api'
import type { BackgroundTerminal, ClaudeSession, ProjectGroup } from '@/store/types'

export type AppView = 'terminal' | 'sessions' | 'overview' | 'settings'

interface UnifiedItem {
  type: 'terminal' | 'session'
  id: string
  title: string
  subtitle?: string
  projectPath?: string
  projectColor?: string
  timestamp: number
  isRunning?: boolean
  isActive?: boolean
  terminalId?: string
  sessionId?: string
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

  // Build unified list
  const unifiedItems = useMemo(() => {
    const items: UnifiedItem[] = []
    const tabsArray = tabs ?? []
    const terminalsArray = terminals ?? []
    const openTerminalIds = new Set(tabsArray.map((t) => t.terminalId).filter(Boolean))

    // Add terminals
    terminalsArray.forEach((t) => {
      items.push({
        type: 'terminal',
        id: `terminal-${t.terminalId}`,
        title: t.title,
        subtitle: t.cwd ? getProjectName(t.cwd) : undefined,
        timestamp: t.lastActivityAt || t.createdAt,
        isRunning: t.status === 'running',
        isActive: openTerminalIds.has(t.terminalId),
        terminalId: t.terminalId,
      })
    })

    // Add sessions from all projects
    const projectsArray = projects ?? []
    projectsArray.forEach((project) => {
      project.sessions.forEach((session) => {
        items.push({
          type: 'session',
          id: `session-${session.sessionId}`,
          title: session.title || session.sessionId.slice(0, 8),
          subtitle: getProjectName(project.projectPath),
          projectPath: project.projectPath,
          projectColor: project.color,
          timestamp: session.updatedAt,
          sessionId: session.sessionId,
        })
      })
    })

    return items
  }, [terminals, projects, tabs])

  // Filter items
  const filteredItems = useMemo(() => {
    if (!filter.trim()) return unifiedItems
    const q = filter.toLowerCase()
    return unifiedItems.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.subtitle?.toLowerCase().includes(q) ||
        item.projectPath?.toLowerCase().includes(q)
    )
  }, [unifiedItems, filter])

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

    // Hybrid: running terminals first, then recency
    const running = items.filter((i) => i.type === 'terminal' && i.isRunning)
    const rest = items.filter((i) => !(i.type === 'terminal' && i.isRunning))
    running.sort((a, b) => b.timestamp - a.timestamp)
    rest.sort((a, b) => b.timestamp - a.timestamp)
    return [...running, ...rest]
  }, [filteredItems, settings.sidebar?.sortMode])

  // Separate running terminals for hybrid display
  const runningTerminals = sortedItems.filter((i) => i.type === 'terminal' && i.isRunning)
  const otherItems = settings.sidebar?.sortMode === 'hybrid'
    ? sortedItems.filter((i) => !(i.type === 'terminal' && i.isRunning))
    : sortedItems

  const handleItemClick = (item: UnifiedItem) => {
    if (item.type === 'terminal' && item.terminalId) {
      const existingTab = tabs.find((t) => t.terminalId === item.terminalId)
      if (existingTab) {
        dispatch(setActiveTab(existingTab.id))
      } else {
        dispatch(addTab({ title: item.title, terminalId: item.terminalId, status: item.isRunning ? 'running' : 'exited', mode: 'shell' }))
      }
      onNavigate('terminal')
    } else if (item.type === 'session' && item.sessionId && item.projectPath) {
      dispatch(addTab({ title: item.title, mode: 'claude', initialCwd: item.projectPath, resumeSessionId: item.sessionId }))
      onNavigate('terminal')
    }
  }

  const toggleTheme = async () => {
    const newTheme = settings.theme === 'dark' ? 'light' : settings.theme === 'light' ? 'system' : 'dark'
    dispatch(updateSettingsLocal({ theme: newTheme }))
    try {
      await api.patch('/api/settings', { theme: newTheme })
      dispatch(markSaved())
    } catch {}
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
        <div className="flex items-center gap-1">
          <button
            onClick={toggleTheme}
            className="p-1.5 rounded-md hover:bg-muted transition-colors"
            title={`Theme: ${settings.theme}`}
          >
            {settings.theme === 'dark' ? (
              <Moon className="h-4 w-4 text-muted-foreground" />
            ) : (
              <Sun className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
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

      {/* Unified List */}
      <div className="flex-1 overflow-y-auto px-2">
        {/* Running terminals section (hybrid mode) */}
        {settings.sidebar?.sortMode === 'hybrid' && runningTerminals.length > 0 && (
          <div className="mb-3">
            <div className="px-2 py-1.5 text-2xs font-medium text-muted-foreground uppercase tracking-wider">
              Running
            </div>
            <div className="space-y-0.5">
              {runningTerminals.map((item) => (
                <SidebarItem
                  key={item.id}
                  item={item}
                  isActiveTab={item.terminalId === tabs.find((t) => t.id === activeTabId)?.terminalId}
                  showProjectBadge={settings.sidebar?.showProjectBadges}
                  onClick={() => handleItemClick(item)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Recent items */}
        <div>
          {settings.sidebar?.sortMode === 'hybrid' && runningTerminals.length > 0 && otherItems.length > 0 && (
            <div className="px-2 py-1.5 text-2xs font-medium text-muted-foreground uppercase tracking-wider">
              Recent
            </div>
          )}
          <div className="space-y-0.5">
            {otherItems.length === 0 && runningTerminals.length === 0 ? (
              <div className="px-2 py-8 text-center text-sm text-muted-foreground">
                No sessions yet
              </div>
            ) : (
              otherItems.map((item) => (
                <SidebarItem
                  key={item.id}
                  item={item}
                  isActiveTab={item.terminalId === tabs.find((t) => t.id === activeTabId)?.terminalId}
                  showProjectBadge={settings.sidebar?.showProjectBadges}
                  onClick={() => handleItemClick(item)}
                />
              ))
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
  item: UnifiedItem
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
        {item.type === 'terminal' ? (
          item.isRunning ? (
            <div className="relative">
              <Circle className="h-2 w-2 fill-success text-success" />
              <div className="absolute inset-0 h-2 w-2 rounded-full bg-success animate-pulse-subtle" />
            </div>
          ) : (
            <Circle className="h-2 w-2 text-muted-foreground/40" />
          )
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
          {item.type === 'terminal' && item.isRunning && (
            <Play className="h-2.5 w-2.5 text-success flex-shrink-0" />
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
  )
}
