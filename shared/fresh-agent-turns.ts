import type { FreshAgentSnapshot, FreshAgentTurn } from './fresh-agent-contract.js'

export function getFreshAgentDisplayTurnKey(turn: Pick<FreshAgentTurn, 'turnId' | 'id'>): string {
  return turn.turnId ?? turn.id
}

export function isTemporaryFreshAgentTurnId(value: string | undefined): boolean {
  return typeof value === 'string' && (
    value.startsWith('live-')
    || value.startsWith('__local-echo:')
  )
}

export function getFreshAgentTurnIdentityKeys(turn: Pick<FreshAgentTurn, 'id' | 'turnId' | 'messageId'>): string[] {
  const keys = new Set<string>()
  for (const candidate of [turn.turnId, turn.id]) {
    if (candidate && !isTemporaryFreshAgentTurnId(candidate)) {
      keys.add(`turn:${candidate}`)
    }
  }
  if (turn.messageId) keys.add(`message:${turn.messageId}`)
  return [...keys]
}

export function freshAgentTurnsReferToSameDisplayTurn(a: FreshAgentTurn, b: FreshAgentTurn): boolean {
  const aKeys = new Set(getFreshAgentTurnIdentityKeys(a))
  return getFreshAgentTurnIdentityKeys(b).some((key) => aKeys.has(key))
}

export function freshAgentTurnText(turn: Pick<FreshAgentTurn, 'summary' | 'items'>): string {
  const textItems = turn.items
    .filter((item): item is Extract<FreshAgentTurn['items'][number], { kind: 'text' }> => item.kind === 'text')
    .map((item) => item.text)
  const text = textItems.join(' ')
  return textItems.length > 0 ? text : turn.summary
}

function normalizeTurnRole(role: unknown): string | undefined {
  return typeof role === 'string' ? role.trim().toLowerCase() : undefined
}

export function freshAgentSnapshotHasUserTurn(
  snapshot: Pick<FreshAgentSnapshot, 'turns'> | null | undefined,
): boolean {
  return snapshot?.turns?.some((turn) => normalizeTurnRole(turn.role) === 'user') ?? false
}
