export function FreshAgentSidebar({
  worktrees,
  childThreads,
  codexReview,
  codexFork,
}: {
  worktrees: Array<{ id: string; path: string; branch?: string }>
  childThreads: Array<{ id: string; threadId: string; origin?: string; title?: string }>
  codexReview?: { id?: string; status?: string }
  codexFork?: { parentThreadId?: string }
}) {
  if (
    worktrees.length === 0
    && childThreads.length === 0
    && !codexReview
    && !codexFork
  ) return null
  return (
    <aside className="fresh-agent-sidebar bg-muted/20" aria-label="Fresh agent metadata">
      <div className="fresh-agent-sidebar-content">
      {codexReview ? (
        <section className="fresh-agent-sidebar-section">
          <div className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Review</div>
          <ul className="fresh-agent-sidebar-list space-y-1 text-sm">
            {codexReview.status ? <li>{codexReview.status}</li> : null}
            {codexReview.id ? <li>{codexReview.id}</li> : null}
          </ul>
        </section>
      ) : null}
      {codexFork?.parentThreadId ? (
        <section className="fresh-agent-sidebar-section">
          <div className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Fork lineage</div>
          <ul className="fresh-agent-sidebar-list space-y-1 text-sm">
            <li>Parent thread</li>
            <li>{codexFork.parentThreadId}</li>
          </ul>
        </section>
      ) : null}
      {worktrees.length > 0 ? (
        <section className="fresh-agent-sidebar-section">
          <div className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Worktrees</div>
          <ul className="fresh-agent-sidebar-list space-y-1 text-sm">
            {worktrees.map((worktree) => (
              <li key={worktree.id}>{worktree.branch ? `${worktree.branch} · ` : ''}{worktree.path}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {childThreads.length > 0 ? (
        <section className="fresh-agent-sidebar-section">
          <div className="mb-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Child Threads</div>
          <ul className="fresh-agent-sidebar-list space-y-1 text-sm">
            {childThreads.map((thread) => (
              <li key={thread.id}>{thread.title ?? thread.threadId}</li>
            ))}
          </ul>
        </section>
      ) : null}
      </div>
    </aside>
  )
}
