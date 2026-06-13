import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import freshAgentReducer from '@/store/freshAgentSlice'
import { handleFreshAgentMessage, registerFreshAgentCreate } from '@/lib/fresh-agent-ws'
import { cancelCreate, _resetCancelledCreates } from '@/lib/sdk-message-handler'

describe('fresh-agent-ws', () => {
  beforeEach(() => {
    _resetCancelledCreates()
  })

  it('registers resumed creates with history hydration and handles freshAgent.created', () => {
    const store = configureStore({
      reducer: {
        freshAgent: freshAgentReducer,
      },
    })

    registerFreshAgentCreate(store.dispatch, 'req-1', {
      resumeSessionId: 'thread-1',
      sessionType: 'freshcodex',
      provider: 'codex',
    })
    const handled = handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.created',
      requestId: 'req-1',
      sessionId: 'thread-1',
      sessionType: 'freshcodex',
      provider: 'codex',
    })

    expect(handled).toBe(true)
    expect(store.getState().freshAgent.pendingCreates['req-1']).toMatchObject({
      sessionId: 'thread-1',
      expectsHistoryHydration: true,
    })
  })

  it('kills a late freshAgent.created session when its create request was cancelled', () => {
    const store = configureStore({
      reducer: {
        freshAgent: freshAgentReducer,
      },
    })
    const ws = { send: vi.fn() }

    registerFreshAgentCreate(store.dispatch, 'req-orphan', {
      sessionType: 'freshcodex',
      provider: 'codex',
    })
    cancelCreate('req-orphan')

    const handled = handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.created',
      requestId: 'req-orphan',
      sessionId: 'thread-orphan',
      sessionType: 'freshcodex',
      provider: 'codex',
    }, ws)

    expect(handled).toBe(true)
    expect(ws.send).toHaveBeenCalledWith({
      type: 'freshAgent.kill',
      sessionId: 'thread-orphan',
      sessionType: 'freshcodex',
      provider: 'codex',
    })
    expect(store.getState().freshAgent.sessions['freshcodex:codex:thread-orphan']).toBeUndefined()
  })

  it('handles freshAgent.create.failed', () => {
    const store = configureStore({
      reducer: {
        freshAgent: freshAgentReducer,
      },
    })

    const handled = handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.create.failed',
      requestId: 'req-2',
      code: 'NOPE',
      message: 'No provider',
      retryable: false,
    })

    expect(handled).toBe(true)
    expect(store.getState().freshAgent.pendingCreateFailures['req-2']).toEqual({
      code: 'NOPE',
      message: 'No provider',
      retryable: false,
    })
  })

  it('recognizes freshAgent.session.materialized as a handled fresh-agent message', () => {
    const store = configureStore({
      reducer: {
        freshAgent: freshAgentReducer,
      },
    })

    expect(handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.session.materialized',
      previousSessionId: 'freshopencode-req-1',
      sessionId: 'ses_real_1',
      sessionType: 'freshopencode',
      provider: 'opencode',
      sessionRef: { provider: 'opencode', sessionId: 'ses_real_1' },
    })).toBe(true)
  })

  it('projects Claude freshAgent.event snapshot and lost-session transport updates into fresh-agent session state', () => {
    const store = configureStore({
      reducer: {
        freshAgent: freshAgentReducer,
      },
    })

    expect(handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId: 'claude-thread-1',
      sessionType: 'freshclaude',
      provider: 'claude',
      event: {
        type: 'sdk.session.snapshot',
        sessionId: 'claude-thread-1',
        latestTurnId: 'turn-1',
        status: 'idle',
        timelineSessionId: 'cli-session-1',
        revision: 7,
      },
    })).toBe(true)

    expect(handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId: 'claude-thread-1',
      sessionType: 'freshclaude',
      provider: 'claude',
      event: {
        type: 'sdk.error',
        sessionId: 'claude-thread-1',
        code: 'INVALID_SESSION_ID',
        message: 'Session missing on server',
      },
    })).toBe(true)

    expect(store.getState().freshAgent.sessions['freshclaude:claude:claude-thread-1']).toEqual(expect.objectContaining({
      latestTurnId: 'turn-1',
      timelineSessionId: 'cli-session-1',
      timelineRevision: 7,
      lost: true,
      historyLoaded: false,
    }))
  })
})
