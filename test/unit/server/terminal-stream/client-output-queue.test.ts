import { describe, expect, it } from 'vitest'
import { ClientOutputQueue } from '../../../../server/terminal-stream/client-output-queue'
import type { ReplayFrame } from '../../../../server/terminal-stream/replay-ring'

function frame(seq: number, data: string): ReplayFrame {
  return {
    seqStart: seq,
    seqEnd: seq,
    data,
    bytes: Buffer.byteLength(data, 'utf8'),
    at: seq,
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
})
