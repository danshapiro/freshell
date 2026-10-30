import { describe, expect, it } from 'vitest'

import { ClientMessageSchema, FreshAgentCreateSchema } from '@shared/ws-protocol'

describe('freshAgent.create pane ownership', () => {
  it('preserves the pane ID through the standalone and client-message schemas', () => {
    const message = {
      type: 'freshAgent.create',
      requestId: 'create-1',
      sessionType: 'freshclaude',
      provider: 'claude',
      tabId: 'tab-1',
      paneId: 'pane-1',
    } as const

    expect(FreshAgentCreateSchema.parse(message).paneId).toBe('pane-1')
    expect(ClientMessageSchema.parse(message)).toMatchObject({ paneId: 'pane-1' })
  })

  it('keeps older create frames valid when they omit the pane ID', () => {
    expect(FreshAgentCreateSchema.safeParse({
      type: 'freshAgent.create',
      requestId: 'create-legacy',
      sessionType: 'freshclaude',
      provider: 'claude',
      tabId: 'tab-1',
    }).success).toBe(true)
  })
})
