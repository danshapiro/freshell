import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import AgentChatView from '@/components/agent-chat/AgentChatView'
import agentChatReducer, { sessionCreated, addPermissionRequest } from '@/store/agentChatSlice'
import panesReducer from '@/store/panesSlice'
import type { AgentChatPaneContent } from '@/store/paneTypes'

// jsdom doesn't implement scrollIntoView
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
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
      panes: panesReducer,
    },
  })
}

describe('AgentChatView status text', () => {
  afterEach(cleanup)

  it('shows "Waiting for answer..." when permissions are pending', () => {
    const store = makeStore()
    // Create a session with a pending permission
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(addPermissionRequest({
      sessionId: 'sess-1',
      requestId: 'perm-1',
      subtype: 'can_use_tool',
      tool: { name: 'Bash', input: { command: 'ls' } },
    }))

    const paneContent: AgentChatPaneContent = {
      kind: 'agent-chat', provider: 'freshclaude',
      createRequestId: 'req-1',
      sessionId: 'sess-1',
      status: 'running',
    }

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={paneContent} />
      </Provider>
    )

    expect(screen.getByText('Waiting for answer...')).toBeInTheDocument()
  })

  it('shows "Running..." when no permissions are pending', () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))

    const paneContent: AgentChatPaneContent = {
      kind: 'agent-chat', provider: 'freshclaude',
      createRequestId: 'req-1',
      sessionId: 'sess-1',
      status: 'running',
    }

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={paneContent} />
      </Provider>
    )

    expect(screen.getByText('Running...')).toBeInTheDocument()
  })
})
