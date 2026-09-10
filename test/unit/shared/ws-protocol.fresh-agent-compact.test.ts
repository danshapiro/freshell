import { describe, expect, it } from 'vitest'
import { ClientMessageSchema, FreshAgentCompactSchema } from '@shared/ws-protocol'

describe('freshAgent.compact protocol', () => {
  it('preserves a stable requestId through the client message schema', () => {
    const request = {
      type: 'freshAgent.compact',
      requestId: 'compact-request-1',
      sessionId: 'thread-1',
      sessionType: 'freshcodex',
      provider: 'codex',
    }

    expect(FreshAgentCompactSchema.parse(request).requestId).toBe(request.requestId)
    expect(ClientMessageSchema.parse(request)).toMatchObject(request)
  })
})
