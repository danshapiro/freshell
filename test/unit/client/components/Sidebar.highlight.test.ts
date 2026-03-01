import { describe, it, expect } from 'vitest'
import { computeIsActive } from '@/components/Sidebar'

describe('Sidebar highlight logic (computeIsActive)', () => {
  describe('when activeSessionKey is available (primary path)', () => {
    it('highlights when sessionKey matches activeSessionKey', () => {
      expect(computeIsActive({
        isRunning: false,
        runningTerminalId: undefined,
        sessionKey: 'claude:session-abc',
        activeSessionKey: 'claude:session-abc',
        activeTerminalId: undefined,
      })).toBe(true)
    })

    it('does not highlight when sessionKey differs from activeSessionKey', () => {
      expect(computeIsActive({
        isRunning: false,
        runningTerminalId: undefined,
        sessionKey: 'claude:session-abc',
        activeSessionKey: 'claude:session-xyz',
        activeTerminalId: undefined,
      })).toBe(false)
    })

    // THE BUG: running session should highlight via sessionKey when
    // activeTerminalId is undefined (multi-pane tab where tab-level
    // terminalId was never set)
    it('highlights a running session via sessionKey when activeTerminalId is undefined', () => {
      expect(computeIsActive({
        isRunning: true,
        runningTerminalId: 'term-1',
        sessionKey: 'codex:session-def',
        activeSessionKey: 'codex:session-def',
        activeTerminalId: undefined,
      })).toBe(true)
    })

    // Running session should highlight via sessionKey even when
    // activeTerminalId points to a different terminal
    it('highlights a running session via sessionKey when activeTerminalId is a different terminal', () => {
      expect(computeIsActive({
        isRunning: true,
        runningTerminalId: 'term-2',
        sessionKey: 'claude:session-abc',
        activeSessionKey: 'claude:session-abc',
        activeTerminalId: 'term-1',
      })).toBe(true)
    })

    // Prevents double-highlight: when activeSessionKey points to session A,
    // a different running session whose terminalId matches activeTerminalId
    // should NOT highlight
    it('does not highlight a running session via stale terminalId when activeSessionKey points elsewhere', () => {
      expect(computeIsActive({
        isRunning: true,
        runningTerminalId: 'term-1',
        sessionKey: 'claude:session-other',
        activeSessionKey: 'claude:session-abc',
        activeTerminalId: 'term-1',
      })).toBe(false)
    })
  })

  describe('when activeSessionKey is null (fallback to terminalId)', () => {
    it('highlights a running session when activeTerminalId matches', () => {
      expect(computeIsActive({
        isRunning: true,
        runningTerminalId: 'term-1',
        sessionKey: 'claude:session-abc',
        activeSessionKey: null,
        activeTerminalId: 'term-1',
      })).toBe(true)
    })

    it('does not highlight a running session when activeTerminalId differs', () => {
      expect(computeIsActive({
        isRunning: true,
        runningTerminalId: 'term-2',
        sessionKey: 'claude:session-abc',
        activeSessionKey: null,
        activeTerminalId: 'term-1',
      })).toBe(false)
    })

    it('does not highlight a non-running session when activeSessionKey is null', () => {
      expect(computeIsActive({
        isRunning: false,
        runningTerminalId: undefined,
        sessionKey: 'claude:session-abc',
        activeSessionKey: null,
        activeTerminalId: undefined,
      })).toBe(false)
    })
  })
})
