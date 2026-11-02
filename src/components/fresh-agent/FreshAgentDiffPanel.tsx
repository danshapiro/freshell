import { useCallback, useEffect, useState } from 'react'
import { ChevronRight, MessageSquarePlus } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import { FreshAgentDiffDrawer } from './FreshAgentDiffDrawer.js'

export type DiffSummary = { id: string; path?: string; title?: string; status?: string; diff?: string }

/** Git quotes escape UTF-8 bytes with octal escapes, not JavaScript escapes. */
function decodeGitPath(value: string): string | null {
  if (!value.startsWith('"')) return value
  if (!value.endsWith('"')) return null
  const escapes: Record<string, string> = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '"': '"', '\\': '\\' }
  try {
    const encoded = (value.slice(1, -1).match(/\\(?:[0-7]{1,3}|.)|[^\\]+/g) ?? []).map((part) => {
      if (!part.startsWith('\\')) return encodeURIComponent(part)
      const escape = part.slice(1)
      if (/^[0-7]+$/.test(escape)) return `%${parseInt(escape, 8).toString(16).padStart(2, '0')}`
      if (!(escape in escapes)) throw new Error('Unknown Git path escape')
      return encodeURIComponent(escapes[escape])
    }).join('')
    return decodeURIComponent(encoded)
  } catch { return null }
}

/** Resolve builder header pairs without guessing at spaces inside filenames. */
function patchHeaderPaths(pair: string): { source: string; destination: string } | null {
  const tokenPattern = /^(?:"(?:\\.|[^"\\])*"|[ab]\/[^"\n]+)$/
  const candidates: { source: string; destination: string }[] = []
  // Unquoted builder paths may contain the separator itself. Consider every
  // valid split, preferring the equal-path pair emitted for ordinary edits.
  for (const separator of pair.matchAll(/ (?=b\/|")/g)) {
    const sourceToken = pair.slice(0, separator.index)
    const destinationToken = pair.slice(separator.index + 1)
    if (!tokenPattern.test(sourceToken) || !tokenPattern.test(destinationToken)) continue
    const source = decodeGitPath(sourceToken)
    const destination = decodeGitPath(destinationToken)
    if (source?.startsWith('a/') && destination?.startsWith('b/')) {
      candidates.push({ source: source.slice(2), destination: destination.slice(2) })
    }
  }
  const equalPaths = candidates.filter(({ source, destination }) => source === destination)
  return equalPaths.length === 1 ? equalPaths[0] : candidates.length === 1 ? candidates[0] : null
}

/** Supplied patches establish cardinality only when each file has an actual header. */
function patchPaths(patch: string): string[] | null {
  if (!patch.trim()) return []
  const blocks = patch.split(/^diff --git /m)
  if (blocks.length === 1 || blocks[0].trim()) return null
  const paths: string[] = []
  for (const block of blocks.slice(1)) {
    const [pair, ...lines] = block.split('\n')
    const resolved = patchHeaderPaths(pair)
    if (!resolved) return null
    let source: string | null = resolved.source
    let destination: string | null = resolved.destination
    for (const line of lines) {
      // Everything after a hunk or binary body is content, never a path.
      if (line.startsWith('@@') || line === 'GIT binary patch' || line.startsWith('Binary files ')) break
      if (line.startsWith('rename from ')) source = decodeGitPath(line.slice(12))
      if (line.startsWith('rename to ')) destination = decodeGitPath(line.slice(10))
      if (line === '+++ /dev/null') destination = null
    }
    const identity = destination ?? source
    if (!identity) return null
    paths.push(identity)
  }
  return paths
}

export function changedFileCount(diffs: DiffSummary[]): number | null {
  const structured = new Set(diffs.map((diff) => diff.path).filter((path): path is string => !!path?.trim()))
  if (structured.size) return structured.size
  const paths = new Set<string>()
  for (const summary of diffs) {
    if (summary.diff === undefined) return null
    const parsed = patchPaths(summary.diff)
    if (parsed === null) return null
    for (const path of parsed) paths.add(path)
  }
  return paths.size
}

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
                    // Keep comments discoverable by pointer and keyboard in Changes.
                    className="ml-2 shrink-0 p-1.5 text-muted-foreground hover:text-primary group-hover/line:visible sm:p-0 [@media(hover:none)]:visible"
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
type DiffPanelProps = {
  diffs: DiffSummary[]
  cwd?: string
  onComment?: (text: string) => void
  paneRoot?: HTMLElement | null
  scopeKey?: string
  hidden?: boolean
}

function ScopedDiffPanel({ diffs, cwd, onComment, paneRoot, hidden }: DiffPanelProps) {
  const [open, setOpen] = useState(false)
  const [fallbackRoot, setFallbackRoot] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (hidden || diffs.length === 0) setOpen(false)
  }, [hidden, diffs.length])
  if (diffs.length === 0) return null
  const count = changedFileCount(diffs)
  const countLabel = count === null ? 'file count unavailable' : `${count} changed file${count === 1 ? '' : 's'}`
  const comment = onComment ? (text: string) => {
    setOpen(false)
    onComment(text)
  } : undefined
  return (
    <div className="fresh-agent-diff-panel min-w-0 overflow-hidden rounded-lg border border-border/60 bg-background/70">
      <button
        type="button"
        className="fresh-agent-diff-trigger flex w-full items-center justify-between gap-2 px-3 py-2 text-xs focus-visible:outline focus-visible:outline-2"
        aria-label={`Diffs: ${countLabel}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => {
          setFallbackRoot(event.currentTarget.closest<HTMLElement>('.fresh-agent-pane'))
          setOpen(true)
        }}
      >
        <span>Diffs</span><span>{countLabel}</span>
      </button>
      {open && !hidden ? (
        <FreshAgentDiffDrawer paneRoot={paneRoot ?? fallbackRoot} onClose={() => setOpen(false)}>
          <div className="fresh-agent-diff-list space-y-1">
            {diffs.map((diff) => (
              <FreshAgentFileDiff key={diff.id} summary={diff} cwd={cwd} onComment={comment} />
            ))}
          </div>
        </FreshAgentDiffDrawer>
      ) : null}
    </div>
  )
}

export function FreshAgentDiffPanel(props: DiffPanelProps) {
  return <ScopedDiffPanel key={props.scopeKey ?? props.cwd ?? ''} {...props} />
}

export default FreshAgentDiffPanel
