import { describe, it, expect, vi, beforeEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import agentChatReducer, { sessionCreated } from '@/store/agentChatSlice'
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
})
