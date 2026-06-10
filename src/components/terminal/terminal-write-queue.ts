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
}

type TerminalWriteQueueArgs = {
  terminalInstanceId: string
  write: (data: string, onWritten?: () => void) => void
  onDrain?: () => void
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
    const onWritten = () => {
      if (didWriteComplete) return
      didWriteComplete = true
      try {
        if (!isStaleGeneration(item.generation)) {
          for (const callback of item.callbacks) callback()
        }
      } finally {
        scope.complete()
        decrementInFlightWrites(item.generation)
        submittedWriteInFlight = false
        continueAfterWriteCompletion()
      }
    }

    try {
      args.write(item.data, onWritten)
    } catch (error) {
      if (!didWriteComplete) {
        didWriteComplete = true
        scope.complete()
        decrementInFlightWrites(item.generation)
        submittedWriteInFlight = false
      }
      throw error
    }
  }

  const flush = () => {
    if (submittedWriteInFlight) return
    const deadline = now() + budgetMs
    flushing = true
    try {
      while (queue.length > 0 && now() <= deadline && !submittedWriteInFlight) {
        const next = queue.shift()
        if (next) runItem(next)
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
        coalescible
        && previous?.kind === 'write'
        && previous.coalescible
        && previous.mode === mode
        && previous.generation === generation
        && previous.data.length + data.length <= MAX_COALESCED_TERMINAL_WRITE_LENGTH
      ) {
        previous.data += data
        previous.callbacks.push(...callbacks)
      } else {
        queue.push({ kind: 'write', mode, generation, coalescible, data, callbacks })
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
