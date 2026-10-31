// Claude approval decisions and the plain-language lines for Claude's own
// permission suggestions (client-alerts plan G20).
//
// Every approval answer a client sends is built here, so the wire shapes live
// in one place: a plain allow never carries `updatedInput` (a defined one,
// even {}, wholesale replaces the tool input — the sidecar resolves the
// decision verbatim), a remembered allow carries exactly the suggestions the
// card showed as `updatedPermissions`, and a deny keeps the turn going.

import type { FreshAgentPermissionUpdate } from '@shared/fresh-agent-contract'

export type FreshAgentApprovalDecision =
  | { nativeDecision: 'accept' | 'acceptForSession' | 'decline' | 'cancel' }
  | { behavior: 'allow'; updatedPermissions?: FreshAgentPermissionUpdate[] }
  | { behavior: 'deny'; message: string; interrupt: false }

/** What "Keep planning" tells Claude when the user wrote nothing. */
export const KEEP_PLANNING_MESSAGE = 'The user wants to keep planning.'
const DENY_MESSAGE = 'Denied by user'

/** Allow the tool call; with `updates`, also apply those permission updates. */
export function buildAllowDecision(updates?: readonly FreshAgentPermissionUpdate[]): FreshAgentApprovalDecision {
  return updates && updates.length > 0
    ? { behavior: 'allow', updatedPermissions: [...updates] }
    : { behavior: 'allow' }
}

/** Deny the tool call and let Claude carry on with `message` (or the default). */
export function buildDenyDecision(message?: string): FreshAgentApprovalDecision {
  return { behavior: 'deny', message: message?.trim() || DENY_MESSAGE, interrupt: false }
}

/** The plan card's four answers. */
export type PlanApprovalChoice = 'approve' | 'approve-accept-edits' | 'approve-bypass' | 'keep-planning'

/**
 * A plan answer. A plain approval lets the CLI return to the mode it had before
 * plan mode; the other two approvals set the mode for the rest of the
 * conversation; "Keep planning" denies with the user's note.
 */
export function buildPlanDecision(choice: PlanApprovalChoice, feedback?: string): FreshAgentApprovalDecision {
  switch (choice) {
    case 'approve':
      return buildAllowDecision()
    case 'approve-accept-edits':
      return buildAllowDecision([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }])
    case 'approve-bypass':
      return buildAllowDecision([{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }])
    case 'keep-planning':
      return buildDenyDecision(feedback?.trim() || KEEP_PLANNING_MESSAGE)
  }
}

type Destination = FreshAgentPermissionUpdate['destination']
type RuleUpdate = Extract<FreshAgentPermissionUpdate, { rules: unknown }>

/** Whether the update outlives this conversation (it is saved to a settings file). */
function isSaved(destination: Destination): boolean {
  return destination === 'localSettings' || destination === 'projectSettings' || destination === 'userSettings'
}

function scopeText(destination: Destination): string {
  switch (destination) {
    case 'localSettings': return 'in this project (saved to .claude/settings.local.json)'
    case 'projectSettings': return 'in this project (saved to .claude/settings.json)'
    case 'userSettings': return 'in every project (saved to ~/.claude/settings.json)'
    case 'session':
    case 'cliArg':
      return 'for the rest of this conversation'
  }
}

function rulesText(rules: RuleUpdate['rules']): string {
  return rules.map((rule) => (rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName)).join(', ')
}

const BEHAVIOR_VERB: Record<RuleUpdate['behavior'], string> = { allow: 'allow', deny: 'deny', ask: 'ask before' }
const BEHAVIOR_LIST: Record<RuleUpdate['behavior'], string> = { allow: 'allowed', deny: 'denied', ask: 'ask-first' }

const MODE_TEXT: Record<Extract<FreshAgentPermissionUpdate, { type: 'setMode' }>['mode'], string> = {
  acceptEdits: 'Auto-accept file edits',
  bypassPermissions: 'Stop asking for permission',
  default: 'Ask for permission as usual',
  plan: 'Switch to plan mode',
  dontAsk: 'Deny anything not already allowed, without asking',
  auto: 'Let an automatic check decide what to allow',
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** One line, in plain language, saying what accepting `update` does and where it is kept. */
export function describePermissionUpdate(update: FreshAgentPermissionUpdate): string {
  const scope = scopeText(update.destination)
  switch (update.type) {
    case 'addRules': {
      const verb = BEHAVIOR_VERB[update.behavior]
      return `${isSaved(update.destination) ? `Always ${verb}` : capitalize(verb)} ${rulesText(update.rules)} ${scope}`
    }
    case 'replaceRules':
      return `Make ${rulesText(update.rules)} the only ${BEHAVIOR_LIST[update.behavior]} rules ${scope}`
    case 'removeRules':
      return `Remove ${rulesText(update.rules)} from the ${BEHAVIOR_LIST[update.behavior]} rules ${scope}`
    case 'setMode':
      return `${MODE_TEXT[update.mode]} ${scope}`
    case 'addDirectories':
      return `${isSaved(update.destination) ? 'Always allow' : 'Allow'} access to ${update.directories.join(', ')} ${scope}`
    case 'removeDirectories':
      return `Remove access to ${update.directories.join(', ')} ${scope}`
  }
}

/** The remember button's label for these suggestions. */
export function rememberLabel(updates: readonly FreshAgentPermissionUpdate[]): string {
  const [only] = updates
  return updates.length === 1 && only?.type === 'setMode' && only.mode === 'acceptEdits'
    ? 'Allow and auto-accept edits'
    : 'Allow and don\'t ask again'
}
