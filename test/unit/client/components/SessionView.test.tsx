import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import SessionView from '../../../../src/components/SessionView'
import codingCliReducer from '../../../../src/store/codingCliSlice'

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

function createTestStore(codingCliState = {}) {
  return configureStore({
    reducer: {
      codingCli: codingCliReducer,
    },
    preloadedState: {
      codingCli: {
        sessions: {
          'session-1': {
            sessionId: 'session-1',
            provider: 'claude',
            prompt: 'test prompt',
            status: 'running' as const,
            events: [],
            createdAt: Date.now(),
          },
          ...codingCliState,
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

describe('SessionView', () => {
  it('renders session prompt', () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <SessionView sessionId="session-1" />
      </Provider>
    )

    expect(screen.getByText(/test prompt/)).toBeInTheDocument()
  })

  it('connects the websocket on mount', async () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <SessionView sessionId="session-1" />
      </Provider>
    )

    await waitFor(() => expect(mockConnect).toHaveBeenCalled())
  })

  it('renders message events', () => {
    const store = createTestStore({
      'session-1': {
        sessionId: 'session-1',
        provider: 'claude',
        prompt: 'test',
        status: 'running' as const,
        events: [
          {
            type: 'message.assistant',
            timestamp: new Date().toISOString(),
            sessionId: 'provider-session',
            provider: 'claude',
            raw: {},
            message: {
              role: 'assistant',
              content: 'Hello from Claude!',
            },
          },
        ],
        createdAt: Date.now(),
      },
    })

    render(
      <Provider store={store}>
        <SessionView sessionId="session-1" />
      </Provider>
    )

    expect(screen.getByText('Hello from Claude!')).toBeInTheDocument()
  })

  it('renders reasoning events', () => {
    const store = createTestStore({
      'session-1': {
        sessionId: 'session-1',
        provider: 'claude',
        prompt: 'test',
        status: 'running' as const,
        events: [
          {
            type: 'reasoning',
            timestamp: new Date().toISOString(),
            sessionId: 'provider-session',
            provider: 'claude',
            raw: {},
            reasoning: 'Thinking through the problem...',
          },
        ],
        createdAt: Date.now(),
      },
    })

    render(
      <Provider store={store}>
        <SessionView sessionId="session-1" />
      </Provider>
    )

    expect(screen.getByText('Thinking through the problem...')).toBeInTheDocument()
  })

  it('shows loading state when no events', () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <SessionView sessionId="session-1" />
      </Provider>
    )

    expect(screen.getByText(/waiting/i)).toBeInTheDocument()
  })

  it('shows completed state', () => {
    const store = createTestStore({
      'session-1': {
        sessionId: 'session-1',
        provider: 'claude',
        prompt: 'test',
        status: 'completed' as const,
        events: [
          {
            type: 'session.end',
            timestamp: new Date().toISOString(),
            sessionId: 'provider-session',
            provider: 'claude',
            raw: {},
          },
        ],
        createdAt: Date.now(),
      },
    })

    render(
      <Provider store={store}>
        <SessionView sessionId="session-1" />
      </Provider>
    )

    expect(screen.getAllByText(/completed/i).length).toBeGreaterThan(0)
  })

  it('shows placeholder for unknown session', () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <SessionView sessionId="unknown" />
      </Provider>
    )

    expect(screen.getByText(/starting session/i)).toBeInTheDocument()
  })
})
