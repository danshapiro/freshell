import { describe, expect, it } from 'vitest'

import { normalizeFreshAgentProviderEvent } from '../../../../server/fresh-agent/sdk-events.js'

describe('normalizeFreshAgentProviderEvent', () => {
  it('maps a provider sdk.turn.complete edge to a freshAgent.turn.complete event', () => {
    const normalized = normalizeFreshAgentProviderEvent({
      type: 'sdk.turn.complete',
      sessionId: 'ses_123',
      at: 1782200000123,
    })

    expect(normalized).toEqual({
      type: 'freshAgent.turn.complete',
      sessionId: 'ses_123',
      at: 1782200000123,
    })
  })

  it('passes through an already-normalized freshAgent.turn.complete event unchanged', () => {
    const event = { type: 'freshAgent.turn.complete', sessionId: 'ses_123', at: 5 }
    expect(normalizeFreshAgentProviderEvent(event)).toBe(event)
  })
})
