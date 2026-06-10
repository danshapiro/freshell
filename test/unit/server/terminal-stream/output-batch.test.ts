import { describe, expect, it } from 'vitest'
import { buildTerminalOutputBatches } from '../../../../server/terminal-stream/output-batch'
import type {
  TerminalOutputBarrierReason,
  TerminalOutputScannerState,
} from '../../../../server/terminal-stream/output-barrier-scanner'
import { measureTerminalOutputPayloadBytes } from '../../../../server/terminal-stream/serialized-budget'
import type { ReplayFrame } from '../../../../server/terminal-stream/replay-ring'

type TestFrame = ReplayFrame & {
  barrier: boolean
  barrierReason?: TerminalOutputBarrierReason
  scannerStateBefore: TerminalOutputScannerState
  scannerStateAfter: TerminalOutputScannerState
}

const GROUND: TerminalOutputScannerState = { mode: 'ground' }

function transparentFrame(seq: number, data: string, streamId = 'stream-1'): TestFrame {
  return {
    seqStart: seq,
    seqEnd: seq,
    data,
    bytes: Buffer.byteLength(data, 'utf8'),
    at: seq,
    streamId,
    barrier: false,
    scannerStateBefore: GROUND,
    scannerStateAfter: GROUND,
  }
}

function barrierFrame(
  seq: number,
  data: string,
  barrierReason: TerminalOutputBarrierReason,
  streamId = 'stream-1',
): TestFrame {
  return {
    ...transparentFrame(seq, data, streamId),
    barrier: true,
    barrierReason,
  }
}

function build(frames: TestFrame[], maxSerializedBytes = 16 * 1024) {
  return buildTerminalOutputBatches({
    terminalId: 'term-1',
    attachRequestId: 'attach-1',
    source: 'replay',
    maxSerializedBytes,
    frames,
  })
}

describe('terminal output batch builder', () => {
  it('coalesces contiguous transparent frames under the serialized budget and emits segment metadata', () => {
    const batches = build([
      transparentFrame(1, 'a'),
      transparentFrame(2, 'b'),
    ])

    expect(batches).toHaveLength(1)
    expect(batches[0]).toMatchObject({
      seqStart: 1,
      seqEnd: 2,
      data: 'ab',
      streamId: 'stream-1',
      attachRequestId: 'attach-1',
      source: 'replay',
      barrier: false,
      scannerStateBefore: { mode: 'ground' },
      scannerStateAfter: { mode: 'ground' },
    })
    expect(batches[0].segments).toEqual([
      {
        seqStart: 1,
        seqEnd: 1,
        streamId: 'stream-1',
        offset: 0,
        endOffset: 1,
        bytes: 1,
        barrier: false,
        scannerStateBefore: { mode: 'ground' },
        scannerStateAfter: { mode: 'ground' },
      },
      {
        seqStart: 2,
        seqEnd: 2,
        streamId: 'stream-1',
        offset: 1,
        endOffset: 2,
        bytes: 1,
        barrier: false,
        scannerStateBefore: { mode: 'ground' },
        scannerStateAfter: { mode: 'ground' },
      },
    ])
  })

  it('does not coalesce across parser barriers', () => {
    const batches = build([
      transparentFrame(1, 'a'),
      barrierFrame(2, '\u0007', 'turn_complete'),
      transparentFrame(3, 'b'),
    ])

    expect(batches.map((batch) => batch.data)).toEqual(['a', '\u0007', 'b'])
    expect(batches.map((batch) => batch.seqStart)).toEqual([1, 2, 3])
    expect(batches[1]).toMatchObject({
      barrier: true,
      barrierReason: 'turn_complete',
      segments: [
        {
          seqStart: 2,
          seqEnd: 2,
          streamId: 'stream-1',
          offset: 0,
          endOffset: 1,
          barrier: true,
          barrierReason: 'turn_complete',
        },
      ],
    })
  })

  it('does not coalesce across stream boundaries', () => {
    const batches = build([
      transparentFrame(1, 'old', 'stream-old'),
      transparentFrame(2, 'new', 'stream-new'),
    ])

    expect(batches).toHaveLength(2)
    expect(batches[0]).toMatchObject({
      seqStart: 1,
      seqEnd: 1,
      data: 'old',
      streamId: 'stream-old',
    })
    expect(batches[1]).toMatchObject({
      seqStart: 2,
      seqEnd: 2,
      data: 'new',
      streamId: 'stream-new',
    })
  })

  it('uses UTF-16 code-unit segment offsets on code-point boundaries', () => {
    const batches = build([
      transparentFrame(1, '😀'),
      transparentFrame(2, 'b'),
    ])

    expect(batches).toHaveLength(1)
    expect(batches[0].data).toBe('😀b')
    expect(batches[0].segments).toMatchObject([
      { seqStart: 1, seqEnd: 1, offset: 0, endOffset: 2 },
      { seqStart: 2, seqEnd: 2, offset: 2, endOffset: 3 },
    ])
  })

  it('uses stored scanner metadata instead of rescanning retained windows from ground', () => {
    const batches = build([
      {
        ...transparentFrame(2, '6n'),
        barrier: true,
        barrierReason: 'request_mode',
        scannerStateBefore: { mode: 'csi' },
        scannerStateAfter: { mode: 'ground' },
      },
      transparentFrame(3, 'after'),
    ])

    expect(batches.map((batch) => batch.data)).toEqual(['6n', 'after'])
    expect(batches[0]).toMatchObject({
      barrier: true,
      barrierReason: 'request_mode',
      scannerStateBefore: { mode: 'csi' },
      scannerStateAfter: { mode: 'ground' },
    })
  })

  it('does not re-coalesce serialized-budget fragments across control barriers and keeps batches within budget', () => {
    const frames = Array.from({ length: 8 }, (_unused, index) => barrierFrame(
      index + 1,
      '\u001b'.repeat(2048),
      'control',
    ))
    const maxSerializedBytes = 16 * 1024

    const batches = build(frames, maxSerializedBytes)

    expect(batches).toHaveLength(frames.length)
    expect(new Set(batches.map((batch) => `${batch.seqStart}:${batch.seqEnd}`)).size)
      .toBe(batches.length)
    expect(batches.every((batch) => batch.legacyOutputSerializedBytes <= maxSerializedBytes)).toBe(true)
    expect(batches.every((batch) =>
      measureTerminalOutputPayloadBytes({
        type: 'terminal.output',
        terminalId: 'term-1',
        streamId: batch.streamId,
        seqStart: batch.seqStart,
        seqEnd: batch.seqEnd,
        data: batch.data,
        attachRequestId: 'attach-1',
      }) <= maxSerializedBytes,
    )).toBe(true)
  })

  it('coalesces many small transparent frames without changing segment offsets', () => {
    const frames = Array.from({ length: 4096 }, (_unused, index) => transparentFrame(index + 1, 'x'))

    const batches = build(frames)

    expect(batches).toHaveLength(1)
    expect(batches[0]).toMatchObject({
      seqStart: 1,
      seqEnd: 4096,
    })
    expect(batches[0].data).toHaveLength(4096)
    expect(batches[0].segments).toHaveLength(4096)
    expect(batches[0].segments[4095]).toMatchObject({
      seqStart: 4096,
      seqEnd: 4096,
      offset: 4095,
      endOffset: 4096,
    })
  })
})
