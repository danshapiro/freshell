import { RUST_BASELINE_UNAVAILABLE } from '@/lib/rust-baseline-unavailable'

type DiffSummary = { id: string; path?: string; title?: string; status?: string }


/**
 * Rust sends only summary metadata; it has no endpoint for loading full diffs.
 */
export function FreshAgentDiffPanel({
  diffs,
}: {
  diffs: DiffSummary[]
}) {
  if (diffs.length === 0) return null
  return (
    <div className="fresh-agent-diff-panel min-w-0 overflow-hidden rounded-lg border border-border/60 bg-background/70 p-3">
      <div className="fresh-agent-diff-title mb-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Diffs</div>
      <div className="fresh-agent-diff-list space-y-1">
        {diffs.map((diff) => (
          <div key={diff.id} className="fresh-agent-file-diff min-w-0 border-l-2 border-l-border px-2 py-1 text-xs">
            <span className="font-mono">{diff.title ?? diff.path ?? diff.id}</span>
            {diff.status ? <span className="ml-2 text-muted-foreground">{diff.status}</span> : null}
            <span className="ml-2 text-muted-foreground">{RUST_BASELINE_UNAVAILABLE.fullDiff}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default FreshAgentDiffPanel
