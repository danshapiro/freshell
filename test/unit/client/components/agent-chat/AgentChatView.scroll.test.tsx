import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import AgentChatView from '@/components/agent-chat/AgentChatView'
import agentChatReducer from '@/store/agentChatSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
import type { AgentChatPaneContent } from '@/store/paneTypes'

// jsdom doesn't implement scrollIntoView
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

// Mock ws-client
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
      settings: settingsReducer,
    },
  })
}

const basePaneContent: AgentChatPaneContent = {
  kind: 'agent-chat', provider: 'freshclaude',
  createRequestId: 'test-req',
  status: 'idle',
  sessionId: 'test-session',
}

describe('AgentChatView visibility', () => {
  afterEach(cleanup)

  it('renders with tab-visible class when not hidden', () => {
    const store = makeStore()
    const { container } = render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={basePaneContent} />
      </Provider>
    )
    const region = container.querySelector('[role="region"]')
    expect(region).toBeInTheDocument()
    expect(region!.className).toContain('tab-visible')
  })

  it('renders with tab-hidden class when hidden (does NOT unmount)', () => {
    const store = makeStore()
    const { container } = render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={basePaneContent} hidden />
      </Provider>
    )
    const region = container.querySelector('[role="region"]')
    expect(region).toBeInTheDocument()
    expect(region!.className).toContain('tab-hidden')
  })
})
