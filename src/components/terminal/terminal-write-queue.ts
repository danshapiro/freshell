export type TerminalWriteQueue = {
  enqueue: (data: string, onWritten?: () => void) => void
  enqueueTask: (task: () => void) => void
  clear: () => void
}

type TerminalWriteQueueArgs = {
  write: (data: string, onWritten?: () => void) => void
  onDrain?: () => void
  budgetMs?: number
  now?: () => number
  requestFrame?: (cb: FrameRequestCallback) => number
  cancelFrame?: (id: number) => void
}

export function createTerminalWriteQueue(args: TerminalWriteQueueArgs): TerminalWriteQueue {
  const queue: Array<() => void> = []
  const budgetMs = args.budgetMs ?? 8
  const now = args.now ?? (() => performance.now())
  const requestFrame = args.requestFrame ?? ((cb) => requestAnimationFrame(cb))
  const cancelFrame = args.cancelFrame ?? ((id) => cancelAnimationFrame(id))
  let rafId: number | null = null
  let scheduled = false

  const flush = () => {
    const deadline = now() + budgetMs
    while (queue.length > 0 && now() <= deadline) {
      const next = queue.shift()
      next?.()
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
    enqueue(data, onWritten) {
      if (!data) return
      queue.push(() => args.write(data, onWritten))
      scheduleFlush()
    },
    enqueueTask(task) {
      queue.push(task)
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
