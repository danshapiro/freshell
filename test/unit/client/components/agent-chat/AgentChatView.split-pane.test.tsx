/**
 * Tests for Bug 2: splitting a connected freshclaude pane causes the original
 * pane to get stuck in "Starting Claude Code..." / "Waiting for connection".
 *
 * The split operation causes the pane tree to restructure, which in React terms
 * means the original AgentChatView is unmounted and a new one is mounted for
 * the same pane ID. This test simulates that unmount/remount cycle with
 * realistic Redux state and verifies the pane recovers correctly.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider, useSelector } from 'react-redux'
import AgentChatView from '@/components/agent-chat/AgentChatView'
import agentChatReducer, {
  sessionCreated,
  sessionInit,
  setSessionStatus,
  replayHistory,
} from '@/store/agentChatSlice'
import panesReducer, { initLayout, addPane } from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
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
      settings: settingsReducer,
    },
  })
}

/** Walk the pane tree and find a leaf by ID */
function findLeaf(node: PaneNode, paneId: string): Extract<PaneNode, { type: 'leaf' }> | null {
  if (node.type === 'leaf') return node.id === paneId ? node : null
  return findLeaf(node.children[0], paneId) || findLeaf(node.children[1], paneId)
}

/** Read pane content from the store for a given tab/pane ID. */
function getPaneContent(store: ReturnType<typeof makeStore>, tabId: string, paneId: string): AgentChatPaneContent | undefined {
  const root = store.getState().panes.layouts[tabId]
  if (!root) return undefined
  const leaf = findLeaf(root, paneId)
  if (leaf && leaf.content.kind === 'agent-chat') return leaf.content
  return undefined
}

/**
 * Wrapper that reads pane content reactively from the store,
 * simulating how PaneContainer passes content to AgentChatView.
 */
function ReactiveWrapper({ store, tabId, paneId }: {
  store: ReturnType<typeof makeStore>
  tabId: string
  paneId: string
}) {
  const content = useSelector((s: ReturnType<typeof store.getState>) => {
    const root = s.panes.layouts[tabId]
    if (!root) return undefined
    const leaf = findLeaf(root, paneId)
    return leaf?.content.kind === 'agent-chat' ? leaf.content : undefined
  })
  if (!content) return <div data-testid="no-content">No content</div>
  return <AgentChatView tabId={tabId} paneId={paneId} paneContent={content} />
}

describe('AgentChatView — split pane (Bug 2)', () => {
  afterEach(() => {
    cleanup()
    wsSend.mockClear()
    vi.useRealTimers()
  })

  it('connected pane stays connected after unmount/remount (simulated split)', () => {
    const store = makeStore()

    // Set up a fully connected freshclaude pane
    const pane: AgentChatPaneContent = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-1',
      sessionId: 'sess-1',
      status: 'connected',
      resumeSessionId: 'cli-abc',
    }

    // Pre-populate the Redux agentChat session
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(sessionInit({
      sessionId: 'sess-1',
      cliSessionId: 'cli-abc',
      model: 'claude-opus-4-6',
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'connected' }))

    // Initialize pane layout
    store.dispatch(initLayout({ tabId: 't1', content: pane, paneId: 'p1' }))

    // First render — connected and interactive
    const { unmount } = render(
      <Provider store={store}>
        <ReactiveWrapper store={store} tabId="t1" paneId="p1" />
      </Provider>,
    )

    expect(screen.getByText('Connected')).toBeInTheDocument()
    expect(screen.getByRole('textbox')).not.toBeDisabled()

    // Simulate split: unmount + remount (React tears down the old component tree)
    unmount()
    wsSend.mockClear()

    render(
      <Provider store={store}>
        <ReactiveWrapper store={store} tabId="t1" paneId="p1" />
      </Provider>,
    )

    // After remount, the pane should still show "Connected"
    expect(screen.getByText('Connected')).toBeInTheDocument()
    // Composer should be interactive (not "Waiting for connection...")
    expect(screen.getByRole('textbox')).not.toBeDisabled()

    // Should have sent sdk.attach to re-subscribe
    const attachCalls = wsSend.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'sdk.attach',
    )
    expect(attachCalls).toHaveLength(1)
    expect(attachCalls[0][0].sessionId).toBe('sess-1')

    // Should NOT have sent sdk.create
    const createCalls = wsSend.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'sdk.create',
    )
    expect(createCalls).toHaveLength(0)
  })

  it('idle pane stays idle after unmount/remount', () => {
    const store = makeStore()

    const pane: AgentChatPaneContent = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-1',
      sessionId: 'sess-1',
      status: 'idle',
      resumeSessionId: 'cli-abc',
    }

    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(sessionInit({
      sessionId: 'sess-1',
      cliSessionId: 'cli-abc',
      model: 'claude-opus-4-6',
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))

    store.dispatch(initLayout({ tabId: 't1', content: pane, paneId: 'p1' }))

    const { unmount } = render(
      <Provider store={store}>
        <ReactiveWrapper store={store} tabId="t1" paneId="p1" />
      </Provider>,
    )

    expect(screen.getByText('Ready')).toBeInTheDocument()

    unmount()
    wsSend.mockClear()

    render(
      <Provider store={store}>
        <ReactiveWrapper store={store} tabId="t1" paneId="p1" />
      </Provider>,
    )

    // Should still show "Ready" (idle status)
    expect(screen.getByText('Ready')).toBeInTheDocument()
    expect(screen.getByRole('textbox')).not.toBeDisabled()
  })

  it('pane recovers when server replies to sdk.attach with updated status', async () => {
    const store = makeStore()

    // Pane thinks it's connected, but server might respond differently
    const pane: AgentChatPaneContent = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-1',
      sessionId: 'sess-1',
      status: 'connected',
      resumeSessionId: 'cli-abc',
    }

    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(sessionInit({
      sessionId: 'sess-1',
      cliSessionId: 'cli-abc',
      model: 'claude-opus-4-6',
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'connected' }))

    store.dispatch(initLayout({ tabId: 't1', content: pane, paneId: 'p1' }))

    const { unmount } = render(
      <Provider store={store}>
        <ReactiveWrapper store={store} tabId="t1" paneId="p1" />
      </Provider>,
    )

    // Simulate split
    unmount()
    wsSend.mockClear()

    render(
      <Provider store={store}>
        <ReactiveWrapper store={store} tabId="t1" paneId="p1" />
      </Provider>,
    )

    // Simulate server response to sdk.attach: sdk.history + sdk.status
    act(() => {
      store.dispatch(replayHistory({
        sessionId: 'sess-1',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      }))
      store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))
    })

    // Status should update to "Ready" (idle), the pane content should reflect this
    expect(screen.getByText('Ready')).toBeInTheDocument()
    const content = getPaneContent(store, 't1', 'p1')
    expect(content!.status).toBe('idle')
  })

  it('handles the full addPane flow: connected pane survives tree restructuring', () => {
    const store = makeStore()

    const pane: AgentChatPaneContent = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-1',
      sessionId: 'sess-1',
      status: 'idle',
      resumeSessionId: 'cli-abc',
    }

    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(sessionInit({
      sessionId: 'sess-1',
      cliSessionId: 'cli-abc',
      model: 'claude-opus-4-6',
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))

    store.dispatch(initLayout({ tabId: 't1', content: pane, paneId: 'p1' }))

    // Render the reactive wrapper — this simulates PaneContainer's behavior
    const { rerender } = render(
      <Provider store={store}>
        <ReactiveWrapper store={store} tabId="t1" paneId="p1" />
      </Provider>,
    )

    expect(screen.getByText('Ready')).toBeInTheDocument()
    wsSend.mockClear()

    // Dispatch addPane — this restructures the tree from leaf to split
    act(() => {
      store.dispatch(addPane({
        tabId: 't1',
        newContent: { kind: 'picker' },
      }))
    })

    // Verify the tree was restructured
    const root = store.getState().panes.layouts['t1']
    expect(root!.type).toBe('split')

    // Verify original pane content is preserved in the new tree
    const content = getPaneContent(store, 't1', 'p1')
    expect(content).toBeDefined()
    expect(content!.sessionId).toBe('sess-1')
    expect(content!.status).toBe('idle')

    // Force re-render to pick up the tree change
    rerender(
      <Provider store={store}>
        <ReactiveWrapper store={store} tabId="t1" paneId="p1" />
      </Provider>,
    )

    // The pane should still show "Ready"
    expect(screen.getByText('Ready')).toBeInTheDocument()
    expect(screen.getByRole('textbox')).not.toBeDisabled()
  })

  it('does not regress from connected to starting when server reports stale status', () => {
    const store = makeStore()

    const pane: AgentChatPaneContent = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-1',
      sessionId: 'sess-1',
      status: 'connected',
      resumeSessionId: 'cli-abc',
    }

    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(sessionInit({
      sessionId: 'sess-1',
      cliSessionId: 'cli-abc',
      model: 'claude-opus-4-6',
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'connected' }))

    store.dispatch(initLayout({ tabId: 't1', content: pane, paneId: 'p1' }))

    // Simulate unmount/remount (split)
    const { unmount } = render(
      <Provider store={store}>
        <ReactiveWrapper store={store} tabId="t1" paneId="p1" />
      </Provider>,
    )

    expect(screen.getByText('Connected')).toBeInTheDocument()
    unmount()

    render(
      <Provider store={store}>
        <ReactiveWrapper store={store} tabId="t1" paneId="p1" />
      </Provider>,
    )

    // Simulate server responding to sdk.attach with stale 'starting' status
    // (server hasn't received system.init yet even though client got preliminary sdk.session.init)
    act(() => {
      store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'starting' }))
    })

    // Status should NOT regress — should still show "Connected"
    expect(screen.getByText('Connected')).toBeInTheDocument()
    const content = getPaneContent(store, 't1', 'p1')
    expect(content!.status).toBe('connected')
  })

  it('does not regress from idle to starting when server reports stale status', () => {
    const store = makeStore()

    const pane: AgentChatPaneContent = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-1',
      sessionId: 'sess-1',
      status: 'idle',
    }

    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(sessionInit({
      sessionId: 'sess-1',
      cliSessionId: 'cli-abc',
      model: 'claude-opus-4-6',
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))

    store.dispatch(initLayout({ tabId: 't1', content: pane, paneId: 'p1' }))

    render(
      <Provider store={store}>
        <ReactiveWrapper store={store} tabId="t1" paneId="p1" />
      </Provider>,
    )

    // Simulate stale status from server
    act(() => {
      store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'starting' }))
    })

    // Should not regress
    expect(screen.getByText('Ready')).toBeInTheDocument()
    expect(getPaneContent(store, 't1', 'p1')!.status).toBe('idle')
  })

  it('allows forward status transitions (starting -> connected -> idle)', () => {
    const store = makeStore()

    const pane: AgentChatPaneContent = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-1',
      sessionId: 'sess-1',
      status: 'starting',
    }

    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))

    store.dispatch(initLayout({ tabId: 't1', content: pane, paneId: 'p1' }))

    render(
      <Provider store={store}>
        <ReactiveWrapper store={store} tabId="t1" paneId="p1" />
      </Provider>,
    )

    // Forward: starting -> connected
    act(() => {
      store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'connected' }))
    })
    expect(screen.getByText('Connected')).toBeInTheDocument()
    expect(getPaneContent(store, 't1', 'p1')!.status).toBe('connected')

    // Forward: connected -> idle
    act(() => {
      store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))
    })
    expect(screen.getByText('Ready')).toBeInTheDocument()
    expect(getPaneContent(store, 't1', 'p1')!.status).toBe('idle')
  })

  it('allows running -> idle transition (normal turn completion cycle)', () => {
    const store = makeStore()

    const pane: AgentChatPaneContent = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-1',
      sessionId: 'sess-1',
      status: 'idle',
      resumeSessionId: 'cli-abc',
    }

    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(sessionInit({
      sessionId: 'sess-1',
      cliSessionId: 'cli-abc',
      model: 'claude-opus-4-6',
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))

    store.dispatch(initLayout({ tabId: 't1', content: pane, paneId: 'p1' }))

    render(
      <Provider store={store}>
        <ReactiveWrapper store={store} tabId="t1" paneId="p1" />
      </Provider>,
    )

    expect(screen.getByText('Ready')).toBeInTheDocument()

    // idle -> running (user sends a message)
    act(() => {
      store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'running' }))
    })
    expect(getPaneContent(store, 't1', 'p1')!.status).toBe('running')

    // running -> idle (turn completes)
    act(() => {
      store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))
    })
    expect(screen.getByText('Ready')).toBeInTheDocument()
    expect(getPaneContent(store, 't1', 'p1')!.status).toBe('idle')

    // running -> starting should still be blocked
    act(() => {
      store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'running' }))
    })
    act(() => {
      store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'starting' }))
    })
    // Should NOT regress to starting
    expect(getPaneContent(store, 't1', 'p1')!.status).toBe('running')
  })
})
