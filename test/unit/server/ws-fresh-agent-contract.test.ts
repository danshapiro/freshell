import { describe, expect, it } from 'vitest'
import {
  ClientMessageSchema,
  FreshAgentClientMessageSchema,
} from '../../../shared/ws-protocol.js'
import { normalizeFreshAgentProviderEvent } from '../../../server/fresh-agent/sdk-events.js'

describe('fresh-agent websocket contract', () => {
  it('rejects legacy top-level SDK client commands from the public browser protocol', () => {
    expect(FreshAgentClientMessageSchema.safeParse({ type: 'sdk.create', requestId: 'req-1' }).success).toBe(false)
    expect(ClientMessageSchema.safeParse({ type: 'sdk.send', sessionId: 's1', text: 'hello' }).success).toBe(false)
    expect(ClientMessageSchema.safeParse({
      type: 'freshAgent.send',
      sessionId: 's1',
      sessionType: 'freshcodex',
      provider: 'codex',
      text: 'hello',
    }).success).toBe(true)
  })

  it('normalizes internal SDK bridge events to fresh-agent provider event names', () => {
    expect(normalizeFreshAgentProviderEvent({
      type: 'sdk.permission.request',
      sessionId: 's1',
      requestId: 'perm-1',
      subtype: 'can_use_tool',
      tool: { name: 'Bash', input: { command: 'npm test' } },
    })).toEqual({
      type: 'freshAgent.permission.request',
      sessionId: 's1',
      requestId: 'perm-1',
      subtype: 'can_use_tool',
      tool: { name: 'Bash', input: { command: 'npm test' } },
    })

    expect(normalizeFreshAgentProviderEvent({
      type: 'freshAgent.status',
      sessionId: 's1',
      status: 'idle',
    })).toEqual({
      type: 'freshAgent.status',
      sessionId: 's1',
      status: 'idle',
    })
  })
})
