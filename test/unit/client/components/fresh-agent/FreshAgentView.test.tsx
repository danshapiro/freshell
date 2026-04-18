import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import panesReducer from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
import freshAgentReducer from '@/store/freshAgentSlice'
import agentChatReducer from '@/store/agentChatSlice'
import { FreshAgentView } from '@/components/fresh-agent/FreshAgentView'

const wsMock = vi.hoisted(() => ({
  send: vi.fn(),
  onMessage: vi.fn(() => () => {}),
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => wsMock,
}))

vi.mock('@/components/agent-chat/AgentChatView', () => ({
  default: ({ paneContent }: { paneContent: { provider: string } }) => <div>agent:{paneContent.provider}</div>,
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getFreshAgentThreadSnapshot: vi.fn().mockResolvedValue({
      status: 'idle',
      summary: 'Codex summary',
      capabilities: { fork: true },
      diffs: [{ id: 'diff-1', title: 'README.md' }],
      worktrees: [{ id: 'wt-1', path: '/tmp/worktree', branch: 'feature/x' }],
      turns: [{ id: 'turn-1', role: 'assistant', items: [{ id: 'item-1', kind: 'text', text: 'Codex turn' }] }],
    }),
  }
})

function createStore() {
  return configureStore({
    reducer: {
      panes: panesReducer,
      settings: settingsReducer,
      freshAgent: freshAgentReducer,
      agentChat: agentChatReducer,
    },
    preloadedState: {
      panes: {
        layouts: {},
        activePane: {},
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
    },
  })
}

describe('FreshAgentView', () => {
  it('renders the Claude compatibility surface for freshclaude', () => {
    const store = createStore()
    render(
      <Provider store={store}>
        <FreshAgentView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={{
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            createRequestId: 'req-1',
            status: 'idle',
          }}
        />
      </Provider>,
    )

    expect(screen.getByText('agent:freshclaude')).toBeInTheDocument()
  })

  it('renders Codex capability metadata in the shared shell', async () => {
    const store = createStore()
    render(
      <Provider store={store}>
        <FreshAgentView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={{
            kind: 'fresh-agent',
            sessionType: 'freshcodex',
            provider: 'codex',
            createRequestId: 'req-2',
            sessionId: 'thread-1',
            status: 'connected',
          }}
        />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByText('Codex summary')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Fork' })).toBeEnabled()
    expect(screen.getByText('README.md')).toBeInTheDocument()
    expect(screen.getByText(/feature\/x/)).toBeInTheDocument()
  })
})
