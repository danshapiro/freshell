import { describe, expect, it } from 'vitest'
import { selectNextNativeNonceTurn } from '../../../e2e-browser/helpers/provider-native-history/sequence.js'
import type { NativeAssistantTurn, NativeHistory } from '../../../e2e-browser/helpers/provider-native-history/types.js'

const nonce = 'codename-00112233445566778899aabbccddeeff'
function turn(id: number, appendOnly = false): NativeAssistantTurn {
  return {
    nativeEvidence: appendOnly ? {
      kind: 'append_only_record', recordIndex: id, byteStart: id * 100, byteEnd: id * 100 + 100,
      recordSha256: String(id).repeat(64), prefixSha256Before: '0'.repeat(64),
      completionEventOrdinal: id, completionEventSha256: String(id).repeat(64),
    } : { kind: 'identified_message', messageId: `message-${id}`, turnId: `turn-${id}`, parentMessageId: `user-${id}` },
    completedAt: 1000 + id, text: `The name is ${nonce}.`, toolCalls: [],
    resolvedProvider: 'opencode', resolvedModel: 'big-pickle', resolvedReasoningEffort: 'provider-default',
    providerProvenance: 'native', modelProvenance: 'native', reasoningEffortProvenance: 'native',
  }
}
function history(turns: NativeAssistantTurn[], nativeSessionId = 'ses_exact'): NativeHistory {
  return { schemaVersion: 1, provider: 'opencode', nativeSessionId, turns }
}
const select = (current: NativeHistory, previous: NativeAssistantTurn[] = []) =>
  selectNextNativeNonceTurn(current, 'ses_exact', nonce, previous)

describe('native completed-turn sequencing', () => {
  it('accepts one native assistant answer without demanding a rendered prompt echo', () => {
    const answer = turn(1)
    expect(select(history([answer]))).toEqual(answer)
  })
  it('does not count an old response or a redraw as another completed turn', () => {
    const first = turn(1)
    expect(select(history([first]), [first])).toBeNull()
  })
  it.each([false, true])('requires a newly persisted turn, including append-only=%s providers without IDs', (appendOnly) => {
    const first = turn(1, appendOnly), next = turn(2, appendOnly)
    expect(select(history([first, next]), [first])).toEqual(next)
  })
  it('does not accept unrelated response text', () => {
    expect(select(history([{ ...turn(1), text: 'unrelated answer' }]))).toBeNull()
  })
  it('rejects another native session', () => {
    expect(() => select(history([turn(1)], 'ses_other'))).toThrow(/session/)
  })
  it('rejects duplicate completed answers for one submitted prompt', () => {
    expect(() => select(history([turn(1), turn(2)]))).toThrow(/more than one/)
  })
  it('rejects a lost or rewritten previously observed native response', () => {
    const first = turn(1)
    expect(() => select(history([]), [first])).toThrow(/lost|prefix/)
    expect(() => select(history([{ ...first, text: `${nonce} changed` }, turn(2)]), [first])).toThrow(/changed|prefix/)
  })
  it('rejects reused native message or append-only record identity', () => {
    const first = turn(1), second = { ...turn(2), nativeEvidence: first.nativeEvidence }
    expect(() => select(history([first, second]), [first])).toThrow(/identity/)
  })
  it('rejects tool-assisted recall', () => {
    expect(() => select(history([{ ...turn(1), toolCalls: [{ type: 'tool', name: 'read' }] }]))).toThrow(/tool/)
  })
})
