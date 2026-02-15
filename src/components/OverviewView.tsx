import { useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/api'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { addTab, setActiveTab, updateTab } from '@/store/tabsSlice'
import { getWsClient } from '@/lib/ws-client'
import { cn } from '@/lib/utils'
import { RefreshCw, Circle, Play, Pencil, Trash2, Sparkles, ExternalLink } from 'lucide-react'
import { ContextIds } from '@/components/context-menu/context-menu-constants'

type TerminalOverview = {
  terminalId: string
  title: string
  description?: string
  createdAt: number
  lastActivityAt: number
  status: 'running' | 'exited'
  hasClients: boolean
  cwd?: string
}

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

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export default function OverviewView({ onOpenTab }: { onOpenTab?: () => void }) {
  const dispatch = useAppDispatch()
  const tabs = useAppSelector((s) => s.tabs.tabs)

  const ws = useMemo(() => getWsClient(), [])

  const [items, setItems] = useState<TerminalOverview[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    setLoading(true)
    setError(null)
    try {
      const data = await api.get<TerminalOverview[]>('/api/terminals')
      setItems(data ?? [])
    } catch (err: any) {
      setError(err.message || 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  useEffect(() => {
    const unsub = ws.onMessage((msg) => {
      if (['terminal.list.updated', 'terminal.exit', 'terminal.detached', 'terminal.attached'].includes(msg.type)) {
        refresh()
      }
    })
    ws.connect().catch(() => {})
    return () => unsub()
  }, [ws])

  const runningTerminals = items.filter((t) => t.status === 'running')
  const exitedTerminals = items.filter((t) => t.status === 'exited')

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 py-5 border-b border-border/30">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Panes</h1>
            <p className="text-sm text-muted-foreground">
              {runningTerminals.length} running, {exitedTerminals.length} exited
            </p>
          </div>
          <button
            onClick={refresh}
            disabled={loading}
            aria-label={loading ? 'Loading...' : 'Refresh terminals'}
            className={cn(
              'p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors',
              loading && 'animate-spin'
            )}
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-6 py-4 space-y-6">
          {error && (
            <div className="p-4 rounded-lg bg-destructive/10 text-destructive text-sm">
              {error}
            </div>
          )}

          {items.length === 0 && !loading && !error && (
            <div className="py-12 text-center">
              <p className="text-muted-foreground">No terminals tracked yet</p>
              <p className="text-sm text-muted-foreground/60 mt-1">
                Create a terminal tab to begin
              </p>
            </div>
          )}

          {/* Running terminals */}
          {runningTerminals.length > 0 && (
            <div>
              <h2 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
                <Circle className="h-2 w-2 fill-success text-success" />
                Running
              </h2>
              <div className="space-y-2">
                {runningTerminals
                  .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
                  .map((t) => (
                    <TerminalCard
                      key={t.terminalId}
                      terminal={t}
                      isOpen={tabs.some((x) => x.terminalId === t.terminalId)}
                      onOpen={() => {
                        const existing = tabs.find((x) => x.terminalId === t.terminalId)
                        if (existing) {
                          dispatch(setActiveTab(existing.id))
                          onOpenTab?.()
                          return
                        }
                        dispatch(addTab({ title: t.title, terminalId: t.terminalId, status: 'running', mode: 'shell' }))
                        onOpenTab?.()
                      }}
                      onRename={async (title, description) => {
                        await api.patch(`/api/terminals/${encodeURIComponent(t.terminalId)}`, {
                          titleOverride: title || undefined,
                          descriptionOverride: description || undefined,
                        })
                        const existing = tabs.find((x) => x.terminalId === t.terminalId)
                        if (existing && title) {
                          dispatch(updateTab({ id: existing.id, updates: { title } }))
                        }
                        await refresh()
                      }}
                      onDelete={async () => {
                        await api.delete(`/api/terminals/${encodeURIComponent(t.terminalId)}`)
                        await refresh()
                      }}
                      onGenerateSummary={async () => {
                        const res = await api.post(`/api/ai/terminals/${encodeURIComponent(t.terminalId)}/summary`, {})
                        if (res?.description) {
                          await api.patch(`/api/terminals/${encodeURIComponent(t.terminalId)}`, {
                            descriptionOverride: res.description,
                          })
                        }
                        await refresh()
                      }}
                    />
                  ))}
              </div>
            </div>
          )}

          {/* Exited terminals */}
          {exitedTerminals.length > 0 && (
            <div>
              <h2 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
                <Circle className="h-2 w-2 text-muted-foreground/40" />
                Exited
              </h2>
              <div className="space-y-2">
                {exitedTerminals
                  .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
                  .map((t) => (
                    <TerminalCard
                      key={t.terminalId}
                      terminal={t}
                      isOpen={tabs.some((x) => x.terminalId === t.terminalId)}
                      onOpen={() => {
                        const existing = tabs.find((x) => x.terminalId === t.terminalId)
                        if (existing) {
                          dispatch(setActiveTab(existing.id))
                          onOpenTab?.()
                          return
                        }
                        dispatch(addTab({ title: t.title, terminalId: t.terminalId, status: 'exited', mode: 'shell' }))
                        onOpenTab?.()
                      }}
                      onRename={async (title, description) => {
                        await api.patch(`/api/terminals/${encodeURIComponent(t.terminalId)}`, {
                          titleOverride: title || undefined,
                          descriptionOverride: description || undefined,
                        })
                        await refresh()
                      }}
                      onDelete={async () => {
                        await api.delete(`/api/terminals/${encodeURIComponent(t.terminalId)}`)
                        await refresh()
                      }}
                      onGenerateSummary={async () => {
                        const res = await api.post(`/api/ai/terminals/${encodeURIComponent(t.terminalId)}/summary`, {})
                        if (res?.description) {
                          await api.patch(`/api/terminals/${encodeURIComponent(t.terminalId)}`, {
                            descriptionOverride: res.description,
                          })
                        }
                        await refresh()
                      }}
                    />
                  ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function TerminalCard({
  terminal,
  isOpen,
  onOpen,
  onRename,
  onDelete,
  onGenerateSummary,
}: {
  terminal: TerminalOverview
  isOpen: boolean
  onOpen: () => void
  onRename: (title: string, description: string) => void
  onDelete: () => void
  onGenerateSummary: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(terminal.title)
  const [desc, setDesc] = useState(terminal.description || '')
  const [showActions, setShowActions] = useState(false)
  const [generating, setGenerating] = useState(false)

  useEffect(() => {
    setTitle(terminal.title)
    setDesc(terminal.description || '')
  }, [terminal.title, terminal.description])

  const handleGenerateSummary = async () => {
    setGenerating(true)
    try {
      await onGenerateSummary()
    } finally {
      setGenerating(false)
    }
  }

  const idleTime = Date.now() - terminal.lastActivityAt

  if (editing) {
    return (
      <div className="rounded-lg border border-border/50 bg-card p-4 space-y-3">
        <input
          className="w-full h-9 px-3 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-border"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title"
          aria-label="Terminal title"
        />
        <textarea
          className="w-full h-20 px-3 py-2 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-border resize-none"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="Description"
          aria-label="Terminal description"
        />
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              onRename(title, desc)
              setEditing(false)
            }}
            className="h-8 px-4 text-sm font-medium rounded-md bg-foreground text-background hover:opacity-90 transition-opacity"
          >
            Save
          </button>
          <button
            onClick={() => {
              setTitle(terminal.title)
              setDesc(terminal.description || '')
              setEditing(false)
            }}
            className="h-8 px-4 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      className="group w-full text-left rounded-lg border border-border/50 bg-card p-4 hover:border-border transition-colors cursor-pointer"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
      role="button"
      tabIndex={0}
      aria-label={`Open terminal ${terminal.title}`}
      data-context={ContextIds.OverviewTerminal}
      data-terminal-id={terminal.terminalId}
    >
      <div className="flex items-start gap-4">
        {/* Status */}
        <div className="pt-1">
          {terminal.status === 'running' ? (
            <div className="relative">
              <Circle className="h-2.5 w-2.5 fill-success text-success" />
              <div className="absolute inset-0 h-2.5 w-2.5 rounded-full bg-success animate-pulse-subtle" />
            </div>
          ) : (
            <Circle className="h-2.5 w-2.5 text-muted-foreground/40" />
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-medium text-sm">{terminal.title}</h3>
            {isOpen && (
              <span className="text-2xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                open
              </span>
            )}
            {terminal.hasClients && !isOpen && (
              <span className="text-2xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                attached
              </span>
            )}
          </div>

          {terminal.description ? (
            <p className="mt-1 text-sm text-muted-foreground line-clamp-2">
              {terminal.description}
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground/50 italic">
              No description
            </p>
          )}

          <div className="mt-2 flex items-center gap-3 text-2xs text-muted-foreground">
            {terminal.cwd && (
              <span className="truncate max-w-[12.5rem]">{terminal.cwd}</span>
            )}
            <span>Created {formatTime(terminal.createdAt)}</span>
            <span>Idle {formatDuration(idleTime)}</span>
          </div>
        </div>

        {/* Actions */}
        <div
          className={cn(
            'flex items-center gap-1 transition-opacity',
            showActions ? 'opacity-100' : 'opacity-0'
          )}
          onClick={(e) => e.stopPropagation()}
          role="presentation"
        >
          <button
            onClick={onOpen}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            aria-label={isOpen ? 'Focus terminal' : 'Open terminal'}
          >
            {isOpen ? <ExternalLink className="h-4 w-4" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}
          </button>
          <button
            onClick={() => setEditing(true)}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            aria-label="Edit terminal"
          >
            <Pencil className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            onClick={handleGenerateSummary}
            disabled={generating}
            className={cn(
              'p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors',
              generating && 'animate-pulse'
            )}
            aria-label={generating ? 'Generating summary...' : 'Generate summary with AI'}
          >
            <Sparkles className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            onClick={onDelete}
            className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
            aria-label="Delete terminal"
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  )
}
