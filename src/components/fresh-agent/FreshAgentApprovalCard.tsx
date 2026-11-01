import { useId, type ReactNode } from 'react'
import DiffView from '@/components/fresh-agent/shared/DiffView'
import type { FreshAgentPendingApproval } from '@shared/fresh-agent-contract'
import {
  buildAllowDecision,
  buildDenyDecision,
  describePermissionUpdate,
  rememberLabel,
  type FreshAgentApprovalDecision,
} from '@/lib/fresh-agent-permission-updates'
import { FreshAgentPlanApprovalCard } from './FreshAgentPlanApprovalCard'

// Touch targets ≥44px at base; compact on sm+. flex-1 lets the buttons share
// the full row width on narrow panes for easy thumbing.
const BUTTON = 'fresh-agent-approval-button min-h-[2.75rem] flex-1 rounded-md px-4 text-sm disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:flex-none sm:px-3 sm:py-1 sm:text-xs'

type FreshAgentApprovalCardProps = {
  approval: FreshAgentPendingApproval
  disabled?: boolean
  onRespond: (decision: FreshAgentApprovalDecision) => void
  onAlwaysAllow?: (toolName: string) => void
}

/**
 * Approval card with an inline preview of what is being approved — the exact
 * Bash command, an Edit diff, or pretty-printed input for other tools. Every
 * answer goes out through `onRespond` as a decision from the shared builders:
 *
 * - "Allow" and "Deny";
 * - when the CLI suggested permission updates (Claude only), the remember
 *   button sends exactly those suggestions, each spelled out in plain language
 *   underneath, so Claude itself stops asking;
 * - legacy shared approvals can expose the caller's pane-local remember action.
 *   Native approvals expose only the decisions offered by their provider.
 *
 * Claude's ExitPlanMode request is a plan to review, not a tool call: it gets
 * the plan card ({@link FreshAgentPlanApprovalCard}).
 */
export function FreshAgentApprovalCard(props: FreshAgentApprovalCardProps) {
  if (props.approval.toolName === 'ExitPlanMode') {
    return <FreshAgentPlanApprovalCard approval={props.approval} disabled={props.disabled} onRespond={props.onRespond} />
  }
  if (props.approval.native) return <NativeApprovalCard {...props} />
  return <FreshAgentToolApprovalCard {...props} />
}

function isVerbose(text: string) {
  return text.length > 240 || text.split('\n').length > 3
}

function Preview({ text, children, command, toolName }: { text: string; children: ReactNode; command?: boolean; toolName?: string }) {
  if (!isVerbose(text)) return children
  return <>
    {command ? <p className="fresh-agent-command-identity text-xs">{toolName}: {text.split('\n')[0].slice(0, 80)}</p> : null}
    <details className="fresh-agent-request-details">
      <summary>{command ? 'Command details' : 'Request details'}</summary>
      {children}
    </details>
  </>
}

function NativeApprovalCard({ approval, disabled, onRespond }: FreshAgentApprovalCardProps) {
  const native = approval.native ?? {}
  const offered = Array.isArray(native.availableDecisions) ? native.availableDecisions : ['accept', 'decline', 'cancel']
  const supported = ['accept', 'acceptForSession', 'decline', 'cancel'] as const
  const choices = approval.toolName === 'Additional permissions' ? ['accept', 'decline'] : offered
  const network = native.networkApprovalContext as { host?: string; protocol?: string } | undefined
  const labels = { accept: 'Allow', acceptForSession: 'Allow for this session', decline: 'Decline', cancel: 'Stop' }
  const details = {
    ...(native.kind ? { action: native.kind } : {}),
    ...(native.cwd ? { directory: native.cwd } : {}),
    ...(native.permissions ? { permissions: native.permissions } : {}),
    ...(native.additionalPermissions ? { additionalPermissions: native.additionalPermissions } : {}),
    ...(native.grantRoot ? { path: native.grantRoot } : {}),
  }
  const compactDetails = JSON.stringify(details)
  const detailsText = isVerbose(compactDetails) ? JSON.stringify(details, null, 2) : compactDetails
  return (
    <div role="alert" aria-label={`Permission request for ${approval.toolName ?? 'Tool'}`} className="fresh-agent-approval-card rounded-md border border-amber-500/50 p-3 space-y-2">
      <p className="font-medium">{native.kind === 'writeStdin' ? 'Write to a running command' : approval.toolName}</p>
      {network ? <p>Connect to {network.host} {network.protocol ? `using ${network.protocol}` : ''}</p> : null}
      {typeof native.grantRoot === 'string' ? <p className="fresh-agent-approval-path text-xs">{native.grantRoot}</p> : null}
      {approval.decisionReason ? <p>{approval.decisionReason}</p> : null}
      {typeof native.command === 'string' ? <Preview text={native.command} command toolName={approval.toolName}>
        <pre className="fresh-agent-approval-preview whitespace-pre-wrap text-xs">{native.command}</pre>
      </Preview> : null}
      {Object.keys(details).length ? (
        <Preview text={detailsText}>
          <pre className="fresh-agent-approval-preview whitespace-pre-wrap text-xs">{detailsText}</pre>
        </Preview>
      ) : null}
      {approval.toolName === 'Additional permissions' ? <p className="text-xs">Allow the requested permissions for this turn.</p> : null}
      <div className="flex flex-wrap gap-2">
        {supported.filter((choice) => choices.includes(choice)).map((choice) => (
          <button key={choice} type="button" className={BUTTON} disabled={disabled} onClick={() => onRespond({ nativeDecision: choice })}>
            {labels[choice]}
          </button>
        ))}
      </div>
      {offered.some((choice) => typeof choice !== 'string') ? <p className="text-xs">Persistent rule changes are not supported here.</p> : null}
    </div>
  )
}

function FreshAgentToolApprovalCard({ approval, disabled, onRespond, onAlwaysAllow }: FreshAgentApprovalCardProps) {
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

  const suggestionsList = (
    <ul
      id={suggestionsId}
      aria-label={`What "${remember}" saves`}
      className="fresh-agent-approval-suggestions mt-2 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground"
    >
      {suggestions.map((update, index) => (
        <li key={index}>{describePermissionUpdate(update)}</li>
      ))}
    </ul>
  )

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
        <Preview text={command} command toolName={toolName}><pre className="fresh-agent-approval-preview mt-2 whitespace-pre-wrap rounded border border-border/60 bg-background/70 px-2 py-1.5 font-mono text-xs">
          {command}
        </pre></Preview>
      ) : editDiff ? (
        <Preview text={editDiff.oldStr + '\n' + editDiff.newStr}><div className="fresh-agent-approval-preview mt-2 text-xs">
          <DiffView oldStr={editDiff.oldStr} newStr={editDiff.newStr} filePath={editDiff.filePath} />
        </div></Preview>
      ) : Object.keys(input).length > 0 ? (
        <Preview text={JSON.stringify(input, null, 2)}><pre className="fresh-agent-approval-preview mt-2 max-h-40 overflow-auto rounded border border-border/60 bg-background/70 px-2 py-1.5 font-mono text-xs">
          {JSON.stringify(input, null, 2)}
        </pre></Preview>
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
      {remember ? (isVerbose(suggestions.map(describePermissionUpdate).join('\n')) ? (
        <details>
          <summary>Permission changes</summary>
          {suggestionsList}
        </details>
      ) : suggestionsList) : null}
    </div>
  )
}

export default FreshAgentApprovalCard
