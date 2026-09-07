import { describe, expect, it } from 'vitest'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import reducer, {
  createFailed,
  freshAgentSnapshotReceived,
  markSessionLost,
  materializeSession,
  registerPendingCreate,
  resetStatusSeqBaselines,
  sessionCreated,
  sessionError,
  sessionInit,
  sessionSnapshotReceived,
  setSessionStatus,
} from '@/store/freshAgentSlice'

describe('freshAgentSlice busy/streaming clearing', () => {
  const loc = { sessionId: 'abc', sessionType: 'freshclaude' as const, provider: 'claude' as const }
  const key = makeFreshAgentSessionKey(loc)

  function streaming() {
    return reducer(undefined, sessionSnapshotReceived({ ...loc, latestTurnId: null, status: 'running', streamingActive: true }))
  }

  it('setSessionStatus(idle) clears streamingActive so the pane does not stay blue', () => {
    let state = streaming()
    expect(state.sessions[key].streamingActive).toBe(true)
    state = reducer(state, setSessionStatus({ ...loc, status: 'idle' }))
    expect(state.sessions[key].streamingActive).toBe(false)
    expect(state.sessions[key].status).toBe('idle')
  })

  it('sessionError (non-RESTORE) clears streamingActive and resets running -> idle', () => {
    let state = streaming()
    state = reducer(state, sessionError({ ...loc, message: 'boom' }))
    expect(state.sessions[key].streamingActive).toBe(false)
    expect(state.sessions[key].status).toBe('idle')
  })

  it('sessionError (RESTORE_*) does NOT reset running/streaming (restore path preserved)', () => {
    let state = streaming()
    state = reducer(state, sessionError({ ...loc, message: 'restore failed', code: 'RESTORE_TIMEOUT' }))
    expect(state.sessions[key].status).toBe('running')
  })
})

describe('freshAgentSlice', () => {
  const codexLoc = { sessionId: 'thread-status-version', sessionType: 'freshcodex' as const, provider: 'codex' as const }
  const codexKey = makeFreshAgentSessionKey(codexLoc)

  it('increments statusVersion for same-valued setSessionStatus updates', () => {
    let state = reducer(undefined, setSessionStatus({ ...codexLoc, status: 'running' }))
    expect(state.sessions[codexKey].status).toBe('running')
    expect((state.sessions[codexKey] as { statusVersion?: number }).statusVersion).toBe(1)

    state = reducer(state, setSessionStatus({ ...codexLoc, status: 'running' }))
    expect(state.sessions[codexKey].status).toBe('running')
    expect((state.sessions[codexKey] as { statusVersion?: number }).statusVersion).toBe(2)
  })

  it('increments statusVersion for snapshot status events and preserves it across identity materialization', () => {
    let state = reducer(undefined, sessionSnapshotReceived({
      ...codexLoc,
      latestTurnId: null,
      status: 'running',
      revision: 1,
    }))
    expect((state.sessions[codexKey] as { statusVersion?: number }).statusVersion).toBe(1)

    state = reducer(state, freshAgentSnapshotReceived({
      snapshot: {
        ...codexLoc,
        threadId: codexLoc.sessionId,
        revision: 2,
        latestTurnId: null,
        status: 'idle',
        capabilities: { send: true, interrupt: true, approvals: false, questions: false, fork: true },
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
        pendingApprovals: [],
        pendingQuestions: [],
        worktrees: [],
        diffs: [],
        childThreads: [],
        turns: [],
        extensions: {},
      },
    }))
    expect(state.sessions[codexKey].status).toBe('idle')
    expect((state.sessions[codexKey] as { statusVersion?: number }).statusVersion).toBe(2)

    state = reducer(state, materializeSession({
      previousSessionId: codexLoc.sessionId,
      sessionId: 'thread-status-version-materialized',
      sessionType: 'freshcodex',
      provider: 'codex',
    }))
    const materializedKey = 'freshcodex:codex:thread-status-version-materialized'
    expect(state.sessions[materializedKey].status).toBe('idle')
    expect((state.sessions[materializedKey] as { statusVersion?: number }).statusVersion).toBe(2)
  })

  it('tracks pending creates and resolves them into sessions', () => {
    let state = reducer(undefined, registerPendingCreate({
      requestId: 'req-1',
      sessionType: 'freshclaude',
      provider: 'claude',
      expectsHistoryHydration: false,
    }))

    state = reducer(state, sessionCreated({
      requestId: 'req-1',
      sessionId: 'sess-1',
      sessionType: 'freshclaude',
      provider: 'claude',
    }))
    state = reducer(state, sessionInit({
      sessionId: 'sess-1',
      sessionType: 'freshclaude',
      provider: 'claude',
      cliSessionId: '00000000-0000-4000-8000-000000000111',
      model: 'claude-opus-4-6',
    }))

    expect(state.pendingCreates['req-1']).toMatchObject({ sessionId: 'sess-1' })
    expect(state.sessions['freshclaude:claude:sess-1']).toMatchObject({
      sessionId: 'sess-1',
      sessionKey: 'freshclaude:claude:sess-1',
      cliSessionId: '00000000-0000-4000-8000-000000000111',
      model: 'claude-opus-4-6',
    })
  })

  it('stores request-scoped create failures without mutating unrelated sessions', () => {
    const state = reducer(undefined, createFailed({
      requestId: 'req-2',
      code: 'BROKEN',
      message: 'Create failed',
      retryable: true,
    }))

    expect(state.pendingCreateFailures['req-2']).toEqual({
      code: 'BROKEN',
      message: 'Create failed',
      retryable: true,
    })
    expect(state.sessions).toEqual({})
  })

  it('markSessionLost is a safe no-op when the session entry does not exist (reload + dead-session attach)', () => {
    // Fresh state: sessions map empty (slice is unpersisted after reload).
    const lostGhost = markSessionLost({ sessionId: 's-ghost', sessionType: 'freshclaude', provider: 'claude' })
    expect(() => reducer(undefined, lostGhost)).not.toThrow()
    expect(reducer(undefined, lostGhost).sessions).toEqual({})
  })
})

describe('freshAgentSlice statusSeq gate', () => {
  // Server-authoritative, provider-agnostic statusSeq (wall-clock-ms, strictly
  // monotonic per session — the same regime as the turn-complete clock): the
  // client folds a frame's status write only when its seq is strictly newer
  // than the last accepted one, and dropped frames skip status /
  // streamingActive / streamingText together. Seq-less frames (pre-seq
  // servers, untracked defaults) keep the legacy unconditional fold.
  const loc = { sessionId: 'thread-status-seq', sessionType: 'freshcodex' as const, provider: 'codex' as const }
  const key = makeFreshAgentSessionKey(loc)

  function trackedRunningState() {
    return reducer(undefined, sessionSnapshotReceived({
      ...loc,
      latestTurnId: null,
      status: 'running',
      statusSeq: 10,
      streamingActive: true,
      streamingText: 'working',
    }))
  }

  it('folds a tracked status write (statusSeq: 10) and records lastStatusSeq', () => {
    const session = trackedRunningState().sessions[key]
    expect(session.status).toBe('running')
    expect(session.streamingActive).toBe(true)
    expect(session.streamingText).toBe('working')
    expect(session.lastStatusSeq).toBe(10)
    expect(session.statusVersion).toBe(1)
  })

  it('drops a stale frame (statusSeq: 9 after 10) — status/streaming/lastStatusSeq untouched, statusVersion not bumped', () => {
    let state = trackedRunningState()
    const versionAfterTracked = state.sessions[key].statusVersion
    state = reducer(state, sessionSnapshotReceived({
      ...loc,
      latestTurnId: null,
      status: 'idle',
      statusSeq: 9,
      streamingActive: false,
      streamingText: 'stale',
    }))
    const session = state.sessions[key]
    expect(session.status).toBe('running')
    expect(session.streamingActive).toBe(true)
    expect(session.streamingText).toBe('working')
    expect(session.lastStatusSeq).toBe(10)
    expect(session.statusVersion).toBe(versionAfterTracked)
  })

  it('drops an equal-seq frame (statusSeq: 10 after 10) — the fold requires strictly newer', () => {
    let state = trackedRunningState()
    const versionAfterTracked = state.sessions[key].statusVersion
    state = reducer(state, sessionSnapshotReceived({
      ...loc,
      latestTurnId: null,
      status: 'idle',
      statusSeq: 10,
      streamingActive: false,
      streamingText: '',
    }))
    const session = state.sessions[key]
    expect(session.status).toBe('running')
    expect(session.streamingActive).toBe(true)
    expect(session.lastStatusSeq).toBe(10)
    expect(session.statusVersion).toBe(versionAfterTracked)
  })

  it('legacy: a seq-less write after a tracked write still folds unconditionally and leaves lastStatusSeq alone', () => {
    let state = trackedRunningState()
    state = reducer(state, sessionSnapshotReceived({
      ...loc,
      latestTurnId: null,
      status: 'idle',
      streamingActive: false,
      streamingText: '',
    }))
    const session = state.sessions[key]
    expect(session.status).toBe('idle')
    expect(session.streamingActive).toBe(false)
    expect(session.streamingText).toBe('')
    expect(session.lastStatusSeq).toBe(10)
  })

  it('resetStatusSeqBaselines clears lastStatusSeq on every session', () => {
    const otherLoc = { sessionId: 'thread-status-seq-b', sessionType: 'freshclaude' as const, provider: 'claude' as const }
    const otherKey = makeFreshAgentSessionKey(otherLoc)
    let state = trackedRunningState()
    state = reducer(state, sessionSnapshotReceived({
      ...otherLoc,
      latestTurnId: null,
      status: 'idle',
      statusSeq: 20,
    }))
    expect(state.sessions[key].lastStatusSeq).toBe(10)
    expect(state.sessions[otherKey].lastStatusSeq).toBe(20)
    state = reducer(state, resetStatusSeqBaselines())
    expect(state.sessions[key].lastStatusSeq).toBeUndefined()
    expect(state.sessions[otherKey].lastStatusSeq).toBeUndefined()
    // A tracked write after the reset folds again from a fresh baseline.
    state = reducer(state, sessionSnapshotReceived({
      ...loc,
      latestTurnId: null,
      status: 'idle',
      statusSeq: 5,
    }))
    expect(state.sessions[key].status).toBe('idle')
    expect(state.sessions[key].lastStatusSeq).toBe(5)
  })
})

describe('freshAgentSlice lost revocation on truth-bearing snapshot evidence', () => {
  // reconnect-revive Task 4: a snapshot answer is positive existence evidence
  // (the 404 FRESH_AGENT_LOST_SESSION path never dispatches these reducers), so
  // it revokes a stale `lost` flag left by a transient dead-window attach race.
  const loc = { sessionId: 'thread-snapshot-truth', sessionType: 'freshcodex' as const, provider: 'codex' as const }
  const key = makeFreshAgentSessionKey(loc)

  function lostState() {
    // Seed a live session first (markSessionLost is a safe no-op on a missing
    // record), then wedge it the way the dead-window attach race does.
    let state = reducer(undefined, setSessionStatus({ ...loc, status: 'running' }))
    state = reducer(state, markSessionLost(loc))
    expect(state.sessions[key].lost).toBe(true)
    return state
  }

  it('sessionSnapshotReceived revokes a stale lost flag on the addressed session', () => {
    const state = reducer(lostState(), sessionSnapshotReceived({ ...loc, latestTurnId: null, status: 'idle' }))
    expect(state.sessions[key].lost).toBe(false)
  })

  it('freshAgentSnapshotReceived revokes a stale lost flag on the addressed session', () => {
    const state = reducer(lostState(), freshAgentSnapshotReceived({
      snapshot: {
        ...loc,
        threadId: loc.sessionId,
        revision: 3,
        latestTurnId: null,
        status: 'idle',
        capabilities: { send: true, interrupt: true, approvals: false, questions: false, fork: true },
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
        pendingApprovals: [],
        pendingQuestions: [],
        worktrees: [],
        diffs: [],
        childThreads: [],
        turns: [],
        extensions: {},
      },
    }))
    expect(state.sessions[key].lost).toBe(false)
  })
})
