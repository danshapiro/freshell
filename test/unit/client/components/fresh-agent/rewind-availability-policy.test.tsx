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

  it('pins the user-row matrix: pending only for the newest user row while the agent is busy AND this pane\'s capture is genuinely in flight', () => {
    // The only pending cell: newest user row, busy, capture in flight.
    expect(unboundRewindAvailability(modernUserTurn, true, true, true)).toEqual({ status: 'pending' })
    // An MCP/CLI-driven turn (busy, newest, but NO capture in flight for it)
    // stays honestly rewind-unavailable — never a still-saving claim.
    expect(unboundRewindAvailability(modernUserTurn, true, true, false))
      .toEqual({ status: 'unavailable', reason: MODERN_UNAVAILABLE_REASON })
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
