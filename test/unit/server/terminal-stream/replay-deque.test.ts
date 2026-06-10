import { describe, expect, it, vi } from 'vitest'
import { ReplayDeque } from '../../../../server/terminal-stream/replay-deque'

const STREAM_ID = 'stream-1'
const GROUND = { mode: 'ground' } as const
const CSI = { mode: 'csi' } as const

describe('ReplayDeque', () => {
  it('evicts many tiny frames without shifting the backing array per frame', () => {
    const deque = new ReplayDeque(1024)
    const shiftSpy = vi.spyOn(Array.prototype, 'shift')
    let shiftCalls = 0

    try {
      for (let index = 0; index < 4096; index += 1) {
        deque.append('x')
      }
      shiftCalls = shiftSpy.mock.calls.length
    } finally {
      shiftSpy.mockRestore()
    }

    expect(shiftCalls).toBe(0)
    expect(deque.totalBytes()).toBeLessThanOrEqual(1024)
    expect(deque.headSeq()).toBe(4096)
    expect(deque.tailSeq()).toBeGreaterThan(1)
  })

  it('reports a gap after eviction while preserving retained frames', () => {
    const deque = new ReplayDeque(3)
    deque.append('a')
    deque.append('b')
    deque.append('c')
    deque.append('d')

    const replay = deque.replayBatchSince(0, 1024, 4)

    expect(replay.missedFromSeq).toBe(1)
    expect(replay.frames.map((frame) => frame.data).join('')).toBe('bcd')
    expect(replay.frames.at(-1)?.seqEnd).toBe(4)
  })

  it('preserves barrier metadata for arbitrary replay windows', () => {
    const deque = new ReplayDeque(1024)
    deque.append({
      data: '\u001b[',
      streamId: STREAM_ID,
      barrier: true,
      barrierReason: 'control',
      scannerStateBefore: GROUND,
      scannerStateAfter: CSI,
    })
    deque.append({
      data: '6n',
      streamId: STREAM_ID,
      barrier: true,
      barrierReason: 'request_mode',
      scannerStateBefore: CSI,
      scannerStateAfter: GROUND,
    })

    const replay = deque.replayBatchSince(1, 1024, 2)

    expect(replay.frames).toHaveLength(1)
    expect(replay.frames[0]).toMatchObject({
      seqStart: 2,
      seqEnd: 2,
      data: '6n',
      streamId: STREAM_ID,
      barrier: true,
      barrierReason: 'request_mode',
      scannerStateBefore: CSI,
      scannerStateAfter: GROUND,
    })
  })
})
