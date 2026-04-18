export function FreshAgentDiffPanel({ diffs }: { diffs: Array<{ id: string; path?: string; title?: string }> }) {
  if (diffs.length === 0) return null
  return (
    <div className="rounded-lg border border-border/60 bg-background/70 p-3">
      <div className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Diffs</div>
      <ul className="space-y-1 text-sm">
        {diffs.map((diff) => (
          <li key={diff.id}>{diff.title ?? diff.path ?? diff.id}</li>
        ))}
      </ul>
    </div>
  )
}
