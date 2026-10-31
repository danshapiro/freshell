import type { FreshAgentSnapshot, FreshAgentTurn } from './fresh-agent-contract.js'

export function getFreshAgentDisplayTurnKey(turn: Pick<FreshAgentTurn, 'turnId' | 'id'>): string {
  return turn.turnId ?? turn.id
}

export function freshAgentTurnText(turn: Pick<FreshAgentTurn, 'summary' | 'items'>): string {
  const textItems = turn.items
    .filter((item): item is Extract<FreshAgentTurn['items'][number], { kind: 'text' }> => item.kind === 'text')
    .map((item) => item.text)
  const text = textItems.join(' ')
  return textItems.length > 0 ? text : turn.summary
}

/**
 * Leading display text of a turn: the FIRST text item's text when one exists,
 * else the summary. The opencode-pty plugin injects its notification blocks as
 * the leading content of a user-role message, in both shapes.
 */
function leadingFreshAgentTurnText(turn: Pick<FreshAgentTurn, 'summary' | 'items'>): string {
  const firstText = turn.items.find(
    (item): item is Extract<FreshAgentTurn['items'][number], { kind: 'text' }> => item.kind === 'text',
  )
  return (firstText?.text ?? turn.summary ?? '').trim()
}

const PTY_NOTIFICATION_TURN_PREFIXES = ['<pty_exited>', '<pty_waited>', '<pty_wait_timeout>'] as const

function isPtyNotificationTurn(turn: Pick<FreshAgentTurn, 'role' | 'summary' | 'items'>): boolean {
  if (turn.role !== 'user') return false
  const leading = leadingFreshAgentTurnText(turn)
  return PTY_NOTIFICATION_TURN_PREFIXES.some((prefix) => leading.startsWith(prefix))
}

/**
 * Display-only: opencode-pty plugin notification turns (machine-injected
 * user-role messages whose leading text is a `<pty_exited>` / `<pty_waited>` /
 * `<pty_wait_timeout>` block) present as agent text in the transcript. The
 * wire snapshot and store turns are never mutated — non-matching turns keep
 * their identity and the input array is returned unchanged when nothing
 * matches, so memoized consumers stay referentially stable.
 */
export function reclassifyPtyNotificationTurns(turns: FreshAgentTurn[]): FreshAgentTurn[] {
  let changed = false
  const mapped = turns.map((turn) => {
    if (!isPtyNotificationTurn(turn)) return turn
    changed = true
    return { ...turn, role: 'assistant' as const }
  })
  return changed ? mapped : turns
}

function normalizeTurnRole(role: unknown): string | undefined {
  return typeof role === 'string' ? role.trim().toLowerCase() : undefined
}

export function freshAgentSnapshotHasUserTurn(
  snapshot: Pick<FreshAgentSnapshot, 'turns'> | null | undefined,
): boolean {
  return snapshot?.turns?.some((turn) => normalizeTurnRole(turn.role) === 'user') ?? false
}

/**
 * A turn that participates in the modern checkpoint contract: current
 * provider snapshots mark materialized/live turns with their source, and a
 * turn that exposes an exact native identity is modern even when an older
 * server omitted the source field. Turns with neither keep the legacy
 * label-based rewind path (an enabled rewind affordance whose click resolves
 * the checkpoint by label lookup, never a per-message verdict).
 */
export function isModernCheckpointTurn(turn: Pick<FreshAgentTurn, 'nativeTurnId' | 'source'>): boolean {
  return Boolean(turn.nativeTurnId)
    || turn.source === 'durable'
    || turn.source === 'live'
    || turn.source === 'server'
}

/**
 * A turn summary is "authored" — provider-written prose that must remain a
 * permanent transcript boundary — unless the server explicitly tagged it as an
 * 'echo' of the turn's own items. A missing tag is conservative (authored):
 * no absorb, no folding.
 */
export function turnSummaryIsAuthored(turn: Pick<FreshAgentTurn, 'summaryKind'>): boolean {
  return turn.summaryKind !== 'echo'
}
