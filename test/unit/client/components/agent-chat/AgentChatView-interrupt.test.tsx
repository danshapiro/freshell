import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import AgentChatView from '@/components/agent-chat/AgentChatView'
import agentChatReducer from '@/store/agentChatSlice'
import panesReducer from '@/store/panesSlice'
import type { AgentChatPaneContent } from '@/store/paneTypes'

// jsdom doesn't implement scrollIntoView
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

// Mock ws-client to capture sent messages
const mockSend = vi.fn()
vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: mockSend,
    onReconnect: vi.fn(() => vi.fn()),
  }),
}))

function makeStore() {
  return configureStore({
    reducer: {
      agentChat: agentChatReducer,
      panes: panesReducer,
    },
  })
}

const basePaneContent: AgentChatPaneContent = {
  kind: 'agent-chat',
  provider: 'freshclaude',
  createRequestId: 'req-1',
  sessionId: 'sess-1',
  status: 'running',
}

describe('AgentChatView Escape interrupt', () => {
  beforeAll(() => {
    mockSend.mockClear()
  })
  afterEach(() => {
    mockSend.mockClear()
    cleanup()
  })

  it('sends sdk.interrupt when Escape is pressed on the container while running', () => {
    const store = makeStore()
    render(
      <Provider store={store}>
        <AgentChatView tabId="tab-1" paneId="pane-1" paneContent={basePaneContent} />
      </Provider>,
    )
    const container = screen.getByRole('region', { name: /chat/i })
    fireEvent.keyDown(container, { key: 'Escape' })
    expect(mockSend).toHaveBeenCalledWith({
      type: 'sdk.interrupt',
      sessionId: 'sess-1',
    })
  })

  it('does not send sdk.interrupt when Escape is pressed while idle', () => {
    const store = makeStore()
    const idleContent: AgentChatPaneContent = { ...basePaneContent, status: 'idle' }
    render(
      <Provider store={store}>
        <AgentChatView tabId="tab-1" paneId="pane-1" paneContent={idleContent} />
      </Provider>,
    )
    const container = screen.getByRole('region', { name: /chat/i })
    fireEvent.keyDown(container, { key: 'Escape' })
    expect(mockSend).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sdk.interrupt' }),
    )
  })

  it('does not send sdk.interrupt for non-Escape keys while running', () => {
    const store = makeStore()
    render(
      <Provider store={store}>
        <AgentChatView tabId="tab-1" paneId="pane-1" paneContent={basePaneContent} />
      </Provider>,
    )
    const container = screen.getByRole('region', { name: /chat/i })
    fireEvent.keyDown(container, { key: 'a' })
    expect(mockSend).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sdk.interrupt' }),
    )
  })
})
