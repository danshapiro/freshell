import { useCallback, useEffect, useMemo, useState } from 'react'
import { nanoid } from 'nanoid'
import { api } from '@/lib/api'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { addTab, setActiveTab, updateTab } from '@/store/tabsSlice'
import { initLayout, updatePaneTitleByTerminalId } from '@/store/panesSlice'
import { receiveSessionNames } from '@/store/sessionNamesSlice'
import { parseSessionNameUpdate } from '@/lib/session-names'
import { isScopedSessionRow, selectSessionDisplayName, selectSessionNativeSync } from '@/store/selectors/sessionNameSelectors'
import type { SessionNameRecord, SessionNameRef } from '@shared/session-names'
import type { AppDispatch } from '@/store/store'
import { getWsClient } from '@/lib/ws-client'
import { collectTerminalIds } from '@/lib/pane-utils'
import { cn } from '@/lib/utils'
import { RefreshCw, Circle, Play, Pencil, Trash2, Sparkles, ExternalLink } from 'lucide-react'
import { ContextIds } from '@/components/context-menu/context-menu-constants'
import { isRetainedManagedTerminal, managedTerminalPaneStatus, managedTerminalProjection } from '@/lib/managed-terminal.js'
import ManagedTerminalRecoveryDetails from './ManagedTerminalRecoveryDetails.js'
import type { BackgroundTerminal } from '@/store/types'

type TerminalOverview = BackgroundTerminal & {
  terminalId: string
  title: string
  description?: string
  createdAt: number
  lastActivityAt: number
  hasClients: boolean
  cwd?: string
  /** Unified agent names (Task 1/2 projection): the terminal's naming
   * identity and its last-known canonical record. */
  nameRef?: SessionNameRef
  sessionName?: SessionNameRecord
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

/**
 * Shared TerminalCard rename handler: PATCH the terminal metadata (the server
 * cascades a coding-CLI title to its session override) AND mirror the new
 * title into any open pane. The server sweep is structurally blind post-PATCH
 * (registry == override → no mismatch → no terminal.title.updated push), so
 * the client must do the pane mirroring itself. This is a user rename →
 * setByUser: true (Scope Decision 3).
 *
 * Unified agent names (Task 5): a SCOPED coding-agent terminal routes through
 * the same PATCH with explicit user intent (+ the captured revision when the
 * row carries a record); the server targets the ONE canonical session name,
 * the accepted record folds into the canonical cache, and NO local
 * pane/tab user-flag write fires. Shell/other terminals keep the legacy
 * override path unchanged.
 */
export async function renameOverviewTerminal(input: {
  dispatch: AppDispatch
  terminalId: string
  title: string
  description: string
  scoped?: {
    ifRevision?: number
  }
}): Promise<void> {
  const { dispatch, terminalId, title, description, scoped } = input
  if (scoped) {
    const response = await api.patch<{ sessionName?: unknown }>(`/api/terminals/${encodeURIComponent(terminalId)}`, {
      titleOverride: title || undefined,
      descriptionOverride: description || undefined,
      nameIntent: 'user',
      ...(scoped.ifRevision !== undefined ? { ifRevision: scoped.ifRevision } : {}),
    })
    const accepted = parseSessionNameUpdate(response?.sessionName)
    if (accepted) dispatch(receiveSessionNames([accepted]))
    return
  }
  await api.patch(`/api/terminals/${encodeURIComponent(terminalId)}`, {
    titleOverride: title || undefined,
    descriptionOverride: description || undefined,
  })
  if (title) {
    dispatch(updatePaneTitleByTerminalId({ terminalId, title, setByUser: true }))
  }
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
  const paneLayouts = useAppSelector((s) => s.panes.layouts)

  const ws = useMemo(() => getWsClient(), [])

  const findTabByTerminalId = useCallback((terminalId: string) => {
    for (const tab of tabs) {
      const layout = paneLayouts[tab.id]
      if (layout && collectTerminalIds(layout).includes(terminalId)) {
        return tab
      }
    }
    return undefined
  }, [tabs, paneLayouts])

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
      if (['terminals.changed', 'terminal.exit', 'terminal.detached', 'terminal.attach.ready'].includes(msg.type)) {
        refresh()
      }
    })
    return () => unsub()
  }, [ws])

  const runningTerminals = items.filter((t) => t.status === 'running')
  const attachableTerminals = items.filter((t) => t.status !== 'exited' && (t.status === 'running' || isRetainedManagedTerminal(t)))
  const exitedTerminals = items.filter((t) => t.status === 'exited')

  const openTerminal = (terminal: TerminalOverview) => {
    const existing = findTabByTerminalId(terminal.terminalId)
    if (existing) {
      dispatch(setActiveTab(existing.id))
    } else {
      const tabId = nanoid()
      const status = managedTerminalPaneStatus(terminal, terminal.status === 'exited' ? 'exited' : 'running')
      const mode = isRetainedManagedTerminal(terminal) ? terminal.mode : 'shell'
      dispatch(addTab({ id: tabId, title: terminal.title, status, mode,
        ...(isRetainedManagedTerminal(terminal) ? {
          initialCwd: terminal.cwd, sessionRef: terminal.sessionRef,
          ...managedTerminalProjection(terminal),
        } : {}),
      }))
      dispatch(initLayout({ tabId, content: {
        kind: 'terminal', mode, terminalId: terminal.terminalId, status,
        ...(isRetainedManagedTerminal(terminal) ? {
          initialCwd: terminal.cwd, sessionRef: terminal.sessionRef,
          ...managedTerminalProjection(terminal),
        } : {}),
      } }))
    }
    onOpenTab?.()
  }

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
          {attachableTerminals.length > 0 && (
            <div>
              <h2 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-2">
                <Circle className="h-2 w-2 fill-success text-success" />
                {attachableTerminals.length === runningTerminals.length ? 'Running' : 'Terminals'}
              </h2>
              <div className="space-y-2">
                {attachableTerminals
                  .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
                  .map((t) => (
                    <TerminalCard
                      key={t.terminalId}
                      terminal={t}
                      isOpen={!!findTabByTerminalId(t.terminalId)}
                      onOpen={() => openTerminal(t)}
                      onRename={async (title, description) => {
                        const scoped = terminalCardScopedRename(t)
                        await renameOverviewTerminal({
                          dispatch,
                          terminalId: t.terminalId,
                          title,
                          description,
                          ...(scoped ? { scoped } : {}),
                        })
                        if (!scoped) {
                          const existing = findTabByTerminalId(t.terminalId)
                          if (existing && title) {
                            dispatch(updateTab({ id: existing.id, updates: { title } }))
                          }
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
                      isOpen={!!findTabByTerminalId(t.terminalId)}
                      onOpen={() => openTerminal(t)}
                      onRename={async (title, description) => {
                        const scoped = terminalCardScopedRename(t)
                        await renameOverviewTerminal({
                          dispatch,
                          terminalId: t.terminalId,
                          title,
                          description,
                          ...(scoped ? { scoped } : {}),
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

/**
 * Unified agent names (Task 5): the Overview rename's scoped capture — the
 * row's nameRef proves the server holds a naming binding for a scoped mode,
 * and the row's record revision becomes the editor's captured revision. A
 * scoped blank title is never sent (a saved name is never cleared).
 */
function terminalCardScopedRename(
  terminal: TerminalOverview,
): { ifRevision?: number } | undefined {
  if (
    !terminal.nameRef
    || !isScopedSessionRow(terminal.mode === 'shell' ? undefined : terminal.mode)
  ) {
    return undefined
  }
  const ifRevision = terminal.sessionName?.revision
  return ifRevision !== undefined ? { ifRevision } : {}
}

/**
 * A scoped coding-agent terminal's ROW fallback display: the row's
 * last-known canonical record. The card's rendered display resolves through
 * the live canonical cache by the row's `nameRef` FIRST (mirroring the
 * sidebar/history row selectors), with this record as the fallback — so a
 * rename converges the card the moment the cache folds, before any
 * directory refetch. The terminal-level title stays visible only for
 * out-of-scope terminals.
 */
function terminalCardDisplayName(terminal: TerminalOverview): string {
  if (
    terminal.nameRef
    && terminal.sessionName?.name
    && isScopedSessionRow(terminal.mode === 'shell' ? undefined : terminal.mode)
  ) {
    return terminal.sessionName.name
  }
  return terminal.title
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
  // Unified agent names (Task 5): a scoped card resolves its display and
  // its native writeback status through the LIVE canonical cache by the
  // row's nameRef (the row's last-known record is the display fallback) —
  // a rename or a status push converges the card the moment the cache
  // folds, with no directory refetch.
  const liveCacheName = useAppSelector((s) => (
    terminal.nameRef && isScopedSessionRow(terminal.mode === 'shell' ? undefined : terminal.mode)
      ? selectSessionDisplayName(s, terminal.nameRef, '')
      : ''
  ))
  const nativeSyncStatus = useAppSelector((s) => (
    terminal.nameRef ? selectSessionNativeSync(s, terminal.nameRef) : undefined
  ))
  const displayName = liveCacheName || terminalCardDisplayName(terminal)
  const [title, setTitle] = useState(displayName)
  const [desc, setDesc] = useState(terminal.description || '')
  const [showActions, setShowActions] = useState(false)
  const [generating, setGenerating] = useState(false)

  useEffect(() => {
    // A row identity change (e.g. a refresh tick landing mid-edit) must
    // never wipe the form while the user is editing; the editor reseeds
    // from the current display when it closes.
    if (editing) return
    setTitle(displayName)
    setDesc(terminal.description || '')
  }, [displayName, terminal.description, editing])

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
              setTitle(displayName)
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
      aria-label={`Open terminal ${displayName}`}
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
            <h3 className="font-medium text-sm">{displayName}</h3>
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

          <ManagedTerminalRecoveryDetails terminal={terminal} />

          {nativeSyncStatus && nativeSyncStatus.status !== 'synced' ? (
            <div
              className="mt-1 text-2xs text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              Native sync: {nativeSyncStatus.status}
              {nativeSyncStatus.reason ? ` — ${nativeSyncStatus.reason}` : ''}
            </div>
          ) : null}

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
