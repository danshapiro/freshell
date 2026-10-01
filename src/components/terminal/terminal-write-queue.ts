import { beginTerminalOutputWriteScope } from '@/lib/terminal-output-write-scope'

export type TerminalWriteQueue = {
  enqueue: (data: string, onWritten?: () => void, options?: TerminalWriteQueueOptions) => void
  enqueueTask: (task: () => void, options?: TerminalWriteQueueOptions) => void
  setActiveGeneration: (
    generation: string,
    options?: { dropQueuedStaleWrites?: boolean },
  ) => void
  hasInFlightWrites: (generation?: string) => boolean
  clear: () => void
}

export type TerminalWriteQueueMode = 'live' | 'replay'

export type TerminalWriteQueueOptions = {
  mode?: TerminalWriteQueueMode
  generation?: string
  coalesce?: boolean
  /**
   * Atomic clear-then-write (round-4 F2): the flush invokes this callback
   * immediately before the item's bytes go to the surface, INSIDE the same
   * generation-guarded queue item — a dropped generation drops the clear
   * and the write together (the surface is preserved), and a stale
   * generation is refused at apply time so neither the clear nor the write
   * ever runs late. An item carrying a clear never coalesces into a
   * previous item (the clear is a hard boundary between byte ranges).
   */
  clearBeforeWrite?: () => void
}

type TerminalWriteQueueArgs = {
  terminalInstanceId: string
  write: (data: string, onWritten?: () => void) => void
  onDrain?: () => void
  /**
   * Fired once per applied write item (write COMPLETED and generation still
   * current — items dropped stale before/during the write never fire it).
   * Used by TerminalView to consume generation-scoped one-shot markers.
   */
  onItemApplied?: (item: { mode: TerminalWriteQueueMode; generation: string | undefined }) => void
  /**
   * Surface-mutation ledger (responsive-terminal-restore WS2): fired for
   * EVERY completed write item — INCLUDING stale generations (the item's
   * bytes were already submitted to the surface when it went in flight, so a
   * stale completion is still a mutation even though onItemApplied rightly
   * skips it). Never fired for tasks. Used by the quarantine repair to prove
   * the surface still matches its last checkpoint.
   */
  onWriteCompleted?: (item: { mode: TerminalWriteQueueMode; generation: string | undefined }) => void
  /** A surface write failed before completion; no success hooks ran. */
  onWriteFailed?: (item: { mode: TerminalWriteQueueMode; generation: string | undefined; error: unknown }) => void
  budgetMs?: number
  now?: () => number
  requestFrame?: (cb: FrameRequestCallback) => number
  cancelFrame?: (id: number) => void
}

type WriteQueueItem = {
  kind: 'write'
  mode: TerminalWriteQueueMode
  generation: string | undefined
  coalescible: boolean
  clearBeforeWrite?: () => void
  data: string
  callbacks: Array<() => void>
}

type TaskQueueItem = {
  kind: 'task'
  mode: TerminalWriteQueueMode
  generation: string | undefined
  task: () => void
}

type QueueItem = WriteQueueItem | TaskQueueItem

const MAX_COALESCED_TERMINAL_WRITE_LENGTH = 256 * 1024

export function createTerminalWriteQueue(args: TerminalWriteQueueArgs): TerminalWriteQueue {
  const queue: QueueItem[] = []
  const budgetMs = args.budgetMs ?? 8
  const now = args.now ?? (() => performance.now())
  const requestFrame = args.requestFrame ?? ((cb) => requestAnimationFrame(cb))
  const cancelFrame = args.cancelFrame ?? ((id) => cancelAnimationFrame(id))
  let rafId: number | null = null
  let scheduled = false
  let activeGeneration: string | undefined
  let inFlightWrites = 0
  let submittedWriteInFlight = false
  let flushing = false
  const inFlightWritesByGeneration = new Map<string | undefined, number>()

  const resolveGeneration = (options?: TerminalWriteQueueOptions) => options?.generation ?? activeGeneration

  const isStaleGeneration = (generation: string | undefined) => (
    activeGeneration !== undefined && generation !== activeGeneration
  )

  const dropQueuedWritesOutsideGeneration = (generation: string) => {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (queue[index]?.generation !== generation) {
        queue.splice(index, 1)
      }
    }
  }

  const incrementInFlightWrites = (generation: string | undefined) => {
    inFlightWrites += 1
    inFlightWritesByGeneration.set(
      generation,
      (inFlightWritesByGeneration.get(generation) ?? 0) + 1,
    )
  }

  const decrementInFlightWrites = (generation: string | undefined) => {
    if (inFlightWrites > 0) {
      inFlightWrites -= 1
    }
    const generationCount = inFlightWritesByGeneration.get(generation) ?? 0
    if (generationCount <= 1) {
      inFlightWritesByGeneration.delete(generation)
      return
    }
    inFlightWritesByGeneration.set(generation, generationCount - 1)
  }

  const continueAfterWriteCompletion = () => {
    if (flushing) return
    if (queue.length > 0) {
      scheduleFlush()
      return
    }
    args.onDrain?.()
  }

  const runItem = (item: QueueItem) => {
    if (isStaleGeneration(item.generation)) {
      return
    }

    if (item.kind === 'task') {
      item.task()
      return
    }

    incrementInFlightWrites(item.generation)
    submittedWriteInFlight = true
    let didWriteComplete = false
    const scope = beginTerminalOutputWriteScope({
      terminalInstanceId: args.terminalInstanceId,
      source: item.mode,
      attachRequestId: item.generation,
      generation: item.generation ?? 'no-attach',
      suppressExternalSideEffects: item.mode === 'replay',
    })
    const settleSubmittedWrite = () => {
      scope.complete()
      decrementInFlightWrites(item.generation)
      submittedWriteInFlight = false
    }
    const onWritten = () => {
      if (didWriteComplete) return
      didWriteComplete = true
      try {
        if (!isStaleGeneration(item.generation)) {
          for (const callback of item.callbacks) callback()
          args.onItemApplied?.({ mode: item.mode, generation: item.generation })
        }
        args.onWriteCompleted?.({ mode: item.mode, generation: item.generation })
      } finally {
        settleSubmittedWrite()
        continueAfterWriteCompletion()
      }
    }

    try {
      // Atomic clear-then-write: the clear runs INSIDE this item, at
      // apply time — a dropped/stale generation never reaches this point,
      // and the serial flush guarantees every earlier item's bytes (and
      // completion) precede it, so nothing can mutate the surface after
      // the clear except this item's own bytes.
      item.clearBeforeWrite?.()
      args.write(item.data, onWritten)
    } catch (error) {
      // A callback/hook exception after completion is not a failed write.
      if (didWriteComplete) throw error
      didWriteComplete = true
      settleSubmittedWrite()
      try {
        args.onWriteFailed?.({ mode: item.mode, generation: item.generation, error })
      } finally {
        continueAfterWriteCompletion()
      }
    }
  }

  const flush = () => {
    if (submittedWriteInFlight) return
    // The drain budget bounds the time the drain CONSUMES, measured per item
    // and summed — never ambient wall-clock time. An up-front deadline makes
    // every OS-scheduling or GC stall that lands between items (or before the
    // first) abort the drain with zero work done, starving the queue on
    // loaded machines and losing sync-completing items entirely under the
    // synchronous frame mocks every e2e harness uses. Per-item spans still
    // bound genuinely expensive work: a drain stops after the item that
    // pushes cumulative consumed time past the budget, so each tick makes
    // real progress before yielding.
    let consumedMs = 0
    flushing = true
    try {
      while (queue.length > 0 && !submittedWriteInFlight) {
        const itemStartAt = now()
        const next = queue.shift()
        if (next) runItem(next)
        const itemEndAt = now()
        if (itemEndAt > itemStartAt) {
          consumedMs += itemEndAt - itemStartAt
        }
        if (consumedMs > budgetMs) break
      }
    } finally {
      flushing = false
    }
    if (submittedWriteInFlight) {
      return
    }
    if (queue.length > 0) {
      scheduleFlush()
      return
    }
    args.onDrain?.()
  }

  const scheduleFlush = () => {
    if (scheduled) return
    scheduled = true
    rafId = requestFrame(() => {
      scheduled = false
      rafId = null
      flush()
    })
  }

  return {
    enqueue(data, onWritten, options) {
      if (!data) return
      const mode = options?.mode ?? 'live'
      const generation = resolveGeneration(options)
      const coalescible = options?.coalesce !== false
      const callbacks = onWritten ? [onWritten] : []
      const previous = queue[queue.length - 1]
      if (
        // An item carrying a clear NEVER coalesces into a previous item:
        // the clear must run between the previous bytes and this item's
        // bytes, so it always starts a new queue item.
        !options?.clearBeforeWrite
        && coalescible
        && previous?.kind === 'write'
        && previous.coalescible
        && previous.mode === mode
        && previous.generation === generation
        && previous.data.length + data.length <= MAX_COALESCED_TERMINAL_WRITE_LENGTH
      ) {
        previous.data += data
        previous.callbacks.push(...callbacks)
      } else {
        queue.push({
          kind: 'write',
          mode,
          generation,
          coalescible,
          clearBeforeWrite: options?.clearBeforeWrite,
          data,
          callbacks,
        })
      }
      scheduleFlush()
    },
    enqueueTask(task, options) {
      queue.push({
        kind: 'task',
        mode: options?.mode ?? 'live',
        generation: resolveGeneration(options),
        task,
      })
      scheduleFlush()
    },
    setActiveGeneration(generation, options) {
      activeGeneration = generation
      if (options?.dropQueuedStaleWrites) {
        dropQueuedWritesOutsideGeneration(generation)
      }
    },
    hasInFlightWrites(generation) {
      if (generation === undefined) {
        return inFlightWrites > 0
      }
      return (inFlightWritesByGeneration.get(generation) ?? 0) > 0
    },
    clear() {
      queue.length = 0
      if (scheduled && rafId !== null) {
        cancelFrame(rafId)
      }
      scheduled = false
      rafId = null
    },
  }
}
