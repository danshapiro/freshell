import { describe, expect, it } from 'vitest'
import {
  confirmOpencodeAssociation,
  createOpencodeOwnershipState,
  rejectOpencodeAssociation,
  reduceOpencodeOwnership,
} from '../../../../server/coding-cli/opencode-ownership-reducer'

describe('opencode ownership reducer', () => {
  it('requests association before completing a fresh live candidate', () => {
    let state = createOpencodeOwnershipState()

    let result = reduceOpencodeOwnership(state, {
      kind: 'sse',
      cycleId: 1,
      streamId: 1,
      sessionId: 'session-a',
      status: 'busy',
      at: 10,
    })
    state = result.state
    expect(result.actions).toContainEqual({
      kind: 'activityUpsert',
      sessionId: 'session-a',
      at: 10,
    })

    result = reduceOpencodeOwnership(state, {
      kind: 'sse',
      cycleId: 1,
      streamId: 1,
      sessionId: 'session-a',
      status: 'idle',
      at: 20,
    })
    state = result.state

    expect(result.actions).toEqual([
      { kind: 'activityRemove', at: 20 },
      { kind: 'requestAssociation', sessionId: 'session-a' },
    ])

    result = confirmOpencodeAssociation(state, { sessionId: 'session-a' })

    expect(result.state).toEqual({
      kind: 'quiet',
      knownSessionId: 'session-a',
    })
    expect(result.actions).toEqual([
      {
        kind: 'turnComplete',
        sessionId: 'session-a',
        at: 20,
      },
    ])
  })

  it('completes a known busy interval only from the same live stream', () => {
    let state = createOpencodeOwnershipState('session-a')

    let result = reduceOpencodeOwnership(state, {
      kind: 'sse',
      cycleId: 1,
      streamId: 1,
      sessionId: 'session-a',
      status: 'busy',
      at: 10,
    })
    state = result.state

    result = reduceOpencodeOwnership(state, {
      kind: 'sse',
      cycleId: 1,
      streamId: 2,
      sessionId: 'session-a',
      status: 'idle',
      at: 20,
    })

    expect(result.state).toEqual(state)
    expect(result.actions).toEqual([])

    result = reduceOpencodeOwnership(state, {
      kind: 'sse',
      cycleId: 1,
      streamId: 1,
      sessionId: 'session-a',
      status: 'idle',
      at: 30,
    })

    expect(result.state).toEqual({
      kind: 'quiet',
      knownSessionId: 'session-a',
    })
    expect(result.actions).toEqual([
      { kind: 'activityRemove', at: 30 },
      { kind: 'turnComplete', sessionId: 'session-a', at: 30 },
    ])
    expect(result.actions).not.toContainEqual(expect.objectContaining({
      kind: 'requestAssociation',
    }))
  })

  it('treats competing candidate sessions as durable ambiguity and blocks third-session adoption until quiet', () => {
    let state = createOpencodeOwnershipState()

    let result = reduceOpencodeOwnership(state, {
      kind: 'sse',
      cycleId: 1,
      streamId: 1,
      sessionId: 'session-a',
      status: 'busy',
      at: 10,
    })
    state = result.state

    result = reduceOpencodeOwnership(state, {
      kind: 'sse',
      cycleId: 1,
      streamId: 1,
      sessionId: 'session-b',
      status: 'busy',
      at: 11,
    })
    state = result.state

    expect(state).toEqual({
      kind: 'ambiguous',
      knownSessionId: undefined,
      blockedSessionIds: ['session-a', 'session-b'],
      since: 11,
    })
    expect(result.actions).toContainEqual({
      kind: 'activityUpsert',
      at: 11,
    })

    result = reduceOpencodeOwnership(state, {
      kind: 'sse',
      cycleId: 1,
      streamId: 1,
      sessionId: 'session-c',
      status: 'busy',
      at: 12,
    })
    state = result.state

    expect(state).toEqual({
      kind: 'ambiguous',
      knownSessionId: undefined,
      blockedSessionIds: ['session-a', 'session-b', 'session-c'],
      since: 11,
    })
    expect(result.actions).not.toContainEqual(expect.objectContaining({
      kind: 'requestAssociation',
    }))

    result = reduceOpencodeOwnership(state, {
      kind: 'snapshot',
      cycleId: 1,
      streamId: 1,
      statuses: {},
      at: 30,
    })

    expect(result.state).toEqual({
      kind: 'quiet',
      knownSessionId: undefined,
    })
    expect(result.actions).toEqual([{ kind: 'activityRemove', at: 30 }])
  })

  it('clears ambiguous ownership after every blocked session idles on the live stream', () => {
    let state = createOpencodeOwnershipState()

    let result = reduceOpencodeOwnership(state, {
      kind: 'sse',
      cycleId: 1,
      streamId: 1,
      sessionId: 'session-a',
      status: 'busy',
      at: 10,
    })
    state = result.state

    result = reduceOpencodeOwnership(state, {
      kind: 'sse',
      cycleId: 1,
      streamId: 1,
      sessionId: 'session-b',
      status: 'busy',
      at: 11,
    })
    state = result.state

    expect(state).toEqual({
      kind: 'ambiguous',
      knownSessionId: undefined,
      blockedSessionIds: ['session-a', 'session-b'],
      since: 11,
    })

    result = reduceOpencodeOwnership(state, {
      kind: 'sse',
      cycleId: 1,
      streamId: 1,
      sessionId: 'session-a',
      status: 'idle',
      at: 20,
    })
    state = result.state

    expect(state).toEqual({
      kind: 'ambiguous',
      knownSessionId: undefined,
      blockedSessionIds: ['session-b'],
      since: 11,
    })
    expect(result.actions).toEqual([{ kind: 'activityUpsert', at: 20 }])

    result = reduceOpencodeOwnership(state, {
      kind: 'sse',
      cycleId: 1,
      streamId: 1,
      sessionId: 'session-b',
      status: 'idle',
      at: 21,
    })

    expect(result.state).toEqual({
      kind: 'quiet',
      knownSessionId: undefined,
    })
    expect(result.actions).toEqual([{ kind: 'activityRemove', at: 21 }])
  })

  it('emits direct completion when a known busy snapshot becomes idle', () => {
    let state = createOpencodeOwnershipState('session-a')

    let result = reduceOpencodeOwnership(state, {
      kind: 'snapshot',
      cycleId: 1,
      streamId: 1,
      statuses: {
        'session-a': { type: 'busy' },
      },
      at: 10,
    })
    state = result.state

    result = reduceOpencodeOwnership(state, {
      kind: 'snapshot',
      cycleId: 2,
      streamId: 2,
      statuses: {},
      at: 20,
    })

    expect(result.state).toEqual({
      kind: 'quiet',
      knownSessionId: 'session-a',
    })
    expect(result.actions).toEqual([
      { kind: 'activityRemove', at: 20 },
      { kind: 'turnComplete', sessionId: 'session-a', at: 20 },
    ])
  })

  it('routes snapshot-idle candidates through association while clearing blue activity', () => {
    let state = createOpencodeOwnershipState()

    let result = reduceOpencodeOwnership(state, {
      kind: 'snapshot',
      cycleId: 1,
      streamId: 1,
      statuses: {
        'session-a': { type: 'busy' },
      },
      at: 10,
    })
    state = result.state

    result = reduceOpencodeOwnership(state, {
      kind: 'snapshot',
      cycleId: 2,
      streamId: 2,
      statuses: {},
      at: 20,
    })
    state = result.state

    expect(result.state).toEqual({
      kind: 'awaitingAssociation',
      sessionId: 'session-a',
      previousKnownSessionId: undefined,
      cycleId: 1,
      streamId: 1,
      completedAt: 20,
    })
    expect(result.actions).toEqual([
      { kind: 'activityRemove', at: 20 },
      { kind: 'requestAssociation', sessionId: 'session-a' },
    ])
    expect(result.actions).not.toContainEqual(expect.objectContaining({
      kind: 'turnComplete',
    }))

    result = confirmOpencodeAssociation(state, { sessionId: 'session-a' })
    expect(result.actions).toEqual([
      { kind: 'turnComplete', sessionId: 'session-a', at: 20 },
    ])
  })

  it('does not emit completion when candidate association is rejected', () => {
    let state = createOpencodeOwnershipState()

    let result = reduceOpencodeOwnership(state, {
      kind: 'snapshot',
      cycleId: 1,
      streamId: 1,
      statuses: {
        'session-a': { type: 'busy' },
      },
      at: 10,
    })
    state = result.state

    result = reduceOpencodeOwnership(state, {
      kind: 'snapshot',
      cycleId: 2,
      streamId: 2,
      statuses: {},
      at: 20,
    })

    result = rejectOpencodeAssociation(result.state, { sessionId: 'session-a' })

    expect(result.state).toEqual({
      kind: 'quiet',
      knownSessionId: undefined,
    })
    expect(result.actions).toEqual([])
  })

  it('requests association for a snapshot-seeded candidate that idles on the same live stream', () => {
    let state = createOpencodeOwnershipState()

    let result = reduceOpencodeOwnership(state, {
      kind: 'snapshot',
      cycleId: 1,
      streamId: 1,
      statuses: {
        'session-a': { type: 'busy' },
      },
      at: 10,
    })
    state = result.state

    result = reduceOpencodeOwnership(state, {
      kind: 'sse',
      cycleId: 1,
      streamId: 1,
      sessionId: 'session-a',
      status: 'idle',
      at: 20,
    })
    state = result.state

    expect(result.actions).toEqual([
      { kind: 'activityRemove', at: 20 },
      { kind: 'requestAssociation', sessionId: 'session-a' },
    ])

    result = confirmOpencodeAssociation(state, { sessionId: 'session-a' })

    expect(result.state).toEqual({
      kind: 'quiet',
      knownSessionId: 'session-a',
    })
    expect(result.actions).toEqual([
      { kind: 'turnComplete', sessionId: 'session-a', at: 20 },
    ])
  })

  it('ignores a stale-stream idle for a snapshot-seeded busy interval', () => {
    let state = createOpencodeOwnershipState()

    let result = reduceOpencodeOwnership(state, {
      kind: 'snapshot',
      cycleId: 1,
      streamId: 1,
      statuses: {
        'session-a': { type: 'busy' },
      },
      at: 10,
    })
    state = result.state

    result = reduceOpencodeOwnership(state, {
      kind: 'sse',
      cycleId: 1,
      streamId: 2,
      sessionId: 'session-a',
      status: 'idle',
      at: 20,
    })

    expect(result.state).toEqual(state)
    expect(result.actions).toEqual([])
  })

  it('recomputes blockedSessionIds from snapshot instead of unioning stale sessions', () => {
    let state = createOpencodeOwnershipState()

    state = reduceOpencodeOwnership(state, {
      kind: 'sse',
      cycleId: 1,
      streamId: 1,
      sessionId: 'session-a',
      status: 'busy',
      at: 10,
    }).state

    state = reduceOpencodeOwnership(state, {
      kind: 'sse',
      cycleId: 1,
      streamId: 1,
      sessionId: 'session-b',
      status: 'busy',
      at: 11,
    }).state

    expect(state).toEqual({
      kind: 'ambiguous',
      knownSessionId: undefined,
      blockedSessionIds: ['session-a', 'session-b'],
      since: 11,
    })

    const result = reduceOpencodeOwnership(state, {
      kind: 'snapshot',
      cycleId: 1,
      streamId: 1,
      statuses: {
        'session-a': { type: 'busy' },
      },
      at: 20,
    })

    expect(result.state).toEqual({
      kind: 'candidate',
      sessionId: 'session-a',
      startedBy: 'snapshot',
      cycleId: 1,
      streamId: 1,
    })
  })

  it('transitions from ambiguous to knownBusy when snapshot shows single known session', () => {
    let state = createOpencodeOwnershipState('session-a')

    state = reduceOpencodeOwnership(state, {
      kind: 'sse',
      cycleId: 1,
      streamId: 1,
      sessionId: 'session-a',
      status: 'busy',
      at: 10,
    }).state

    state = reduceOpencodeOwnership(state, {
      kind: 'sse',
      cycleId: 1,
      streamId: 1,
      sessionId: 'session-b',
      status: 'busy',
      at: 11,
    }).state

    expect(state).toEqual({
      kind: 'ambiguous',
      knownSessionId: 'session-a',
      blockedSessionIds: ['session-a', 'session-b'],
      since: 11,
    })

    const result = reduceOpencodeOwnership(state, {
      kind: 'snapshot',
      cycleId: 1,
      streamId: 1,
      statuses: {
        'session-a': { type: 'busy' },
      },
      at: 20,
    })

    expect(result.state).toEqual({
      kind: 'knownBusy',
      sessionId: 'session-a',
      startedBy: 'snapshot',
      cycleId: 1,
      streamId: 1,
    })
    expect(result.actions).toEqual([
      { kind: 'activityUpsert', sessionId: 'session-a', at: 20 },
    ])
  })

  it('transitions from ambiguous to candidate when snapshot shows single unknown session', () => {
    let state = createOpencodeOwnershipState()

    state = reduceOpencodeOwnership(state, {
      kind: 'sse',
      cycleId: 1,
      streamId: 1,
      sessionId: 'session-a',
      status: 'busy',
      at: 10,
    }).state

    state = reduceOpencodeOwnership(state, {
      kind: 'sse',
      cycleId: 1,
      streamId: 1,
      sessionId: 'session-b',
      status: 'busy',
      at: 11,
    }).state

    expect(state).toEqual({
      kind: 'ambiguous',
      knownSessionId: undefined,
      blockedSessionIds: ['session-a', 'session-b'],
      since: 11,
    })

    const result = reduceOpencodeOwnership(state, {
      kind: 'snapshot',
      cycleId: 1,
      streamId: 1,
      statuses: {
        'session-a': { type: 'busy' },
      },
      at: 20,
    })

    expect(result.state).toEqual({
      kind: 'candidate',
      sessionId: 'session-a',
      startedBy: 'snapshot',
      cycleId: 1,
      streamId: 1,
    })
  })

  it('does not re-emit warnAmbiguous when snapshot shows same set of sessions', () => {
    let state = createOpencodeOwnershipState()

    state = reduceOpencodeOwnership(state, {
      kind: 'sse',
      cycleId: 1,
      streamId: 1,
      sessionId: 'session-a',
      status: 'busy',
      at: 10,
    }).state

    state = reduceOpencodeOwnership(state, {
      kind: 'sse',
      cycleId: 1,
      streamId: 1,
      sessionId: 'session-b',
      status: 'busy',
      at: 11,
    }).state

    expect(state).toEqual({
      kind: 'ambiguous',
      knownSessionId: undefined,
      blockedSessionIds: ['session-a', 'session-b'],
      since: 11,
    })

    const result = reduceOpencodeOwnership(state, {
      kind: 'snapshot',
      cycleId: 1,
      streamId: 1,
      statuses: {
        'session-a': { type: 'busy' },
        'session-b': { type: 'busy' },
      },
      at: 20,
    })

    expect(result.state).toEqual({
      kind: 'ambiguous',
      knownSessionId: undefined,
      blockedSessionIds: ['session-a', 'session-b'],
      since: 11,
    })
    expect(result.actions).toEqual([
      { kind: 'activityUpsert', at: 20 },
    ])
  })

  it('re-emits warnAmbiguous when snapshot shows different set of sessions', () => {
    let state = createOpencodeOwnershipState()

    state = reduceOpencodeOwnership(state, {
      kind: 'sse',
      cycleId: 1,
      streamId: 1,
      sessionId: 'session-a',
      status: 'busy',
      at: 10,
    }).state

    state = reduceOpencodeOwnership(state, {
      kind: 'sse',
      cycleId: 1,
      streamId: 1,
      sessionId: 'session-b',
      status: 'busy',
      at: 11,
    }).state

    expect(state).toEqual({
      kind: 'ambiguous',
      knownSessionId: undefined,
      blockedSessionIds: ['session-a', 'session-b'],
      since: 11,
    })

    const result = reduceOpencodeOwnership(state, {
      kind: 'snapshot',
      cycleId: 1,
      streamId: 1,
      statuses: {
        'session-a': { type: 'busy' },
        'session-c': { type: 'busy' },
      },
      at: 20,
    })

    expect(result.state).toEqual({
      kind: 'ambiguous',
      knownSessionId: undefined,
      blockedSessionIds: ['session-a', 'session-c'],
      since: 11,
    })
    expect(result.actions).toEqual([
      { kind: 'activityUpsert', at: 20 },
      { kind: 'warnAmbiguous', sessionIds: ['session-a', 'session-c'] },
    ])
  })
})

describe('abort gate (session.error MessageAbortedError)', () => {
  const stream = { cycleId: 1, streamId: 1 }

  function busyKnown() {
    // quiet(known) + busy sse -> knownBusy
    const s0 = createOpencodeOwnershipState('ses-root')
    return reduceOpencodeOwnership(s0, { kind: 'sse', ...stream, sessionId: 'ses-root', status: 'busy', at: 1000 }).state
  }

  it('abort then idle clears busy silently (no turnComplete)', () => {
    const s1 = reduceOpencodeOwnership(busyKnown(), { kind: 'error', ...stream, sessionId: 'ses-root', errorName: 'MessageAbortedError', at: 1500 })
    expect(s1.actions).toEqual([])
    const s2 = reduceOpencodeOwnership(s1.state, { kind: 'sse', ...stream, sessionId: 'ses-root', status: 'idle', at: 1507 })
    expect(s2.actions).toEqual([{ kind: 'activityRemove', at: 1507 }])
    expect(s2.state).toEqual({ kind: 'quiet', knownSessionId: 'ses-root' })
  })

  it('second idle edge after abort is a no-op (double session.idle dedupe)', () => {
    const s1 = reduceOpencodeOwnership(busyKnown(), { kind: 'error', ...stream, sessionId: 'ses-root', errorName: 'MessageAbortedError', at: 1500 })
    const s2 = reduceOpencodeOwnership(s1.state, { kind: 'sse', ...stream, sessionId: 'ses-root', status: 'idle', at: 1507 })
    const s3 = reduceOpencodeOwnership(s2.state, { kind: 'sse', ...stream, sessionId: 'ses-root', status: 'idle', at: 1527 })
    expect(s3.actions).toEqual([])
  })

  it('non-abort error names do not suppress the completion (failed turns ring)', () => {
    const s1 = reduceOpencodeOwnership(busyKnown(), { kind: 'error', ...stream, sessionId: 'ses-root', errorName: 'UnknownError', at: 1500 })
    expect(s1.actions).toEqual([])
    const s2 = reduceOpencodeOwnership(s1.state, { kind: 'sse', ...stream, sessionId: 'ses-root', status: 'idle', at: 1507 })
    expect(s2.actions).toEqual([
      { kind: 'activityRemove', at: 1507 },
      { kind: 'turnComplete', sessionId: 'ses-root', at: 1507 },
    ])
  })

  it('trailing error on quiet state is a no-op (never mint from idle)', () => {
    const quiet = { kind: 'quiet' as const, knownSessionId: 'ses-root' }
    const r = reduceOpencodeOwnership(quiet, { kind: 'error', ...stream, sessionId: 'ses-root', errorName: 'UnknownError', at: 2000 })
    expect(r.state).toEqual(quiet)
    expect(r.actions).toEqual([])
  })

  it('a new busy clears the abort flag (per-turn semantics)', () => {
    const s1 = reduceOpencodeOwnership(busyKnown(), { kind: 'error', ...stream, sessionId: 'ses-root', errorName: 'MessageAbortedError', at: 1500 })
    const s2 = reduceOpencodeOwnership(s1.state, { kind: 'sse', ...stream, sessionId: 'ses-root', status: 'busy', at: 1600 })
    const s3 = reduceOpencodeOwnership(s2.state, { kind: 'sse', ...stream, sessionId: 'ses-root', status: 'idle', at: 1700 })
    expect(s3.actions).toContainEqual({ kind: 'turnComplete', sessionId: 'ses-root', at: 1700 })
  })

  it('abort from a mismatched cycle/stream is ignored', () => {
    const s1 = reduceOpencodeOwnership(busyKnown(), { kind: 'error', cycleId: 9, streamId: 9, sessionId: 'ses-root', errorName: 'MessageAbortedError', at: 1500 })
    const s2 = reduceOpencodeOwnership(s1.state, { kind: 'sse', ...stream, sessionId: 'ses-root', status: 'idle', at: 1507 })
    expect(s2.actions).toContainEqual({ kind: 'turnComplete', sessionId: 'ses-root', at: 1507 })
  })

  it('snapshot-empty after abort is silent too', () => {
    const s1 = reduceOpencodeOwnership(busyKnown(), { kind: 'error', ...stream, sessionId: 'ses-root', errorName: 'MessageAbortedError', at: 1500 })
    const s2 = reduceOpencodeOwnership(s1.state, { kind: 'snapshot', ...stream, statuses: {}, at: 1507 })
    expect(s2.actions).toEqual([{ kind: 'activityRemove', at: 1507 }])
  })

  it('aborted candidate turn never mints a completion at association confirm', () => {
    // quiet(no known) + busy -> candidate
    const s0 = createOpencodeOwnershipState()
    const c1 = reduceOpencodeOwnership(s0, { kind: 'sse', ...stream, sessionId: 'ses-x', status: 'busy', at: 1000 })
    const c2 = reduceOpencodeOwnership(c1.state, { kind: 'error', ...stream, sessionId: 'ses-x', errorName: 'MessageAbortedError', at: 1100 })
    const c3 = reduceOpencodeOwnership(c2.state, { kind: 'sse', ...stream, sessionId: 'ses-x', status: 'idle', at: 1200 })
    expect(c3.state.kind).toBe('awaitingAssociation')
    const confirmed = confirmOpencodeAssociation(c3.state, { sessionId: 'ses-x' })
    expect(confirmed.actions).toEqual([])
    expect(confirmed.state).toEqual({ kind: 'quiet', knownSessionId: 'ses-x' })
  })
})
