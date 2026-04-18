export function FreshAgentSidebar({
  worktrees,
  childThreads,
}: {
  worktrees: Array<{ id: string; path: string; branch?: string }>
  childThreads: Array<{ id: string; threadId: string; origin?: string; title?: string }>
}) {
  if (worktrees.length === 0 && childThreads.length === 0) return null
  return (
    <aside className="w-full max-w-xs space-y-3 border-l border-border/60 bg-muted/20 p-3">
      {worktrees.length > 0 ? (
        <section>
          <div className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Worktrees</div>
          <ul className="space-y-1 text-sm">
            {worktrees.map((worktree) => (
              <li key={worktree.id}>{worktree.branch ? `${worktree.branch} · ` : ''}{worktree.path}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {childThreads.length > 0 ? (
        <section>
          <div className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Child Threads</div>
          <ul className="space-y-1 text-sm">
            {childThreads.map((thread) => (
              <li key={thread.id}>{thread.title ?? thread.threadId}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </aside>
  )
}
