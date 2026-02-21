import { describe, it, expect, vi } from 'vitest'
import { createTerminalWriteQueue } from '@/components/terminal/terminal-write-queue'

describe('createTerminalWriteQueue', () => {
  it('processes queued writes in time slices and preserves order', () => {
    const writes: string[] = []
    const rafCallbacks: FrameRequestCallback[] = []
    let nowMs = 0

    const queue = createTerminalWriteQueue({
      write: (chunk) => {
        writes.push(chunk)
        nowMs += 5
      },
      requestFrame: (cb) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length
      },
      cancelFrame: () => {},
      now: () => nowMs,
      budgetMs: 4,
    })

    queue.enqueue('A')
    queue.enqueue('B')
    queue.enqueue('C')

    expect(writes).toEqual([])

    rafCallbacks.shift()?.(16)
    expect(writes).toEqual(['A'])

    rafCallbacks.shift()?.(32)
    expect(writes).toEqual(['A', 'B'])

    rafCallbacks.shift()?.(48)
    expect(writes).toEqual(['A', 'B', 'C'])
  })

  it('clears pending queue work and cancels the scheduled frame', () => {
    const cancelFrame = vi.fn()
    const rafCallbacks: FrameRequestCallback[] = []
    const write = vi.fn()

    const queue = createTerminalWriteQueue({
      write,
      requestFrame: (cb) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length
      },
      cancelFrame,
    })

    queue.enqueue('A')
    queue.enqueue('B')
    queue.clear()

    expect(cancelFrame).toHaveBeenCalledTimes(1)
    expect(write).not.toHaveBeenCalled()
  })

  it('does not schedule an extra frame when enqueueing while a continuation frame is pending', () => {
    const writes: string[] = []
    const rafCallbacks: FrameRequestCallback[] = []
    let nowMs = 0

    const queue = createTerminalWriteQueue({
      write: (chunk) => {
        writes.push(chunk)
        nowMs += 5
      },
      requestFrame: (cb) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length
      },
      cancelFrame: () => {},
      now: () => nowMs,
      budgetMs: 4,
    })

    queue.enqueue('A')
    queue.enqueue('B')

    expect(rafCallbacks).toHaveLength(1)

    rafCallbacks.shift()?.(16)
    expect(writes).toEqual(['A'])
    expect(rafCallbacks).toHaveLength(1)

    queue.enqueue('C')
    expect(rafCallbacks).toHaveLength(1)

    rafCallbacks.shift()?.(32)
    expect(writes).toEqual(['A', 'B'])
    expect(rafCallbacks).toHaveLength(1)

    rafCallbacks.shift()?.(48)
    expect(writes).toEqual(['A', 'B', 'C'])
    expect(rafCallbacks).toHaveLength(0)
  })
})
