import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider, useSelector } from 'react-redux'
import AgentChatView from '@/components/agent-chat/AgentChatView'
import agentChatReducer, {
  addUserMessage,
  registerPendingCreate,
  sessionCreated,
  sessionInit,
  sessionSnapshotReceived,
  setSessionStatus,
  timelinePageReceived,
  turnBodyReceived,
} from '@/store/agentChatSlice'
import panesReducer, { initLayout } from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
import tabsReducer, { addTab } from '@/store/tabsSlice'
import type { AgentChatPaneContent } from '@/store/paneTypes'
import type { PaneNode } from '@/store/paneTypes'

// jsdom doesn't implement scrollIntoView
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

const wsSend = vi.fn()
const getAgentTimelinePage = vi.fn()
const getAgentTurnBody = vi.fn()
const setSessionMetadata = vi.fn(() => Promise.resolve(undefined))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsSend,
    onReconnect: vi.fn(() => vi.fn()),
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getAgentTimelinePage: (...args: unknown[]) => getAgentTimelinePage(...args),
    getAgentTurnBody: (...args: unknown[]) => getAgentTurnBody(...args),
    setSessionMetadata: (...args: unknown[]) => setSessionMetadata(...args),
  }
})

function makeStore() {
  return configureStore({
    reducer: {
      agentChat: agentChatReducer,
      panes: panesReducer,
      settings: settingsReducer,
    },
  })
}

function makeStoreWithTabs() {
  return configureStore({
    reducer: {
      agentChat: agentChatReducer,
      panes: panesReducer,
      settings: settingsReducer,
      tabs: tabsReducer,
    },
  })
}

const RELOAD_PANE: AgentChatPaneContent = {
  kind: 'agent-chat', provider: 'freshclaude',
  createRequestId: 'req-1',
  sessionId: 'sess-reload-1',
  status: 'idle',
}

describe('AgentChatView reload/restore behavior', () => {
  beforeEach(() => {
    localStorage.clear()
    getAgentTimelinePage.mockReset()
    getAgentTurnBody.mockReset()
    setSessionMetadata.mockReset()
    setSessionMetadata.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    wsSend.mockClear()
    localStorage.clear()
    delete window.__FRESHELL_TEST_HARNESS__
  })

  it('sends sdk.attach on mount when paneContent has a persisted sessionId', () => {
    const store = makeStore()
    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    expect(wsSend).toHaveBeenCalledWith({
      type: 'sdk.attach',
      sessionId: 'sess-reload-1',
    })
  })

  it('skips sdk.attach when the e2e harness suppresses agent chat network effects for the pane', () => {
    window.__FRESHELL_TEST_HARNESS__ = {
      getState: vi.fn(),
      dispatch: vi.fn(),
      getWsReadyState: vi.fn(),
      waitForConnection: vi.fn(),
      forceDisconnect: vi.fn(),
      sendWsMessage: vi.fn(),
      setAgentChatNetworkEffectsSuppressed: vi.fn(),
      isAgentChatNetworkEffectsSuppressed: vi.fn((paneId: string) => paneId === 'p1'),
      setTerminalNetworkEffectsSuppressed: vi.fn(),
      isTerminalNetworkEffectsSuppressed: vi.fn(() => false),
      getTerminalBuffer: vi.fn(),
      registerTerminalBuffer: vi.fn(),
      unregisterTerminalBuffer: vi.fn(),
      getPerfAuditSnapshot: vi.fn(),
    }

    const store = makeStore()
    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    const attachCalls = wsSend.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'sdk.attach',
    )
    expect(attachCalls).toHaveLength(0)
  })

  it('does NOT send sdk.attach when paneContent has no sessionId (new session)', () => {
    const store = makeStore()
    const newPane: AgentChatPaneContent = {
      kind: 'agent-chat', provider: 'freshclaude',
      createRequestId: 'req-new',
      status: 'creating',
    }
    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={newPane} />
      </Provider>,
    )

    const attachCalls = wsSend.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'sdk.attach',
    )
    expect(attachCalls).toHaveLength(0)
  })

  it('shows loading state instead of welcome screen when sessionId is set but messages have not arrived', () => {
    const store = makeStore()
    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    // Should NOT show the Freshclaude welcome text
    expect(screen.queryByText('Freshclaude')).not.toBeInTheDocument()

    // Should show a restoring/loading indicator
    expect(screen.getByText(/restoring/i)).toBeInTheDocument()
  })

  it('shows welcome screen when no sessionId (brand new session)', () => {
    const store = makeStore()
    const newPane: AgentChatPaneContent = {
      kind: 'agent-chat', provider: 'freshclaude',
      createRequestId: 'req-new',
      status: 'creating',
    }
    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={newPane} />
      </Provider>,
    )

    expect(screen.getByText('Freshclaude')).toBeInTheDocument()
  })

  it('replaces loading state with hydrated timeline content after the initial window arrives', () => {
    const store = makeStore()
    const { rerender } = render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    // Initially shows loading
    expect(screen.queryByText('Freshclaude')).not.toBeInTheDocument()
    expect(screen.getByText(/restoring/i)).toBeInTheDocument()

    store.dispatch(timelinePageReceived({
      sessionId: 'sess-reload-1',
      items: [
        {
          turnId: 'turn-1',
          sessionId: 'sess-reload-1',
          role: 'assistant',
          summary: 'Hello! How can I help?',
          timestamp: '2026-01-01T00:00:00Z',
        },
      ],
      nextCursor: null,
      revision: 1,
      replace: true,
    }))
    store.dispatch(turnBodyReceived({
      sessionId: 'sess-reload-1',
      turnId: 'turn-1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello! How can I help?' }],
        timestamp: '2026-01-01T00:00:01Z',
      },
    }))

    // Force re-render to pick up store changes
    rerender(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    // Loading should be gone
    expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()

    expect(screen.getByText('Hello! How can I help?')).toBeInTheDocument()
  })

  it('shows welcome screen (not restoring) for freshly created session with sessionId', () => {
    const store = makeStore()
    // Simulate sdk.created — Redux now has the session object
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-fresh' }))

    const freshPane: AgentChatPaneContent = {
      kind: 'agent-chat', provider: 'freshclaude',
      createRequestId: 'req-1',
      sessionId: 'sess-fresh',
      status: 'starting',
    }
    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={freshPane} />
      </Provider>,
    )

    // Should show welcome, NOT "Restoring session..."
    expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()
    expect(screen.getByText('Freshclaude')).toBeInTheDocument()
  })

  it('does not show restoring for a fresh sdk.created session', () => {
    const store = makeStore()
    store.dispatch(registerPendingCreate({
      requestId: 'req-fresh',
      expectsHistoryHydration: false,
    }))
    store.dispatch(sessionCreated({
      requestId: 'req-fresh',
      sessionId: 'sdk-fresh',
    }))

    render(
      <Provider store={store}>
        <AgentChatView
          tabId="t1"
          paneId="p1"
          paneContent={{
            kind: 'agent-chat',
            provider: 'freshclaude',
            createRequestId: 'req-fresh',
            sessionId: 'sdk-fresh',
            status: 'starting',
          }}
        />
      </Provider>,
    )

    expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()
    expect(screen.getByText('Freshclaude')).toBeInTheDocument()
  })

  it('shows welcome screen (not stuck restoring) when the initial timeline window arrives empty', () => {
    const store = makeStore()
    const { rerender } = render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    // Initially shows restoring
    expect(screen.getByText(/restoring/i)).toBeInTheDocument()

    store.dispatch(timelinePageReceived({
      sessionId: 'sess-reload-1',
      items: [],
      nextCursor: null,
      revision: 1,
      replace: true,
    }))

    rerender(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    // Should NOT be stuck on restoring
    expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()

    // Should show the welcome screen since session is empty
    expect(screen.getByText('Freshclaude')).toBeInTheDocument()
  })

  it('restores from sdk.session.snapshot plus HTTP timeline fetch without waiting for sdk.history', async () => {
    getAgentTimelinePage.mockResolvedValue({
      sessionId: 'sess-reload-1',
      items: [
        {
          turnId: 'turn-2',
          sessionId: 'sess-reload-1',
          role: 'assistant',
          summary: 'Recent summary',
          timestamp: '2026-03-10T10:01:00.000Z',
        },
      ],
      nextCursor: null,
      revision: 2,
    })
    getAgentTurnBody.mockResolvedValue({
      sessionId: 'sess-reload-1',
      turnId: 'turn-2',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hydrated from HTTP timeline' }],
        timestamp: '2026-03-10T10:01:00.000Z',
      },
    })

    const store = makeStore()
    store.dispatch(sessionSnapshotReceived({
      sessionId: 'sess-reload-1',
      latestTurnId: 'turn-2',
      status: 'idle',
    }))

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    await waitFor(() => {
      expect(getAgentTimelinePage).toHaveBeenCalledWith(
        'sess-reload-1',
        expect.objectContaining({ priority: 'visible' }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    })
    expect(getAgentTurnBody).toHaveBeenCalledWith(
      'sess-reload-1',
      'turn-2',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(await screen.findByText('Hydrated from HTTP timeline')).toBeInTheDocument()
    expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()
  })

  it('defers restored timeline hydration while hidden and fetches exactly once when the pane becomes visible', async () => {
    getAgentTimelinePage.mockResolvedValue({
      sessionId: 'sess-reload-1',
      items: [],
      nextCursor: null,
      revision: 1,
    })
    const store = makeStore()
    store.dispatch(sessionSnapshotReceived({
      sessionId: 'sess-reload-1',
      latestTurnId: 'turn-2',
      status: 'idle',
    }))

    const { rerender } = render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} hidden />
      </Provider>,
    )

    await act(async () => {
      await Promise.resolve()
    })

    expect(getAgentTimelinePage).not.toHaveBeenCalled()
    expect(getAgentTurnBody).not.toHaveBeenCalled()
    expect(wsSend).toHaveBeenCalledWith({
      type: 'sdk.attach',
      sessionId: 'sess-reload-1',
    })

    rerender(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    await waitFor(() => {
      expect(getAgentTimelinePage).toHaveBeenCalledTimes(1)
      expect(getAgentTimelinePage).toHaveBeenCalledWith(
        'sess-reload-1',
        expect.objectContaining({ priority: 'visible', includeBodies: true }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    })
    expect(getAgentTurnBody).not.toHaveBeenCalled()
  })

  it('uses the persisted resumeSessionId for visible timeline hydration', async () => {
    const durableSessionId = '11111111-1111-1111-1111-111111111111'
    getAgentTimelinePage.mockResolvedValue({
      sessionId: durableSessionId,
      items: [],
      nextCursor: null,
      revision: 1,
    })

    const store = makeStore()
    store.dispatch(sessionSnapshotReceived({
      sessionId: 'sess-reload-1',
      latestTurnId: 'turn-2',
      status: 'idle',
    }))

    render(
      <Provider store={store}>
        <AgentChatView
          tabId="t1"
          paneId="p1"
          paneContent={{ ...RELOAD_PANE, resumeSessionId: durableSessionId }}
        />
      </Provider>,
    )

    await waitFor(() => {
      expect(getAgentTimelinePage).toHaveBeenCalledWith(
        durableSessionId,
        expect.objectContaining({ priority: 'visible', includeBodies: true }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    })
  })

  it('uses timelineSessionId from sdk.session.snapshot for visible restore hydration', async () => {
    getAgentTimelinePage.mockResolvedValue({ sessionId: 'cli-sess-1', items: [], nextCursor: null, revision: 1 })

    const store = makeStore()
    store.dispatch(sessionSnapshotReceived({
      sessionId: 'sess-reload-1',
      latestTurnId: 'turn-2',
      status: 'idle',
      timelineSessionId: 'cli-sess-1',
      revision: 2,
    }))

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={{ ...RELOAD_PANE, sessionId: 'sess-reload-1' }} />
      </Provider>,
    )

    await waitFor(() => {
      expect(getAgentTimelinePage).toHaveBeenCalledWith(
        'cli-sess-1',
        expect.objectContaining({ includeBodies: true }),
        expect.anything(),
      )
    })
  })

  it('keeps the live-only restore fallback on the SDK session id until a durable timelineSessionId exists', async () => {
    getAgentTimelinePage.mockResolvedValue({ sessionId: 'sdk-sess-1', items: [], nextCursor: null, revision: 1 })

    const store = makeStore()
    store.dispatch(sessionSnapshotReceived({
      sessionId: 'sdk-sess-1',
      latestTurnId: 'turn-2',
      status: 'idle',
    }))

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={{ ...RELOAD_PANE, sessionId: 'sdk-sess-1' }} />
      </Provider>,
    )

    await waitFor(() => {
      expect(getAgentTimelinePage).toHaveBeenCalledWith(
        'sdk-sess-1',
        expect.objectContaining({ includeBodies: true }),
        expect.anything(),
      )
    })
  })

  it('persists timelineSessionId into pane content and tab fallback metadata before sdk.session.init arrives', () => {
    const store = makeStoreWithTabs()
    const pane = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-1',
      sessionId: 'sdk-sess-1',
      status: 'starting',
    } satisfies AgentChatPaneContent
    store.dispatch(addTab({
      id: 't1',
      title: 'FreshClaude Tab',
      mode: 'claude',
      codingCliProvider: 'claude',
      resumeSessionId: 'named-resume',
      sessionMetadataByKey: {
        'claude:named-resume': {
          sessionType: 'freshclaude',
          firstUserMessage: 'Continue from the old tab',
        },
      },
    }))
    store.dispatch(initLayout({ tabId: 't1', paneId: 'p1', content: pane }))

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={pane} />
      </Provider>,
    )

    act(() => {
      store.dispatch(sessionSnapshotReceived({
        sessionId: 'sdk-sess-1',
        latestTurnId: 'turn-2',
        status: 'idle',
        timelineSessionId: 'cli-session-abc-123',
        revision: 2,
      }))
    })

    expect(getPaneContent(store as unknown as ReturnType<typeof makeStore>, 't1', 'p1')?.resumeSessionId).toBe('cli-session-abc-123')
    const tab = store.getState().tabs.tabs.find((entry) => entry.id === 't1')
    expect(tab?.resumeSessionId).toBe('cli-session-abc-123')
    expect(tab?.sessionMetadataByKey?.['claude:cli-session-abc-123']).toEqual(expect.objectContaining({
      sessionType: 'freshclaude',
      firstUserMessage: 'Continue from the old tab',
    }))
  })

  it('shows a restored partial assistant stream after reconnect', () => {
    const store = makeStore()
    store.dispatch(sessionSnapshotReceived({
      sessionId: 'sdk-sess-1',
      latestTurnId: 'turn-2',
      status: 'running',
      timelineSessionId: 'cli-sess-1',
      streamingActive: true,
      streamingText: 'partial reply',
    }))

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={{ ...RELOAD_PANE, sessionId: 'sdk-sess-1' }} />
      </Provider>,
    )

    expect(screen.getByText('partial reply')).toBeInTheDocument()
  })

  it('keeps restored partial assistant output visible after content_block_stop before the final assistant message arrives', () => {
    vi.useFakeTimers()
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sdk-sess-2' }))
    store.dispatch(addUserMessage({ sessionId: 'sdk-sess-2', text: 'continue' }))
    store.dispatch(sessionSnapshotReceived({
      sessionId: 'sdk-sess-2',
      latestTurnId: 'turn-3',
      status: 'running',
      timelineSessionId: 'cli-sess-2',
      streamingActive: false,
      streamingText: 'partial reply',
    }))

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={{ ...RELOAD_PANE, sessionId: 'sdk-sess-2' }} />
      </Provider>,
    )

    act(() => { vi.advanceTimersByTime(250) })

    expect(screen.getByText('partial reply')).toBeInTheDocument()
    expect(screen.queryByLabelText('Claude is thinking')).not.toBeInTheDocument()

    vi.useRealTimers()
  })

  it('does not issue an HTTP timeline fetch when snapshot proves the resumed session is empty', async () => {
    const store = makeStore()
    store.dispatch(registerPendingCreate({
      requestId: 'req-empty',
      expectsHistoryHydration: true,
    }))
    store.dispatch(sessionCreated({
      requestId: 'req-empty',
      sessionId: 'sdk-empty',
    }))
    store.dispatch(sessionSnapshotReceived({
      sessionId: 'sdk-empty',
      latestTurnId: null,
      status: 'idle',
    }))

    render(
      <Provider store={store}>
        <AgentChatView
          tabId="t1"
          paneId="p1"
          paneContent={{
            kind: 'agent-chat',
            provider: 'freshclaude',
            createRequestId: 'req-empty',
            sessionId: 'sdk-empty',
            status: 'idle',
            resumeSessionId: 'cli-empty',
          }}
        />
      </Provider>,
    )

    await act(async () => {
      await Promise.resolve()
    })

    expect(getAgentTimelinePage).not.toHaveBeenCalled()
    expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()
  })

  it('stays in restoring state when sdk.status arrives before the first timeline window (race condition)', () => {
    const store = makeStore()
    store.dispatch(setSessionStatus({ sessionId: 'sess-reload-1', status: 'idle' }))

    const { rerender } = render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    // Session exists in Redux but historyLoaded is not set — should still show restoring
    expect(screen.getByText(/restoring/i)).toBeInTheDocument()
    expect(screen.queryByText('Freshclaude')).not.toBeInTheDocument()

    store.dispatch(timelinePageReceived({
      sessionId: 'sess-reload-1',
      items: [
        {
          turnId: 'turn-1',
          sessionId: 'sess-reload-1',
          role: 'user',
          summary: 'Hello',
          timestamp: '2026-01-01T00:00:00Z',
        },
      ],
      nextCursor: null,
      revision: 1,
      replace: true,
    }))
    store.dispatch(turnBodyReceived({
      sessionId: 'sess-reload-1',
      turnId: 'turn-1',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
        timestamp: '2026-01-01T00:00:00Z',
      },
    }))

    rerender(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    // Now restoring should be done, messages visible
    expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()
    expect(screen.getByText('Hello')).toBeInTheDocument()
  })

  it('reactively updates when timeline hydration lands (no manual rerender)', async () => {
    const store = makeStore()
    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    // Initially shows restoring
    expect(screen.getByText(/restoring/i)).toBeInTheDocument()

    act(() => {
      store.dispatch(timelinePageReceived({
        sessionId: 'sess-reload-1',
        items: [
          {
            turnId: 'turn-1',
            sessionId: 'sess-reload-1',
            role: 'user',
            summary: 'Reactive test message',
            timestamp: '2026-01-01T00:00:00Z',
          },
        ],
        nextCursor: null,
        revision: 1,
        replace: true,
      }))
      store.dispatch(turnBodyReceived({
        sessionId: 'sess-reload-1',
        turnId: 'turn-1',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Reactive test message' }],
          timestamp: '2026-01-01T00:00:00Z',
        },
      }))
    })

    expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()
    expect(screen.getByText('Reactive test message')).toBeInTheDocument()
  })

  it('reactively updates when timeline hydration + sdk.status arrive back-to-back', () => {
    const store = makeStore()
    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    // Initially shows restoring
    expect(screen.getByText(/restoring/i)).toBeInTheDocument()

    act(() => {
      store.dispatch(timelinePageReceived({
        sessionId: 'sess-reload-1',
        items: [
          {
            turnId: 'turn-1',
            sessionId: 'sess-reload-1',
            role: 'user',
            summary: 'Back-to-back test',
            timestamp: '2026-01-01T00:00:00Z',
          },
        ],
        nextCursor: null,
        revision: 1,
        replace: true,
      }))
      store.dispatch(turnBodyReceived({
        sessionId: 'sess-reload-1',
        turnId: 'turn-1',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Back-to-back test' }],
          timestamp: '2026-01-01T00:00:00Z',
        },
      }))
      store.dispatch(setSessionStatus({
        sessionId: 'sess-reload-1',
        status: 'idle',
      }))
    })

    // Messages should be visible — both dispatches should be processed
    expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()
    expect(screen.getByText('Back-to-back test')).toBeInTheDocument()
  })

  it('reactively updates when timeline hydration and sdk.status arrive in separate event loop ticks', () => {
    const store = makeStore()
    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    // Initially shows restoring
    expect(screen.getByText(/restoring/i)).toBeInTheDocument()

    act(() => {
      store.dispatch(timelinePageReceived({
        sessionId: 'sess-reload-1',
        items: [
          {
            turnId: 'turn-1',
            sessionId: 'sess-reload-1',
            role: 'user',
            summary: 'Separate tick test',
            timestamp: '2026-01-01T00:00:00Z',
          },
        ],
        nextCursor: null,
        revision: 1,
        replace: true,
      }))
      store.dispatch(turnBodyReceived({
        sessionId: 'sess-reload-1',
        turnId: 'turn-1',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Separate tick test' }],
          timestamp: '2026-01-01T00:00:00Z',
        },
      }))
    })

    expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()
    expect(screen.getByText('Separate tick test')).toBeInTheDocument()

    act(() => {
      store.dispatch(setSessionStatus({
        sessionId: 'sess-reload-1',
        status: 'idle',
      }))
    })

    expect(screen.getByText('Separate tick test')).toBeInTheDocument()
  })

  it('falls back to welcome screen after restore timeout (stale sessionId)', () => {
    vi.useFakeTimers()
    const store = makeStore()
    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    // Initially shows restoring
    expect(screen.getByText(/restoring/i)).toBeInTheDocument()
    expect(screen.queryByText('Freshclaude')).not.toBeInTheDocument()

    // Advance past the 5-second timeout
    act(() => { vi.advanceTimersByTime(5_000) })

    // Should fall back to welcome screen
    expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()
    expect(screen.getByText('Freshclaude')).toBeInTheDocument()

    vi.useRealTimers()
  })
})

/** Read pane content from the store for a given tab/pane ID. */
function getPaneContent(store: ReturnType<typeof makeStore>, tabId: string, paneId: string): AgentChatPaneContent | undefined {
  const root = store.getState().panes.layouts[tabId]
  if (!root) return undefined
  function find(node: PaneNode): AgentChatPaneContent | undefined {
    if (node.type === 'leaf' && node.id === paneId && node.content.kind === 'agent-chat') {
      return node.content
    }
    if (node.type === 'split') {
      return find(node.children[0]) || find(node.children[1])
    }
    return undefined
  }
  return find(root)
}

describe('AgentChatView server-restart recovery', () => {
  afterEach(() => {
    cleanup()
    wsSend.mockClear()
    vi.useRealTimers()
  })

  it('persists cliSessionId as resumeSessionId in pane content when sessionInit arrives', () => {
    const store = makeStore()
    const pane: AgentChatPaneContent = {
      kind: 'agent-chat', provider: 'freshclaude',
      createRequestId: 'req-1',
      sessionId: 'sdk-sess-1',
      status: 'starting',
    }

    // Initialize the pane layout so updatePaneContent can find it
    store.dispatch(initLayout({ tabId: 't1', content: pane, paneId: 'p1' }))

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={pane} />
      </Provider>,
    )

    // Simulate sdk.session.init arriving with the Claude Code CLI session ID
    act(() => {
      store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sdk-sess-1' }))
      store.dispatch(sessionInit({
        sessionId: 'sdk-sess-1',
        cliSessionId: 'cli-session-abc-123',
        model: 'claude-opus-4-6',
      }))
    })

    // Pane content should now have resumeSessionId persisted
    const content = getPaneContent(store, 't1', 'p1')
    expect(content?.resumeSessionId).toBe('cli-session-abc-123')
  })

  it('auto-resets pane on restore timeout to create a new session', () => {
    vi.useFakeTimers()
    const store = makeStore()
    const pane: AgentChatPaneContent = {
      kind: 'agent-chat', provider: 'freshclaude',
      createRequestId: 'req-stale',
      sessionId: 'dead-session-id',
      status: 'idle',
      resumeSessionId: 'cli-session-to-resume',
    }

    // Initialize pane layout
    store.dispatch(initLayout({ tabId: 't1', content: pane, paneId: 'p1' }))

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={pane} />
      </Provider>,
    )

    // Initially shows restoring
    expect(screen.getByText(/restoring/i)).toBeInTheDocument()

    // Advance past the 5-second timeout
    act(() => { vi.advanceTimersByTime(5_000) })

    // Pane content should be reset for creating a new session
    const content = getPaneContent(store, 't1', 'p1')
    expect(content).toBeDefined()
    expect(content!.sessionId).toBeUndefined()
    expect(content!.status).toBe('creating')
    expect(content!.createRequestId).not.toBe('req-stale')
    // resumeSessionId should be preserved so the new session resumes the old CLI session
    expect(content!.resumeSessionId).toBe('cli-session-to-resume')
  })

  it('sends sdk.create with resumeSessionId after recovery reset', () => {
    vi.useFakeTimers()
    const store = makeStore()
    const pane: AgentChatPaneContent = {
      kind: 'agent-chat', provider: 'freshclaude',
      createRequestId: 'req-stale',
      sessionId: 'dead-session-id',
      status: 'idle',
      resumeSessionId: 'cli-session-to-resume',
    }

    store.dispatch(initLayout({ tabId: 't1', content: pane, paneId: 'p1' }))

    // Wrapper that reads pane content from the store via useSelector, simulating the real parent.
    // Re-renders when the store changes (unlike getPaneContent which is a plain function).
    function Wrapper() {
      const root = useSelector((s: ReturnType<typeof store.getState>) => s.panes.layouts['t1'])
      const content = root?.type === 'leaf' && root.content.kind === 'agent-chat'
        ? root.content
        : undefined
      if (!content) return null
      return <AgentChatView tabId="t1" paneId="p1" paneContent={content} />
    }

    render(
      <Provider store={store}>
        <Wrapper />
      </Provider>,
    )

    wsSend.mockClear()

    // Advance past timeout to trigger recovery
    act(() => { vi.advanceTimersByTime(5_000) })

    // Should have sent sdk.create with the resumeSessionId
    const createCalls = wsSend.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'sdk.create',
    )
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0][0].resumeSessionId).toBe('cli-session-to-resume')
  })
})
