import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import {
  makeSnapshotKey,
  getSnapshotScheduler,
  resetSnapshotSchedulerForTests,
} from '@/lib/fresh-agent-snapshot-scheduler'

const KEY = makeSnapshotKey({ sessionType: 'freshopencode', provider: 'opencode', threadId: 'ses_1', cwd: '/w' })

describe('FreshAgentSnapshotScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetSnapshotSchedulerForTests()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('builds the key from the exact request tuple', () => {
    expect(KEY).toBe('freshopencode:opencode:ses_1:/w')
    expect(makeSnapshotKey({ sessionType: 'freshopencode', provider: 'opencode', threadId: 'ses_1' }))
      .toBe('freshopencode:opencode:ses_1:')
  })

  it('coalesces an event burst into a single run shared by all callers', async () => {
    const scheduler = getSnapshotScheduler()
    const run = vi.fn(async () => 'snap')
    const p1 = scheduler.schedule(KEY, 'event', run)
    const p2 = scheduler.schedule(KEY, 'event', run)
    const p3 = scheduler.schedule(KEY, 'event', run)
    await vi.advanceTimersByTimeAsync(250)
    const [o1, o2, o3] = await Promise.all([p1, p2, p3])
    expect(run).toHaveBeenCalledTimes(1)
    expect(o1).toEqual({ status: 'ok', value: 'snap' })
    expect(o2).toEqual({ status: 'ok', value: 'snap' })
    expect(o3).toEqual({ status: 'ok', value: 'snap' })
  })

  it('runs manual triggers immediately and holds a single trailing run while in flight', async () => {
    const scheduler = getSnapshotScheduler()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const run = vi.fn(async () => { await gate; return 'v' })
    const first = scheduler.schedule(KEY, 'manual', run)
    // three arrivals while in flight -> exactly one trailing run
    const t1 = scheduler.schedule(KEY, 'event', run)
    const t2 = scheduler.schedule(KEY, 'event', run)
    release()
    await first
    await vi.advanceTimersByTimeAsync(250)
    await Promise.all([t1, t2])
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('keys are independent', async () => {
    const scheduler = getSnapshotScheduler()
    const runA = vi.fn(async () => 'a')
    const runB = vi.fn(async () => 'b')
    const otherKey = makeSnapshotKey({ sessionType: 'freshopencode', provider: 'opencode', threadId: 'ses_2', cwd: '/w' })
    const pa = scheduler.schedule(KEY, 'manual', runA)
    const pb = scheduler.schedule(otherKey, 'manual', runB)
    await Promise.all([pa, pb])
    expect(runA).toHaveBeenCalledTimes(1)
    expect(runB).toHaveBeenCalledTimes(1)
  })

  it('honors Retry-After on 429 and suppresses further runs until expiry', async () => {
    const scheduler = getSnapshotScheduler()
    const run = vi.fn(async () => { throw new ApiError(429, 'Too many requests', undefined, 5_000) })
    const first = await scheduler.schedule(KEY, 'manual', run)
    expect(first.status).toBe('rate-limited')
    expect(run).toHaveBeenCalledTimes(1)

    const during = await scheduler.schedule(KEY, 'poll', run)
    expect(during.status).toBe('backoff')
    expect(run).toHaveBeenCalledTimes(1)          // NO network call during backoff
    expect(scheduler.getBackoffUntil(KEY)).toBeGreaterThan(Date.now())

    await vi.advanceTimersByTimeAsync(5_001)
    const ok = vi.fn(async () => 'fresh')
    const after = await scheduler.schedule(KEY, 'poll', ok)
    expect(after).toEqual({ status: 'ok', value: 'fresh' })
    expect(scheduler.getBackoffUntil(KEY)).toBeNull()
  })

  it('resolves mid-flight sharers with rate-limited on a 429 instead of stranding their promises', async () => {
    const scheduler = getSnapshotScheduler()
    let reject!: (e: unknown) => void
    const gated = new Promise<never>((_, r) => { reject = r })
    const run = vi.fn(() => gated)
    const first = scheduler.schedule(KEY, 'manual', run)
    const midFlight = scheduler.schedule(KEY, 'event', run)   // arrives while in flight -> queued for the trailing run
    reject(new ApiError(429, 'Too many requests', undefined, 5_000))
    const [o1, o2] = await Promise.all([first, midFlight])    // BOTH must settle
    expect(o1.status).toBe('rate-limited')
    expect(o2.status).toBe('rate-limited')
    expect(run).toHaveBeenCalledTimes(1)                      // the trailing run is cancelled: no second network call
  })

  it('falls back to exponential backoff when Retry-After is absent and doubles per consecutive 429', async () => {
    const scheduler = getSnapshotScheduler()
    const run429 = vi.fn(async () => { throw new ApiError(429, 'Too many requests') })
    const o1 = await scheduler.schedule(KEY, 'manual', run429)
    expect(o1.status).toBe('rate-limited')
    if (o1.status !== 'rate-limited') throw new Error('unreachable')
    const firstDelta = o1.retryAtMs - Date.now()
    expect(firstDelta).toBeGreaterThan(0)
    expect(firstDelta).toBeLessThanOrEqual(1_000)

    await vi.advanceTimersByTimeAsync(1_001)
    const o2 = await scheduler.schedule(KEY, 'manual', run429)
    if (o2.status !== 'rate-limited') throw new Error(`expected rate-limited, got ${o2.status}`)
    expect(o2.retryAtMs - Date.now()).toBeGreaterThan(1_000)   // doubled
  })

  it('resolves non-429 failures as error outcomes without backoff', async () => {
    const scheduler = getSnapshotScheduler()
    const boom = new Error('network down')
    const out = await scheduler.schedule(KEY, 'manual', async () => { throw boom })
    expect(out).toEqual({ status: 'error', error: boom })
    expect(scheduler.getBackoffUntil(KEY)).toBeNull()
  })

  it('retires settled successful generations while retaining active and trailing work', async () => {
    const scheduler = getSnapshotScheduler()
    // Inspect the existing runtime state to verify the resource lifecycle;
    // its public outcomes alone cannot distinguish an idle entry from none.
    const cohorts = (scheduler as unknown as { keys: Map<string, unknown> }).keys
    for (let generation = 0; generation < 20; generation += 1) {
      const key = `${KEY}:generation:${generation}`
      await expect(scheduler.schedule(key, 'manual', async () => generation)).resolves.toEqual({ status: 'ok', value: generation })
    }
    expect(cohorts.size).toBe(0)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const run = vi.fn(async () => { await gate; return 'current' })
    const first = scheduler.schedule(KEY, 'manual', run)
    const trailing = scheduler.schedule(KEY, 'event', run)
    expect(cohorts.size).toBe(1)
    release()
    await first
    expect(cohorts.size).toBe(1)
    await vi.advanceTimersByTimeAsync(250)
    await expect(trailing).resolves.toEqual({ status: 'ok', value: 'current' })
    expect(run).toHaveBeenCalledTimes(2)
    expect(cohorts.size).toBe(0)
  })

  it('retains 429 history through an ordinary failure until a successful retry', async () => {
    const scheduler = getSnapshotScheduler()
    const cohorts = (scheduler as unknown as { keys: Map<string, unknown> }).keys
    const rateLimit = async () => { throw new ApiError(429, 'Too many requests') }
    const first = await scheduler.schedule(KEY, 'manual', rateLimit)
    if (first.status !== 'rate-limited') throw new Error('expected rate limit')
    const firstDelay = first.retryAtMs - Date.now()
    const suppressed = vi.fn(async () => 'unexpected')
    expect((await scheduler.schedule(KEY, 'manual', suppressed)).status).toBe('backoff')
    expect(suppressed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(firstDelay + 1)
    expect((await scheduler.schedule(KEY, 'manual', async () => { throw new Error('offline') })).status).toBe('error')
    expect(cohorts.size).toBe(1)
    const second = await scheduler.schedule(KEY, 'manual', rateLimit)
    if (second.status !== 'rate-limited') throw new Error('expected second rate limit')
    expect(second.retryAtMs - Date.now()).toBeGreaterThan(firstDelay)
    await vi.advanceTimersByTimeAsync(second.retryAtMs - Date.now() + 1)
    expect((await scheduler.schedule(KEY, 'manual', async () => 'recovered')).status).toBe('ok')
    expect(cohorts.size).toBe(0)
    const afterSuccess = await scheduler.schedule(KEY, 'manual', rateLimit)
    if (afterSuccess.status !== 'rate-limited') throw new Error('expected rate limit after success')
    expect(afterSuccess.retryAtMs - Date.now()).toBe(firstDelay)
  })

  it('does not let an old completion retire a replacement in-flight cohort', async () => {
    const scheduler = getSnapshotScheduler()
    let releaseOld!: () => void
    let releaseCurrent!: () => void
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve })
    const currentGate = new Promise<void>((resolve) => { releaseCurrent = resolve })
    const old = scheduler.schedule(KEY, 'manual', async () => { await oldGate; return 'old' })
    scheduler.disposeForTests()
    const run = vi.fn(async () => { await currentGate; return 'current' })
    const current = scheduler.schedule(KEY, 'manual', run)
    releaseOld()
    await expect(old).resolves.toEqual({ status: 'ok', value: 'old' })
    const trailing = scheduler.schedule(KEY, 'event', run)
    releaseCurrent()
    await expect(current).resolves.toEqual({ status: 'ok', value: 'current' })
    await vi.advanceTimersByTimeAsync(250)
    await expect(trailing).resolves.toEqual({ status: 'ok', value: 'current' })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('reset cancels pending debounced runs so a stale run cannot fire into the next test', async () => {
    const scheduler = getSnapshotScheduler()
    const run = vi.fn(async () => 'snap')
    const pending = scheduler.schedule(KEY, 'event', run) // debounced 250ms
    resetSnapshotSchedulerForTests()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run).not.toHaveBeenCalled()
    // The caller's promise must still settle, never hang.
    await expect(pending).resolves.toEqual({ status: 'coalesced' })
  })
})
