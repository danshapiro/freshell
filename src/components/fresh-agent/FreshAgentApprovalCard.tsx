import DiffView from '@/components/agent-chat/DiffView'
import type { FreshAgentPendingApproval } from '@shared/fresh-agent-contract'

/**
 * Approval card with an inline preview of what is being approved — the exact
 * Bash command, an Edit diff, or pretty-printed input for other tools — plus a
 * session-scoped "always allow" escape hatch handled by the caller.
 */
export function FreshAgentApprovalCard({
  approval,
  disabled,
  onAllow,
  onAlwaysAllow,
  onDeny,
}: {
  approval: FreshAgentPendingApproval
  disabled?: boolean
  onAllow: () => void
  onAlwaysAllow: (toolName: string) => void
  onDeny: () => void
}) {
  const toolName = approval.toolName ?? 'Tool'
  const input = approval.input ?? {}
  const command = toolName === 'Bash' && typeof input.command === 'string' ? input.command : null
  const editDiff = toolName === 'Edit'
    && typeof input.old_string === 'string'
    && typeof input.new_string === 'string'
    ? { oldStr: input.old_string, newStr: input.new_string, filePath: typeof input.file_path === 'string' ? input.file_path : undefined }
    : null

  return (
    <div
      role="alert"
      aria-label={`Permission request for ${toolName}`}
      className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm"
    >
      <div className="flex items-center gap-2 font-medium">
        <span className="rounded-full border border-amber-500/60 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-amber-600 dark:text-amber-400">
          approval
        </span>
        <span>{toolName}</span>
        {approval.blockedPath ? (
          <span className="truncate font-mono text-xs text-muted-foreground">{approval.blockedPath}</span>
        ) : null}
      </div>
      {approval.decisionReason ? (
        <p className="mt-1 text-xs text-muted-foreground">{approval.decisionReason}</p>
      ) : null}

      {command ? (
        <pre className="mt-2 overflow-x-auto rounded border border-border/60 bg-background/70 px-2 py-1.5 font-mono text-xs">
          {command}
        </pre>
      ) : editDiff ? (
        <div className="mt-2 text-xs">
          <DiffView oldStr={editDiff.oldStr} newStr={editDiff.newStr} filePath={editDiff.filePath} />
        </div>
      ) : Object.keys(input).length > 0 ? (
        <pre className="mt-2 max-h-40 overflow-auto rounded border border-border/60 bg-background/70 px-2 py-1.5 font-mono text-xs">
          {JSON.stringify(input, null, 2)}
        </pre>
      ) : null}

      {/* Touch targets ≥44px at base; compact on sm+. flex-1 lets the buttons
          share the full row width on narrow panes for easy thumbing. */}
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          aria-label="Allow tool use"
          disabled={disabled}
          onClick={onAllow}
          className="min-h-[2.75rem] flex-1 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:flex-none sm:px-3 sm:py-1 sm:text-xs"
        >
          Allow
        </button>
        {approval.toolName ? (
          <button
            type="button"
            aria-label={`Always allow ${toolName} this session`}
            disabled={disabled}
            onClick={() => onAlwaysAllow(toolName)}
            className="min-h-[2.75rem] flex-1 rounded-md border border-border px-4 text-sm disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:flex-none sm:px-3 sm:py-1 sm:text-xs"
            title={`Auto-approve every ${toolName} request for the rest of this session`}
          >
            Always allow {toolName} this session
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Deny tool use"
          disabled={disabled}
          onClick={onDeny}
          className="min-h-[2.75rem] flex-1 rounded-md border border-border px-4 text-sm text-muted-foreground hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:flex-none sm:px-3 sm:py-1 sm:text-xs"
        >
          Deny
        </button>
      </div>
    </div>
  )
}

export default FreshAgentApprovalCard
