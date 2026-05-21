import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { FreshAgentView } from '@/components/fresh-agent/FreshAgentView'
import panesReducer, { initLayout } from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
import freshAgentReducer from '@/store/freshAgentSlice'
import agentChatReducer, { markSessionLost, sessionSnapshotReceived } from '@/store/agentChatSlice'
import { useAppSelector } from '@/store/hooks'
import type { PaneNode } from '@/store/paneTypes'

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

function leafContent(layout: PaneNode | undefined) {
  return layout?.type === 'leaf' ? layout.content : undefined
}

describe('Fresh-agent lost-session recovery coverage', () => {
  afterEach(() => {
    cleanup()
  })

  beforeEach(() => {
    wsMock.send.mockReset()
    wsMock.onMessage.mockReset()
    wsMock.onMessage.mockImplementation(() => () => {})
    apiMock.getFreshAgentThreadSnapshot.mockReset()
    apiMock.getFreshAgentThreadSnapshot.mockRejectedValue(new TypeError('Failed to parse URL from /api/fresh-agent/threads/claude/dead-session-id'))
  })

  it('shows a restoring state for a durable freshclaude resume before recovery completes', async () => {
    const durableSessionId = '00000000-0000-4000-8000-000000000123'
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
      timelineSessionId: durableSessionId,
      revision: 2,
    }))

    const view = render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(within(view.container).getAllByText(/restoring/i).length).toBeGreaterThan(0)
    })
    expect(within(view.container).queryByText(/failed to parse url/i)).not.toBeInTheDocument()
  })

  it('recreates a lost freshclaude session with the canonical durable resume id', async () => {
    const durableSessionId = '00000000-0000-4000-8000-000000000123'
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
      timelineSessionId: durableSessionId,
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
        resumeSessionId: durableSessionId,
      }))
    })
    expect(wsMock.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'freshAgent.create',
      resumeSessionId: 'named-resume',
    }))
  })

  it('does not recreate from a named-only legacy resume target', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-named-only',
        sessionId: 'dead-session-named',
        status: 'idle',
        resumeSessionId: 'named-only-fallback',
      },
    }))
    store.dispatch(markSessionLost({ sessionId: 'dead-session-named' }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByText(/legacy name, not a canonical Claude session id/i)).toBeInTheDocument()
    })
    expect(wsMock.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'freshAgent.create',
    }))
    expect(leafContent(store.getState().panes.layouts['tab-1'])?.restoreError).toEqual({
      code: 'RESTORE_UNAVAILABLE',
      reason: 'invalid_legacy_restore_target',
    })
  })

  it('writes canonical sessionRef when Claude durable id appears after recovery', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-canonical-id-recovery',
        sessionId: 'dead-session-3',
        status: 'idle',
        resumeSessionId: 'named-resume-alt',
      },
    }))
    store.dispatch(sessionSnapshotReceived({
      sessionId: 'dead-session-3',
      latestTurnId: 'turn-1',
      status: 'idle',
      timelineSessionId: '00000000-0000-4000-8000-000000000555',
      revision: 2,
    }))
    store.dispatch(markSessionLost({ sessionId: 'dead-session-3' }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(wsMock.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'freshAgent.create',
        resumeSessionId: '00000000-0000-4000-8000-000000000555',
      }))
    })
    expect(wsMock.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'freshAgent.create',
      resumeSessionId: 'named-resume-alt',
    }))
  })
})
