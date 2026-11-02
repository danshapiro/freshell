import { describe, expect, it } from 'vitest'
import { ClientMessageSchema } from '@shared/ws-protocol'

describe('Fresh Agent detach protocol', () => {
  it('accepts a requester-scoped detach in the top-level client message schema', () => {
    const parsed = ClientMessageSchema.safeParse({
      type: 'freshAgent.detach',
      requestId: 'detach-request',
      provider: 'codex',
      sessionType: 'freshcodex',
      sessionId: 'shared-thread',
      viewId: 'view-a',
    })

    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).toMatchObject({
        type: 'freshAgent.detach',
        requestId: 'detach-request',
        sessionId: 'shared-thread',
        viewId: 'view-a',
      })
    }
  })
})
