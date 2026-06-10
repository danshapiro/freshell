import { describe, expect, it } from 'vitest'
import { measureTerminalOutputPayloadBytes } from '../../../../server/terminal-stream/serialized-budget'

describe('terminal stream serialized budget', () => {
  it('measures escaped JSON bytes instead of raw data bytes', () => {
    const data = '\u001b'.repeat(16 * 1024)
    const bytes = measureTerminalOutputPayloadBytes({
      type: 'terminal.output',
      terminalId: 'term-1',
      data,
      seqStart: 1,
      seqEnd: 1,
      attachRequestId: 'attach-1',
    })

    expect(Buffer.byteLength(data, 'utf8')).toBe(16 * 1024)
    expect(bytes).toBeGreaterThan(16 * 1024)
  })
})
