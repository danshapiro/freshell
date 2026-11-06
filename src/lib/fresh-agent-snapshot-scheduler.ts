/**
 * Per-snapshot-key scheduler for Fresh Agent snapshot reads. It coalesces
 * bursts, shares one read with its waiters, and bounds each shared run. A
 * waiter signal only unsubscribes that waiter; the scheduler owns the signal
 * passed to the shared read.
 */

import { ApiError } from '@/lib/api'
import { FRESH_AGENT_REFRESH_TIMEOUT_MS } from '@/lib/fresh-agent-refresh'

export type SnapshotTrigger =
  | 'identity' | 'event' | 'send-accepted' | 'materialized'
  | 'manual' | 'poll' | 'reconnect' | 'reveal' | 'reveal-surface' | 'idle-incomplete'

export type SnapshotOutcome<T> =
  | { status: 'ok'; value: T }
  | { status: 'rate-limited'; retryAtMs: number }
  | { status: 'backoff'; retryAtMs: number }
  | { status: 'coalesced' }
  | { status: 'error'; error: unknown }

export const SNAPSHOT_DEBOUNCE_MS = 250
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 30_000

const DEBOUNCED_TRIGGERS: ReadonlySet<SnapshotTrigger> = new Set(['event', 'send-accepted', 'reveal', 'reveal-surface', 'reconnect'])

export class SnapshotRunTimeoutError extends Error {
  constructor() {
    super(`Conversation refresh did not finish within ${FRESH_AGENT_REFRESH_TIMEOUT_MS}ms.`)
    this.name = 'SnapshotRunTimeoutError'
  }
}

export function makeSnapshotKey(input: {
  sessionType: string; provider: string; threadId: string; cwd?: string; soulId?: string; soulIntentRevision?: number
}): string {
  return `${input.sessionType}:${input.provider}:${input.threadId}:${input.cwd ?? ''}${input.soulId ? `:soul:${input.soulId}:${input.soulIntentRevision ?? ''}` : ''}`
}

type Resolver<T> = (outcome: SnapshotOutcome<T>) => void
type Waiter<T> = {
  resolve: Resolver<T>
  signal?: AbortSignal
  abortListener?: () => void
}
type SnapshotRun<T> = (signal: AbortSignal) => Promise<T>
type RunResult<T> = { kind: 'ok'; value: T } | { kind: 'error'; error: unknown } | { kind: 'timeout' } | { kind: 'cancelled' }

type ActiveRun = {
  generation: number
  controller: AbortController
  deadlineTimer: ReturnType<typeof setTimeout>
  waiters: Waiter<any>[]
  cancel: () => void
}

type KeyState = {
  inFlight: ActiveRun | null
  debounceTimer: ReturnType<typeof setTimeout> | null
  /** Callers waiting on the pending (debounced or trailing) run. */
  pendingWaiters: Waiter<any>[]
  /** Latest run fn wins for the pending run. */
  pendingRun: SnapshotRun<any> | null
  trailingRequested: boolean
  backoffUntil: number | null
  consecutive429: number
  generation: number
}

export class FreshAgentSnapshotScheduler {
  private readonly keys = new Map<string, KeyState>()

  private state(key: string): KeyState {
    let state = this.keys.get(key)
    if (!state) {
      state = {
        inFlight: null,
        debounceTimer: null,
        pendingWaiters: [],
        pendingRun: null,
        trailingRequested: false,
        backoffUntil: null,
        consecutive429: 0,
        generation: 0,
      }
      this.keys.set(key, state)
    }
    return state
  }

  getBackoffUntil(key: string): number | null {
    const state = this.keys.get(key)
    if (!state?.backoffUntil) return null
    if (state.backoffUntil <= Date.now()) return null
    return state.backoffUntil
  }

  schedule<T>(
    key: string,
    trigger: SnapshotTrigger,
    run: SnapshotRun<T>,
    observer: { signal?: AbortSignal } = {},
  ): Promise<SnapshotOutcome<T>> {
    const state = this.state(key)
    const retryAt = this.getBackoffUntil(key)
    if (retryAt !== null) return Promise.resolve({ status: 'backoff', retryAtMs: retryAt })
    if (observer.signal?.aborted) return Promise.resolve({ status: 'coalesced' })

    return new Promise<SnapshotOutcome<T>>((resolve) => {
      const waiter: Waiter<T> = { resolve }
      if (observer.signal) {
        waiter.signal = observer.signal
        waiter.abortListener = () => {
          this.removeWaiter(state.pendingWaiters, waiter)
          if (state.inFlight) this.removeWaiter(state.inFlight.waiters, waiter)
          this.resolveWaiter(waiter, { status: 'coalesced' })
        }
        observer.signal.addEventListener('abort', waiter.abortListener, { once: true })
      }
      state.pendingWaiters.push(waiter)
      state.pendingRun = run
      if (state.inFlight) {
        state.trailingRequested = true
        return
      }
      const delay = DEBOUNCED_TRIGGERS.has(trigger) ? SNAPSHOT_DEBOUNCE_MS : 0
      if (state.debounceTimer !== null) {
        if (delay === 0) {
          clearTimeout(state.debounceTimer)
          state.debounceTimer = null
          void this.execute(key)
        }
        return
      }
      if (delay === 0) {
        void this.execute(key)
      } else {
        state.debounceTimer = setTimeout(() => {
          state.debounceTimer = null
          void this.execute(key)
        }, delay)
      }
    })
  }

  private removeWaiter<T>(waiters: Waiter<any>[], target: Waiter<T>): void {
    const index = waiters.indexOf(target)
    if (index >= 0) waiters.splice(index, 1)
  }

  private resolveWaiter<T>(waiter: Waiter<T>, outcome: SnapshotOutcome<T>): void {
    if (waiter.signal && waiter.abortListener) {
      waiter.signal.removeEventListener('abort', waiter.abortListener)
      waiter.abortListener = undefined
    }
    waiter.resolve(outcome)
  }

  private settleWaiters<T>(waiters: Waiter<any>[], outcome: SnapshotOutcome<T>): void {
    const cohort = waiters.splice(0)
    for (const waiter of cohort) this.resolveWaiter(waiter, outcome)
  }

  private async execute(key: string): Promise<void> {
    const state = this.state(key)
    const run = state.pendingRun
    const waiters = state.pendingWaiters.splice(0)
    state.pendingRun = null
    if (!run || waiters.length === 0) return

    const controller = new AbortController()
    let resolveDeadline!: (result: RunResult<any>) => void
    const deadline = new Promise<RunResult<any>>((resolve) => { resolveDeadline = resolve })
    let resolveCancellation!: (result: RunResult<any>) => void
    const cancellation = new Promise<RunResult<any>>((resolve) => { resolveCancellation = resolve })
    const generation = ++state.generation
    const active: ActiveRun = {
      generation,
      controller,
      deadlineTimer: setTimeout(() => {
        controller.abort()
        resolveDeadline({ kind: 'timeout' })
      }, FRESH_AGENT_REFRESH_TIMEOUT_MS),
      waiters,
      cancel: () => resolveCancellation({ kind: 'cancelled' }),
    }
    state.inFlight = active

    const execution: Promise<RunResult<any>> = Promise.resolve()
      .then(() => run(controller.signal))
      .then(
        (value): RunResult<any> => ({ kind: 'ok', value }),
        (error: unknown): RunResult<any> => ({ kind: 'error', error }),
      )
    let result!: RunResult<any>
    let wasCurrentGeneration = false
    try {
      result = await Promise.race([execution, deadline, cancellation])
      wasCurrentGeneration = state.inFlight === active && state.generation === generation
    } finally {
      clearTimeout(active.deadlineTimer)
      if (state.inFlight === active && state.generation === generation) {
        state.inFlight = null
      }
    }
    if (!wasCurrentGeneration) return

    if (result.kind === 'cancelled') {
      this.settleWaiters(active.waiters, { status: 'coalesced' })
      return
    }

    let outcome: SnapshotOutcome<any>
    if (result.kind === 'timeout') {
      outcome = { status: 'error', error: new SnapshotRunTimeoutError() }
    } else if (result.kind === 'ok') {
      state.consecutive429 = 0
      state.backoffUntil = null
      outcome = { status: 'ok', value: result.value }
    } else if (result.error instanceof ApiError && result.error.status === 429) {
      state.consecutive429 += 1
      const fallback = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (state.consecutive429 - 1))
      const retryAtMs = Date.now() + (result.error.retryAfterMs ?? fallback)
      state.backoffUntil = retryAtMs
      outcome = { status: 'rate-limited', retryAtMs }
      // A 429 supersedes any trailing request. Settle those observers too.
      state.trailingRequested = false
      if (state.debounceTimer !== null) {
        clearTimeout(state.debounceTimer)
        state.debounceTimer = null
      }
      state.pendingRun = null
      this.settleWaiters(state.pendingWaiters, outcome)
    } else {
      outcome = { status: 'error', error: result.error }
    }
    this.settleWaiters(active.waiters, outcome)

    if (state.trailingRequested && state.pendingRun && state.pendingWaiters.length > 0) {
      state.trailingRequested = false
      state.debounceTimer = setTimeout(() => {
        state.debounceTimer = null
        void this.execute(key)
      }, SNAPSHOT_DEBOUNCE_MS)
    } else {
      state.trailingRequested = false
    }
  }

  /**
   * Test-only teardown: cancel pending debounced runs and release observers.
   * The shared run signal is aborted; its generation is invalidated so a late
   * completion cannot write state into a later test.
   */
  disposeForTests(): void {
    for (const state of this.keys.values()) {
      if (state.debounceTimer !== null) {
        clearTimeout(state.debounceTimer)
        state.debounceTimer = null
      }
      state.trailingRequested = false
      state.pendingRun = null
      this.settleWaiters(state.pendingWaiters, { status: 'coalesced' })
      if (state.inFlight) {
        const active = state.inFlight
        clearTimeout(active.deadlineTimer)
        active.controller.abort()
        ++state.generation
        state.inFlight = null
        active.cancel()
        this.settleWaiters(active.waiters, { status: 'coalesced' })
      }
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
