import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import { streamOpsApplied } from '@/store/freshAgentLiveSlice'
import type { FreshAgentSessionLocator } from '@/store/freshAgentTypes'
import type { LiveStreamOp } from '@/store/freshAgentLiveTypes'

/**
 * How long stream events wait before they reach the store. A model streams a
 * token every few milliseconds; applying them every 100 ms bounds the live
 * tail's re-renders (and its markdown re-parses) to ten a second while text
 * still appears without a visible lag (transcript-live plan §4.4, risk 6).
 */
export const LIVE_STREAM_FLUSH_MS = 100

export type StreamBatcherScheduler = {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

// Read the timer functions at call time so fake timers installed after this
// module loads still drive the batcher.
const timerScheduler: StreamBatcherScheduler = {
  set: (fn, ms) => globalThis.setTimeout(fn, ms),
  clear: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

type Dispatch = (action: ReturnType<typeof streamOpsApplied>) => unknown

type PendingSession = {
  locator: FreshAgentSessionLocator
  ops: LiveStreamOp[]
}

/**
 * Buffers stream events per session and applies each session's batch as one
 * `streamOpsApplied` action. The websocket handler flushes a session before it
 * handles any other event of that session, so the store always sees one
 * session's events in arrival order.
 */
export class FreshAgentStreamBatcher {
  private readonly pending = new Map<string, PendingSession>()
  private timer: unknown = null

  constructor(
    private readonly dispatch: Dispatch,
    private readonly scheduler: StreamBatcherScheduler = timerScheduler,
  ) {}

  enqueue(locator: FreshAgentSessionLocator, op: LiveStreamOp): void {
    const key = makeFreshAgentSessionKey(locator)
    let entry = this.pending.get(key)
    if (!entry) {
      entry = { locator: { sessionId: locator.sessionId, sessionType: locator.sessionType, provider: locator.provider }, ops: [] }
      this.pending.set(key, entry)
    }
    entry.ops.push(op)
    if (this.timer === null) {
      this.timer = this.scheduler.set(() => {
        this.timer = null
        this.flush()
      }, LIVE_STREAM_FLUSH_MS)
    }
  }

  /** Apply one session's pending events now, or every session's when none is named. */
  flush(locator?: FreshAgentSessionLocator): void {
    if (locator) {
      const key = makeFreshAgentSessionKey(locator)
      const entry = this.pending.get(key)
      if (!entry) return
      this.pending.delete(key)
      this.dispatchEntry(entry)
    } else {
      const entries = [...this.pending.values()]
      this.pending.clear()
      for (const entry of entries) this.dispatchEntry(entry)
    }
    if (this.pending.size === 0 && this.timer !== null) {
      this.scheduler.clear(this.timer)
      this.timer = null
    }
  }

  private dispatchEntry(entry: PendingSession): void {
    this.dispatch(streamOpsApplied({ ...entry.locator, ops: entry.ops }))
  }
}

const batchers = new WeakMap<object, FreshAgentStreamBatcher>()

/**
 * The batcher that feeds one store (keyed by its dispatch function, which is
 * stable for a store's lifetime).
 */
export function streamBatcherFor(dispatch: Dispatch): FreshAgentStreamBatcher {
  let batcher = batchers.get(dispatch)
  if (!batcher) {
    batcher = new FreshAgentStreamBatcher(dispatch)
    batchers.set(dispatch, batcher)
  }
  return batcher
}
