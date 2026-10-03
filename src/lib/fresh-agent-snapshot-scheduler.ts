/**
 * FreshAgentSnapshotScheduler -- per-snapshot-key scheduler for fresh-agent
 * snapshot GETs: single-flight, trailing coalesce, class-based debounce, and
 * 429 backoff (Retry-After or exponential). Module singleton, precedent:
 * getRebindQueue()/resetRebindQueueForTests() in src/lib/rebind-queue.ts.
 *
 * Run-closure contract: the scheduler may execute a `run` closure long after
 * the caller's React effect cleaned up (debounce/trailing), and one caller's
 * closure runs on behalf of ALL sharers of the key. Callers must NOT bind
 * caller-scoped AbortControllers/signals into `run` -- an owner abort
 * mid-flight (or a debounced run firing an already-aborted signal) would
 * resolve { status: 'error', AbortError } to every sharer, silently dropping
 * the refresh for panes that are still alive. Pass no signal; staleness is
 * handled by result-application guards, not cancellation.
 */

import { ApiError } from '@/lib/api'

export type SnapshotTrigger =
  | 'identity' | 'event' | 'send-accepted' | 'materialized'
  | 'manual' | 'poll' | 'reconnect' | 'reveal' | 'idle-incomplete'

export type SnapshotOutcome<T> =
  | { status: 'ok'; value: T }
  | { status: 'rate-limited'; retryAtMs: number }
  | { status: 'backoff'; retryAtMs: number }
  | { status: 'coalesced' }
  | { status: 'error'; error: unknown }

export const SNAPSHOT_DEBOUNCE_MS = 250
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 30_000

const DEBOUNCED_TRIGGERS: ReadonlySet<SnapshotTrigger> = new Set(['event', 'send-accepted', 'reveal', 'reconnect'])

export function makeSnapshotKey(input: {
  sessionType: string; provider: string; threadId: string; cwd?: string; soulId?: string; soulIntentRevision?: number
}): string {
  return `${input.sessionType}:${input.provider}:${input.threadId}:${input.cwd ?? ''}${input.soulId ? `:soul:${input.soulId}:${input.soulIntentRevision ?? ''}` : ''}`
}

type Resolver<T> = (outcome: SnapshotOutcome<T>) => void

type KeyState = {
  inFlight: boolean
  debounceTimer: ReturnType<typeof setTimeout> | null
  /** Callers waiting on the pending (debounced or trailing) run. */
  pendingResolvers: Resolver<any>[]
  /** Latest run fn wins for the pending run. */
  pendingRun: (() => Promise<any>) | null
  trailingRequested: boolean
  backoffUntil: number | null
  consecutive429: number
}

export class FreshAgentSnapshotScheduler {
  private readonly keys = new Map<string, KeyState>()

  private state(key: string): KeyState {
    let s = this.keys.get(key)
    if (!s) {
      s = {
        inFlight: false, debounceTimer: null, pendingResolvers: [],
        pendingRun: null, trailingRequested: false, backoffUntil: null, consecutive429: 0,
      }
      this.keys.set(key, s)
    }
    return s
  }

  getBackoffUntil(key: string): number | null {
    const s = this.keys.get(key)
    if (!s?.backoffUntil) return null
    if (s.backoffUntil <= Date.now()) return null
    return s.backoffUntil
  }

  schedule<T>(key: string, trigger: SnapshotTrigger, run: () => Promise<T>): Promise<SnapshotOutcome<T>> {
    const s = this.state(key)
    const retryAt = this.getBackoffUntil(key)
    if (retryAt !== null) {
      return Promise.resolve({ status: 'backoff', retryAtMs: retryAt })
    }
    return new Promise<SnapshotOutcome<T>>((resolve) => {
      s.pendingResolvers.push(resolve as Resolver<any>)
      s.pendingRun = run
      if (s.inFlight) {
        s.trailingRequested = true
        return
      }
      const delay = DEBOUNCED_TRIGGERS.has(trigger) ? SNAPSHOT_DEBOUNCE_MS : 0
      if (s.debounceTimer !== null) {
        if (delay === 0) {
          clearTimeout(s.debounceTimer)
          s.debounceTimer = null
          void this.execute(key)
        }
        return // burst absorbed into the pending timer
      }
      if (delay === 0) {
        void this.execute(key)
      } else {
        s.debounceTimer = setTimeout(() => {
          s.debounceTimer = null
          void this.execute(key)
        }, delay)
      }
    })
  }

  private async execute(key: string): Promise<void> {
    const s = this.state(key)
    const run = s.pendingRun
    const resolvers = s.pendingResolvers
    s.pendingRun = null
    s.pendingResolvers = []
    if (!run) return
    s.inFlight = true
    let outcome: SnapshotOutcome<any>
    try {
      const value = await run()
      s.consecutive429 = 0
      s.backoffUntil = null
      outcome = { status: 'ok', value }
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 429) {
        s.consecutive429 += 1
        const fallback = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (s.consecutive429 - 1))
        const retryAtMs = Date.now() + (error.retryAfterMs ?? fallback)
        s.backoffUntil = retryAtMs
        outcome = { status: 'rate-limited', retryAtMs }
        // A 429 supersedes any trailing request: cancel it AND resolve the
        // mid-flight cohort queued behind this run with the same rate-limited
        // outcome -- their promises must never be left pending.
        s.trailingRequested = false
        const trailing = s.pendingResolvers
        s.pendingResolvers = []
        s.pendingRun = null
        for (const resolve of trailing) resolve(outcome)
      } else {
        outcome = { status: 'error', error }
      }
    }
    s.inFlight = false
    for (const resolve of resolvers) resolve(outcome)
    if (s.trailingRequested && s.pendingRun) {
      s.trailingRequested = false
      s.debounceTimer = setTimeout(() => {
        s.debounceTimer = null
        void this.execute(key)
      }, SNAPSHOT_DEBOUNCE_MS)
    } else {
      s.trailingRequested = false
    }
  }

  /**
   * Test-only teardown: cancel pending debounced runs and drop all key state.
   * The singleton outlives component unmount BY DESIGN (run-closure contract),
   * so without this a debounce timer armed near the end of one test fires its
   * stale run into the next test (consuming that test's mock queues). Queued
   * resolvers are resolved as coalesced so no caller promise is left pending.
   */
  disposeForTests(): void {
    for (const s of this.keys.values()) {
      if (s.debounceTimer !== null) {
        clearTimeout(s.debounceTimer)
        s.debounceTimer = null
      }
      s.trailingRequested = false
      s.pendingRun = null
      const resolvers = s.pendingResolvers
      s.pendingResolvers = []
      for (const resolve of resolvers) resolve({ status: 'coalesced' })
    }
    this.keys.clear()
  }
}

let singleton: FreshAgentSnapshotScheduler | null = null

export function getSnapshotScheduler(): FreshAgentSnapshotScheduler {
  if (!singleton) singleton = new FreshAgentSnapshotScheduler()
  return singleton
}

export function resetSnapshotSchedulerForTests(): void {
  singleton?.disposeForTests()
  singleton = null
}
