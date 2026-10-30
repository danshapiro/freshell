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
    expect(unboundRewindAvailability(assistantTurn, false, false)).toBeUndefined()
    expect(unboundRewindAvailability(assistantTurn, true, true)).toBeUndefined()
    expect(unboundRewindAvailability(assistantTurn, true, false)).toBeUndefined()
  })

  it('pins the user-row matrix: pending only for the newest user row while the agent is busy', () => {
    expect(unboundRewindAvailability(modernUserTurn, true, true)).toEqual({ status: 'pending' })
    expect(unboundRewindAvailability(modernUserTurn, false, true))
      .toEqual({ status: 'unavailable', reason: MODERN_UNAVAILABLE_REASON })
    expect(unboundRewindAvailability(modernUserTurn, true, false))
      .toEqual({ status: 'unavailable', reason: MODERN_UNAVAILABLE_REASON })
    expect(unboundRewindAvailability(modernUserTurn, false, false))
      .toEqual({ status: 'unavailable', reason: MODERN_UNAVAILABLE_REASON })
    expect(unboundRewindAvailability(legacyUserTurn, true, true)).toBeUndefined()
  })
})
