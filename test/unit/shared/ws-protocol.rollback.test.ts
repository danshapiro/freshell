import { describe, expect, it } from 'vitest'
import { ClientMessageSchema } from '../../../shared/ws-protocol.js'

describe('freshAgent.undo / freshAgent.redo frames', () => {
  const base = { sessionId: 'ses_1', sessionType: 'freshopencode', provider: 'opencode', requestId: 'rb-1' }

  it('accepts an undo frame with mode omitted (step default)', () => {
    expect(ClientMessageSchema.safeParse({ ...base, type: 'freshAgent.undo' }).success).toBe(true)
  })

  it('accepts a toTurn redo frame carrying turnId', () => {
    expect(ClientMessageSchema.safeParse({ ...base, type: 'freshAgent.redo', mode: 'toTurn', turnId: 'msg_x1' }).success).toBe(true)
  })

  it('rejects an unknown mode', () => {
    expect(ClientMessageSchema.safeParse({ ...base, type: 'freshAgent.undo', mode: 'all' }).success).toBe(false)
  })

  it('rejects a missing requestId (ack correlation is mandatory)', () => {
    const { requestId: _drop, ...noReq } = base as Record<string, unknown>
    expect(ClientMessageSchema.safeParse({ ...noReq, type: 'freshAgent.undo' }).success).toBe(false)
  })
})
