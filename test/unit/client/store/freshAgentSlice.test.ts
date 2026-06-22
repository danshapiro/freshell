import { describe, expect, it } from 'vitest'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import reducer, {
  createFailed,
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
