import { describe, it, expect, vi, beforeEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import claudeChatReducer, { sessionCreated } from '@/store/claudeChatSlice'
import { handleSdkMessage } from '@/lib/sdk-message-handler'

function createTestStore() {
  return configureStore({
    reducer: { claudeChat: claudeChatReducer },
  })
}

describe('handleSdkMessage', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    store = createTestStore()
    // Pre-create a session so messages have somewhere to go
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
  })

  it('dispatches addQuestionRequest for sdk.question.request', () => {
    const questions = [
      {
        question: 'Which option?',
        header: 'Choice',
        options: [{ label: 'A', description: 'Option A' }],
        multiSelect: false,
      },
    ]

    const handled = handleSdkMessage(store.dispatch, {
      type: 'sdk.question.request',
      sessionId: 'sess-1',
      requestId: 'q-1',
      questions,
    })

    expect(handled).toBe(true)
    const session = store.getState().claudeChat.sessions['sess-1']
    expect(session.pendingQuestions['q-1']).toBeDefined()
    expect(session.pendingQuestions['q-1'].questions).toEqual(questions)
  })

  it('returns false for unknown message types', () => {
    const handled = handleSdkMessage(store.dispatch, { type: 'unknown.type' })
    expect(handled).toBe(false)
  })

  it('dispatches addPermissionRequest for sdk.permission.request', () => {
    const handled = handleSdkMessage(store.dispatch, {
      type: 'sdk.permission.request',
      sessionId: 'sess-1',
      requestId: 'perm-1',
      subtype: 'can_use_tool',
      tool: { name: 'Bash', input: { command: 'ls' } },
    })

    expect(handled).toBe(true)
    const session = store.getState().claudeChat.sessions['sess-1']
    expect(session.pendingPermissions['perm-1']).toBeDefined()
  })
})
