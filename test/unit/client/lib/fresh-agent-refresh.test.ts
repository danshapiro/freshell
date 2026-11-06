import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FRESH_AGENT_REFRESH_TIMEOUT_MS,
  armRefreshDeadline,
  beginRefresh,
  settleRefresh,
  type RefreshAttempt,
} from '@/lib/fresh-agent-refresh'

describe('fresh-agent refresh lifecycle', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('starts a fixed 15-second attempt and preserves that deadline across an internal retry', () => {
    const first = beginRefresh({ identity: 'pane-a:thread-1', requestId: 'request-1', now: 1_000 })
    expect(first).toEqual({
      identity: 'pane-a:thread-1',
      requestId: 'request-1',
      startedAt: 1_000,
      deadlineAt: 1_000 + FRESH_AGENT_REFRESH_TIMEOUT_MS,
      state: 'pending',
    })

    const retry = beginRefresh({
      identity: first.identity,
      requestId: 'request-2',
      now: 8_000,
      previous: first,
      preserveDeadline: true,
    })
    expect(retry.startedAt).toBe(first.startedAt)
    expect(retry.deadlineAt).toBe(first.deadlineAt)
    expect(retry.requestId).toBe('request-2')
  })

  it('starts a distinct deadline when the identity changes or the previous attempt settled', () => {
    const first = beginRefresh({ identity: 'pane-a:thread-1', requestId: 'request-1', now: 1_000 })
    const replacement = beginRefresh({
      identity: 'pane-a:thread-2', requestId: 'request-2', now: 2_000,
      previous: first, preserveDeadline: true,
    })
    expect(replacement.deadlineAt).toBe(2_000 + FRESH_AGENT_REFRESH_TIMEOUT_MS)

    const settled = settleRefresh(replacement, replacement.identity, replacement.requestId, 'timed-out')
    expect(settled?.state).toBe('timed-out')
    const retry = beginRefresh({
      identity: replacement.identity, requestId: 'request-3', now: 20_000,
      previous: settled ?? undefined, preserveDeadline: true,
    })
    expect(retry.deadlineAt).toBe(20_000 + FRESH_AGENT_REFRESH_TIMEOUT_MS)
  })

  it('only settles the matching pending identity and request', () => {
    const current = beginRefresh({ identity: 'pane-a:thread-1', requestId: 'request-2', now: 1_000 })
    expect(settleRefresh(current, 'pane-a:thread-1', 'request-1', 'succeeded')).toBeNull()
    expect(settleRefresh(current, 'pane-b:thread-1', 'request-2', 'failed')).toBeNull()
    expect(settleRefresh(current, current.identity, current.requestId, 'succeeded')).toMatchObject({
      state: 'succeeded',
      requestId: 'request-2',
    })
  })

  it('fires at the attempt deadline and can dispose the timer', () => {
    const attempt: RefreshAttempt = beginRefresh({ identity: 'pane-a:thread-1', requestId: 'request-1', now: Date.now() })
    const timedOut = vi.fn()
    const dispose = armRefreshDeadline(attempt, timedOut)

    vi.advanceTimersByTime(FRESH_AGENT_REFRESH_TIMEOUT_MS - 1)
    expect(timedOut).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(timedOut).toHaveBeenCalledTimes(1)

    const disposedAttempt = beginRefresh({ identity: 'pane-a:thread-1', requestId: 'request-2', now: Date.now() })
    const disposed = vi.fn()
    const disposeSecond = armRefreshDeadline(disposedAttempt, disposed)
    disposeSecond()
    dispose()
    vi.advanceTimersByTime(FRESH_AGENT_REFRESH_TIMEOUT_MS)
    expect(disposed).not.toHaveBeenCalled()
  })
})
