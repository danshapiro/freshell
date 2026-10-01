import { describe, it, expect, vi } from 'vitest'
import { createTerminalWriteQueue } from '@/components/terminal/terminal-write-queue'
import {
  getTerminalOutputWriteScope,
  shouldAllowTerminalOutputSideEffect,
} from '@/lib/terminal-output-write-scope'

describe('createTerminalWriteQueue', () => {
  it('settles a thrown write without success and schedules following ordered work', () => {
    const raf: FrameRequestCallback[] = []
    const failed = vi.fn()
    const successful = vi.fn()
    const laterTask = vi.fn()
    const completed = vi.fn()
    const write = vi.fn((data: string, callback?: () => void) => {
      if (data === 'bad') throw new Error('write rejected')
      callback?.()
    })
    const queue = createTerminalWriteQueue({
      terminalInstanceId: 'surface-throw', write,
      onWriteFailed: failed, onWriteCompleted: completed,
      requestFrame: (callback) => { raf.push(callback); return raf.length },
      cancelFrame: () => {},
    })
    queue.setActiveGeneration('A')
    queue.enqueue('bad', successful, { generation: 'A', coalesce: false })
    queue.enqueueTask(laterTask, { generation: 'A' })
    expect(() => { while (raf.length) raf.shift()!(0) }).not.toThrow()
    expect(successful).not.toHaveBeenCalled()
    expect(completed).not.toHaveBeenCalled()
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ generation: 'A', error: expect.any(Error) }))
    expect(laterTask).toHaveBeenCalledOnce()
    expect(queue.hasInFlightWrites()).toBe(false)
    expect(getTerminalOutputWriteScope('surface-throw')).toBeNull()
    queue.setActiveGeneration('B')
    queue.enqueue('good', successful, { generation: 'B' })
    while (raf.length) raf.shift()!(0)
    expect(successful).toHaveBeenCalledOnce()
    expect(completed).toHaveBeenCalledWith({ mode: 'live', generation: 'B' })
  })

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

  it('keeps draining through ambient wall-clock stalls that land between items', () => {
    // The load-race class observed in full-suite gates (shard runs and the
    // Cloud Run vitest partition): an OS-scheduling or GC stall advances the
    // wall clock in the gaps AROUND queue items while the drain itself
    // consumes microseconds. A drain budget computed from ambient wall time
    // sees the stall and defers items that cost ~nothing — under a
    // synchronous frame mock (every e2e harness here) the remaining items
    // never drain; on a loaded machine the queue throttles to one drained
    // item per frame. The budget must bound the time the drain CONSUMES, not
    // ambient time.
    //
    // Simulated interleaving via the `now` seam: the first write consumes
    // ~1ms of real work; the drain's THIRD clock read observes 100ms of
    // ambient time that passed between items without the queue doing any
    // work. On an up-front-deadline drain this read lands on the loop's
    // between-items check and aborts the drain after one item; per-item
    // consumed-work accounting brackets only item work, so the stall is
    // excluded and the drain continues.
    const writes: string[] = []
    const rafCallbacks: FrameRequestCallback[] = []
    let nowMs = 0
    let nowCalls = 0

    const queue = createTerminalWriteQueue({
      terminalInstanceId: 'surface-ambient-stall',
      write: (chunk, onWritten) => {
        writes.push(chunk)
        nowMs += 1
        onWritten?.()
      },
      requestFrame: (cb) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length
      },
      cancelFrame: () => {},
      now: () => {
        nowCalls += 1
        if (nowCalls === 3) {
          // One ambient stall, observed on a read that brackets no drain work.
          return nowMs + 100
        }
        return nowMs
      },
    })

    queue.enqueue('A', undefined, { coalesce: false })
    queue.enqueue('B', undefined, { coalesce: false })
    queue.enqueue('C', undefined, { coalesce: false })

    rafCallbacks.shift()?.(16)

    expect(writes).toEqual(['A', 'B', 'C'])
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

describe('onItemApplied marker hook', () => {
  it('fires once per applied write item; never for stale generations or tasks', () => {
    const applied: Array<{ mode: string; generation: string | undefined }> = []
    const rafCallbacks: FrameRequestCallback[] = []
    const queue = createTerminalWriteQueue({
      terminalInstanceId: 'surface-onitemapplied',
      write: (_chunk, onWritten) => onWritten?.(),
      onItemApplied: (item) => applied.push({ mode: item.mode, generation: item.generation }),
      requestFrame: (cb) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length
      },
      cancelFrame: () => {},
    })

    queue.setActiveGeneration('gen-1')
    queue.enqueue('A', undefined, { mode: 'replay', generation: 'gen-1', coalesce: false })
    queue.enqueue('B', undefined, { mode: 'live', generation: 'gen-1', coalesce: false })
    queue.enqueue('S', undefined, { mode: 'replay', generation: 'stale-gen' })
    queue.enqueueTask(() => applied.push({ mode: 'task', generation: 'gen-1' }), {
      mode: 'replay',
      generation: 'gen-1',
    })

    rafCallbacks.shift()?.(0)

    expect(applied).toEqual([
      { mode: 'replay', generation: 'gen-1' },
      { mode: 'live', generation: 'gen-1' },
      { mode: 'task', generation: 'gen-1' },
    ])
  })

  it('does not fire when the item goes stale between submit and completion', () => {
    const applied: Array<{ mode: string; generation: string | undefined }> = []
    const rafCallbacks: FrameRequestCallback[] = []
    let pendingWritten: (() => void) | undefined
    const queue = createTerminalWriteQueue({
      terminalInstanceId: 'surface-onitemapplied-stale',
      write: (_chunk, onWritten) => {
        pendingWritten = onWritten
      },
      onItemApplied: (item) => applied.push({ mode: item.mode, generation: item.generation }),
      requestFrame: (cb) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length
      },
      cancelFrame: () => {},
    })

    queue.setActiveGeneration('gen-1')
    queue.enqueue('A', undefined, { mode: 'replay', generation: 'gen-1' })
    rafCallbacks.shift()?.(0) // write submitted, completion pending
    queue.setActiveGeneration('gen-2') // rolls generation before the write completes
    pendingWritten?.()

    expect(applied).toEqual([])
  })
})

describe('onWriteCompleted surface-mutation ledger hook', () => {
  it('fires for EVERY completed write — including stale generations; never for tasks', () => {
    const completed: string[] = []
    const rafCallbacks: FrameRequestCallback[] = []
    let pendingWritten: (() => void) | undefined
    const queue = createTerminalWriteQueue({
      terminalInstanceId: 'surface-onwritecompleted',
      write: (_chunk, onWritten) => {
        pendingWritten = onWritten
      },
      onWriteCompleted: (item) => completed.push(`${item.mode}:${item.generation}`),
      requestFrame: (cb) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length
      },
      cancelFrame: () => {},
    })

    queue.setActiveGeneration('gen-1')
    queue.enqueue('A', undefined, { mode: 'replay', generation: 'gen-1', coalesce: false })
    rafCallbacks.shift()?.(0) // in flight
    queue.setActiveGeneration('gen-2') // the in-flight write goes stale
    queue.enqueueTask(() => {}, { mode: 'replay', generation: 'gen-2' })
    rafCallbacks.shift()?.(0) // task runs while the stale write is still in flight
    expect(completed).toEqual([])

    // The stale write completes: its bytes already reached the surface when it
    // was submitted — the mutation ledger must count it even though
    // onItemApplied (generation-scoped) does not.
    pendingWritten?.()
    expect(completed).toEqual(['replay:gen-1'])
  })
})

describe('onDrain (paced-replay credit flush tick)', () => {
  it('fires exactly once after a withheld write burst is released in order', () => {
    const rafCallbacks: FrameRequestCallback[] = []
    const pendingWritten: Array<() => void> = []
    const drains: number[] = []
    let nowMs = 0

    const queue = createTerminalWriteQueue({
      terminalInstanceId: 'surface-drain-burst',
      write: (_chunk, onWritten) => {
        if (onWritten) pendingWritten.push(onWritten)
      },
      onDrain: () => {
        drains.push(nowMs)
      },
      requestFrame: (cb) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length
      },
      cancelFrame: () => {},
      now: () => nowMs,
    })

    queue.setActiveGeneration('attach-paced')
    queue.enqueue('one', undefined, { mode: 'replay', generation: 'attach-paced', coalesce: false })
    queue.enqueue('two', undefined, { mode: 'replay', generation: 'attach-paced', coalesce: false })
    queue.enqueue('three', undefined, { mode: 'replay', generation: 'attach-paced', coalesce: false })

    rafCallbacks.shift()?.(0)
    expect(pendingWritten).toHaveLength(1)
    expect(drains).toEqual([])

    // Release in order: each completion schedules the next submit; only the
    // LAST completion finds the queue empty and fires the drain.
    nowMs += 1
    pendingWritten.shift()?.()
    rafCallbacks.shift()?.(0)
    nowMs += 1
    pendingWritten.shift()?.()
    rafCallbacks.shift()?.(0)
    nowMs += 1
    pendingWritten.shift()?.()

    expect(pendingWritten).toEqual([])
    expect(drains).toEqual([3])
  })

  it('drains a task enqueued while writes are withheld in the same single drain', () => {
    const rafCallbacks: FrameRequestCallback[] = []
    const pendingWritten: Array<() => void> = []
    const tasks: string[] = []
    const drains: number[] = []
    let nowMs = 0

    const queue = createTerminalWriteQueue({
      terminalInstanceId: 'surface-drain-task-ride',
      write: (_chunk, onWritten) => {
        if (onWritten) pendingWritten.push(onWritten)
      },
      onDrain: () => {
        drains.push(nowMs)
      },
      requestFrame: (cb) => {
        rafCallbacks.push(cb)
        return rafCallbacks.length
      },
      cancelFrame: () => {},
      now: () => nowMs,
    })

    queue.setActiveGeneration('attach-paced')
    queue.enqueue('one', undefined, { mode: 'replay', generation: 'attach-paced', coalesce: false })
    rafCallbacks.shift()?.(0)
    // A frontier flush task rides behind the withheld write.
    queue.enqueueTask(() => tasks.push('flush'), { mode: 'replay', generation: 'attach-paced' })
    // ...and a second page's write behind that.
    queue.enqueue('two', undefined, { mode: 'replay', generation: 'attach-paced', coalesce: false })

    expect(drains).toEqual([])
    expect(tasks).toEqual([])

    nowMs += 1
    pendingWritten.shift()?.()
    // The completion submits the task and the next write in one flush.
    rafCallbacks.shift()?.(0)
    expect(tasks).toEqual(['flush'])
    nowMs += 1
    pendingWritten.shift()?.()

    expect(pendingWritten).toEqual([])
    expect(drains).toEqual([2])
  })
})
