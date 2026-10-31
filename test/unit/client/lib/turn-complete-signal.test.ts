import { describe, it, expect } from 'vitest'
import {
  createTurnCompleteSignalParserState,
  extractTurnCompleteSignals,
  normalizeTurnCompleteSignalMode,
  TURN_COMPLETE_SIGNAL,
} from '@/lib/turn-complete-signal'

describe('normalizeTurnCompleteSignalMode', () => {
  it('preserves the turn-signal-capable modes', () => {
    expect(normalizeTurnCompleteSignalMode('claude')).toBe('claude')
    expect(normalizeTurnCompleteSignalMode('codex')).toBe('codex')
    expect(normalizeTurnCompleteSignalMode('opencode')).toBe('opencode')
  })

  it('maps gemini/kimi to shell (status-inert; agrees with supportsTurnSignal)', () => {
    expect(normalizeTurnCompleteSignalMode('gemini')).toBe('shell')
    expect(normalizeTurnCompleteSignalMode('kimi')).toBe('shell')
  })

  it('maps antigravity to shell (NOT a BEL mode — plan Task 8 negative pin)', () => {
    // Antigravity is server-authoritative: its turn-completion attention
    // flows from the transcript lane (terminal.turn.complete +
    // terminal.idle), never from a BEL byte. The shared
    // `supportsTurnSignal` gate stays claude|codex only.
    expect(normalizeTurnCompleteSignalMode('antigravity')).toBe('shell')
    expect(extractTurnCompleteSignals(`x${TURN_COMPLETE_SIGNAL}y`, 'antigravity')).toEqual({
      cleaned: `x${TURN_COMPLETE_SIGNAL}y`,
      count: 0,
    })
  })
})

describe('extractTurnCompleteSignals', () => {
  it('extracts BEL for codex and strips it from output', () => {
    const input = `hello${TURN_COMPLETE_SIGNAL}world`
    const out = extractTurnCompleteSignals(input, 'codex')
    expect(out.count).toBe(1)
    expect(out.cleaned).toBe('helloworld')
  })

  it('extracts BEL for claude and strips all signal bytes', () => {
    const input = `${TURN_COMPLETE_SIGNAL}a${TURN_COMPLETE_SIGNAL}b${TURN_COMPLETE_SIGNAL}`
    const out = extractTurnCompleteSignals(input, 'claude')
    expect(out.count).toBe(3)
    expect(out.cleaned).toBe('ab')
  })

  it('ignores BEL in shell mode', () => {
    const input = `x${TURN_COMPLETE_SIGNAL}y`
    const out = extractTurnCompleteSignals(input, 'shell')
    expect(out.count).toBe(0)
    expect(out.cleaned).toBe(input)
  })

  it('ignores BEL for providers without turn-complete signals', () => {
    const input = `x${TURN_COMPLETE_SIGNAL}y`
    const out = extractTurnCompleteSignals(input, 'gemini')
    expect(out.count).toBe(0)
    expect(out.cleaned).toBe(input)
  })

  it('ignores non-signal output in codex mode', () => {
    const input = 'normal output'
    const out = extractTurnCompleteSignals(input, 'codex')
    expect(out.count).toBe(0)
    expect(out.cleaned).toBe(input)
  })

  it('preserves BEL when it terminates an OSC sequence', () => {
    const input = '\x1b]0;tab-title\x07'
    const out = extractTurnCompleteSignals(input, 'codex')
    expect(out.count).toBe(0)
    expect(out.cleaned).toBe(input)
  })

  it('tracks parser state across chunks so split OSC sequences are preserved', () => {
    const state = createTurnCompleteSignalParserState()

    const first = extractTurnCompleteSignals('\x1b', 'claude', state)
    const second = extractTurnCompleteSignals(']0;tab-title\x07done', 'claude', state)

    expect(first.count).toBe(0)
    expect(first.cleaned).toBe('')
    expect(second.count).toBe(0)
    expect(second.cleaned).toBe('\x1b]0;tab-title\x07done')
  })

  it('preserves C1 ST when it terminates an OSC sequence', () => {
    const input = '\x1b]0;tab-title\x9c'
    const out = extractTurnCompleteSignals(input, 'codex')
    expect(out.count).toBe(0)
    expect(out.cleaned).toBe(input)
  })

  it('counts BEL after OSC terminated by C1 ST', () => {
    const state = createTurnCompleteSignalParserState()
    const osc = extractTurnCompleteSignals('\x1b]0;tab-title\x9c', 'claude', state)
    const bell = extractTurnCompleteSignals('\x07done', 'claude', state)

    expect(osc.count).toBe(0)
    expect(osc.cleaned).toBe('\x1b]0;tab-title\x9c')
    expect(bell.count).toBe(1)
    expect(bell.cleaned).toBe('done')
  })

  it('tracks split CSI sequences across chunks so a later BEL still counts', () => {
    const state = createTurnCompleteSignalParserState()

    const first = extractTurnCompleteSignals('\x1b[', 'codex', state)
    const second = extractTurnCompleteSignals(`0m${TURN_COMPLETE_SIGNAL}done`, 'codex', state)

    expect(first).toEqual({ cleaned: '\x1b[', count: 0 })
    expect(second).toEqual({ cleaned: '0mdone', count: 1 })
  })

  it('tracks split DCS sequences across chunks and only counts BEL after the terminator', () => {
    const state = createTurnCompleteSignalParserState()

    const first = extractTurnCompleteSignals('\x1bP', 'codex', state)
    const second = extractTurnCompleteSignals(`qpayload${TURN_COMPLETE_SIGNAL}\x1b\\${TURN_COMPLETE_SIGNAL}done`, 'codex', state)

    expect(first).toEqual({ cleaned: '\x1bP', count: 0 })
    expect(second).toEqual({ cleaned: `qpayload${TURN_COMPLETE_SIGNAL}\x1b\\done`, count: 1 })
  })
})
