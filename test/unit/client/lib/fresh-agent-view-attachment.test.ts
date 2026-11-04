import { describe, expect, it } from 'vitest'
import { captureFreshAgentAttachDecision } from '@/lib/fresh-agent-view-attachment'

describe('fresh-agent attach decision correlation', () => {
  it('reuses the request id for a retry of the same target and owner fence', () => {
    const first = captureFreshAgentAttachDecision(
      'session:decision-1',
      { sessionId: 'session-1' },
      { epoch: 4, generation: 2 },
      null,
    )
    const retry = captureFreshAgentAttachDecision(
      'session:decision-1',
      { sessionId: 'session-1' },
      { epoch: 4, generation: 2 },
      first,
    )

    expect(retry).toBe(first)
    expect(retry.requestId).toBe(first.requestId)
  })

  it('mints a new request id when the target decision or observed owner changes', () => {
    const first = captureFreshAgentAttachDecision(
      'session:decision-1',
      { sessionId: 'session-1' },
      { epoch: 4, generation: 2 },
      null,
    )
    const nextDecision = captureFreshAgentAttachDecision(
      'session:decision-2',
      { sessionId: 'session-1' },
      { epoch: 4, generation: 2 },
      first,
    )
    const newOwner = captureFreshAgentAttachDecision(
      'session:decision-2',
      { sessionId: 'session-1' },
      { epoch: 4, generation: 3 },
      nextDecision,
    )

    expect(nextDecision.requestId).not.toBe(first.requestId)
    expect(newOwner.requestId).not.toBe(nextDecision.requestId)
  })
})
