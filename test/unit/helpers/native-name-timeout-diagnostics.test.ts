import { describe, expect, it, vi } from 'vitest'

import {
  appendNativeSyncSample,
  readNativeTitleDiagnosticFacts,
  summarizeNativeLifecycleBusyRefusals,
  summarizeNativeNameDurableState,
  summarizeNativeNameWorkerLogs,
  summarizeNativeTitleObservation,
  type NativeSyncDiagnosticSample,
} from '../../helpers/native-name-timeout-diagnostics.js'

describe('native-name timeout diagnostics', () => {
  it('keeps only a bounded safe projection of recent sync updates', () => {
    const samples: NativeSyncDiagnosticSample[] = []
    for (let sample = 1; sample <= 40; sample += 1) {
      appendNativeSyncSample(samples, {
        record: { revision: 100 + sample, name: 'private saved title' },
        nativeSync: {
          status: sample === 40 ? 'unsynced' : 'pending',
          desiredRevision: 7,
          locationRevision: 3,
          observedCurrent: false,
          reason: 'private provider text',
        },
      }, sample)
    }

    expect(samples).toHaveLength(24)
    expect(samples[0]).toEqual({
      sample: 17,
      recordRevision: 117,
      nativeSync: {
        present: true,
        status: 'pending',
        desiredRevision: 7,
        locationRevision: 3,
        observedCurrent: false,
      },
    })
    expect(samples.at(-1)?.nativeSync.status).toBe('unsynced')
    expect(JSON.stringify(samples)).not.toContain('private saved title')
    expect(JSON.stringify(samples)).not.toContain('private provider text')
  })

  it('records only expected-title comparison facts, never the native title or ID', () => {
    const facts = summarizeNativeTitleObservation(
      { id: 'actual-native-id', title: 'private native title' },
      'expected-native-id',
      'expected native title',
    )

    expect(facts).toEqual({
      idMatchesExpected: false,
      titlePresent: true,
      titleMatchesExpected: false,
    })
    expect(JSON.stringify(facts)).not.toContain('actual-native-id')
    expect(JSON.stringify(facts)).not.toContain('private native title')
  })

  it('projects the exact durable native-write series without names, paths, or receipts', () => {
    const id = 'private-native-id'
    const document = {
      records: { secret: { name: 'private saved title', source: 'manual' } },
      locations: { secret: { verified: { location: { path: '/private/workspace' } } } },
      nativeWrite: {
        [JSON.stringify(['session', 'codex', id])]: {
          status: 'unsynced', desiredRevision: 7, desiredName: 'private saved title',
          seriesEpoch: 7, cyclesConsumed: 1, readsConsumed: 0, lifecycleBusyDeferrals: 6,
          settled: true, nextDue: null, confirmationPendingReceipt: null,
          unsyncedReason: 'native name synchronization stopped after repeated lifecycle lock contention',
          attemptedLocation: { cwd: '/private/workspace' }, receiptId: 'private-receipt',
        },
      },
    }

    const summary = summarizeNativeNameDurableState(document, 'codex', id, 7)
    expect(summary).toEqual({
      available: true,
      entryPresent: true,
      desiredRevision: 7,
      desiredRevisionMatches: true,
      seriesEpoch: 7,
      status: 'unsynced',
      cyclesConsumed: 1,
      readsConsumed: 0,
      lifecycleBusyDeferrals: 6,
      settled: true,
      retryScheduled: false,
      confirmationPending: false,
      reasonCategory: 'lifecycle_busy_exhausted',
    })
    expect(JSON.stringify(summary)).not.toContain(id)
    expect(JSON.stringify(summary)).not.toContain('private saved title')
    expect(JSON.stringify(summary)).not.toContain('/private/workspace')
    expect(JSON.stringify(summary)).not.toContain('private-receipt')
  })

  it('does not select a durable series for a different native ref', () => {
    const document = { nativeWrite: {
      [JSON.stringify(['session', 'codex', 'session-a'])]: { desiredRevision: 7, status: 'unsynced' },
    } }
    expect(summarizeNativeNameDurableState(document, 'codex', 'session-b', 7)).toEqual({
      available: true,
      entryPresent: false,
    })
  })

  it('keeps a safe timestamped refusal trace for only the expected native session', () => {
    const output = [
      JSON.stringify({ at: 1_000, event: 'freshagent.native_name_refused', data: {
        reason: 'lifecycle_busy', operation: 'probe', soulId: 'private-soul', nativeSessionId: 'expected-id',
      } }),
      JSON.stringify({ at: 2_000, event: 'freshagent.native_name_refused', data: {
        reason: 'lifecycle_busy', operation: 'write', nativeSessionId: 'other-id',
      } }),
      JSON.stringify({ at: 3_000, event: 'freshagent.native_name_refused', data: {
        reason: 'lifecycle_busy', operation: 'read', soulId: 'private-soul', nativeSessionId: 'expected-id',
        path: '/private/workspace',
      } }),
    ].join('\n')
    const summary = summarizeNativeLifecycleBusyRefusals(output, 'expected-id')

    expect(summary).toEqual({
      lineCount: 3,
      records: [
        { atMs: 1_000, operation: 'probe', reason: 'lifecycle_busy' },
        { atMs: 3_000, operation: 'read', reason: 'lifecycle_busy' },
      ],
    })
    expect(JSON.stringify(summary)).not.toContain('expected-id')
    expect(JSON.stringify(summary)).not.toContain('other-id')
    expect(JSON.stringify(summary)).not.toContain('private-soul')
    expect(JSON.stringify(summary)).not.toContain('/private/workspace')
  })

  it('marks a readable response with no native title distinctly', async () => {
    const facts = await readNativeTitleDiagnosticFacts(
      async () => ({ id: 'expected-id', title: null }),
      'expected-id',
      'expected title',
    )

    expect(facts).toEqual({
      outcome: 'readable',
      idMatchesExpected: true,
      titlePresent: false,
      titleMatchesExpected: false,
    })
  })

  it('marks a rejected title read as failed without exposing its error', async () => {
    const facts = await readNativeTitleDiagnosticFacts(
      async () => { throw new Error('private provider failure') },
      'expected-id',
      'expected title',
    )

    expect(facts).toEqual({
      outcome: 'failed',
      idMatchesExpected: false,
      titlePresent: false,
      titleMatchesExpected: false,
    })
    expect(JSON.stringify(facts)).not.toContain('private provider failure')
  })

  it('marks a stalled title read as timeout and consumes a later rejection', async () => {
    let rejectRead!: (error: Error) => void
    const read = vi.fn(() => new Promise<unknown>((_resolve, reject) => { rejectRead = reject }))

    const facts = await readNativeTitleDiagnosticFacts(read, 'expected-id', 'expected title', 5)
    expect(read).toHaveBeenCalledTimes(1)
    expect(facts).toEqual({
      outcome: 'timeout',
      idMatchesExpected: false,
      titlePresent: false,
      titleMatchesExpected: false,
    })

    rejectRead(new Error('private provider failure'))
    await Promise.resolve()
  })

  it('retains only bounded recognized deferral fields from structured server logs', () => {
    const rows = [
      JSON.stringify({ ts: '2026-11-02T12:00:00.000Z', level: 'INFO', msg: 'session_names.native_cycle_deferred', revision: 7,
        series_epoch: 2, location_revision: 3, cycle: 1, operation: 'write', deferral_count: 2,
        retry_in_ms: 10_000, refunded_cycle: true, refunded_read: false,
        name_ref: 'private-ref', error: 'private provider text' }),
      JSON.stringify({ level: 'WARN', msg: 'unrelated.private_event', prompt: 'private prompt' }),
      JSON.stringify({ level: 'WARN', msg: 'session_names.native_cycle_deferrals_exhausted', revision: 7,
        series_epoch: 2, location_revision: 3, cycle: 1, operation: 'write', deferral_count: 6,
        name_ref: 'private-ref', error: 'private provider text' }),
    ].join('\n')

    const summary = summarizeNativeNameWorkerLogs(rows)
    expect(summary.records).toEqual([
      { event: 'deferred', atMs: Date.parse('2026-11-02T12:00:00.000Z'), severity: 'info', revision: 7, seriesEpoch: 2, locationRevision: 3,
        cycle: 1, operation: 'write', deferralCount: 2, retryInMs: 10_000,
        refundedCycle: true, refundedRead: false },
      { event: 'exhausted', severity: 'warn', revision: 7, seriesEpoch: 2, locationRevision: 3,
        cycle: 1, operation: 'write', deferralCount: 6 },
    ])
    expect(JSON.stringify(summary)).not.toContain('private-ref')
    expect(JSON.stringify(summary)).not.toContain('private provider text')
    expect(JSON.stringify(summary)).not.toContain('private prompt')
  })

  it('bounds combined server output before parsing and retains only recent deferral rows', () => {
    const oldSecretRows = Array.from({ length: 900 }, (_, index) => JSON.stringify({
      level: 'INFO', msg: 'session_names.native_cycle_deferred', revision: index,
      operation: 'write', error: 'private historical payload',
    }))
    const recentRows = Array.from({ length: 40 }, (_, index) => JSON.stringify({
      level: 'WARN', msg: 'session_names.native_cycle_deferrals_exhausted', revision: 100 + index,
      operation: 'read', name_ref: 'private-ref',
    }))
    const chunks = [...oldSecretRows, ...recentRows]
    expect(chunks.join('\n').length).toBeGreaterThan(64 * 1024)
    const summary = summarizeNativeNameWorkerLogs(chunks)

    expect(summary.lineCount).toBeLessThan(chunks.length)
    expect(summary.records).toHaveLength(32)
    expect(summary.records[0]).toEqual({ event: 'exhausted', severity: 'warn', revision: 108, operation: 'read' })
    expect(summary.records.at(-1)?.revision).toBe(139)
    expect(JSON.stringify(summary)).not.toContain('private historical payload')
    expect(JSON.stringify(summary)).not.toContain('private-ref')
  })
})
