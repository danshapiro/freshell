import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import ClaudeSessionView from '../../../../src/components/ClaudeSessionView'
import claudeReducer from '../../../../src/store/claudeSlice'

const mockConnect = vi.fn().mockResolvedValue(undefined)
const mockSend = vi.fn()
const mockOnMessage = vi.fn(() => () => {})

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: mockSend,
    onMessage: mockOnMessage,
    connect: mockConnect,
  }),
}))

function createTestStore(claudeState = {}) {
  return configureStore({
    reducer: {
      claude: claudeReducer,
    },
    preloadedState: {
      claude: {
        sessions: {
          'session-1': {
            sessionId: 'session-1',
            prompt: 'test prompt',
            status: 'running' as const,
            messages: [],
            createdAt: Date.now(),
          },
          ...claudeState,
        },
      },
    },
  })
}

afterEach(() => {
  cleanup()
  mockConnect.mockClear()
  mockSend.mockClear()
  mockOnMessage.mockClear()
})

describe('ClaudeSessionView', () => {
  it('renders session prompt', () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <ClaudeSessionView sessionId="session-1" />
      </Provider>
    )

    expect(screen.getByText(/test prompt/)).toBeInTheDocument()
  })

  it('connects the websocket on mount', async () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <ClaudeSessionView sessionId="session-1" />
      </Provider>
    )

    await waitFor(() => expect(mockConnect).toHaveBeenCalled())
  })

  it('renders message events', () => {
    const store = createTestStore({
      'session-1': {
        sessionId: 'session-1',
        prompt: 'test',
        status: 'running' as const,
        messages: [
          {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Hello from Claude!' }],
            },
            session_id: 'abc',
            uuid: '123',
          },
        ],
        createdAt: Date.now(),
      },
    })

    render(
      <Provider store={store}>
        <ClaudeSessionView sessionId="session-1" />
      </Provider>
    )

    expect(screen.getByText('Hello from Claude!')).toBeInTheDocument()
  })

  it('shows loading state when no events', () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <ClaudeSessionView sessionId="session-1" />
      </Provider>
    )

    expect(screen.getByText(/waiting/i)).toBeInTheDocument()
  })

  it('shows completed state', () => {
    const store = createTestStore({
      'session-1': {
        sessionId: 'session-1',
        prompt: 'test',
        status: 'completed' as const,
        messages: [],
        result: {
          type: 'result',
          subtype: 'success',
          is_error: false,
          duration_ms: 1000,
          session_id: 'abc',
        },
        createdAt: Date.now(),
      },
    })

    render(
      <Provider store={store}>
        <ClaudeSessionView sessionId="session-1" />
      </Provider>
    )

    // The word "completed" appears in multiple places - status badge, duration, and footer
    // Just check that at least one exists
    expect(screen.getAllByText(/completed/i).length).toBeGreaterThan(0)
  })

  it('returns null for unknown session', () => {
    const store = createTestStore()
    const { container } = render(
      <Provider store={store}>
        <ClaudeSessionView sessionId="unknown" />
      </Provider>
    )

    expect(container.firstChild).toBeNull()
  })
})
