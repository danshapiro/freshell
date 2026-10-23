import { useId } from 'react'
import DiffView from '@/components/fresh-agent/shared/DiffView'
import type { FreshAgentPendingApproval } from '@shared/fresh-agent-contract'
import {
  buildAllowDecision,
  buildDenyDecision,
  describePermissionUpdate,
  rememberLabel,
  type FreshAgentApprovalDecision,
} from '@/lib/fresh-agent-permission-updates'

// Touch targets ≥44px at base; compact on sm+. flex-1 lets the buttons share
// the full row width on narrow panes for easy thumbing.
const BUTTON = 'fresh-agent-approval-button min-h-[2.75rem] flex-1 rounded-md px-4 text-sm disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:flex-none sm:px-3 sm:py-1 sm:text-xs'

/**
 * Approval card with an inline preview of what is being approved — the exact
 * Bash command, an Edit diff, or pretty-printed input for other tools. Every
 * answer goes out through `onRespond` as a decision from the shared builders:
 *
 * - "Allow" and "Deny";
 * - when the CLI suggested permission updates (Claude only), the remember
 *   button sends exactly those suggestions, each spelled out in plain language
 *   underneath, so Claude itself stops asking;
 * - `onAlwaysAllow`, when the caller provides it, adds the client-only "Always
 *   allow <Tool> in this pane" (codex): the caller remembers the tool and
 *   answers later requests until the pane reloads.
 */
export function FreshAgentApprovalCard({
  approval,
  disabled,
  onRespond,
  onAlwaysAllow,
}: {
  approval: FreshAgentPendingApproval
  disabled?: boolean
  onRespond: (decision: FreshAgentApprovalDecision) => void
  onAlwaysAllow?: (toolName: string) => void
}) {
  const suggestionsId = useId()
  const toolName = approval.toolName ?? 'Tool'
  const input = approval.input ?? {}
  const suggestions = approval.suggestions ?? []
  const command = toolName === 'Bash' && typeof input.command === 'string' ? input.command : null
  const editDiff = toolName === 'Edit'
    && typeof input.old_string === 'string'
    && typeof input.new_string === 'string'
    ? { oldStr: input.old_string, newStr: input.new_string, filePath: typeof input.file_path === 'string' ? input.file_path : undefined }
    : null
  const remember = suggestions.length > 0 ? rememberLabel(suggestions) : null

  return (
    <div
      role="alert"
      aria-label={`Permission request for ${toolName}`}
      className="fresh-agent-approval-card rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm"
    >
      <div className="fresh-agent-approval-heading flex items-center gap-2 font-medium">
        <span className="fresh-agent-approval-kicker rounded-full border border-amber-500/60 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-amber-600 dark:text-amber-400">
          approval
        </span>
        <span className="fresh-agent-approval-tool">{toolName}</span>
        {approval.blockedPath ? (
          <span className="fresh-agent-approval-path truncate font-mono text-xs text-muted-foreground">{approval.blockedPath}</span>
        ) : null}
      </div>
      {approval.decisionReason ? (
        <p className="fresh-agent-approval-reason mt-1 text-xs text-muted-foreground">{approval.decisionReason}</p>
      ) : null}

      {command ? (
        <pre className="fresh-agent-approval-preview mt-2 overflow-x-auto rounded border border-border/60 bg-background/70 px-2 py-1.5 font-mono text-xs">
          {command}
        </pre>
      ) : editDiff ? (
        <div className="fresh-agent-approval-preview mt-2 text-xs">
          <DiffView oldStr={editDiff.oldStr} newStr={editDiff.newStr} filePath={editDiff.filePath} />
        </div>
      ) : Object.keys(input).length > 0 ? (
        <pre className="fresh-agent-approval-preview mt-2 max-h-40 overflow-auto rounded border border-border/60 bg-background/70 px-2 py-1.5 font-mono text-xs">
          {JSON.stringify(input, null, 2)}
        </pre>
      ) : null}

      <div className="fresh-agent-approval-actions mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          aria-label="Allow tool use"
          disabled={disabled}
          onClick={() => onRespond(buildAllowDecision())}
          className={`${BUTTON} fresh-agent-approval-button-primary bg-primary font-medium text-primary-foreground`}
        >
          Allow
        </button>
        {remember ? (
          <button
            type="button"
            aria-describedby={suggestionsId}
            disabled={disabled}
            onClick={() => onRespond(buildAllowDecision(suggestions))}
            className={`${BUTTON} fresh-agent-approval-button-remember border border-border`}
          >
            {remember}
          </button>
        ) : null}
        {onAlwaysAllow && approval.toolName ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onAlwaysAllow(toolName)}
            className={`${BUTTON} border border-border`}
            title="Until this pane reloads"
          >
            Always allow {toolName} in this pane
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Deny tool use"
          disabled={disabled}
          onClick={() => onRespond(buildDenyDecision())}
          className={`${BUTTON} fresh-agent-approval-button-deny border border-border text-muted-foreground hover:text-destructive`}
        >
          Deny
        </button>
      </div>
      {remember ? (
        <ul
          id={suggestionsId}
          aria-label={`What "${remember}" saves`}
          className="fresh-agent-approval-suggestions mt-2 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground"
        >
          {suggestions.map((update, index) => (
            <li key={index}>{describePermissionUpdate(update)}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export default FreshAgentApprovalCard
