import { describe, expect, it } from 'vitest'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import reducer, {
  createFailed,
  freshAgentSnapshotReceived,
  materializeSession,
  registerPendingCreate,
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
})
