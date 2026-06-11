import { describe, it, expect, vi } from 'vitest'
import { createTerminalWriteQueue } from '@/components/terminal/terminal-write-queue'
import {
  getTerminalOutputWriteScope,
  shouldAllowTerminalOutputSideEffect,
} from '@/lib/terminal-output-write-scope'

describe('createTerminalWriteQueue', () => {
  it('processes queued writes in time slices and preserves order', () => {
    const writes: string[] = []
    const rafCallbacks: FrameRequestCallback[] = []
    let nowMs = 0

    const queue = createTerminalWriteQueue({
      terminalInstanceId: 'surface-timeslice',
      write: (chunk, onWritten) => {
        writes.push(chunk)
        nowMs += 5
        onWritten?.()
      },
      requestFrame: (cb) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length
      },
      cancelFrame: () => {},
      now: () => nowMs,
      budgetMs: 4,
    })

    queue.enqueue('A', undefined, { coalesce: false })
    queue.enqueue('B', undefined, { coalesce: false })
    queue.enqueue('C', undefined, { coalesce: false })

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
      terminalInstanceId: 'surface-clear',
      write,
      requestFrame: (cb) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length
      },
      cancelFrame,
    })

    queue.enqueue('A', undefined, { coalesce: false })
    queue.enqueue('B', undefined, { coalesce: false })
    queue.clear()

    expect(cancelFrame).toHaveBeenCalledTimes(1)
    expect(write).not.toHaveBeenCalled()
  })

  it('does not schedule an extra frame when enqueueing while a continuation frame is pending', () => {
    const writes: string[] = []
    const rafCallbacks: FrameRequestCallback[] = []
    let nowMs = 0

    const queue = createTerminalWriteQueue({
      terminalInstanceId: 'surface-continuation',
      write: (chunk, onWritten) => {
        writes.push(chunk)
        nowMs += 5
        onWritten?.()
      },
      requestFrame: (cb) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length
      },
      cancelFrame: () => {},
      now: () => nowMs,
      budgetMs: 4,
    })

    queue.enqueue('A', undefined, { coalesce: false })
    queue.enqueue('B', undefined, { coalesce: false })

    expect(rafCallbacks).toHaveLength(1)

    rafCallbacks.shift()?.(16)
    expect(writes).toEqual(['A'])
    expect(rafCallbacks).toHaveLength(1)

    queue.enqueue('C', undefined, { coalesce: false })
    expect(rafCallbacks).toHaveLength(1)

    rafCallbacks.shift()?.(32)
    expect(writes).toEqual(['A', 'B'])
    expect(rafCallbacks).toHaveLength(1)

    rafCallbacks.shift()?.(48)
    expect(writes).toEqual(['A', 'B', 'C'])
    expect(rafCallbacks).toHaveLength(0)
  })

  it('coalesces adjacent writes and preserves write callbacks', () => {
    const writes: string[] = []
    const callbacks: string[] = []
    const rafCallbacks: FrameRequestCallback[] = []

    const queue = createTerminalWriteQueue({
      terminalInstanceId: 'surface-coalesce',
      write: (chunk, onWritten) => {
        writes.push(chunk)
        onWritten?.()
      },
      requestFrame: (cb) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length
      },
      cancelFrame: () => {},
    })

    queue.enqueue('A', () => callbacks.push('A'), { mode: 'replay' })
    queue.enqueue('B', () => callbacks.push('B'), { mode: 'replay' })
    queue.enqueue('C', undefined, { mode: 'replay' })

    rafCallbacks.shift()?.(16)

    expect(writes).toEqual(['ABC'])
    expect(callbacks).toEqual(['A', 'B'])
  })

  it('coalesces adjacent live writes and preserves write callbacks', () => {
    const writes: string[] = []
    const callbacks: string[] = []
    const rafCallbacks: FrameRequestCallback[] = []

    const queue = createTerminalWriteQueue({
      terminalInstanceId: 'surface-live-coalesce',
      write: (chunk, onWritten) => {
        writes.push(chunk)
        onWritten?.()
      },
      requestFrame: (cb) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length
      },
      cancelFrame: () => {},
    })

    queue.enqueue('A', () => callbacks.push('A'), { mode: 'live' })
    queue.enqueue('B', () => callbacks.push('B'), { mode: 'live' })
    queue.enqueue('C', undefined, { mode: 'live' })

    rafCallbacks.shift()?.(16)

    expect(writes).toEqual(['ABC'])
    expect(callbacks).toEqual(['A', 'B'])
  })

  it('does not coalesce across explicit output barriers', () => {
    const writes: string[] = []
    const rafCallbacks: FrameRequestCallback[] = []

    const queue = createTerminalWriteQueue({
      terminalInstanceId: 'surface-live-barriers',
      write: (chunk, onWritten) => {
        writes.push(chunk)
        onWritten?.()
      },
      requestFrame: (cb) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length
      },
      cancelFrame: () => {},
    })

    queue.enqueue('A', undefined, { mode: 'live' })
    queue.enqueue('B', undefined, { mode: 'live', coalesce: false })
    queue.enqueue('C', undefined, { mode: 'live' })

    rafCallbacks.shift()?.(16)

    expect(writes).toEqual(['A', 'B', 'C'])
  })

  it('keeps a four-hour hidden-tab live backlog bounded to large coalesced writes', () => {
    const writes: string[] = []
    const callbacks: number[] = []
    const rafCallbacks: FrameRequestCallback[] = []
    const line = `${'B'.repeat(1023)}\n`
    const nowMs = 0

    const queue = createTerminalWriteQueue({
      terminalInstanceId: 'surface-live-four-hour-backlog',
      write: (chunk, onWritten) => {
        writes.push(chunk)
        onWritten?.()
      },
      requestFrame: (cb) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length
      },
      cancelFrame: () => {},
      now: () => nowMs,
    })

    for (let index = 0; index < 14_400; index += 1) {
      queue.enqueue(line, () => callbacks.push(index), { mode: 'live' })
    }

    rafCallbacks.shift()?.(16)

    expect(writes.length).toBeLessThanOrEqual(57)
    expect(writes.reduce((total, write) => total + write.length, 0)).toBe(line.length * 14_400)
    expect(callbacks).toHaveLength(14_400)
    expect(callbacks[0]).toBe(0)
    expect(callbacks.at(-1)).toBe(14_399)
  })

  it('drops queued writes from stale generations before they reach xterm', () => {
    const writes: string[] = []
    const callbacks: string[] = []
    const rafCallbacks: FrameRequestCallback[] = []

    const queue = createTerminalWriteQueue({
      terminalInstanceId: 'surface-stale-queued',
      write: (chunk, onWritten) => {
        writes.push(chunk)
        onWritten?.()
      },
      requestFrame: (cb) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length
      },
      cancelFrame: () => {},
    })

    queue.setActiveGeneration('attach-1')
    queue.enqueue('old', () => callbacks.push('old'), { generation: 'attach-1' })
    queue.setActiveGeneration('attach-2', { dropQueuedStaleWrites: true })
    queue.enqueue('new', () => callbacks.push('new'), { generation: 'attach-2' })

    rafCallbacks.shift()?.(16)

    expect(writes).toEqual(['new'])
    expect(callbacks).toEqual(['new'])
  })

  it('suppresses stale write callbacks after generation changes', () => {
    const callbacks: string[] = []
    const pendingCallbacks: Array<() => void> = []
    const rafCallbacks: FrameRequestCallback[] = []

    const queue = createTerminalWriteQueue({
      terminalInstanceId: 'surface-stale-callback',
      write: (_chunk, onWritten) => {
        if (onWritten) pendingCallbacks.push(onWritten)
      },
      requestFrame: (cb) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length
      },
      cancelFrame: () => {},
    })

    queue.setActiveGeneration('attach-1')
    queue.enqueue('old', () => callbacks.push('old'), { generation: 'attach-1' })
    rafCallbacks.shift()?.(16)

    expect(queue.hasInFlightWrites()).toBe(true)
    queue.setActiveGeneration('attach-2', { dropQueuedStaleWrites: true })
    pendingCallbacks.shift()?.()

    expect(callbacks).toEqual([])
    expect(queue.hasInFlightWrites()).toBe(false)
  })

  it('keeps replay work on the normal frame budget', () => {
    const tasks: string[] = []
    const rafCallbacks: FrameRequestCallback[] = []
    let nowMs = 0

    const queue = createTerminalWriteQueue({
      terminalInstanceId: 'surface-replay-budget',
      write: (_chunk, onWritten) => {
        onWritten?.()
      },
      requestFrame: (cb) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length
      },
      cancelFrame: () => {},
      now: () => nowMs,
      budgetMs: 4,
    })

    queue.enqueueTask(() => {
      tasks.push('A')
      nowMs += 5
    }, { mode: 'replay' })
    queue.enqueueTask(() => {
      tasks.push('B')
      nowMs += 5
    }, { mode: 'replay' })
    queue.enqueueTask(() => {
      tasks.push('C')
      nowMs += 5
    }, { mode: 'replay' })

    rafCallbacks.shift()?.(16)

    expect(tasks).toEqual(['A'])
    expect(rafCallbacks).toHaveLength(1)

    rafCallbacks.shift()?.(32)

    expect(tasks).toEqual(['A', 'B'])
    expect(rafCallbacks).toHaveLength(1)

    rafCallbacks.shift()?.(48)

    expect(tasks).toEqual(['A', 'B', 'C'])
    expect(rafCallbacks).toHaveLength(0)
  })

  it('keeps submitted write scope active across async parser callbacks and serializes writes', () => {
    const writes: string[] = []
    const pendingCallbacks: Array<() => void> = []
    const rafCallbacks: FrameRequestCallback[] = []

    const queue = createTerminalWriteQueue({
      terminalInstanceId: 'surface-async-scope',
      write: (chunk, onWritten) => {
        writes.push(chunk)
        if (onWritten) pendingCallbacks.push(onWritten)
      },
      requestFrame: (cb) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length
      },
      cancelFrame: () => {},
    })

    queue.enqueue('replay', undefined, { mode: 'replay', generation: 'attach-1' })
    queue.enqueue('live', undefined, { mode: 'live', generation: 'attach-1' })

    rafCallbacks.shift()?.(16)

    expect(writes).toEqual(['replay'])
    expect(getTerminalOutputWriteScope('surface-async-scope')?.source).toBe('replay')
    expect(shouldAllowTerminalOutputSideEffect({
      terminalInstanceId: 'surface-async-scope',
      effect: 'request_mode_reply',
      mode: 'shell',
    })).toBe(false)
    expect(pendingCallbacks).toHaveLength(1)
    expect(queue.hasInFlightWrites()).toBe(true)

    pendingCallbacks.shift()?.()

    expect(getTerminalOutputWriteScope('surface-async-scope')).toBeNull()
    expect(writes).toEqual(['replay'])
    expect(rafCallbacks).toHaveLength(1)

    rafCallbacks.shift()?.(32)

    expect(writes).toEqual(['replay', 'live'])
    expect(getTerminalOutputWriteScope('surface-async-scope')?.source).toBe('live')
    expect(shouldAllowTerminalOutputSideEffect({
      terminalInstanceId: 'surface-async-scope',
      effect: 'request_mode_reply',
      mode: 'shell',
    })).toBe(true)
  })
})
