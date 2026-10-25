import type { CodexLatestUsage } from '@/lib/fresh-agent-context-usage'

type CodexPlan = { explanation?: string; plan: Array<{ step: string; status: 'pending' | 'inProgress' | 'completed' }> }

export function readCodexPlan(raw: unknown): CodexPlan | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as { explanation?: unknown; plan?: unknown }
  if (!Array.isArray(value.plan) || !value.plan.every((step) => step && typeof step.step === 'string' && ['pending', 'inProgress', 'completed'].includes(step.status))) return undefined
  return { plan: value.plan, ...(typeof value.explanation === 'string' ? { explanation: value.explanation } : {}) }
}

export function FreshAgentSidebar({
  worktrees,
  childThreads,
  codexReview,
  codexFork,
  codexPlan,
  codexUsage,
}: {
  worktrees: Array<{ id: string; path: string; branch?: string }>
  childThreads: Array<{ id: string; threadId: string; origin?: string; title?: string }>
  codexReview?: { id?: string; status?: string }
  codexFork?: { parentThreadId?: string }
  codexPlan?: CodexPlan
  codexUsage?: CodexLatestUsage
}) {
  if (
    worktrees.length === 0
    && childThreads.length === 0
    && !codexReview
    && !codexFork
    && !codexPlan
    && !codexUsage
  ) return null
  return (
    <aside className="fresh-agent-sidebar bg-muted/20" aria-label="Fresh agent metadata">
      <div className="fresh-agent-sidebar-content">
      {codexPlan ? (
        <section className="fresh-agent-sidebar-section" aria-label="Plan">
          <div className="fresh-agent-sidebar-title mb-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Plan</div>
          {codexPlan.explanation ? <p className="mb-2 text-sm">{codexPlan.explanation}</p> : null}
          <ol className="space-y-1 text-sm">
            {codexPlan.plan.map((step, index) => <li key={index}><span>{step.step}</span> <span className="text-xs text-muted-foreground">{step.status === 'inProgress' ? 'In progress' : step.status === 'completed' ? 'Completed' : 'Pending'}</span></li>)}
          </ol>
        </section>
      ) : null}
      {codexUsage ? (
        <section className="fresh-agent-sidebar-section" aria-label="Token usage">
          <div className="fresh-agent-sidebar-title mb-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Usage</div>
          <p className="text-sm">Latest usage {codexUsage.observed ? `${codexUsage.latestTokens!.toLocaleString()} tokens` : '—'}</p>
          {codexUsage.observed ? <p className="text-xs text-muted-foreground">Total usage {codexUsage.totalTokens!.toLocaleString()} tokens</p> : null}
          {codexUsage.modelContextWindow !== undefined ? <p className="text-xs text-muted-foreground">Model context limit {codexUsage.modelContextWindow.toLocaleString()} tokens</p> : null}
        </section>
      ) : null}
      {codexReview ? (
        <section className="fresh-agent-sidebar-section">
          <div className="fresh-agent-sidebar-title mb-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Review</div>
          <ul className="fresh-agent-sidebar-list space-y-1 text-sm">
            {codexReview.status ? <li>{codexReview.status}</li> : null}
            {codexReview.id ? <li>{codexReview.id}</li> : null}
          </ul>
        </section>
      ) : null}
      {codexFork?.parentThreadId ? (
        <section className="fresh-agent-sidebar-section">
          <div className="fresh-agent-sidebar-title mb-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Fork lineage</div>
          <ul className="fresh-agent-sidebar-list space-y-1 text-sm">
            <li>Parent thread</li>
            <li>{codexFork.parentThreadId}</li>
          </ul>
        </section>
      ) : null}
      {worktrees.length > 0 ? (
        <section className="fresh-agent-sidebar-section">
          <div className="fresh-agent-sidebar-title mb-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Worktrees</div>
          <ul className="fresh-agent-sidebar-list space-y-1 text-sm">
            {worktrees.map((worktree) => (
              <li key={worktree.id}>{worktree.branch ? `${worktree.branch} · ` : ''}{worktree.path}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {childThreads.length > 0 ? (
        <section className="fresh-agent-sidebar-section">
          <div className="fresh-agent-sidebar-title mb-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Child Threads</div>
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
