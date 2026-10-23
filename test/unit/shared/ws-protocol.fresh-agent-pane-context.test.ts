import { describe, expect, it } from 'vitest'
import { ClientMessageSchema } from '@shared/ws-protocol'

// G19 (api-hosted-ops plan §2.4): a fresh-agent create and attach name the
// pane they run for, so the agent's Freshell MCP acts for that pane. The
// fields are optional; the client schema keeps them (zod strips unknown keys,
// so a field missing from the schema would never reach the server).
describe('freshAgent create/attach pane context', () => {
  it('keeps the create\'s tabId and paneId', () => {
    const create = {
      type: 'freshAgent.create',
      requestId: 'req-1',
      sessionType: 'freshclaude',
      provider: 'claude',
      tabId: 'tab-1',
      paneId: 'pane-1',
    }
    expect(ClientMessageSchema.parse(create)).toEqual(create)
  })

  it('keeps the attach\'s tabId and paneId', () => {
    const attach = {
      type: 'freshAgent.attach',
      sessionId: 'session-1',
      sessionType: 'kilroy',
      provider: 'claude',
      tabId: 'tab-1',
      paneId: 'pane-1',
    }
    expect(ClientMessageSchema.parse(attach)).toEqual(attach)
  })

  it('still accepts frames without them, and refuses empty ids', () => {
    const attach = { type: 'freshAgent.attach', sessionId: 'session-1', sessionType: 'freshclaude', provider: 'claude' }
    expect(ClientMessageSchema.parse(attach)).toEqual(attach)
    expect(ClientMessageSchema.safeParse({ ...attach, paneId: '' }).success).toBe(false)
    expect(ClientMessageSchema.safeParse({
      type: 'freshAgent.create', requestId: 'req-2', sessionType: 'freshclaude', paneId: '',
    }).success).toBe(false)
  })
})
