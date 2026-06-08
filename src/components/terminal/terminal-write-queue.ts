export type TerminalWriteQueue = {
  enqueue: (data: string, onWritten?: () => void, options?: TerminalWriteQueueOptions) => void
  enqueueTask: (task: () => void, options?: TerminalWriteQueueOptions) => void
  clear: () => void
}

export type TerminalWriteQueueMode = 'live' | 'replay'

export type TerminalWriteQueueOptions = {
  mode?: TerminalWriteQueueMode
}

type TerminalWriteQueueArgs = {
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
  data: string
  callbacks: Array<() => void>
}

type TaskQueueItem = {
  kind: 'task'
  mode: TerminalWriteQueueMode
  task: () => void
}

type QueueItem = WriteQueueItem | TaskQueueItem

const MAX_COALESCED_REPLAY_WRITE_LENGTH = 256 * 1024

export function createTerminalWriteQueue(args: TerminalWriteQueueArgs): TerminalWriteQueue {
  const queue: QueueItem[] = []
  const budgetMs = args.budgetMs ?? 8
  const now = args.now ?? (() => performance.now())
  const requestFrame = args.requestFrame ?? ((cb) => requestAnimationFrame(cb))
  const cancelFrame = args.cancelFrame ?? ((id) => cancelAnimationFrame(id))
  let rafId: number | null = null
  let scheduled = false

  const runItem = (item: QueueItem) => {
    if (item.kind === 'task') {
      item.task()
      return
    }

    const onWritten = item.callbacks.length > 0
      ? () => {
          for (const callback of item.callbacks) callback()
        }
      : undefined
    args.write(item.data, onWritten)
  }

  const flush = () => {
    const deadline = now() + budgetMs
    while (queue.length > 0 && now() <= deadline) {
      const next = queue.shift()
      if (next) runItem(next)
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
      const callbacks = onWritten ? [onWritten] : []
      const previous = queue[queue.length - 1]
      if (
        mode === 'replay'
        && previous?.kind === 'write'
        && previous.mode === 'replay'
        && previous.data.length + data.length <= MAX_COALESCED_REPLAY_WRITE_LENGTH
      ) {
        previous.data += data
        previous.callbacks.push(...callbacks)
      } else {
        queue.push({ kind: 'write', mode, data, callbacks })
      }
      scheduleFlush()
    },
    enqueueTask(task, options) {
      queue.push({ kind: 'task', mode: options?.mode ?? 'live', task })
      scheduleFlush()
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
