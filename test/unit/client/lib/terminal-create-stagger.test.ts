import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TerminalCreateStagger,
  getTerminalCreateStagger,
  resetTerminalCreateStaggerForTests,
} from '@/lib/terminal-create-stagger'

describe('TerminalCreateStagger', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetTerminalCreateStaggerForTests()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends the first message immediately (no prior send)', () => {
    const stagger = new TerminalCreateStagger()
    const sent: string[] = []
    stagger.enqueue(() => { sent.push('a') })
    vi.advanceTimersByTime(0)
    expect(sent).toEqual(['a'])
  })

  it('spaces subsequent sends by STAGGER_INTERVAL_MS (450ms)', () => {
    const stagger = new TerminalCreateStagger()
    const sent: string[] = []
    stagger.enqueue(() => { sent.push('a') })
    stagger.enqueue(() => { sent.push('b') })
    stagger.enqueue(() => { sent.push('c') })
    vi.advanceTimersByTime(0)
    expect(sent).toEqual(['a'])
    vi.advanceTimersByTime(450)
    expect(sent).toEqual(['a', 'b'])
    vi.advanceTimersByTime(450)
    expect(sent).toEqual(['a', 'b', 'c'])
  })

  it('no two sends land within the same 100ms window', () => {
    const stagger = new TerminalCreateStagger()
    const timestamps: number[] = []
    for (let i = 0; i < 5; i++) {
      stagger.enqueue(() => { timestamps.push(Date.now()) })
    }
    vi.advanceTimersByTime(0)
    vi.advanceTimersByTime(450)
    vi.advanceTimersByTime(450)
    vi.advanceTimersByTime(450)
    vi.advanceTimersByTime(450)
    expect(timestamps).toHaveLength(5)
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i] - timestamps[i - 1]).toBeGreaterThanOrEqual(450)
    }
  })

  it('clear drops all pending sends and resets lastSendAt', () => {
    const stagger = new TerminalCreateStagger()
    const sent: string[] = []
    stagger.enqueue(() => { sent.push('a') })
    stagger.enqueue(() => { sent.push('b') })
    stagger.enqueue(() => { sent.push('c') })
    vi.advanceTimersByTime(0)
    expect(sent).toEqual(['a'])
    stagger.clear()
    vi.advanceTimersByTime(1000)
    expect(sent).toEqual(['a'])
    // After clear(), lastSendAt is reset — next send goes immediately
    stagger.enqueue(() => { sent.push('d') })
    vi.advanceTimersByTime(0)
    expect(sent).toEqual(['a', 'd'])
  })

  it('resetForTests clears pending and resets lastSendAt', () => {
    const stagger = new TerminalCreateStagger()
    const sent: string[] = []
    stagger.enqueue(() => { sent.push('a') })
    vi.advanceTimersByTime(0)
    expect(sent).toEqual(['a'])
    stagger.resetForTests()
    stagger.enqueue(() => { sent.push('b') })
    vi.advanceTimersByTime(0)
    expect(sent).toEqual(['a', 'b'])
  })

  it('getTerminalCreateStagger returns a singleton reset by resetTerminalCreateStaggerForTests', () => {
    const first = getTerminalCreateStagger()
    expect(getTerminalCreateStagger()).toBe(first)
    resetTerminalCreateStaggerForTests()
    expect(getTerminalCreateStagger()).not.toBe(first)
  })

  it('handles enqueue from within a send callback (pump re-entrancy)', () => {
    const stagger = new TerminalCreateStagger()
    const sent: string[] = []
    stagger.enqueue(() => {
      sent.push('a')
      stagger.enqueue(() => { sent.push('b') })
    })
    vi.advanceTimersByTime(0)
    expect(sent).toEqual(['a'])
    vi.advanceTimersByTime(450)
    expect(sent).toEqual(['a', 'b'])
  })
})
