// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { findFreshAgentCreateOutcome } from '../../../../scripts/testing/fresh-agent-create-result.js'

describe('fresh-agent create result correlation', () => {
  it('ignores unrelated and non-terminal frames while a create is pending', () => {
    expect(findFreshAgentCreateOutcome([
      { type: 'freshAgent.create.failed', requestId: 'other', code: 'NO_SESSION' },
      { type: 'freshAgent.send.accepted', requestId: 'create-1' },
    ], 'create-1')).toBeNull()
  })

  it('returns the reply for the matching successful create', () => {
    const reply = { type: 'freshAgent.created', requestId: 'create-1', sessionId: 'session-1' }
    expect(findFreshAgentCreateOutcome([reply], 'create-1')).toEqual({ kind: 'created', reply })
  })

  it('surfaces a matching failure code without retaining its provider message', () => {
    const failure = {
      type: 'freshAgent.create.failed',
      requestId: 'create-1',
      code: 'FRESH_AGENT_CREATE_FAILED',
      message: 'private provider detail',
    }
    expect(findFreshAgentCreateOutcome([failure], 'create-1')).toEqual({
      kind: 'failed',
      code: 'FRESH_AGENT_CREATE_FAILED',
    })
  })

  it('uses the first correlated terminal result', () => {
    const failure = { type: 'freshAgent.create.failed', requestId: 'create-1', code: 'FAILED' }
    const reply = { type: 'freshAgent.created', requestId: 'create-1', sessionId: 'session-1' }
    expect(findFreshAgentCreateOutcome([failure, reply], 'create-1')).toEqual({ kind: 'failed', code: 'FAILED' })
  })
})
