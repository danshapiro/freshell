import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import AgentChatView from '@/components/agent-chat/AgentChatView'
import agentChatReducer, {
  addAssistantMessage,
  addUserMessage,
  sessionCreated,
  setSessionStatus,
} from '@/store/agentChatSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
import { createPerfAuditBridge, installPerfAuditBridge } from '@/lib/perf-audit-bridge'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: vi.fn(),
    onReconnect: vi.fn(() => vi.fn()),
  }),
}))

describe('AgentChatView perf audit milestone', () => {
  afterEach(() => {
    cleanup()
    installPerfAuditBridge(null)
  })

  it('marks agent_chat.surface_visible when the focused history is rendered and loaded', async () => {
    const bridge = createPerfAuditBridge()
    installPerfAuditBridge(bridge)

    const store = configureStore({
      reducer: {
        agentChat: agentChatReducer,
        panes: panesReducer,
        settings: settingsReducer,
      },
      preloadedState: {
        panes: {
          layouts: {},
          activePane: { 'tab-1': 'pane-1' },
          paneTitles: {},
        },
        settings: {
          settings: {},
          loaded: true,
          lastSavedAt: 0,
        },
      },
    })

    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(addUserMessage({ sessionId: 'sess-1', text: 'Question 1' }))
    store.dispatch(addAssistantMessage({
      sessionId: 'sess-1',
      content: [{ type: 'text', text: 'Assistant reply 1' }],
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))

    render(
      <Provider store={store}>
        <AgentChatView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={{
            kind: 'agent-chat',
            provider: 'freshclaude',
            createRequestId: 'req-1',
            sessionId: 'sess-1',
            status: 'idle',
          }}
        />
      </Provider>,
    )

    expect(await screen.findByText(/assistant reply 1/i)).toBeVisible()
    expect(bridge.snapshot().milestones['agent_chat.surface_visible']).toBeTypeOf('number')
  })
})
