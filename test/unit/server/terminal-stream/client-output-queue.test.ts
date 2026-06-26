import { describe, expect, it } from 'vitest'
import { ClientOutputQueue, isGapEvent } from '../../../../server/terminal-stream/client-output-queue'
import { createTerminalOutputBarrierScanner } from '../../../../server/terminal-stream/output-barrier-scanner'
import type { ReplayFrame } from '../../../../server/terminal-stream/replay-ring'

function frame(seq: number, data: string, streamId = 'stream-1'): ReplayFrame {
  const scanner = createTerminalOutputBarrierScanner()
  const classification = scanner.scan(data)
  return {
    seqStart: seq,
    seqEnd: seq,
    data,
    bytes: Buffer.byteLength(data, 'utf8'),
    at: seq,
    streamId,
    barrier: classification.barrier,
    ...(classification.barrier ? { barrierReason: classification.reason } : {}),
    scannerStateBefore: classification.stateBefore,
    scannerStateAfter: classification.stateAfter,
  }
}

describe('ClientOutputQueue', () => {
  it('keeps pending bytes bounded by max queue size', () => {
    const queue = new ClientOutputQueue(5)
    queue.enqueue(frame(1, 'abc'))
    queue.enqueue(frame(2, 'de'))
    queue.enqueue(frame(3, 'f'))

    expect(queue.pendingBytes()).toBeLessThanOrEqual(5)
  })

  it('keeps a four-hour one-kib-per-second hidden-tab backlog by default', () => {
    const queue = new ClientOutputQueue()
    const frameCount = 4 * 60 * 60
    const queuedBytesPerSecond = 1024

    for (let seq = 1; seq <= frameCount; seq += 1) {
      queue.enqueue(frame(seq, `line-${seq}\n`), queuedBytesPerSecond)
    }

    const prepared = queue.prepareBatch(64 * 1024)

    expect(queue.pendingFrames()).toBe(frameCount)
    expect(queue.peekDroppedBytes()).toBe(0)
    expect(prepared.entries.some(isGapEvent)).toBe(false)
  })

  it('coalesces adjacent frames when queued', () => {
    const queue = new ClientOutputQueue(1024)
    queue.enqueue(frame(1, 'hello '))
    queue.enqueue(frame(2, 'world'))

    const batch = queue.nextBatch(1024)
    expect(batch).toHaveLength(1)
    expect(batch[0]).toMatchObject({
      seqStart: 1,
      seqEnd: 2,
      data: 'hello world',
    })
  })

  it('does not consume prepared frames until acknowledged', () => {
    const queue = new ClientOutputQueue(1024)
    queue.enqueue(frame(1, 'hello '))
    queue.enqueue(frame(2, 'world'))

    const prepared = queue.prepareBatch(1024)

    expect(prepared.frameCount).toBe(2)
    expect(queue.pendingFrames()).toBe(2)
    expect(queue.pendingBytes()).toBe(Buffer.byteLength('hello world', 'utf8'))

    queue.acknowledgePreparedBatch(prepared)

    expect(queue.pendingFrames()).toBe(0)
    expect(queue.pendingBytes()).toBe(0)
  })

  it('keeps an unsent prepared suffix after partial acknowledgement', () => {
    const queue = new ClientOutputQueue(1024)
    queue.enqueue(frame(1, 'one'))
    queue.enqueue(frame(2, 'two'))
    queue.enqueue(frame(3, 'three'))

    const prepared = queue.prepareBatch(1024)
    queue.acknowledgePreparedBatch(prepared, { frames: 2 })

    expect(queue.pendingFrames()).toBe(1)
    const retry = queue.nextBatch(1024)
    const dataFrames = retry.filter((entry): entry is ReplayFrame => entry.type !== 'gap')
    expect(dataFrames).toHaveLength(1)
    expect(dataFrames[0]).toMatchObject({
      seqStart: 3,
      seqEnd: 3,
      data: 'three',
    })
  })

  it('keeps overflow gaps pending until acknowledged', () => {
    const queue = new ClientOutputQueue(2)
    queue.enqueue(frame(1, '1'))
    queue.enqueue(frame(2, '2'))
    queue.enqueue(frame(3, '3'))

    const prepared = queue.prepareBatch(64)
    expect(prepared.entries[0]).toMatchObject({ type: 'gap', fromSeq: 1, toSeq: 1 })

    const retryBeforeAck = queue.prepareBatch(64)
    expect(retryBeforeAck.entries[0]).toMatchObject({ type: 'gap', fromSeq: 1, toSeq: 1 })

    queue.acknowledgePreparedBatch(prepared, { gaps: 1, frames: 0 })
    const retryAfterGapAck = queue.nextBatch(64)
    expect(retryAfterGapAck.some(isGapEvent)).toBe(false)
  })

  it('does not coalesce adjacent frames from different stream ids', () => {
    const queue = new ClientOutputQueue(1024)
    queue.enqueue(frame(1, 'old', 'stream-old'))
    queue.enqueue(frame(2, 'new', 'stream-new'))

    const batch = queue.nextBatch(1024)
    const dataFrames = batch.filter((entry): entry is ReplayFrame => entry.type !== 'gap')

    expect(dataFrames).toHaveLength(2)
    expect(dataFrames[0]).toMatchObject({
      seqStart: 1,
      seqEnd: 1,
      data: 'old',
      streamId: 'stream-old',
    })
    expect(dataFrames[1]).toMatchObject({
      seqStart: 2,
      seqEnd: 2,
      data: 'new',
      streamId: 'stream-new',
    })
    expect(queue.pendingBytes()).toBe(0)
  })

  it('does not coalesce adjacent frames across barrier metadata', () => {
    const queue = new ClientOutputQueue(1024)
    queue.enqueue(frame(1, 'before'))
    queue.enqueue(frame(2, '\u001b[31m'))
    queue.enqueue(frame(3, 'after'))

    const batch = queue.nextBatch(1024)
    const dataFrames = batch.filter((entry): entry is ReplayFrame => entry.type !== 'gap')

    expect(dataFrames.map((entry) => entry.data)).toEqual([
      'before',
      '\u001b[31m',
      'after',
    ])
  })

  it('drops oldest frames when queue overflows', () => {
    const queue = new ClientOutputQueue(2)
    queue.enqueue(frame(1, '1'))
    queue.enqueue(frame(2, '2'))
    queue.enqueue(frame(3, '3'))

    const batch = queue.nextBatch(64)
    const dataFrames = batch.filter((entry): entry is ReplayFrame => entry.type !== 'gap')
    expect(dataFrames).toHaveLength(1)
    expect(dataFrames[0]).toMatchObject({
      seqStart: 2,
      seqEnd: 3,
      data: '23',
    })
  })

  it('emits a single coalesced gap range after overflow before data', () => {
    const queue = new ClientOutputQueue(2)
    queue.enqueue(frame(1, '1'))
    queue.enqueue(frame(2, '2'))
    queue.enqueue(frame(3, '3'))
    queue.enqueue(frame(4, '4'))
    queue.enqueue(frame(5, '5'))

    const batch = queue.nextBatch(64)
    expect(batch[0]).toEqual({
      type: 'gap',
      fromSeq: 1,
      toSeq: 3,
      streamId: 'stream-1',
      reason: 'queue_overflow',
    })
    const dataFrames = batch.filter((entry): entry is ReplayFrame => entry.type !== 'gap')
    expect(dataFrames).toHaveLength(1)
    expect(dataFrames[0]).toMatchObject({
      seqStart: 4,
      seqEnd: 5,
      data: '45',
    })
  })

  it('tracks queue depth and dropped bytes for overflow logging', () => {
    const queue = new ClientOutputQueue(2)
    queue.enqueue(frame(1, '1'))
    queue.enqueue(frame(2, '2'))
    queue.enqueue(frame(3, '3'))

    expect(queue.pendingFrames()).toBe(2)
    expect(queue.peekDroppedBytes()).toBe(1)
    expect(queue.consumeDroppedBytes()).toBe(1)
    expect(queue.peekDroppedBytes()).toBe(0)
  })

  it('splits overflow gaps at stream id boundaries', () => {
    const queue = new ClientOutputQueue(1)
    queue.enqueue(frame(1, '1', 'stream-old'))
    queue.enqueue(frame(2, '2', 'stream-old'))
    queue.enqueue(frame(3, '3', 'stream-new'))
    queue.enqueue(frame(4, '4', 'stream-new'))

    const batch = queue.nextBatch(64)
    const gaps = batch.filter(isGapEvent)
    const dataFrames = batch.filter((entry): entry is ReplayFrame => entry.type !== 'gap')

    expect(gaps).toEqual([
      {
        type: 'gap',
        fromSeq: 1,
        toSeq: 2,
        streamId: 'stream-old',
        reason: 'queue_overflow',
      },
      {
        type: 'gap',
        fromSeq: 3,
        toSeq: 3,
        streamId: 'stream-new',
        reason: 'queue_overflow',
      },
    ])
    expect(dataFrames).toHaveLength(1)
    expect(dataFrames[0]).toMatchObject({
      seqStart: 4,
      seqEnd: 4,
      streamId: 'stream-new',
    })
  })

})
