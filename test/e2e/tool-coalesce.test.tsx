import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import MessageBubble from '@/components/agent-chat/MessageBubble'
import agentChatReducer, {
  sessionCreated,
  addAssistantMessage
} from '@/store/agentChatSlice'
import { BROWSER_PREFERENCES_STORAGE_KEY } from '@/store/storage-keys'

vi.mock('@/components/markdown/LazyMarkdown', async () => {
  const { MarkdownRenderer } = await import('@/components/markdown/MarkdownRenderer')
  return {
    LazyMarkdown: ({ content }: { content: string }) => (
      <MarkdownRenderer content={content} />
    ),
  }
})

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: vi.fn(),
    onReconnect: vi.fn(() => vi.fn()),
  }),
}))

function makeStore() {
  return configureStore({
    reducer: {
      agentChat: agentChatReducer,
    },
  })
}

describe('tool coalescing integration tests', () => {
  afterEach(cleanup)
  beforeEach(() => {
    localStorage.removeItem(BROWSER_PREFERENCES_STORAGE_KEY)
  })

  describe('Priority 3.1: End-to-end tool strip rendering with coalesced messages', () => {
    it('renders one tool strip showing "2 tools used" after coalescing', () => {
      const store = makeStore()
      store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 's1' }))
      store.dispatch(addAssistantMessage({
        sessionId: 's1',
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
      }))
      store.dispatch(addAssistantMessage({
        sessionId: 's1',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'output' },
          { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'f.ts' } },
        ],
      }))
      const session = store.getState().agentChat.sessions['s1']
      expect(session.messages).toHaveLength(1)
      expect(session.messages[0].content).toHaveLength(3)
      render(
        <Provider store={store}>
          <MessageBubble
            role="assistant"
            content={session.messages[0].content}
            showTools={false}
          />
        </Provider>,
      )
      expect(screen.getByText('2 tools used')).toBeInTheDocument()
    })
  })
})
