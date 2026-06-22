import { describe, expect, it } from 'vitest'

import { FreshAgentTurnSchema } from '../../../shared/fresh-agent-contract.js'
import {
  freshAgentSnapshotHasUserTurn,
  freshAgentTurnText,
  getFreshAgentDisplayTurnKey,
} from '../../../shared/fresh-agent-turns.js'

describe('fresh-agent display turn helpers', () => {
  it('prefers turnId over id for display keys', () => {
    expect(getFreshAgentDisplayTurnKey({ turnId: 'turn-1', id: 'id-1' })).toBe('turn-1')
    expect(getFreshAgentDisplayTurnKey({ turnId: 'turn-2', id: 'id-2' })).toBe('turn-2')
  })

  it('falls back to id when turnId is missing', () => {
    expect(getFreshAgentDisplayTurnKey({ turnId: undefined as unknown as string, id: 'id-fallback' })).toBe('id-fallback')
  })

  it('joins text items and falls back to summary when no text item exists', () => {
    expect(freshAgentTurnText({
      summary: 'fallback',
      items: [
        { id: 'a', kind: 'text', text: 'hello' },
        { id: 'b', kind: 'reasoning', summary: ['ignore'], content: ['ignore'], text: 'ignore' },
        { id: 'c', kind: 'text', text: 'world' },
      ],
    })).toBe('hello world')

    expect(freshAgentTurnText({
      summary: 'fallback text',
      items: [{ id: 'x', kind: 'thinking', text: 'ignored' }],
    })).toBe('fallback text')

    expect(freshAgentTurnText({
      summary: 'fallback text',
      items: [{ id: 'y', kind: 'text', text: '' }],
    })).toBe('')
  })

  it('returns true only for normalized user turns', () => {
    expect(freshAgentSnapshotHasUserTurn({
      turns: [
        { turnId: '1', id: '1', summary: 'user prompt', role: 'user', items: [] },
        { turnId: '2', id: '2', summary: 'assistant response', role: 'assistant', items: [] },
      ],
    })).toBe(true)

    expect(freshAgentSnapshotHasUserTurn({ turns: [] })).toBe(false)
    expect(freshAgentSnapshotHasUserTurn({
      turns: [{ turnId: '3', id: '3', summary: 'tool', role: 'tool', items: [] }],
    })).toBe(false)

    expect(freshAgentSnapshotHasUserTurn({
      turns: [{ turnId: '4', id: '4', summary: 'legacy user value', role: 'USER' as unknown as string, items: [] }],
    })).toBe(true)

    expect(freshAgentSnapshotHasUserTurn({
      turns: [{ turnId: '5', id: '5', summary: 'normalized user', role: 'USER', items: [] }],
    })).toBe(true)
  })

  it('does not treat assistant quoted prompt text as user submissions', () => {
    expect(freshAgentSnapshotHasUserTurn({
      turns: [{
        turnId: '6',
        id: '6',
        summary: 'assistant turn',
        role: 'assistant',
        items: [{ id: 'a', kind: 'text', text: 'user: hi there' }],
      }],
    })).toBe(false)
  })

  it('supports legacy calls with null or undefined snapshots', () => {
    expect(freshAgentSnapshotHasUserTurn(null)).toBe(false)
    expect(freshAgentSnapshotHasUserTurn(undefined)).toBe(false)
  })

  it('keeps FreshAgentTurnSchema unchanged and rejects providerTurnId', () => {
    expect(() => FreshAgentTurnSchema.parse({
      id: '1',
      turnId: 't-1',
      summary: 'summary',
      items: [],
      providerTurnId: 'legacy-id',
    })).toThrow()
  })
})
