import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import ClaudeChatView from '@/components/claude-chat/ClaudeChatView'
import claudeChatReducer, { replayHistory, sessionCreated, setSessionStatus } from '@/store/claudeChatSlice'
import panesReducer from '@/store/panesSlice'
import type { ClaudeChatPaneContent } from '@/store/paneTypes'

// jsdom doesn't implement scrollIntoView
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

const wsSend = vi.fn()

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsSend,
    onReconnect: vi.fn(() => vi.fn()),
  }),
}))

function makeStore() {
  return configureStore({
    reducer: {
      claudeChat: claudeChatReducer,
      panes: panesReducer,
    },
  })
}

const RELOAD_PANE: ClaudeChatPaneContent = {
  kind: 'claude-chat',
  createRequestId: 'req-1',
  sessionId: 'sess-reload-1',
  status: 'idle',
}

describe('ClaudeChatView reload/restore behavior', () => {
  afterEach(() => {
    cleanup()
    wsSend.mockClear()
  })

  it('sends sdk.attach on mount when paneContent has a persisted sessionId', () => {
    const store = makeStore()
    render(
      <Provider store={store}>
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    expect(wsSend).toHaveBeenCalledWith({
      type: 'sdk.attach',
      sessionId: 'sess-reload-1',
    })
  })

  it('does NOT send sdk.attach when paneContent has no sessionId (new session)', () => {
    const store = makeStore()
    const newPane: ClaudeChatPaneContent = {
      kind: 'claude-chat',
      createRequestId: 'req-new',
      status: 'creating',
    }
    render(
      <Provider store={store}>
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={newPane} />
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
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    // Should NOT show the freshclaude welcome text
    expect(screen.queryByText('freshclaude')).not.toBeInTheDocument()

    // Should show a restoring/loading indicator
    expect(screen.getByText(/restoring/i)).toBeInTheDocument()
  })

  it('shows welcome screen when no sessionId (brand new session)', () => {
    const store = makeStore()
    const newPane: ClaudeChatPaneContent = {
      kind: 'claude-chat',
      createRequestId: 'req-new',
      status: 'creating',
    }
    render(
      <Provider store={store}>
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={newPane} />
      </Provider>,
    )

    expect(screen.getByText('freshclaude')).toBeInTheDocument()
  })

  it('replaces loading state with messages after replayHistory arrives', () => {
    const store = makeStore()
    const { rerender } = render(
      <Provider store={store}>
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    // Initially shows loading
    expect(screen.queryByText('freshclaude')).not.toBeInTheDocument()
    expect(screen.getByText(/restoring/i)).toBeInTheDocument()

    // Simulate server sending sdk.history
    store.dispatch(replayHistory({
      sessionId: 'sess-reload-1',
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Hello Claude' }],
          timestamp: '2026-01-01T00:00:00Z',
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello! How can I help?' }],
          timestamp: '2026-01-01T00:00:01Z',
        },
      ],
    }))

    // Force re-render to pick up store changes
    rerender(
      <Provider store={store}>
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    // Loading should be gone
    expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()

    // Messages should be visible
    expect(screen.getByText('Hello Claude')).toBeInTheDocument()
    expect(screen.getByText('Hello! How can I help?')).toBeInTheDocument()
  })

  it('shows welcome screen (not restoring) for freshly created session with sessionId', () => {
    const store = makeStore()
    // Simulate sdk.created — Redux now has the session object
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-fresh' }))

    const freshPane: ClaudeChatPaneContent = {
      kind: 'claude-chat',
      createRequestId: 'req-1',
      sessionId: 'sess-fresh',
      status: 'starting',
    }
    render(
      <Provider store={store}>
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={freshPane} />
      </Provider>,
    )

    // Should show welcome, NOT "Restoring session..."
    expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()
    expect(screen.getByText('freshclaude')).toBeInTheDocument()
  })

  it('shows welcome screen (not stuck restoring) when replayHistory arrives with empty messages', () => {
    const store = makeStore()
    const { rerender } = render(
      <Provider store={store}>
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    // Initially shows restoring
    expect(screen.getByText(/restoring/i)).toBeInTheDocument()

    // Server sends sdk.history with no messages (empty session)
    store.dispatch(replayHistory({
      sessionId: 'sess-reload-1',
      messages: [],
    }))

    rerender(
      <Provider store={store}>
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    // Should NOT be stuck on restoring
    expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()

    // Should show the welcome screen since session is empty
    expect(screen.getByText('freshclaude')).toBeInTheDocument()
  })

  it('stays in restoring state when setSessionStatus arrives before replayHistory (race condition)', () => {
    const store = makeStore()
    // Simulate sdk.status arriving before sdk.history — creates session via ensureSession
    // but without historyLoaded flag
    store.dispatch(setSessionStatus({ sessionId: 'sess-reload-1', status: 'idle' }))

    const { rerender } = render(
      <Provider store={store}>
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    // Session exists in Redux but historyLoaded is not set — should still show restoring
    expect(screen.getByText(/restoring/i)).toBeInTheDocument()
    expect(screen.queryByText('freshclaude')).not.toBeInTheDocument()

    // Now sdk.history arrives
    store.dispatch(replayHistory({
      sessionId: 'sess-reload-1',
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Hello' }],
          timestamp: '2026-01-01T00:00:00Z',
        },
      ],
    }))

    rerender(
      <Provider store={store}>
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    // Now restoring should be done, messages visible
    expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()
    expect(screen.getByText('Hello')).toBeInTheDocument()
  })

  it('reactively updates when replayHistory fires (no manual rerender)', async () => {
    const store = makeStore()
    render(
      <Provider store={store}>
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    // Initially shows restoring
    expect(screen.getByText(/restoring/i)).toBeInTheDocument()

    // Dispatch replayHistory — the component should re-render via Redux subscription
    // WITHOUT requiring an explicit rerender() call
    act(() => {
      store.dispatch(replayHistory({
        sessionId: 'sess-reload-1',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Reactive test message' }],
            timestamp: '2026-01-01T00:00:00Z',
          },
        ],
      }))
    })

    // Messages should be visible without manual rerender
    expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()
    expect(screen.getByText('Reactive test message')).toBeInTheDocument()
  })

  it('reactively updates when sdk.history + sdk.status arrive back-to-back (production flow)', () => {
    const store = makeStore()
    render(
      <Provider store={store}>
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    // Initially shows restoring
    expect(screen.getByText(/restoring/i)).toBeInTheDocument()

    // Simulate the real server response: sdk.history then sdk.status arrive back-to-back
    // Both are dispatched synchronously in the same event loop tick (as they would be
    // when two WS messages arrive in rapid succession)
    act(() => {
      store.dispatch(replayHistory({
        sessionId: 'sess-reload-1',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Back-to-back test' }],
            timestamp: '2026-01-01T00:00:00Z',
          },
        ],
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

  it('reactively updates when sdk.history and sdk.status arrive in separate event loop ticks', () => {
    const store = makeStore()
    render(
      <Provider store={store}>
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    // Initially shows restoring
    expect(screen.getByText(/restoring/i)).toBeInTheDocument()

    // sdk.history arrives first (separate event loop tick)
    act(() => {
      store.dispatch(replayHistory({
        sessionId: 'sess-reload-1',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Separate tick test' }],
            timestamp: '2026-01-01T00:00:00Z',
          },
        ],
      }))
    })

    // After first dispatch, messages should already be visible
    expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()
    expect(screen.getByText('Separate tick test')).toBeInTheDocument()

    // sdk.status arrives in a separate tick
    act(() => {
      store.dispatch(setSessionStatus({
        sessionId: 'sess-reload-1',
        status: 'idle',
      }))
    })

    // Messages should still be visible after status update
    expect(screen.getByText('Separate tick test')).toBeInTheDocument()
  })

  it('falls back to welcome screen after restore timeout (stale sessionId)', () => {
    vi.useFakeTimers()
    const store = makeStore()
    render(
      <Provider store={store}>
        <ClaudeChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
      </Provider>,
    )

    // Initially shows restoring
    expect(screen.getByText(/restoring/i)).toBeInTheDocument()
    expect(screen.queryByText('freshclaude')).not.toBeInTheDocument()

    // Advance past the 5-second timeout
    act(() => { vi.advanceTimersByTime(5_000) })

    // Should fall back to welcome screen
    expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()
    expect(screen.getByText('freshclaude')).toBeInTheDocument()

    vi.useRealTimers()
  })
})
