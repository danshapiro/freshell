import { useEffect, useMemo, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import type { CodingCliProviderName, CodingCliSession, ProjectGroup } from '@/store/types'
import { toggleProjectExpanded, setProjects } from '@/store/sessionsSlice'
import { api } from '@/lib/api'
import { openSessionTab } from '@/store/tabsSlice'
import { cn } from '@/lib/utils'
import { getProviderLabel } from '@/lib/coding-cli-utils'
import { useMobile } from '@/hooks/useMobile'
import { Search, ChevronRight, Play, Pencil, Trash2, RefreshCw } from 'lucide-react'
import { ContextIds } from '@/components/context-menu/context-menu-constants'

function formatTime(ts: number) {
  const now = Date.now()
  const diff = now - ts
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)

  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 7) return `${days}d ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function getProjectName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || path
}

type MobileSessionSheetState = {
  session: CodingCliSession
  onOpen: () => void
  onRename: (title?: string, summary?: string) => void
  onDelete: () => void
}

export default function HistoryView({ onOpenSession }: { onOpenSession?: () => void }) {
  const dispatch = useAppDispatch()
  const isMobile = useMobile()
  const { projects, expandedProjects } = useAppSelector((s) => s.sessions)
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [mobileSessionSheet, setMobileSessionSheet] = useState<MobileSessionSheetState | null>(null)

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return projects ?? []
    return (projects ?? [])
      .map((p) => ({
        ...p,
        sessions: p.sessions.filter((s) => {
          const title = (s.title || s.sessionId).toLowerCase()
          const sum = (s.summary || '').toLowerCase()
          const cwd = (s.cwd || '').toLowerCase()
          const provider = getProviderLabel(s.provider).toLowerCase()
          return (
            title.includes(q) ||
            sum.includes(q) ||
            p.projectPath.toLowerCase().includes(q) ||
            cwd.includes(q) ||
            provider.includes(q)
          )
        }),
      }))
      .filter((p) => p.sessions.length > 0)
  }, [projects, filter])

  async function refresh() {
    setLoading(true)
    try {
      const data = await api.get('/api/sessions')
      dispatch(setProjects(data))
    } finally {
      setLoading(false)
    }
  }

  async function setProjectColor(projectPath: string, color: string) {
    await api.put('/api/project-colors', { projectPath, color })
    await refresh()
  }

  async function renameSession(provider: CodingCliProviderName | undefined, sessionId: string, titleOverride?: string, summaryOverride?: string) {
    // Use composite key format: provider:sessionId
    const compositeKey = `${provider || 'claude'}:${sessionId}`
    await api.patch(`/api/sessions/${encodeURIComponent(compositeKey)}`, { titleOverride, summaryOverride })
    await refresh()
  }

  async function deleteSession(provider: CodingCliProviderName | undefined, sessionId: string) {
    // Use composite key format: provider:sessionId
    const compositeKey = `${provider || 'claude'}:${sessionId}`
    await api.delete(`/api/sessions/${encodeURIComponent(compositeKey)}`)
    await refresh()
  }

  function openSession(cwd: string | undefined, sessionId: string, title: string, provider: CodingCliProviderName | undefined) {
    // cwd might be undefined if session metadata didn't include it
    const label = getProviderLabel(provider)
    // TabMode now includes all CodingCliProviderName values, so this is type-safe
    const mode = (provider || 'claude') as CodingCliProviderName
    dispatch(openSessionTab({ sessionId, title: title || label, cwd, provider: mode }))
    onOpenSession?.()
  }

  const totalSessions = (projects ?? []).reduce((acc, p) => acc + p.sessions.length, 0)

  useEffect(() => {
    if (!isMobile) {
      setMobileSessionSheet(null)
    }
  }, [isMobile])

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="border-b border-border/30 px-3 py-4 md:px-6 md:py-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Projects</h1>
            <p className="text-sm text-muted-foreground">
              {totalSessions} project session{totalSessions !== 1 ? 's' : ''} across {(projects ?? []).length} project{(projects ?? []).length !== 1 ? 's' : ''}
            </p>
          </div>
          <button
            onClick={refresh}
            disabled={loading}
            aria-label={loading ? 'Loading...' : 'Refresh sessions'}
            className={cn(
              'p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors',
              loading && 'animate-spin'
            )}
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search sessions, projects..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-full h-10 pl-10 pr-4 text-sm bg-muted/50 border-0 rounded-lg placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-border"
          />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="space-y-2 px-3 py-4 md:px-6">
          {filtered.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-muted-foreground">No sessions found</p>
              {filter && (
                <button
                  onClick={() => setFilter('')}
                  className="mt-2 text-sm text-foreground hover:underline"
                >
                  Clear search
                </button>
              )}
            </div>
          ) : (
            filtered.map((project) => (
              <ProjectCard
                key={project.projectPath}
                project={project}
                expanded={expandedProjects.has(project.projectPath)}
                isMobile={isMobile}
                onToggle={() => dispatch(toggleProjectExpanded(project.projectPath))}
                onColorChange={(color) => setProjectColor(project.projectPath, color)}
                  onOpenSession={(sessionId, title, cwd, provider) => openSession(cwd, sessionId, title, provider)}
                onRenameSession={(provider, sessionId, title, summary) => renameSession(provider, sessionId, title, summary)}
                onDeleteSession={(provider, sessionId) => deleteSession(provider, sessionId)}
                onShowSessionDetails={(sheetState) => setMobileSessionSheet(sheetState)}
              />
            ))
          )}
        </div>
      </div>
      {isMobile && mobileSessionSheet && (
        <MobileSessionDetailsSheet
          session={mobileSessionSheet.session}
          onClose={() => setMobileSessionSheet(null)}
          onOpen={() => {
            mobileSessionSheet.onOpen()
            setMobileSessionSheet(null)
          }}
          onRename={mobileSessionSheet.onRename}
          onDelete={() => {
            mobileSessionSheet.onDelete()
            setMobileSessionSheet(null)
          }}
        />
      )}
    </div>
  )
}

function ProjectCard({
  project,
  expanded,
  isMobile,
  onToggle,
  onColorChange,
  onOpenSession,
  onRenameSession,
  onDeleteSession,
  onShowSessionDetails,
}: {
  project: ProjectGroup
  expanded: boolean
  isMobile: boolean
  onToggle: () => void
  onColorChange: (color: string) => void
  onOpenSession: (sessionId: string, title: string, cwd?: string, provider?: CodingCliProviderName) => void
  onRenameSession: (provider: CodingCliProviderName | undefined, sessionId: string, title?: string, summary?: string) => void
  onDeleteSession: (provider: CodingCliProviderName | undefined, sessionId: string) => void
  onShowSessionDetails: (sheetState: MobileSessionSheetState) => void
}) {
  const color = project.color || '#6b7280'
  const [showColorPicker, setShowColorPicker] = useState(false)

  return (
    <div className="rounded-lg border border-border/50 bg-card overflow-hidden">
      {/* Project header */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/50 transition-colors"
        data-context={ContextIds.HistoryProject}
        data-project-path={project.projectPath}
      >
        <div
          className="h-3 w-3 rounded-sm flex-shrink-0"
          style={{ backgroundColor: color }}
        />
        <div className="flex-1 text-left min-w-0">
          <div className="font-medium text-sm truncate">{getProjectName(project.projectPath)}</div>
          <div className="text-2xs text-muted-foreground truncate">{project.projectPath}</div>
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">
          {project.sessions.length}
        </span>
        <ChevronRight
          className={cn(
            'h-4 w-4 text-muted-foreground transition-transform',
            expanded && 'rotate-90'
          )}
        />
      </button>

      {/* Sessions */}
      {expanded && (
        <div className="border-t border-border/30">
          {/* Color picker */}
          <div className="px-4 py-2 flex items-center gap-2 border-b border-border/30 bg-muted/30">
            <span className="text-2xs text-muted-foreground">Color:</span>
            <div className="relative">
              <button
                onClick={() => setShowColorPicker(!showColorPicker)}
                className="h-5 w-8 rounded border border-border/50"
                style={{ backgroundColor: color }}
                aria-label="Open color picker"
              />
              {showColorPicker && (
                <input
                  type="color"
                  value={color}
                  onChange={(e) => {
                    onColorChange(e.target.value)
                    setShowColorPicker(false)
                  }}
                  className="absolute top-full left-0 mt-1"
                  onBlur={() => setShowColorPicker(false)}
                  aria-label="Project color picker"
                />
              )}
            </div>
          </div>

          {/* Session list */}
          <div className="divide-y divide-border/30">
            {project.sessions
              .slice()
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .map((session) => (
                <SessionRow
                  key={session.sessionId}
                  isMobile={isMobile}
                  session={session}
                  onOpen={() => onOpenSession(session.sessionId, session.title || session.sessionId.slice(0, 8), session.cwd, session.provider)}
                  onRename={(title, summary) => onRenameSession(session.provider, session.sessionId, title, summary)}
                  onDelete={() => onDeleteSession(session.provider, session.sessionId)}
                  onShowDetails={() => onShowSessionDetails({
                    session,
                    onOpen: () => onOpenSession(session.sessionId, session.title || session.sessionId.slice(0, 8), session.cwd, session.provider),
                    onRename: (title, summary) => onRenameSession(session.provider, session.sessionId, title, summary),
                    onDelete: () => onDeleteSession(session.provider, session.sessionId),
                  })}
                />
              ))}
          </div>
        </div>
      )}
    </div>
  )
}

function SessionRow({
  isMobile,
  session,
  onOpen,
  onRename,
  onDelete,
  onShowDetails,
}: {
  isMobile: boolean
  session: CodingCliSession
  onOpen: () => void
  onRename: (title?: string, summary?: string) => void
  onDelete: () => void
  onShowDetails: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(session.title || '')
  const [summary, setSummary] = useState(session.summary || '')

  if (editing) {
    return (
      <div className="px-4 py-3 space-y-2">
        <input
          className="w-full h-8 px-3 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-border"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title"
          aria-label="Session title"
        />
        <input
          className="w-full h-8 px-3 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-border"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Summary"
          aria-label="Session summary"
        />
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              onRename(title || undefined, summary || undefined)
              setEditing(false)
            }}
            className="h-7 px-3 text-xs font-medium rounded-md bg-foreground text-background hover:opacity-90 transition-opacity"
          >
            Save
          </button>
          <button
            onClick={() => {
              setTitle(session.title || '')
              setSummary(session.summary || '')
              setEditing(false)
            }}
            className="h-7 px-3 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      className="group w-full px-4 py-3 hover:bg-muted/30 transition-colors rounded-md"
      data-context={ContextIds.HistorySession}
      data-session-id={session.sessionId}
      data-provider={session.provider}
    >
      <div className="flex items-start gap-3">
        <button
          type="button"
          className="flex-1 min-w-0 text-left cursor-pointer"
          onClick={isMobile ? onShowDetails : onOpen}
          aria-label={`Open session ${session.title || session.sessionId.slice(0, 8)}`}
        >
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm truncate">
              {session.title || session.sessionId.slice(0, 8)}
            </span>
            <span className="text-2xs text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded">
              {getProviderLabel(session.provider)}
            </span>
            <span className="text-2xs text-muted-foreground">
              {formatTime(session.updatedAt)}
            </span>
          </div>
          {session.summary && (
            <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
              {session.summary}
            </p>
          )}
          {session.cwd && (
            <p className="mt-1 text-2xs text-muted-foreground/60 truncate">
              {session.cwd}
            </p>
          )}
        </button>

        {/* Actions */}
        <div
          className={cn(
            'flex items-center gap-2 transition-opacity',
            isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
          )}
          role="presentation"
        >
          <button
            type="button"
            onClick={onOpen}
            className="min-h-11 min-w-11 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:min-h-0 md:min-w-0"
            aria-label="Open session"
          >
            <Play className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="min-h-11 min-w-11 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:min-h-0 md:min-w-0"
            aria-label="Edit session"
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="min-h-11 min-w-11 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive md:min-h-0 md:min-w-0"
            aria-label="Delete session"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  )
}

function MobileSessionDetailsSheet({
  session,
  onClose,
  onOpen,
  onRename,
  onDelete,
}: {
  session: CodingCliSession
  onClose: () => void
  onOpen: () => void
  onRename: (title?: string, summary?: string) => void
  onDelete: () => void
}) {
  const [title, setTitle] = useState(session.title || '')
  const [summary, setSummary] = useState(session.summary || '')

  useEffect(() => {
    setTitle(session.title || '')
    setSummary(session.summary || '')
  }, [session])

  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-40 bg-black/50"
        aria-label="Close session details"
        onClick={onClose}
      />
      <div className="fixed inset-x-0 bottom-0 z-50 rounded-t-xl border border-border bg-background p-4 shadow-xl safe-area-bottom">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Session details</h2>
          <button
            type="button"
            className="min-h-11 rounded-md px-3 text-sm text-muted-foreground"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <div className="space-y-2 text-xs text-muted-foreground">
          <div>{getProviderLabel(session.provider)}</div>
          <div>{formatTime(session.updatedAt)}</div>
          {session.cwd && <div className="truncate">{session.cwd}</div>}
        </div>
        <div className="mt-3 space-y-2">
          <input
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Session title"
            className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
            aria-label="Session details title"
          />
          <input
            type="text"
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            placeholder="Session summary"
            className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
            aria-label="Session details summary"
          />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            className="min-h-11 rounded-md border border-border px-3 text-sm font-medium"
            onClick={onOpen}
          >
            Open
          </button>
          <button
            type="button"
            className="min-h-11 rounded-md border border-border px-3 text-sm font-medium"
            onClick={() => onRename(title || undefined, summary || undefined)}
          >
            Save
          </button>
          <button
            type="button"
            className="min-h-11 rounded-md border border-destructive/50 px-3 text-sm font-medium text-destructive"
            onClick={onDelete}
          >
            Delete
          </button>
          <button
            type="button"
            className="min-h-11 rounded-md border border-border px-3 text-sm font-medium"
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </div>
    </>
  )
}
