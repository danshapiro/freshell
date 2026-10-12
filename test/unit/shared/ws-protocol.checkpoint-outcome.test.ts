import { describe, expect, it } from 'vitest'
import {
  FreshAgentCheckpointOutcomeSchema,
  FreshAgentSendSchema,
} from '../../../shared/ws-protocol.js'

describe('FreshAgentCheckpointOutcomeSchema', () => {
  const base = {
    type: 'freshAgent.checkpoint.outcome',
    logicalAttemptId: 'attempt-1',
    requestId: 'request-1',
    provider: 'opencode',
    sessionId: 'session-1',
    sessionType: 'freshopencode',
    status: 'available',
    checkpointId: 'a'.repeat(40),
  } as const

  it('accepts optional native and display turn identities', () => {
    expect(FreshAgentCheckpointOutcomeSchema.parse({
      ...base,
      nativeTurnId: 'native-turn-1',
      displayTurnId: 'display-turn-1',
    })).toMatchObject({
      nativeTurnId: 'native-turn-1',
      displayTurnId: 'display-turn-1',
    })
    expect(FreshAgentCheckpointOutcomeSchema.parse(base).nativeTurnId).toBeUndefined()
  })

  it('rejects malformed or unrecognized identity fields', () => {
    expect(() => FreshAgentCheckpointOutcomeSchema.parse({ ...base, nativeTurnId: 42 })).toThrow()
    expect(() => FreshAgentCheckpointOutcomeSchema.parse({ ...base, displayTurnId: '' })).toThrow()
    expect(() => FreshAgentCheckpointOutcomeSchema.parse({ ...base, providerTurnId: 'legacy' })).toThrow()
  })

  it('requires request correlation for a checkpoint-bearing send', () => {
    const send = {
      type: 'freshAgent.send',
      sessionId: 'session-1',
      sessionType: 'freshopencode',
      provider: 'opencode',
      checkpointIntent: { logicalAttemptId: 'attempt-1' },
      text: 'hello',
    }
    expect(FreshAgentSendSchema.safeParse(send).success).toBe(false)
    expect(FreshAgentSendSchema.parse({ ...send, requestId: 'request-1' }).requestId).toBe('request-1')
    expect(FreshAgentSendSchema.safeParse({ ...send, requestId: '   ' }).success).toBe(false)
    expect(FreshAgentSendSchema.safeParse({
      ...send,
      requestId: 'request-1',
      checkpointIntent: { logicalAttemptId: '   ' },
    }).success).toBe(false)
  })
})
