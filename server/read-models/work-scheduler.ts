import type { ReadModelLane } from '../../shared/read-models.js'

export type ReadModelAbortError = Error & {
  name: 'AbortError'
}

export type ReadModelSchedulerTask<T> = {
  lane: ReadModelLane
  signal?: AbortSignal
  run: (signal: AbortSignal) => Promise<T> | T
}

export type ReadModelWorkScheduler = {
  schedule: <T>(task: ReadModelSchedulerTask<T>) => Promise<T>
}

type SchedulerQueue = 'foreground' | 'background'

type QueueEntry<T> = ReadModelSchedulerTask<T> & {
  controller: AbortController
  started: boolean
  queue: SchedulerQueue
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
  abortListener?: () => void
}

type SchedulerOptions = {
  foregroundConcurrency?: number
  backgroundConcurrency?: number
}

export function createReadModelAbortError(message = 'Read-model request aborted'): ReadModelAbortError {
  const error = new Error(message) as ReadModelAbortError
  error.name = 'AbortError'
  return error
}

export function isReadModelAbortError(error: unknown): error is ReadModelAbortError {
  return error instanceof Error && error.name === 'AbortError'
}

function removeQueueEntry<T>(queue: QueueEntry<T>[], entry: QueueEntry<T>): boolean {
  const index = queue.indexOf(entry)
  if (index === -1) return false
  queue.splice(index, 1)
  return true
}

export function createReadModelWorkScheduler(options: SchedulerOptions = {}): ReadModelWorkScheduler {
  const foregroundConcurrency = Math.max(1, options.foregroundConcurrency ?? 1)
  const backgroundConcurrency = Math.max(1, options.backgroundConcurrency ?? 1)
  const criticalQueue: Array<QueueEntry<unknown>> = []
  const visibleQueue: Array<QueueEntry<unknown>> = []
  const backgroundQueue: Array<QueueEntry<unknown>> = []
  let foregroundRunning = 0
  let backgroundRunning = 0
  let flushScheduled = false

  const scheduleFlush = () => {
    if (flushScheduled) return
    flushScheduled = true
    queueMicrotask(() => {
      flushScheduled = false
      flush()
    })
  }

  const finishEntry = (entry: QueueEntry<unknown>, queue: SchedulerQueue) => {
    if (entry.abortListener && entry.signal) {
      entry.signal.removeEventListener('abort', entry.abortListener)
      entry.abortListener = undefined
    }
    if (queue === 'foreground') {
      foregroundRunning = Math.max(0, foregroundRunning - 1)
    } else {
      backgroundRunning = Math.max(0, backgroundRunning - 1)
    }
    scheduleFlush()
  }

  const runEntry = <T>(entry: QueueEntry<T>) => {
    entry.started = true
    if (entry.queue === 'foreground') {
      foregroundRunning += 1
    } else {
      backgroundRunning += 1
    }

    if (entry.signal?.aborted) {
      entry.controller.abort(entry.signal.reason)
    }
    if (entry.controller.signal.aborted) {
      finishEntry(entry as QueueEntry<unknown>, entry.queue)
      entry.reject(createReadModelAbortError())
      return
    }

    Promise.resolve()
      .then(() => entry.run(entry.controller.signal))
      .then((value) => {
        finishEntry(entry as QueueEntry<unknown>, entry.queue)
        if (entry.controller.signal.aborted) {
          entry.reject(createReadModelAbortError())
          return
        }
        entry.resolve(value)
      })
      .catch((error) => {
        finishEntry(entry as QueueEntry<unknown>, entry.queue)
        if (entry.controller.signal.aborted && !isReadModelAbortError(error)) {
          entry.reject(createReadModelAbortError())
          return
        }
        entry.reject(error)
      })
  }

  const dequeueForeground = () => criticalQueue.shift() ?? visibleQueue.shift()

  const flush = () => {
    while (foregroundRunning < foregroundConcurrency) {
      const next = dequeueForeground()
      if (!next) break
      runEntry(next)
    }

    while (
      backgroundRunning < backgroundConcurrency &&
      criticalQueue.length === 0 &&
      visibleQueue.length === 0
    ) {
      const next = backgroundQueue.shift()
      if (!next) break
      runEntry(next)
    }
  }

  return {
    schedule<T>(task: ReadModelSchedulerTask<T>) {
      return new Promise<T>((resolve, reject) => {
        const controller = new AbortController()
        const queue: SchedulerQueue = task.lane === 'background' ? 'background' : 'foreground'
        const entry: QueueEntry<T> = {
          ...task,
          controller,
          started: false,
          queue,
          resolve,
          reject,
        }

        const abortPendingEntry = () => {
          controller.abort(task.signal?.reason)
          if (entry.started) return
          const removed = entry.lane === 'critical'
            ? removeQueueEntry(criticalQueue as Array<QueueEntry<T>>, entry)
            : entry.lane === 'visible'
              ? removeQueueEntry(visibleQueue as Array<QueueEntry<T>>, entry)
              : removeQueueEntry(backgroundQueue as Array<QueueEntry<T>>, entry)
          if (removed) {
            reject(createReadModelAbortError())
            scheduleFlush()
          }
        }

        if (task.signal) {
          if (task.signal.aborted) {
            reject(createReadModelAbortError())
            return
          }
          entry.abortListener = abortPendingEntry
          task.signal.addEventListener('abort', abortPendingEntry, { once: true })
        }

        if (task.lane === 'critical') {
          criticalQueue.push(entry as QueueEntry<unknown>)
        } else if (task.lane === 'visible') {
          visibleQueue.push(entry as QueueEntry<unknown>)
        } else {
          backgroundQueue.push(entry as QueueEntry<unknown>)
        }

        scheduleFlush()
      })
    },
  }
}

export const defaultReadModelScheduler = createReadModelWorkScheduler()
