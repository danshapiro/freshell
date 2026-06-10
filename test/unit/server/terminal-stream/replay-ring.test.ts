import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_TERMINAL_REPLAY_RING_MAX_BYTES,
  ReplayRing,
} from '../../../../server/terminal-stream/replay-ring'

const STREAM_ID = 'stream-1'

function append(ring: ReplayRing, data: string, streamId = STREAM_ID) {
  return ring.append(data, { streamId })
}

describe('ReplayRing', () => {
  const originalMaxBytes = process.env.TERMINAL_REPLAY_RING_MAX_BYTES

  afterEach(() => {
    if (originalMaxBytes === undefined) {
      delete process.env.TERMINAL_REPLAY_RING_MAX_BYTES
    } else {
      process.env.TERMINAL_REPLAY_RING_MAX_BYTES = originalMaxBytes
    }
  })

  it('assigns monotonic sequence numbers starting at 1', () => {
    const ring = new ReplayRing(1024)
    const one = append(ring, 'a')
    const two = append(ring, 'b')
    const three = append(ring, 'c')

    expect(one.seqStart).toBe(1)
    expect(one.seqEnd).toBe(1)
    expect(two.seqStart).toBe(2)
    expect(three.seqEnd).toBe(3)
    expect(ring.headSeq()).toBe(3)
    expect(ring.tailSeq()).toBe(1)
  })

  it('evicts oldest frames to enforce byte budget', () => {
    const ring = new ReplayRing(5)
    append(ring, 'abc') // 3
    append(ring, 'de') // 2 (total 5)
    append(ring, 'f') // 1 (evict seq 1)

    expect(ring.headSeq()).toBe(3)
    expect(ring.tailSeq()).toBe(2)
    const replay = ring.replaySince(0)
    expect(replay.frames.map((f) => f.seqStart)).toEqual([2, 3])
  })

  it('replays only frames newer than sinceSeq', () => {
    const ring = new ReplayRing(1024)
    append(ring, 'a')
    append(ring, 'b')
    append(ring, 'c')

    const replay = ring.replaySince(1)
    expect(replay.frames.map((f) => f.data)).toEqual(['b', 'c'])
    expect(replay.frames[0].seqStart).toBe(2)
    expect(replay.frames[1].seqEnd).toBe(3)
  })

  it('returns coalesced bounded replay batches without materializing the full replay window', () => {
    const ring = new ReplayRing(1024)
    append(ring, 'aa')
    append(ring, 'bb')
    append(ring, 'cc')
    append(ring, 'dd')

    const firstBatch = ring.replayBatchSince(0, 4, 4)
    expect(firstBatch.frames).toHaveLength(1)
    expect(firstBatch.frames[0]).toMatchObject({
      seqStart: 1,
      seqEnd: 2,
      data: 'aabb',
      bytes: 4,
    })
    expect(firstBatch.missedFromSeq).toBeUndefined()

    const secondBatch = ring.replayBatchSince(firstBatch.frames.at(-1)?.seqEnd, 4, 4)
    expect(secondBatch.frames).toHaveLength(1)
    expect(secondBatch.frames[0]).toMatchObject({
      seqStart: 3,
      seqEnd: 4,
      data: 'ccdd',
      bytes: 4,
    })
  })

  it('splits coalesced replay batches at the byte budget', () => {
    const ring = new ReplayRing(1024)
    append(ring, 'aaa')
    append(ring, 'bbb')
    append(ring, 'ccc')

    const firstBatch = ring.replayBatchSince(0, 6, 3)
    expect(firstBatch.frames).toHaveLength(1)
    expect(firstBatch.frames[0]).toMatchObject({
      seqStart: 1,
      seqEnd: 2,
      data: 'aaabbb',
      bytes: 6,
    })

    const secondBatch = ring.replayBatchSince(firstBatch.frames[0].seqEnd, 6, 3)
    expect(secondBatch.frames).toHaveLength(1)
    expect(secondBatch.frames[0]).toMatchObject({
      seqStart: 3,
      seqEnd: 3,
      data: 'ccc',
      bytes: 3,
    })
  })

  it('does not coalesce replay batches across retained parser barriers', () => {
    const ring = new ReplayRing(1024)
    append(ring, 'before')
    append(ring, '\u001b[31m')
    append(ring, 'after')

    const batch = ring.replayBatchSince(0, 1024, 3)

    expect(batch.frames.map((frame) => frame.data)).toEqual([
      'before',
      '\u001b[31m',
      'after',
    ])
    expect(batch.frames[1]).toMatchObject({
      seqStart: 2,
      seqEnd: 2,
      barrier: true,
      barrierReason: 'control',
      scannerStateBefore: { mode: 'ground' },
      scannerStateAfter: { mode: 'ground' },
    })
  })

  it('does not re-coalesce retained fragments into oversized serialized payloads', () => {
    const ring = new ReplayRing(1024)
    append(ring, 'a'.repeat(60))
    append(ring, 'b'.repeat(60))

    const measureSerializedPayload = (frame: { data: string }) => 100 + frame.data.length
    const firstBatch = ring.replayBatchSince(0, 170, 2, measureSerializedPayload)

    expect(firstBatch.frames).toHaveLength(1)
    expect(firstBatch.frames[0]).toMatchObject({
      seqStart: 1,
      seqEnd: 1,
      data: 'a'.repeat(60),
    })

    const secondBatch = ring.replayBatchSince(firstBatch.frames[0].seqEnd, 170, 2, measureSerializedPayload)
    expect(secondBatch.frames).toHaveLength(1)
    expect(secondBatch.frames[0]).toMatchObject({
      seqStart: 2,
      seqEnd: 2,
      data: 'b'.repeat(60),
    })
  })

  it('does not coalesce adjacent replay frames from different stream ids', () => {
    const ring = new ReplayRing(1024)
    append(ring, 'old', 'stream-old')
    append(ring, 'new', 'stream-new')

    const limitedBatch = ring.replayBatchSince(0, 3, 2)
    expect(limitedBatch.frames).toHaveLength(1)
    expect(limitedBatch.frames[0]).toMatchObject({
      seqStart: 1,
      seqEnd: 1,
      data: 'old',
      streamId: 'stream-old',
    })

    const batch = ring.replayBatchSince(0, 1024, 2)

    expect(batch.frames).toHaveLength(2)
    expect(batch.frames[0]).toMatchObject({
      seqStart: 1,
      seqEnd: 1,
      data: 'old',
      streamId: 'stream-old',
    })
    expect(batch.frames[1]).toMatchObject({
      seqStart: 2,
      seqEnd: 2,
      data: 'new',
      streamId: 'stream-new',
    })
  })

  it('reports replay miss when requested sequence is older than tail', () => {
    const ring = new ReplayRing(2)
    append(ring, '1')
    append(ring, '2')
    append(ring, '3')
    append(ring, '4')
    append(ring, '5')

    expect(ring.headSeq()).toBe(5)
    expect(ring.tailSeq()).toBe(4)

    const replay = ring.replaySince(2)
    expect(replay.missedFromSeq).toBe(3)
    expect(replay.frames.map((f) => f.seqStart)).toEqual([4, 5])
  })

  it('enforces default max bytes when no constructor/env override is provided', () => {
    delete process.env.TERMINAL_REPLAY_RING_MAX_BYTES
    const ring = new ReplayRing()
    const half = 'x'.repeat(DEFAULT_TERMINAL_REPLAY_RING_MAX_BYTES / 2)

    append(ring, half)
    append(ring, half)
    expect(ring.tailSeq()).toBe(1)

    append(ring, 'y')
    expect(ring.headSeq()).toBe(3)
    expect(ring.tailSeq()).toBe(2)
  })

  it('supports runtime max-byte resize and re-evicts to the new budget', () => {
    const ring = new ReplayRing(1024)
    append(ring, 'x'.repeat(300))
    append(ring, 'y'.repeat(300))
    append(ring, 'z'.repeat(300))

    ring.setMaxBytes(400)

    const replay = ring.replaySince(0)
    const total = replay.frames.reduce((sum, frame) => sum + frame.bytes, 0)
    expect(total).toBeLessThanOrEqual(400)
  })

  it('retains truncated tail bytes when a single append exceeds maxBytes', () => {
    const ring = new ReplayRing(8)
    append(ring, '0123456789')

    const replay = ring.replaySince(0)
    expect(replay.frames).toHaveLength(1)
    expect(replay.frames[0].seqStart).toBe(1)
    expect(replay.frames[0].bytes).toBeLessThanOrEqual(8)
    expect(replay.missedFromSeq).toBeUndefined()
  })

  it('marks a retained tail truncated inside OSC as fail-closed barrier metadata', () => {
    const ring = new ReplayRing(8)
    const frame = append(ring, `\u001b]52;c;${'A'.repeat(32)}`)

    expect(frame.data).toBe('A'.repeat(8))
    expect(frame).toMatchObject({
      barrier: true,
      barrierReason: 'osc52',
      scannerStateBefore: { mode: 'ground' },
      scannerStateAfter: { mode: 'osc' },
    })
  })

  it('keeps retained tails truncated inside CSI from batching as transparent text', () => {
    const ring = new ReplayRing(8)
    append(ring, `\u001b[${'1'.repeat(32)}`)
    ring.setMaxBytes(1024)
    append(ring, 'after')

    const replay = ring.replaySince(0)
    expect(replay.frames[0]).toMatchObject({
      data: '1'.repeat(8),
      barrier: true,
      barrierReason: 'control',
      scannerStateBefore: { mode: 'ground' },
      scannerStateAfter: { mode: 'csi' },
    })
    expect(replay.frames[1]).toMatchObject({
      data: 'after',
      barrier: true,
      barrierReason: 'control',
      scannerStateBefore: { mode: 'csi' },
      scannerStateAfter: { mode: 'ground' },
    })

    const batch = ring.replayBatchSince(0, 1024, 2)
    expect(batch.frames.map((frame) => frame.data)).toEqual(['1'.repeat(8), 'after'])
  })

  it('truncates oversized multi-byte frames on UTF-8 boundaries', () => {
    const ring = new ReplayRing(7)
    append(ring, '🙂🙂🙂')

    const replay = ring.replaySince(0)
    expect(replay.frames).toHaveLength(1)
    expect(replay.frames[0].bytes).toBeLessThanOrEqual(7)
    expect(replay.frames[0].data).toBe('🙂')
  })

  it('preserves literal U+FFFD characters emitted by the source output', () => {
    const ring = new ReplayRing(4)
    append(ring, `A\uFFFDB`)

    const replay = ring.replaySince(0)
    expect(replay.frames).toHaveLength(1)
    expect(replay.frames[0].bytes).toBeLessThanOrEqual(4)
    expect(replay.frames[0].data).toBe('\uFFFDB')
  })

  it('keeps the current head anchor stable after older frames overflow out of the replay window', () => {
    const ring = new ReplayRing(3)
    append(ring, 'a')
    append(ring, 'b')
    append(ring, 'c')
    append(ring, 'd')

    expect(ring.headSeq()).toBe(4)
    expect(ring.tailSeq()).toBe(2)

    const replay = ring.replaySince(ring.headSeq())
    expect(replay.frames).toEqual([])
    expect(replay.missedFromSeq).toBeUndefined()
  })
})
