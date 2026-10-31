import { useCallback, useState } from 'react'
import { ChevronRight, MessageSquarePlus } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'

type DiffSummary = { id: string; path?: string; title?: string; status?: string; diff?: string }

/**
 * A 404 from /api/fresh-agent/diff means the connected server predates the
 * route entirely (an older Rust-server build without it) — say so explicitly
 * instead of surfacing a bare "Not found". Everything else shows the
 * server/ApiError message inline, unchanged.
 */
function mapDiffLoadError(err: unknown): string {
  if (err instanceof ApiError && err.status === 404) {
    return 'Diffs are not supported by this server.'
  }
  return err instanceof Error ? err.message : 'Failed to load diff'
}

function classifyLine(line: string): 'add' | 'del' | 'hunk' | 'meta' | 'ctx' {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) return 'meta'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'ctx'
}

function FreshAgentFileDiff({
  summary,
  cwd,
  onComment,
}: {
  summary: DiffSummary
  cwd?: string
  onComment?: (text: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [diff, setDiff] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // Prerequisites are enforced structurally: every caller must hand over a
  // present cwd + path, so no cast or in-load check is needed. The success
  // guard is one-shot; a failed load leaves diff null so the Retry
  // affordance can call load() again.
  const load = useCallback((cwd: string, path: string) => {
    if (loading || diff !== null) return
    setLoading(true)
    setError(null)
    void Promise
      .resolve(api.get<{ diff: string }>(
        `/api/fresh-agent/diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`
      ))
      .then((result) => setDiff(result?.diff ?? ''))
      .catch((err: unknown) => setError(mapDiffLoadError(err)))
      .finally(() => setLoading(false))
  }, [diff, loading])

  const label = summary.title ?? summary.path ?? summary.id
  const shownDiff = summary.diff ?? diff
  const lines = shownDiff !== null && shownDiff.trim() ? shownDiff.split('\n') : null

  return (
    <div className="fresh-agent-file-diff min-w-0 border-l-2 border-l-border text-xs">
      <button
        type="button"
        className="fresh-agent-file-diff-trigger flex min-h-[2.75rem] w-full min-w-0 items-center gap-2 rounded-r px-2 py-1 text-left transition-colors hover:bg-accent/50 sm:min-h-0"
        aria-expanded={expanded}
        aria-label={`Diff: ${label}`}
        onClick={() => {
          setExpanded((value) => !value)
          if (!expanded && summary.diff === undefined && cwd && summary.path) load(cwd, summary.path)
        }}
      >
        <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', expanded && 'rotate-90')} />
        <span className="fresh-agent-file-diff-label min-w-0 flex-1 truncate font-mono">{label}</span>
        {summary.status ? <span className="fresh-agent-file-diff-status ml-auto shrink-0 text-muted-foreground">{summary.status}</span> : null}
      </button>
      {expanded ? (
        <div className="fresh-agent-file-diff-body mt-1 overflow-x-auto rounded border border-border/60 bg-background/70 font-mono text-[11px] leading-5">
          {summary.diff === undefined && loading ? <div className="px-3 py-2 text-muted-foreground">Loading diff…</div> : null}
          {summary.diff === undefined && error ? (
            <div className="px-3 py-2 text-destructive">
              {error}{' '}
              {cwd && summary.path ? (
                <button
                  type="button"
                  aria-label="Retry loading diff"
                  className="underline hover:text-destructive/80"
                  onClick={() => {
                    if (cwd && summary.path) load(cwd, summary.path)
                  }}
                >
                  Retry
                </button>
              ) : null}
            </div>
          ) : null}
          {summary.diff === undefined && (!cwd || !summary.path) ? (
            <div className="px-3 py-2 text-muted-foreground">Diff unavailable for this file.</div>
          ) : null}
          {(summary.diff !== undefined || (!loading && !error)) && lines === null && shownDiff !== null ? (
            <div className="px-3 py-2 text-muted-foreground">{summary.diff !== undefined ? 'No changes in this turn.' : 'No uncommitted changes for this file.'}</div>
          ) : null}
          {lines?.map((line, index) => {
            const kind = classifyLine(line)
            if (kind === 'meta' && summary.diff === undefined) return null
            return (
              <div
                key={index}
                className={cn(
                  'group/line flex items-center whitespace-pre px-3',
                  kind === 'add' && 'bg-success/10 text-success',
                  kind === 'del' && 'bg-destructive/10 text-destructive',
                  kind === 'hunk' && 'bg-muted/60 text-muted-foreground',
                )}
              >
                <span className="min-w-0 flex-1 overflow-hidden text-ellipsis">{line || ' '}</span>
                {onComment && kind !== 'hunk' ? (
                  <button
                    type="button"
                    // Hover-revealed on desktop; always visible (with a real
                    // touch target) on no-hover devices.
                    className="invisible ml-2 shrink-0 p-1.5 text-muted-foreground hover:text-primary group-hover/line:visible sm:p-0 [@media(hover:none)]:visible"
                    aria-label="Comment on this line for the agent"
                    title="Comment on this line for the agent"
                    onClick={() => onComment(`On ${summary.path ?? label} at \`${line.trim()}\`: `)}
                  >
                    <MessageSquarePlus className="h-3 w-3" />
                  </button>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Provider-supplied diffs replace the displayed content directly. File-only
 * summaries load git diff from the session cwd when expanded.
 * Line comments drop a prefilled mention into the composer via onComment.
 */
export function FreshAgentDiffPanel({
  diffs,
  cwd,
  onComment,
}: {
  diffs: DiffSummary[]
  cwd?: string
  onComment?: (text: string) => void
}) {
  if (diffs.length === 0) return null
  return (
    <div className="fresh-agent-diff-panel min-w-0 overflow-hidden rounded-lg border border-border/60 bg-background/70 p-3">
      <div className="fresh-agent-diff-title mb-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Diffs</div>
      <div className="fresh-agent-diff-list space-y-1">
        {diffs.map((diff) => (
          <FreshAgentFileDiff key={diff.id} summary={diff} cwd={cwd} onComment={onComment} />
        ))}
      </div>
    </div>
  )
}

export default FreshAgentDiffPanel
