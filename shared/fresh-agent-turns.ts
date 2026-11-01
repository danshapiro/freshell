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

function isSyntheticToolResultTurn(turn: FreshAgentTurn): boolean {
  return turn.role === 'user'
    && turn.items.length > 0
    && turn.items.every((item) => item.kind === 'tool_result')
}

function appendTurnItems(previous: FreshAgentTurn, next: FreshAgentTurn): FreshAgentTurn {
  return {
    ...previous,
    id: `${previous.id}:${next.id}`,
    summary: [previous.summary, next.summary].filter(Boolean).join('\n\n'),
    // Echo only when BOTH sides are echo: an authored segment must never be
    // laundered into a foldable caption, and an untagged side is conservative.
    summaryKind: previous.summaryKind === 'echo' && next.summaryKind === 'echo' ? 'echo' : 'authored',
    items: [...previous.items, ...next.items],
    model: next.model ?? previous.model,
    timestamp: next.timestamp ?? previous.timestamp,
  }
}

/**
 * Display-only: a synthetic tool-result turn (a machine-injected user-role
 * message whose items are ALL tool_result) folds into the preceding assistant
 * turn, or stands alone as a tool turn. The second stage of the transcript's
 * display pipeline (applied after [`reclassifyPtyNotificationTurns`], in that
 * order); exported so the view can derive the DISPLAYED user rows from the
 * same transformed list the transcript renders.
 */
export function coalesceSyntheticToolResultTurns(turns: FreshAgentTurn[]): FreshAgentTurn[] {
  const coalesced: FreshAgentTurn[] = []
  for (const turn of turns) {
    const previous = coalesced[coalesced.length - 1]
    if (isSyntheticToolResultTurn(turn)) {
      if (previous?.role === 'assistant') {
        coalesced[coalesced.length - 1] = appendTurnItems(previous, turn)
      } else {
        coalesced.push({ ...turn, role: 'tool' })
      }
      continue
    }
    coalesced.push(turn)
  }
  return coalesced
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
 * The id marker of the pending local echo row — the optimistic display copy
 * of a composer send whose turn has not landed in the provider snapshot yet.
 * Both a fresh send and a restored pendingLocalEcho record build their row
 * with it, so action surfaces can identify the echo row without a wire
 * contract.
 */
export const LOCAL_ECHO_TURN_ID_PREFIX = '__local-echo:'

export function isPendingLocalEchoTurn(turn: Pick<FreshAgentTurn, 'id'>): boolean {
  return typeof turn.id === 'string' && turn.id.startsWith(LOCAL_ECHO_TURN_ID_PREFIX)
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
