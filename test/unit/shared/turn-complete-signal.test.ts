import { describe, expect, it } from 'vitest'
import {
  TURN_COMPLETE_SIGNAL,
  createTurnCompleteSignalParserState,
  extractTurnCompleteSignals,
} from '../../../shared/turn-complete-signal'

describe('shared turn-complete signal parser', () => {
  it('counts BEL in Codex output and strips it from cleaned output', () => {
    const input = `hello${TURN_COMPLETE_SIGNAL}world`
    const out = extractTurnCompleteSignals(input, 'codex')

    expect(out.count).toBe(1)
    expect(out.cleaned).toBe('helloworld')
  })

  it('preserves BEL when it terminates an OSC sequence', () => {
    const input = '\x1b]0;tab-title\x07'
    const out = extractTurnCompleteSignals(input, 'codex')

    expect(out.count).toBe(0)
    expect(out.cleaned).toBe(input)
  })

  it('preserves split ESC ] OSC sequences across chunks with parser state', () => {
    const state = createTurnCompleteSignalParserState()

    const first = extractTurnCompleteSignals('\x1b', 'claude', state)
    const second = extractTurnCompleteSignals(']0;tab-title\x07done', 'claude', state)

    expect(first.count).toBe(0)
    expect(first.cleaned).toBe('')
    expect(second.count).toBe(0)
    expect(second.cleaned).toBe('\x1b]0;tab-title\x07done')
  })

  it('supports independent parser state for browser and server consumers', () => {
    const browserState = createTurnCompleteSignalParserState()
    const serverState = createTurnCompleteSignalParserState()

    const browserFirst = extractTurnCompleteSignals('\x1b', 'claude', browserState)
    const browserSecond = extractTurnCompleteSignals(']0;title\x07browser', 'claude', browserState)
    const serverOut = extractTurnCompleteSignals(`server${TURN_COMPLETE_SIGNAL}`, 'codex', serverState)

    expect(browserFirst).toEqual({ cleaned: '', count: 0 })
    expect(browserSecond).toEqual({ cleaned: '\x1b]0;title\x07browser', count: 0 })
    expect(serverOut).toEqual({ cleaned: 'server', count: 1 })
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
