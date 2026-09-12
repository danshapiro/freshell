import { isDeepStrictEqual } from 'node:util'
import type { NativeAssistantTurn, NativeHistory, NativeTurnEvidence } from './types.js'

function sameIdentity(left: NativeTurnEvidence, right: NativeTurnEvidence): boolean {
  if (left.kind === 'identified_message' && right.kind === 'identified_message') {
    return left.messageId === right.messageId || left.turnId === right.turnId
  }
  if (left.kind === 'append_only_record' && right.kind === 'append_only_record') {
    return left.recordIndex === right.recordIndex || left.byteStart === right.byteStart
      || left.completionEventOrdinal === right.completionEventOrdinal
  }
  return false
}

/**
 * Sequence submitted prompts using completed provider-native assistant records,
 * never terminal echo/redraw counts. The readers exclude incomplete/user rows.
 * Retain the already-observed prefix across faults, and accept exactly one new
 * no-tools answer. Both identified messages and native append-only records work.
 */
export function selectNextNativeNonceTurn(
  history: NativeHistory,
  nativeSessionId: string,
  nonce: string,
  previous: readonly NativeAssistantTurn[],
): NativeAssistantTurn | null {
  if (history.nativeSessionId !== nativeSessionId) throw new Error('native sequence has the wrong session')
  if (!nonce) throw new Error('native sequence requires a non-empty nonce')
  const matching = history.turns.filter((turn) => turn.text.includes(nonce))
  if (matching.length < previous.length) throw new Error('native sequence lost its observed prefix')
  for (let index = 0; index < previous.length; index += 1) {
    if (!isDeepStrictEqual(matching[index], previous[index])) {
      throw new Error('native sequence changed an already observed completed response')
    }
  }
  if (matching.length > previous.length + 1) throw new Error('native sequence completed more than one answer for one prompt')
  const next = matching[previous.length]
  if (!next) return null
  if (next.toolCalls.length) throw new Error('native recall used a tool')
  if (previous.some((turn) => sameIdentity(turn.nativeEvidence, next.nativeEvidence))) {
    throw new Error('native sequence reused a completed response identity')
  }
  return next
}
