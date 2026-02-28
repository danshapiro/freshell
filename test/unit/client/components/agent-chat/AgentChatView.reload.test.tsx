import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider, useSelector } from 'react-redux'
import AgentChatView from '@/components/agent-chat/AgentChatView'
import agentChatReducer, { replayHistory, sessionCreated, sessionInit, setSessionStatus } from '@/store/agentChatSlice'
import panesReducer, { initLayout } from '@/store/panesSlice'
import type { AgentChatPaneContent } from '@/store/paneTypes'
import type { PaneNode } from '@/store/paneTypes'

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
      agentChat: agentChatReducer,
      panes: panesReducer,
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
  afterEach(() => {
    cleanup()
    wsSend.mockClear()
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

    // Should NOT show the freshclaude welcome text
    expect(screen.queryByText('freshclaude')).not.toBeInTheDocument()

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

    expect(screen.getByText('freshclaude')).toBeInTheDocument()
  })

  it('replaces loading state with messages after replayHistory arrives', () => {
    const store = makeStore()
    const { rerender } = render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
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
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
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
    expect(screen.getByText('freshclaude')).toBeInTheDocument()
  })

  it('shows welcome screen (not stuck restoring) when replayHistory arrives with empty messages', () => {
    const store = makeStore()
    const { rerender } = render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
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
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
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
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
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
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
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
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
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
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
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
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
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
        <AgentChatView tabId="t1" paneId="p1" paneContent={RELOAD_PANE} />
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

/** Read pane content from the store for a given tab/pane ID. */
function getPaneContent(store: ReturnType<typeof makeStore>, tabId: string, paneId: string): AgentChatPaneContent | undefined {
  const root = store.getState().panes.layouts[tabId]
  if (!root) return undefined
  function find(node: PaneNode): AgentChatPaneContent | undefined {
    if (node.type === 'leaf' && node.id === paneId && node.content.kind === 'claude-chat') {
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
      const content = root?.type === 'leaf' && root.content.kind === 'claude-chat'
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
