import { describe, expect, it } from 'vitest'
import { createTerminalOutputBarrierScanner } from '../../../../server/terminal-stream/output-barrier-scanner'

describe('terminal output barrier scanner', () => {
  it('treats plain printable text and newlines as transparent', () => {
    const scanner = createTerminalOutputBarrierScanner()

    expect(scanner.scan('hello\nworld\r\n')).toMatchObject({
      barrier: false,
      ground: true,
      stateBefore: { mode: 'ground' },
      stateAfter: { mode: 'ground' },
    })
  })

  it('treats escape and control sequences as barriers', () => {
    const scanner = createTerminalOutputBarrierScanner()

    expect(scanner.scan('\u001b[31mred')).toMatchObject({
      barrier: true,
      reason: 'control',
      ground: true,
      stateBefore: { mode: 'ground' },
      stateAfter: { mode: 'ground' },
    })
  })

  it('treats BEL as a turn-complete-sensitive barrier', () => {
    const scanner = createTerminalOutputBarrierScanner()

    expect(scanner.scan('\u0007')).toMatchObject({
      barrier: true,
      reason: 'turn_complete',
      ground: true,
      stateBefore: { mode: 'ground' },
      stateAfter: { mode: 'ground' },
    })
  })

  it('treats OSC sequences as OSC52-sensitive barriers', () => {
    const scanner = createTerminalOutputBarrierScanner()

    expect(scanner.scan('\u001b]52;c;SGVsbG8=\u0007')).toMatchObject({
      barrier: true,
      reason: 'osc52',
      ground: true,
      stateBefore: { mode: 'ground' },
      stateAfter: { mode: 'ground' },
    })
  })

  it('carries pending CSI state across fragments', () => {
    const scanner = createTerminalOutputBarrierScanner()

    expect(scanner.scan('\u001b[')).toMatchObject({
      barrier: true,
      reason: 'control',
      ground: false,
      stateBefore: { mode: 'ground' },
      stateAfter: { mode: 'csi' },
    })
    expect(scanner.scan('6n')).toMatchObject({
      barrier: true,
      reason: 'request_mode',
      ground: true,
      stateBefore: { mode: 'csi' },
      stateAfter: { mode: 'ground' },
    })
  })

  it('carries pending OSC state across fragments', () => {
    const scanner = createTerminalOutputBarrierScanner()

    expect(scanner.scan('\u001b]52;c;')).toMatchObject({
      barrier: true,
      reason: 'osc52',
      ground: false,
      stateBefore: { mode: 'ground' },
      stateAfter: { mode: 'osc' },
    })
    expect(scanner.scan('SGVsbG8=\u0007')).toMatchObject({
      barrier: true,
      reason: 'osc52',
      ground: true,
      stateBefore: { mode: 'osc' },
      stateAfter: { mode: 'ground' },
    })
  })

  it('treats replacement characters from lossy PTY decoding as barriers', () => {
    const scanner = createTerminalOutputBarrierScanner()

    expect(scanner.scan('\ufffd')).toMatchObject({
      barrier: true,
      reason: 'control',
      ground: true,
      stateBefore: { mode: 'ground' },
      stateAfter: { mode: 'ground' },
    })
  })

  it('returns scanner state snapshots that can be stored on retained frames', () => {
    const scanner = createTerminalOutputBarrierScanner()
    const first = scanner.scan('\u001b[')
    const second = scanner.scan('6n')

    expect(first.stateBefore).toEqual({ mode: 'ground' })
    expect(first.stateAfter).toEqual({ mode: 'csi' })
    expect(second.stateBefore).toEqual({ mode: 'csi' })
    expect(second.stateAfter).toEqual({ mode: 'ground' })
  })
})
