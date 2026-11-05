import { afterEach, describe, expect, it, vi } from 'vitest'
import { selectProviderReplacement, waitForProviderReplacement, type ReplacementView, type RetryEvent } from '../../../helpers/provider-replacement-observation.js'

const before = { terminalId: 'terminal', soulId: 'soul', incarnationId: 'old', intentRevision: 4,
  nativeSessionId: 'native-root', controlEpoch: 8 }
const pending: ReplacementView = { ...before, launchState: 'stopped', recoveryState: 'blocked',
  recoveryReason: 'CAPABILITY_PENDING', evidenceRevision: 2 }
const ready: ReplacementView = { ...before, incarnationId: 'new', launchState: 'running',
  recoveryState: 'live', containerId: 'owned' }
const scheduled: RetryEvent = { event: 'supervisor.recovery_retry.scheduled', data: {
  soulId: before.soulId, incarnationId: before.incarnationId, intentRevision: before.intentRevision,
  controlEpoch: before.controlEpoch, attemptId: 'attempt', attemptCount: 1, nextDueAtMs: 2_000,
  reason: 'preparation_unavailable',
} }

afterEach(() => { vi.useRealTimers() })

describe('provider replacement observation', () => {
  it('accepts an identity-fenced running replacement before its retry event is observed', () => {
    expect(selectProviderReplacement([pending, ready], before, [])).toEqual(ready)
  })

  it('observes a valid bounded preparation retry through the same native replacement', async () => {
    vi.useFakeTimers()
    const read = vi.fn()
      .mockResolvedValueOnce({ rows: [pending], events: [scheduled] })
      .mockResolvedValueOnce({ rows: [pending], events: [scheduled, { ...scheduled,
        event: 'supervisor.recovery_retry.reserved', data: { ...scheduled.data, attemptId: 'next-attempt', attemptCount: 2 } }] })
      .mockResolvedValue({ rows: [ready], events: [scheduled] })
    const result = waitForProviderReplacement(before, read, Date.now() + 500)
      .then(value => ({ value }), error => ({ error }))
    await vi.advanceTimersByTimeAsync(200)
    expect(await result).toEqual({ value: ready })
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('fails a capability block without a matching retry authorization', () => {
    for (const events of [[], [{ ...scheduled, data: { ...scheduled.data, soulId: 'other' } }],
      [{ ...scheduled, data: { ...scheduled.data, controlEpoch: 7 } }],
      [{ ...scheduled, data: { ...scheduled.data, intentRevision: 3 } }],
      [{ ...scheduled, data: { ...scheduled.data, incarnationId: 'other' } }],
      [{ ...scheduled, data: { ...scheduled.data, reason: 'host_unavailable' } }],
      [{ ...scheduled, data: { ...scheduled.data, attemptCount: 3 } }],
      [{ ...scheduled, data: { ...scheduled.data, nextDueAtMs: null } }],
      [scheduled, { ...scheduled, event: 'supervisor.recovery_retry.reserved',
        data: { ...scheduled.data, attemptCount: 2 } }]]) {
      expect(() => selectProviderReplacement([pending], before, events)).toThrow('CAPABILITY_PENDING')
    }
  })

  it('fails permanent and exhausted blockage even after a preparation retry', () => {
    for (const recoveryReason of ['IDENTITY_MISMATCH', 'RETRY_BUDGET']) {
      expect(() => selectProviderReplacement([{ ...pending, recoveryReason }], before, [scheduled])).toThrow(recoveryReason)
    }
    const cancelled = { ...scheduled, event: 'supervisor.recovery_retry.cancelled' }
    expect(() => selectProviderReplacement([pending], before, [scheduled, cancelled])).toThrow('CAPABILITY_PENDING')
  })

  it('keeps one absolute deadline when authorized preparation never completes', async () => {
    vi.useFakeTimers()
    const read = vi.fn().mockResolvedValue({ rows: [pending], events: [scheduled] })
    const result = waitForProviderReplacement(before, read, Date.now() + 500)
      .then(() => undefined, (error: Error) => error)
    await vi.advanceTimersByTimeAsync(500)
    expect((await result)?.message).toBe('timed out waiting for provider replacement')
    expect(read).toHaveBeenCalledTimes(5)
  })

  it('does not accept a ready probe that completes after the original deadline', async () => {
    vi.useFakeTimers()
    const read = () => new Promise<{ rows: ReplacementView[]; events: RetryEvent[] }>(resolve => {
      setTimeout(() => resolve({ rows: [ready], events: [] }), 600)
    })
    const result = waitForProviderReplacement(before, read, Date.now() + 500)
      .then(() => undefined, (error: Error) => error)
    await vi.advanceTimersByTimeAsync(600)
    expect((await result)?.message).toBe('timed out waiting for provider replacement')
  })

  it('rejects a running replacement with a different soul, intent or native root', () => {
    for (const change of [{ soulId: 'other' }, { intentRevision: 5 }, { nativeSessionId: 'other' }]) {
      expect(() => selectProviderReplacement([{ ...ready, ...change }], before, [])).toThrow('fence')
    }
  })
})
