import { describe, expect, it } from 'vitest'
import reducer, {
  createFailed,
  registerPendingCreate,
  sessionCreated,
  sessionInit,
} from '@/store/freshAgentSlice'

describe('freshAgentSlice', () => {
  it('tracks pending creates and resolves them into sessions', () => {
    let state = reducer(undefined, registerPendingCreate({
      requestId: 'req-1',
      expectsHistoryHydration: false,
    }))

    state = reducer(state, sessionCreated({
      requestId: 'req-1',
      sessionId: 'sess-1',
    }))
    state = reducer(state, sessionInit({
      sessionId: 'sess-1',
      cliSessionId: '00000000-0000-4000-8000-000000000111',
      model: 'claude-opus-4-6',
    }))

    expect(state.pendingCreates['req-1']).toMatchObject({ sessionId: 'sess-1' })
    expect(state.sessions['sess-1']).toMatchObject({
      sessionId: 'sess-1',
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
