import { describe, expect, it } from 'vitest'
import type { FreshAgentTurn } from '@shared/fresh-agent-contract'
import { unboundRewindAvailability } from '@/components/fresh-agent/FreshAgentView'

const MODERN_UNAVAILABLE_REASON = 'No exact code checkpoint is available for this message.'

// A modern assistant row: only the role gate can exclude it from rewind
// status (a non-modern assistant would also be filtered by the modern-turn
// gate, which would not prove the role gate at all).
const assistantTurn: FreshAgentTurn = {
  id: 'msg_assistant_1',
  turnId: 'msg_assistant_1',
  source: 'durable',
  role: 'assistant',
  summary: 'Done',
  items: [],
}

const modernUserTurn: FreshAgentTurn = {
  id: 'msg_user_1',
  turnId: 'msg_user_1',
  source: 'durable',
  role: 'user',
  summary: 'Ship it',
  items: [],
}

const legacyUserTurn: FreshAgentTurn = {
  id: 'legacy-user-1',
  turnId: 'legacy-user-1',
  role: 'user',
  summary: 'Older label-based rewind path',
  items: [],
}

describe('unboundRewindAvailability policy', () => {
  it('does not consider agent response turns for rewind status at all', () => {
    expect(unboundRewindAvailability(assistantTurn, false, false, false)).toBeUndefined()
    expect(unboundRewindAvailability(assistantTurn, true, true, true)).toBeUndefined()
    expect(unboundRewindAvailability(assistantTurn, true, false, true)).toBeUndefined()
    // The capture-in-flight input can never resurrect an agent row either.
    expect(unboundRewindAvailability(assistantTurn, true, true, false)).toBeUndefined()
  })

  it('pins the user-row matrix: pending only for the newest user row while the agent is busy AND this pane\'s capture is genuinely in flight; the uncertain mid-turn window makes no claim at all', () => {
    // The only pending cell: newest user row, busy, capture in flight.
    expect(unboundRewindAvailability(modernUserTurn, true, true, true)).toEqual({ status: 'pending' })
    // The uncertain window (busy, newest, but NO capture this pane can
    // evidence as in flight — an MCP/CLI-driven turn, a reloaded pane with
    // no send metadata, a capture that already settled) makes NO claim:
    // undefined, per the User Request's "(or nothing)" acceptance. The
    // honest unavailable verdict returns at the turn's settle (idle cell).
    expect(unboundRewindAvailability(modernUserTurn, true, true, false)).toBeUndefined()
    expect(unboundRewindAvailability(modernUserTurn, false, true, true))
      .toEqual({ status: 'unavailable', reason: MODERN_UNAVAILABLE_REASON })
    expect(unboundRewindAvailability(modernUserTurn, false, true, false))
      .toEqual({ status: 'unavailable', reason: MODERN_UNAVAILABLE_REASON })
    expect(unboundRewindAvailability(modernUserTurn, true, false, true))
      .toEqual({ status: 'unavailable', reason: MODERN_UNAVAILABLE_REASON })
    expect(unboundRewindAvailability(modernUserTurn, true, false, false))
      .toEqual({ status: 'unavailable', reason: MODERN_UNAVAILABLE_REASON })
    expect(unboundRewindAvailability(modernUserTurn, false, false, false))
      .toEqual({ status: 'unavailable', reason: MODERN_UNAVAILABLE_REASON })
    expect(unboundRewindAvailability(legacyUserTurn, true, true, true)).toBeUndefined()
  })
})
