import { describe, expect, it } from 'vitest'

import { FreshAgentTurnSchema, type FreshAgentTurn } from '../../../shared/fresh-agent-contract.js'
import {
  freshAgentSnapshotHasUserTurn,
  freshAgentTurnText,
  getFreshAgentDisplayTurnKey,
  reclassifyPtyNotificationTurns,
  turnSummaryIsAuthored,
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

  it('accepts an optional summaryKind provenance tag on turn schema', () => {
    const base = { id: '1', turnId: 't-1', summary: 'summary', items: [] }
    expect(FreshAgentTurnSchema.parse({ ...base, summaryKind: 'echo' }).summaryKind).toBe('echo')
    expect(FreshAgentTurnSchema.parse({ ...base, summaryKind: 'authored' }).summaryKind).toBe('authored')
    // Graceful absence: a server that does not emit the field still parses.
    expect(FreshAgentTurnSchema.parse(base).summaryKind).toBeUndefined()
    // The enum is closed and the object stays strict.
    expect(() => FreshAgentTurnSchema.parse({ ...base, summaryKind: 'bogus' })).toThrow()
  })

  it('accepts the optional native turn identity without changing display turn ids', () => {
    const turn = FreshAgentTurnSchema.parse({
      id: 'turn-native:row-0',
      turnId: 'turn-native:row-0',
      nativeTurnId: 'turn-native',
      role: 'user',
      summary: 'same prompt',
      items: [],
    })
    expect(turn.turnId).toBe('turn-native:row-0')
    expect(turn.nativeTurnId).toBe('turn-native')
    expect(() => FreshAgentTurnSchema.parse({
      id: 'turn-native:row-0',
      turnId: 'turn-native:row-0',
      nativeTurnId: '',
      role: 'user',
      summary: 'same prompt',
      items: [],
    })).toThrow()
  })

  it('treats only an explicit echo tag as non-authored (missing is conservative)', () => {
    expect(turnSummaryIsAuthored({ summaryKind: 'echo' })).toBe(false)
    expect(turnSummaryIsAuthored({ summaryKind: 'authored' })).toBe(true)
    expect(turnSummaryIsAuthored({})).toBe(true)
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

  describe('reclassifyPtyNotificationTurns', () => {
    const ptyTurn = (text: string, summary = text): FreshAgentTurn => ({
      id: 'pty-1',
      turnId: 'pty-1',
      role: 'user',
      summary,
      items: [{ id: 'pty-1-i0', kind: 'text', text }],
    })

    it('reclassifies <pty_exited>, <pty_waited>, and <pty_wait_timeout> user turns to assistant', () => {
      for (const tag of ['<pty_exited>', '<pty_waited>', '<pty_wait_timeout>']) {
        const turn = ptyTurn(`${tag}\nID: pty_x\nExit Code: 0`)
        const [mapped] = reclassifyPtyNotificationTurns([turn])
        expect(mapped?.role).toBe('assistant')
        expect(mapped?.id).toBe('pty-1')
        expect(mapped?.items).toEqual(turn.items)
      }
    })

    it('matches leading-tag text after trimming, and falls back to summary when no text item exists', () => {
      const [withWhitespace] = reclassifyPtyNotificationTurns([ptyTurn('  <pty_exited>\nLast Line: SYNC_EXIT=0')])
      expect(withWhitespace?.role).toBe('assistant')

      const summaryOnly: FreshAgentTurn = {
        id: 'pty-2',
        turnId: 'pty-2',
        role: 'user',
        summary: '<pty_exited>\nno items on this degraded snapshot',
        items: [],
      }
      const [fromSummary] = reclassifyPtyNotificationTurns([summaryOnly])
      expect(fromSummary?.role).toBe('assistant')
    })

    it('does not match when the tag appears mid-message (leading-anchored only)', () => {
      const turn = ptyTurn('Result of the run:\n<pty_exited>\nID: pty_x')
      const [mapped] = reclassifyPtyNotificationTurns([turn])
      expect(mapped?.role).toBe('user')
    })

    it('leaves non-matching user turns untouched and never touches non-user roles', () => {
      const plainUser: FreshAgentTurn = { id: 'u1', turnId: 'u1', role: 'user', summary: 'real prompt', items: [{ id: 'u1-i0', kind: 'text', text: 'real prompt' }] }
      const taggedAssistant: FreshAgentTurn = { id: 'a1', turnId: 'a1', role: 'assistant', summary: '<pty_exited>', items: [{ id: 'a1-i0', kind: 'text', text: '<pty_exited>' }] }
      // A user turn with NO text item (verified item shape from this file's
      // existing `freshAgentTurnText` test) whose summary does not lead
      // with a tag: leading-text extraction falls to the summary, no match.
      const noTextItem: FreshAgentTurn = { id: 's1', turnId: 's1', role: 'user', summary: 'tool output', items: [{ id: 's1-i0', kind: 'thinking', text: 'internal' }] }

      const turns = [plainUser, taggedAssistant, noTextItem]
      const mapped = reclassifyPtyNotificationTurns(turns)

      expect(mapped).toBe(turns) // same array reference: nothing matched
      expect(mapped[0]).toBe(plainUser)
      expect(mapped[1]?.role).toBe('assistant')
      expect(mapped[2]).toBe(noTextItem)
    })

    it('returns a new array with new objects only for matches, preserving order and identity of the rest', () => {
      const plain: FreshAgentTurn = { id: 'u1', turnId: 'u1', role: 'user', summary: 'hi', items: [{ id: 'u1-i0', kind: 'text', text: 'hi' }] }
      const pty = ptyTurn('<pty_exited>\nID: pty_x')
      const turns = [plain, pty]
      const mapped = reclassifyPtyNotificationTurns(turns)

      expect(mapped).not.toBe(turns)
      expect(mapped).toHaveLength(2)
      expect(mapped[0]).toBe(plain)
      expect(mapped[1]).not.toBe(pty)
      expect({ ...mapped[1], role: 'user' }).toEqual(pty)
    })

    it('does not mutate its input (wire/store turns stay raw)', () => {
      const pty = ptyTurn('<pty_exited>\nID: pty_x')
      reclassifyPtyNotificationTurns([pty])
      expect(pty.role).toBe('user')
    })
  })
})
