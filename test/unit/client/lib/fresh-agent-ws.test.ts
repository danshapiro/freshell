import { describe, expect, it } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import freshAgentReducer from '@/store/freshAgentSlice'
import { handleFreshAgentMessage, registerFreshAgentCreate } from '@/lib/fresh-agent-ws'

describe('fresh-agent-ws', () => {
  it('registers creates and handles freshAgent.created', () => {
    const store = configureStore({
      reducer: {
        freshAgent: freshAgentReducer,
      },
    })

    registerFreshAgentCreate(store.dispatch, 'req-1')
    const handled = handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.created',
      requestId: 'req-1',
      sessionId: 'thread-1',
    })

    expect(handled).toBe(true)
    expect(store.getState().freshAgent.pendingCreates['req-1']).toMatchObject({
      sessionId: 'thread-1',
    })
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
})
