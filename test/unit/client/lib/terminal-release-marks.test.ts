import { describe, it, expect, beforeEach } from 'vitest'
import {
  markTerminalReleased,
  consumeTerminalReleaseMark,
  resetTerminalReleaseMarks,
} from '@/lib/terminal-release-marks'

describe('terminal release marks', () => {
  beforeEach(() => {
    resetTerminalReleaseMarks()
  })

  it('consume returns false for an unmarked terminal', () => {
    expect(consumeTerminalReleaseMark('term-1')).toBe(false)
  })

  it('consume returns true exactly once for a marked terminal', () => {
    markTerminalReleased('term-1')
    expect(consumeTerminalReleaseMark('term-1')).toBe(true)
    expect(consumeTerminalReleaseMark('term-1')).toBe(false)
  })

  it('marks are independent per terminal id', () => {
    markTerminalReleased('term-1')
    expect(consumeTerminalReleaseMark('term-2')).toBe(false)
    expect(consumeTerminalReleaseMark('term-1')).toBe(true)
  })

  it('reset clears all marks', () => {
    markTerminalReleased('term-1')
    resetTerminalReleaseMarks()
    expect(consumeTerminalReleaseMark('term-1')).toBe(false)
  })
})
