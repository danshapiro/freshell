import { useId, useState } from 'react'
import type { FreshAgentPendingApproval } from '@shared/fresh-agent-contract'
import {
  buildPlanDecision,
  type FreshAgentApprovalDecision,
  type PlanApprovalChoice,
} from '@/lib/fresh-agent-permission-updates'
import { FreshAgentMarkdownBody } from './FreshAgentItemCard'

// Touch targets ≥44px at base; compact on sm+ (the approval card's sizing).
const BUTTON = 'fresh-agent-plan-button min-h-[2.75rem] flex-1 rounded-md px-4 text-sm disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:flex-none sm:px-3 sm:py-1 sm:text-xs'

const APPROVALS: Array<{ choice: Exclude<PlanApprovalChoice, 'keep-planning'>; label: string; primary?: boolean }> = [
  { choice: 'approve', label: 'Approve plan', primary: true },
  { choice: 'approve-accept-edits', label: 'Approve and auto-accept edits' },
  { choice: 'approve-bypass', label: 'Approve and stop asking for permission' },
]

/**
 * Claude's ExitPlanMode request, reviewed as a plan (client-alerts G20): the
 * plan the CLI sent (`input.plan`, the plan file's text when the model wrote
 * one) rendered as markdown, the file it lives in, and four answers. A plain
 * approval lets the CLI return to the mode it had before plan mode; the other
 * two set the mode for the rest of the conversation; "Keep planning" denies
 * with the user's optional note.
 */
export function FreshAgentPlanApprovalCard({
  approval,
  disabled,
  onRespond,
}: {
  approval: FreshAgentPendingApproval
  disabled?: boolean
  onRespond: (decision: FreshAgentApprovalDecision) => void
}) {
  const feedbackId = useId()
  const [feedback, setFeedback] = useState('')
  const input = approval.input ?? {}
  const plan = typeof input.plan === 'string' && input.plan.trim() ? input.plan : null
  const planFilePath = typeof input.planFilePath === 'string' ? input.planFilePath : null
  const answer = (choice: PlanApprovalChoice) => onRespond(buildPlanDecision(choice, feedback))

  return (
    <div
      role="alert"
      aria-label="Plan approval request"
      className="fresh-agent-plan-card rounded-md border border-sky-500/50 bg-sky-500/10 px-3 py-2 text-sm"
    >
      <div className="fresh-agent-plan-heading flex items-center gap-2 font-medium">
        <span className="fresh-agent-plan-kicker rounded-full border border-sky-500/60 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-sky-600 dark:text-sky-400">
          plan
        </span>
        <span>Plan ready for review</span>
      </div>
      {planFilePath ? (
        <p className="fresh-agent-plan-path mt-1 truncate font-mono text-[11px] text-muted-foreground" title={planFilePath}>
          {planFilePath}
        </p>
      ) : null}
      <div className="fresh-agent-plan-body mt-2 max-h-96 overflow-auto rounded border border-border/60 bg-background/70 px-3 py-2">
        {plan ? (
          <FreshAgentMarkdownBody text={plan} />
        ) : (
          <p className="text-muted-foreground">No plan text was provided. You can still approve it or keep planning.</p>
        )}
      </div>

      <div className="fresh-agent-plan-actions mt-2 flex flex-wrap gap-2">
        {APPROVALS.map(({ choice, label, primary }) => (
          <button
            key={choice}
            type="button"
            disabled={disabled}
            onClick={() => answer(choice)}
            className={primary
              ? `${BUTTON} bg-primary font-medium text-primary-foreground`
              : `${BUTTON} border border-border`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="fresh-agent-plan-feedback mt-2 flex flex-col gap-1">
        <label htmlFor={feedbackId} className="text-xs text-muted-foreground">
          What should change? (optional)
        </label>
        <div className="flex flex-wrap items-start gap-2">
          <textarea
            id={feedbackId}
            rows={2}
            value={feedback}
            disabled={disabled}
            onChange={(event) => setFeedback(event.target.value)}
            className="min-h-[2.75rem] min-w-0 flex-1 resize-y rounded-md border border-border bg-background px-2 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          />
          <button
            type="button"
            disabled={disabled}
            onClick={() => answer('keep-planning')}
            className={`${BUTTON} border border-border text-muted-foreground`}
          >
            Keep planning
          </button>
        </div>
      </div>
    </div>
  )
}

export default FreshAgentPlanApprovalCard
