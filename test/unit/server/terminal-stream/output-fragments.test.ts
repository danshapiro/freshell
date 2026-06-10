import { describe, expect, it } from 'vitest'
import { measureTerminalOutputPayloadBytes } from '../../../../server/terminal-stream/serialized-budget'
import {
  containsLoneSurrogate,
  fragmentTerminalOutputForPayloadBudget,
} from '../../../../server/terminal-stream/output-fragments'

describe('terminal output fragmentation', () => {
  it('fragments escaped output before sequence assignment so every payload fits the budget', () => {
    const data = '\u001b'.repeat(16 * 1024)
    const chunks = fragmentTerminalOutputForPayloadBudget({
      maxSerializedBytes: 16 * 1024,
      payloadForData: (chunk) => ({
        type: 'terminal.output',
        terminalId: 'term-1',
        data: chunk,
        seqStart: 1,
        seqEnd: 1,
        attachRequestId: 'attach-1',
      }),
      data,
    })

    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(measureTerminalOutputPayloadBytes({
        type: 'terminal.output',
        terminalId: 'term-1',
        data: chunk,
        seqStart: 1,
        seqEnd: 1,
        attachRequestId: 'attach-1',
      })).toBeLessThanOrEqual(16 * 1024)
    }
    expect(chunks.join('')).toBe(data)
  })

  it('does not split surrogate pairs', () => {
    const data = `prefix-${'😀'.repeat(2048)}-suffix`
    const chunks = fragmentTerminalOutputForPayloadBudget({
      maxSerializedBytes: 2048,
      payloadForData: (chunk) => ({
        type: 'terminal.output',
        terminalId: 'term-1',
        data: chunk,
        seqStart: 1,
        seqEnd: 1,
        attachRequestId: 'attach-1',
      }),
      data,
    })

    expect(chunks.join('')).toBe(data)
    expect(chunks.every((chunk) => !containsLoneSurrogate(chunk))).toBe(true)
  })

  it('preserves lone surrogates already present in string-mode output', () => {
    const data = `prefix-\uD800-middle-\uDC00-suffix`
    const chunks = fragmentTerminalOutputForPayloadBudget({
      maxSerializedBytes: 128,
      payloadForData: (chunk) => ({
        type: 'terminal.output',
        terminalId: 'term-1',
        data: chunk,
        seqStart: 1,
        seqEnd: 1,
        attachRequestId: 'attach-1',
      }),
      data,
    })

    expect(chunks.join('')).toBe(data)
    expect(chunks.some((chunk) => containsLoneSurrogate(chunk))).toBe(true)
  })

  it('throws when the budget is too small for one code point', () => {
    expect(() => fragmentTerminalOutputForPayloadBudget({
      maxSerializedBytes: 1,
      payloadForData: (chunk) => ({
        type: 'terminal.output',
        terminalId: 'term-1',
        data: chunk,
        seqStart: 1,
        seqEnd: 1,
      }),
      data: 'x',
    })).toThrow(/too small for one code point/)
  })

  it('preserves replacement characters emitted by current string-mode PTY decoding', () => {
    const data = `prefix-\uFFFD-\uFFFD-suffix`
    const chunks = fragmentTerminalOutputForPayloadBudget({
      maxSerializedBytes: 2048,
      payloadForData: (chunk) => ({
        type: 'terminal.output',
        terminalId: 'term-1',
        data: chunk,
        seqStart: 1,
        seqEnd: 1,
        attachRequestId: 'attach-1',
      }),
      data,
    })

    // node-pty currently delivers terminal output as JavaScript strings. Invalid
    // UTF-8 and raw 8-bit C1 bytes are already represented as replacement
    // characters by this point, so Task 5 preserves them without claiming
    // byte-perfect replay.
    expect(chunks.join('')).toBe(data)
  })
})
