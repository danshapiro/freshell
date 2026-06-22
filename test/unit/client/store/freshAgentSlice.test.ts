import { describe, expect, it } from 'vitest'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import reducer, {
  createFailed,
  freshAgentSnapshotReceived,
  historyLoadStarted,
  historyPageReceived,
  registerPendingCreate,
  selectFreshAgentTranscriptTurns,
  sessionCreated,
  sessionError,
  sessionInit,
  sessionSnapshotReceived,
  setSessionStatus,
} from '@/store/freshAgentSlice'
import type { FreshAgentTurn } from '@shared/fresh-agent-contract'

function turn(turnId: string, summary = turnId, messageId = turnId, ordinal?: number): FreshAgentTurn {
  return {
    id: turnId,
    turnId,
    messageId,
    ...(ordinal !== undefined ? { ordinal } : {}),
    role: 'assistant',
    summary,
    items: [{ id: `${turnId}-text`, kind: 'text', text: summary }],
  }
}

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

  it('preserves older loaded turns when a newest-page refresh arrives', () => {
    const loc = { sessionId: 'thread-1', sessionType: 'freshcodex' as const, provider: 'codex' as const }
    const key = makeFreshAgentSessionKey(loc)
    let state = reducer(undefined, historyLoadStarted({ ...loc, requestKey: 'first' }))
    state = reducer(state, historyPageReceived({
      ...loc,
      requestKey: 'first',
      turns: [turn('turn-2', 'second'), turn('turn-3', 'third')],
      nextCursor: 'cursor-after-newest',
      revision: 5,
    }))
    state = reducer(state, historyPageReceived({
      ...loc,
      cursor: 'cursor-after-newest',
      turns: [turn('turn-1', 'first')],
      nextCursor: 'cursor-after-older',
      revision: 5,
    }))

    state = reducer(state, historyPageReceived({
      ...loc,
      requestKey: 'first',
      turns: [turn('turn-3', 'third updated'), turn('turn-4', 'fourth')],
      nextCursor: 'cursor-after-newest-refresh',
      revision: 5,
    }))

    expect(state.sessions[key].historyItems.map((item) => item.turnId)).toEqual([
      'turn-1',
      'turn-2',
      'turn-3',
      'turn-4',
    ])
    expect(state.sessions[key].historyItems[2]?.summary).toBe('third updated')
    expect(state.sessions[key].nextHistoryCursor).toBe('cursor-after-older')
  })

  it('ignores stale newest-page responses by request key', () => {
    const loc = { sessionId: 'thread-2', sessionType: 'freshcodex' as const, provider: 'codex' as const }
    const key = makeFreshAgentSessionKey(loc)
    let state = reducer(undefined, historyLoadStarted({ ...loc, requestKey: 'newer' }))

    state = reducer(state, historyPageReceived({
      ...loc,
      requestKey: 'older',
      turns: [turn('turn-stale')],
      nextCursor: null,
      revision: 1,
    }))

    expect(state.sessions[key].historyItems).toEqual([])
    expect(state.sessions[key].historyLoaded).toBe(false)
  })

  it('keeps older loaded turns but resets the older cursor when the first-page revision changes', () => {
    const loc = { sessionId: 'thread-3', sessionType: 'freshcodex' as const, provider: 'codex' as const }
    const key = makeFreshAgentSessionKey(loc)
    let state = reducer(undefined, historyPageReceived({
      ...loc,
      turns: [turn('turn-2')],
      nextCursor: 'cursor-v1',
      revision: 1,
    }))
    state = reducer(state, historyPageReceived({
      ...loc,
      cursor: 'cursor-v1',
      turns: [turn('turn-1')],
      nextCursor: 'older-cursor-v1',
      revision: 1,
    }))

    state = reducer(state, historyPageReceived({
      ...loc,
      turns: [turn('turn-2', 'second updated'), turn('turn-3')],
      nextCursor: 'cursor-v2',
      revision: 2,
    }))

    expect(state.sessions[key].historyItems.map((item) => item.turnId)).toEqual(['turn-1', 'turn-2', 'turn-3'])
    expect(state.sessions[key].historyRevision).toBe(2)
    expect(state.sessions[key].nextHistoryCursor).toBe('cursor-v2')
  })

  it('does not append older snapshot-only turns after a loaded newest page', () => {
    const loc = { sessionId: 'thread-order', sessionType: 'freshclaude' as const, provider: 'claude' as const }
    const key = makeFreshAgentSessionKey(loc)
    let state = reducer(undefined, freshAgentSnapshotReceived({
      hydrateHistory: false,
      snapshot: {
        sessionType: loc.sessionType,
        provider: loc.provider,
        threadId: loc.sessionId,
        latestTurnId: 'turn-4',
        status: 'idle',
        revision: 9,
        turns: [
          turn('turn-1', 'older one', 'message-1', 1),
          turn('turn-2', 'older two', 'message-2', 2),
          turn('turn-3', 'newest loaded', 'message-3', 3),
          turn('turn-4', 'new live result', 'message-4', 4),
        ],
      },
    }))
    state = reducer(state, historyPageReceived({
      ...loc,
      requestKey: 'first-page',
      turns: [turn('turn-3', 'newest loaded', 'message-3', 3)],
      nextCursor: 'older-cursor',
      revision: 9,
    }))

    expect(selectFreshAgentTranscriptTurns(state.sessions[key]).map((item) => item.turnId)).toEqual([
      'turn-3',
      'turn-4',
    ])
  })
})
