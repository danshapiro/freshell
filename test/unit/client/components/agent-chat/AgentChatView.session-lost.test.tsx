import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { FreshAgentView } from '@/components/fresh-agent/FreshAgentView'
import panesReducer, { initLayout } from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
import freshAgentReducer from '@/store/freshAgentSlice'
import agentChatReducer, { markSessionLost, sessionSnapshotReceived } from '@/store/agentChatSlice'
import { useAppSelector } from '@/store/hooks'

const wsMock = vi.hoisted(() => ({
  send: vi.fn(),
  onMessage: vi.fn(() => () => {}),
}))

const apiMock = vi.hoisted(() => ({
  getFreshAgentThreadSnapshot: vi.fn(),
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => wsMock,
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getFreshAgentThreadSnapshot: apiMock.getFreshAgentThreadSnapshot,
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

function StoreBackedFreshAgentView({ tabId, paneId }: { tabId: string; paneId: string }) {
  const paneContent = useAppSelector((state) => {
    const layout = state.panes.layouts[tabId]
    if (!layout || layout.type !== 'leaf' || layout.id !== paneId || layout.content.kind !== 'fresh-agent') {
      throw new Error(`Missing fresh-agent pane ${paneId}`)
    }
    return layout.content
  })
  return <FreshAgentView tabId={tabId} paneId={paneId} paneContent={paneContent} />
}

describe('Fresh-agent lost-session recovery coverage', () => {
  beforeEach(() => {
    wsMock.send.mockReset()
    wsMock.onMessage.mockReset()
    wsMock.onMessage.mockImplementation(() => () => {})
    apiMock.getFreshAgentThreadSnapshot.mockReset()
    apiMock.getFreshAgentThreadSnapshot.mockRejectedValue(new TypeError('Failed to parse URL from /api/fresh-agent/threads/claude/dead-session-id'))
  })

  it('shows a restoring state for a durable freshclaude resume before recovery completes', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-stale',
        sessionId: 'dead-session-id',
        status: 'idle',
        resumeSessionId: 'named-resume',
      },
    }))
    store.dispatch(sessionSnapshotReceived({
      sessionId: 'dead-session-id',
      latestTurnId: 'turn-1',
      status: 'idle',
      timelineSessionId: 'cli-session-abc-123',
      revision: 2,
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getAllByText(/restoring/i).length).toBeGreaterThan(0)
    })
    expect(screen.queryByText(/failed to parse url/i)).not.toBeInTheDocument()
  })

  it('recreates a lost freshclaude session with the canonical durable resume id', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-stale',
        sessionId: 'dead-session-id',
        status: 'idle',
        resumeSessionId: 'named-resume',
      },
    }))
    store.dispatch(sessionSnapshotReceived({
      sessionId: 'dead-session-id',
      latestTurnId: 'turn-1',
      status: 'idle',
      timelineSessionId: 'cli-session-abc-123',
      revision: 2,
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getAllByText(/restoring/i).length).toBeGreaterThan(0)
    })

    act(() => {
      store.dispatch(markSessionLost({ sessionId: 'dead-session-id' }))
    })

    await waitFor(() => {
      expect(wsMock.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'freshAgent.create',
        sessionType: 'freshclaude',
        resumeSessionId: 'cli-session-abc-123',
      }))
    })
  })
})
