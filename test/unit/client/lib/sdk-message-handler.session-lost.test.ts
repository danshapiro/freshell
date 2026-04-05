import { describe, it, expect, vi, beforeEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import agentChatReducer, { registerPendingCreate, sessionCreated } from '@/store/agentChatSlice'
import { handleSdkMessage } from '@/lib/sdk-message-handler'

function createTestStore() {
  return configureStore({
    reducer: { agentChat: agentChatReducer },
  })
}

describe('handleSdkMessage — session-lost error handling', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    store = createTestStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
  })

  it('handles sdk.error and sets lastError on the session', () => {
    const handled = handleSdkMessage(store.dispatch, {
      type: 'sdk.error',
      sessionId: 'sess-1',
      message: 'SDK session not found',
    })

    expect(handled).toBe(true)
    const session = store.getState().agentChat.sessions['sess-1']
    expect(session.lastError).toBe('SDK session not found')
  })

  it('marks session as lost when sdk.error has code INVALID_SESSION_ID', () => {
    const handled = handleSdkMessage(store.dispatch, {
      type: 'sdk.error',
      sessionId: 'sess-1',
      code: 'INVALID_SESSION_ID',
      message: 'SDK session not found',
    })

    expect(handled).toBe(true)
    const session = store.getState().agentChat.sessions['sess-1']
    // Session should be marked as lost (not removed) so the UI can detect and recover
    expect(session).toBeDefined()
    expect(session.lost).toBe(true)
    expect(session.historyLoaded).toBe(true)
  })

  it('preserves snapshot state when a restored session is later reported lost', () => {
    handleSdkMessage(store.dispatch, {
      type: 'sdk.session.snapshot',
      sessionId: 'sess-1',
      latestTurnId: 'turn-9',
      status: 'idle',
    })

    const handled = handleSdkMessage(store.dispatch, {
      type: 'sdk.error',
      sessionId: 'sess-1',
      code: 'INVALID_SESSION_ID',
      message: 'SDK session not found',
    })

    expect(handled).toBe(true)
    const session = store.getState().agentChat.sessions['sess-1']
    expect(session.latestTurnId).toBe('turn-9')
    expect(session.lost).toBe(true)
  })

  it('keeps restore hydration pending when INVALID_SESSION_ID arrives before the first timeline window lands', () => {
    const restoringStore = createTestStore()
    restoringStore.dispatch(registerPendingCreate({
      requestId: 'req-restore',
      expectsHistoryHydration: true,
    }))
    restoringStore.dispatch(sessionCreated({
      requestId: 'req-restore',
      sessionId: 'sess-restore',
    }))

    handleSdkMessage(restoringStore.dispatch, {
      type: 'sdk.session.snapshot',
      sessionId: 'sess-restore',
      latestTurnId: 'turn-9',
      status: 'idle',
      timelineSessionId: '00000000-0000-4000-8000-000000000555',
      revision: 5,
    })

    const handled = handleSdkMessage(restoringStore.dispatch, {
      type: 'sdk.error',
      sessionId: 'sess-restore',
      code: 'INVALID_SESSION_ID',
      message: 'SDK session not found',
    })

    expect(handled).toBe(true)
    const session = restoringStore.getState().agentChat.sessions['sess-restore']
    expect(session).toBeDefined()
    expect(session.lost).toBe(true)
    expect(session.latestTurnId).toBe('turn-9')
    expect(session.historyLoaded).toBe(false)
  })

  it('keeps restore hydration pending after page refresh when snapshot and INVALID_SESSION_ID arrive before the first timeline window', () => {
    const restoringStore = createTestStore()

    handleSdkMessage(restoringStore.dispatch, {
      type: 'sdk.session.snapshot',
      sessionId: 'sess-refresh',
      latestTurnId: 'turn-4',
      status: 'idle',
      timelineSessionId: '00000000-0000-4000-8000-000000000556',
      revision: 6,
    })

    const handled = handleSdkMessage(restoringStore.dispatch, {
      type: 'sdk.error',
      sessionId: 'sess-refresh',
      code: 'INVALID_SESSION_ID',
      message: 'SDK session not found',
    })

    expect(handled).toBe(true)
    const session = restoringStore.getState().agentChat.sessions['sess-refresh']
    expect(session).toBeDefined()
    expect(session.lost).toBe(true)
    expect(session.latestTurnId).toBe('turn-4')
    expect(session.historyLoaded).toBe(false)
  })

  it('creates session entry and marks lost even if session did not exist in Redux', () => {
    // This simulates a page-refresh scenario: pane has sessionId from localStorage
    // but Redux was empty. Server responds with INVALID_SESSION_ID.
    const handled = handleSdkMessage(store.dispatch, {
      type: 'sdk.error',
      sessionId: 'nonexistent-session',
      code: 'INVALID_SESSION_ID',
      message: 'SDK session not found',
    })

    expect(handled).toBe(true)
    const session = store.getState().agentChat.sessions['nonexistent-session']
    expect(session).toBeDefined()
    expect(session.lost).toBe(true)
    expect(session.historyLoaded).toBe(true)
  })

  it('does NOT mark session lost for non-INVALID_SESSION_ID errors', () => {
    const handled = handleSdkMessage(store.dispatch, {
      type: 'sdk.error',
      sessionId: 'sess-1',
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong',
    })

    expect(handled).toBe(true)
    const session = store.getState().agentChat.sessions['sess-1']
    expect(session).toBeDefined()
    expect(session.lastError).toBe('Something went wrong')
    expect(session.lost).toBeUndefined()
  })

  it('records restore-specific sdk.error messages even when the session was not yet present in Redux', () => {
    const handled = handleSdkMessage(store.dispatch, {
      type: 'sdk.error',
      sessionId: 'missing-session',
      code: 'RESTORE_NOT_FOUND',
      message: 'SDK session history not found',
    })

    expect(handled).toBe(true)
    const session = store.getState().agentChat.sessions['missing-session']
    expect(session).toBeDefined()
    expect(session.lastError).toBe('SDK session history not found')
    expect(session.lost).toBeUndefined()
  })

  it('records sdk.create.failed as a request-scoped create failure instead of impersonating lost-session recovery', () => {
    const handled = handleSdkMessage(store.dispatch, {
      type: 'sdk.create.failed',
      requestId: 'req-1',
      code: 'RESTORE_INTERNAL',
      message: 'boom',
      retryable: true,
    })

    expect(handled).toBe(true)
    const session = store.getState().agentChat.sessions['sess-1']
    expect(session).toBeDefined()
    expect(session.lost).not.toBe(true)
    expect((store.getState().agentChat as any).pendingCreateFailures['req-1']).toEqual({
      code: 'RESTORE_INTERNAL',
      message: 'boom',
      retryable: true,
    })
  })
})
