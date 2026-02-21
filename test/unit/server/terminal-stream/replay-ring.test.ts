import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_TERMINAL_REPLAY_RING_MAX_BYTES,
  ReplayRing,
} from '../../../../server/terminal-stream/replay-ring'

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
    const one = ring.append('a')
    const two = ring.append('b')
    const three = ring.append('c')

    expect(one.seqStart).toBe(1)
    expect(one.seqEnd).toBe(1)
    expect(two.seqStart).toBe(2)
    expect(three.seqEnd).toBe(3)
    expect(ring.headSeq()).toBe(3)
    expect(ring.tailSeq()).toBe(1)
  })

  it('evicts oldest frames to enforce byte budget', () => {
    const ring = new ReplayRing(5)
    ring.append('abc') // 3
    ring.append('de') // 2 (total 5)
    ring.append('f') // 1 (evict seq 1)

    expect(ring.headSeq()).toBe(3)
    expect(ring.tailSeq()).toBe(2)
    const replay = ring.replaySince(0)
    expect(replay.frames.map((f) => f.seqStart)).toEqual([2, 3])
  })

  it('replays only frames newer than sinceSeq', () => {
    const ring = new ReplayRing(1024)
    ring.append('a')
    ring.append('b')
    ring.append('c')

    const replay = ring.replaySince(1)
    expect(replay.frames.map((f) => f.data)).toEqual(['b', 'c'])
    expect(replay.frames[0].seqStart).toBe(2)
    expect(replay.frames[1].seqEnd).toBe(3)
  })

  it('reports replay miss when requested sequence is older than tail', () => {
    const ring = new ReplayRing(2)
    ring.append('1')
    ring.append('2')
    ring.append('3')
    ring.append('4')
    ring.append('5')

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

    ring.append(half)
    ring.append(half)
    expect(ring.tailSeq()).toBe(1)

    ring.append('y')
    expect(ring.headSeq()).toBe(3)
    expect(ring.tailSeq()).toBe(2)
  })
})
