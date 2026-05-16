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
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider, useSelector } from 'react-redux'
import AgentChatView from '@/components/agent-chat/AgentChatView'
import agentChatReducer, {
  sessionCreated,
  sessionInit,
  sessionSnapshotReceived,
  setSessionStatus,
  timelinePageReceived,
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

function makeTimelineItem(
  turnId: string,
  role: 'user' | 'assistant',
  summary: string,
  overrides: Partial<{
    sessionId: string
    messageId: string
    ordinal: number
    source: 'durable' | 'live'
    timestamp: string
  }> = {},
) {
  return {
    turnId,
    messageId: overrides.messageId ?? `message:${turnId}`,
    ordinal: overrides.ordinal ?? 0,
    source: overrides.source ?? 'durable',
    sessionId: overrides.sessionId ?? 'cli-abc',
    role,
    summary,
    ...(overrides.timestamp ? { timestamp: overrides.timestamp } : {}),
  }
}

function makeTimelineTurn(
  turnId: string,
  role: 'user' | 'assistant',
  text: string,
  overrides: Partial<{
    sessionId: string
    messageId: string
    ordinal: number
    source: 'durable' | 'live'
    timestamp: string
  }> = {},
) {
  return {
    sessionId: overrides.sessionId ?? 'cli-abc',
    turnId,
    messageId: overrides.messageId ?? `message:${turnId}`,
    ordinal: overrides.ordinal ?? 0,
    source: overrides.source ?? 'durable',
    message: {
      role,
      content: [{ type: 'text' as const, text }],
      timestamp: overrides.timestamp ?? '2026-03-10T10:01:00.000Z',
    },
  }
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
    getAgentTimelinePage.mockReset()
    getAgentTurnBody.mockReset()
    setSessionMetadata.mockClear()
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

    // Simulate server response to sdk.attach: sdk.session.snapshot + timeline hydration + sdk.status
    act(() => {
      store.dispatch(sessionSnapshotReceived({
        sessionId: 'sess-1',
        latestTurnId: null,
        status: 'connected',
      }))
      store.dispatch(timelinePageReceived({
        sessionId: 'sess-1',
        items: [],
        nextCursor: null,
        revision: 1,
        replace: true,
      }))
      store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))
    })

    // Status should update to "Ready" (idle), the pane content should reflect this
    expect(screen.getByText('Ready')).toBeInTheDocument()
    const content = getPaneContent(store, 't1', 'p1')
    expect(content!.status).toBe('idle')
  })

  it('restores a split-pane remount from sdk.session.snapshot plus HTTP timeline hydration', async () => {
    const store = makeStore()

    const pane: AgentChatPaneContent = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-1',
      sessionId: 'sess-1',
      status: 'idle',
      resumeSessionId: 'cli-abc',
    }

    store.dispatch(sessionInit({
      sessionId: 'sess-1',
      cliSessionId: 'cli-abc',
      model: 'claude-opus-4-6',
    }))
    store.dispatch(sessionSnapshotReceived({
      sessionId: 'sess-1',
      latestTurnId: 'turn-2',
      status: 'idle',
      revision: 2,
    }))
    store.dispatch(initLayout({ tabId: 't1', content: pane, paneId: 'p1' }))

    getAgentTimelinePage.mockResolvedValue({
      sessionId: 'cli-abc',
      items: [
        makeTimelineItem('turn-2', 'assistant', 'Split-pane summary', {
          sessionId: 'cli-abc',
          ordinal: 2,
          timestamp: '2026-03-10T10:01:00.000Z',
        }),
      ],
      nextCursor: null,
      revision: 2,
      bodies: {
        'turn-2': makeTimelineTurn('turn-2', 'assistant', 'Hydrated split-pane turn', {
          sessionId: 'cli-abc',
          ordinal: 2,
          timestamp: '2026-03-10T10:01:00.000Z',
        }),
      },
    })

    const { unmount } = render(
      <Provider store={store}>
        <ReactiveWrapper store={store} tabId="t1" paneId="p1" />
      </Provider>,
    )

    unmount()
    wsSend.mockClear()
    getAgentTimelinePage.mockClear()
    getAgentTurnBody.mockClear()

    render(
      <Provider store={store}>
        <ReactiveWrapper store={store} tabId="t1" paneId="p1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(getAgentTimelinePage).toHaveBeenCalledWith(
        'cli-abc',
        expect.objectContaining({ priority: 'visible', includeBodies: true, revision: 2 }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    })
    expect(getAgentTurnBody).not.toHaveBeenCalled()
    expect(await screen.findByText('Hydrated split-pane turn')).toBeInTheDocument()
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

  it('expands older turns by fetching bodies on demand after a split-pane remount', async () => {
    const store = makeStore()

    const pane: AgentChatPaneContent = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-1',
      sessionId: 'sess-1',
      status: 'idle',
      resumeSessionId: 'cli-abc',
    }

    getAgentTimelinePage.mockResolvedValue({
      sessionId: 'cli-abc',
      items: [
        makeTimelineItem('turn-3', 'assistant', 'Newest visible turn', {
          sessionId: 'cli-abc',
          ordinal: 3,
          timestamp: '2026-03-10T10:02:00.000Z',
        }),
        makeTimelineItem('turn-2', 'assistant', 'Older collapsed summary', {
          sessionId: 'cli-abc',
          ordinal: 2,
          timestamp: '2026-03-10T10:01:00.000Z',
        }),
      ],
      nextCursor: null,
      revision: 2,
      bodies: {
        'turn-3': makeTimelineTurn('turn-3', 'assistant', 'Newest visible turn body', {
          sessionId: 'cli-abc',
          ordinal: 3,
          timestamp: '2026-03-10T10:02:00.000Z',
        }),
      },
    })
    getAgentTurnBody.mockImplementation(async (_sessionId: string, turnId: string) => {
      return {
        sessionId: 'cli-abc',
        turnId,
        messageId: `message:${turnId}`,
        ordinal: 2,
        source: 'durable' as const,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Expanded older turn body' }],
          timestamp: '2026-03-10T10:01:00.000Z',
        },
      }
    })

    store.dispatch(sessionInit({
      sessionId: 'sess-1',
      cliSessionId: 'cli-abc',
      model: 'claude-opus-4-6',
    }))
    store.dispatch(sessionSnapshotReceived({
      sessionId: 'sess-1',
      latestTurnId: 'turn-3',
      status: 'idle',
      revision: 2,
    }))
    store.dispatch(initLayout({ tabId: 't1', content: pane, paneId: 'p1' }))

    const { unmount } = render(
      <Provider store={store}>
        <ReactiveWrapper store={store} tabId="t1" paneId="p1" />
      </Provider>,
    )
    unmount()

    render(
      <Provider store={store}>
        <ReactiveWrapper store={store} tabId="t1" paneId="p1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(getAgentTimelinePage).toHaveBeenCalledWith(
        'cli-abc',
        expect.objectContaining({ priority: 'visible', includeBodies: true, revision: 2 }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    })

    expect(await screen.findByText('Newest visible turn body')).toBeInTheDocument()

    const olderTurnToggle = await screen.findByRole('button', { name: 'Expand turn' })
    expect(screen.getByText('Older collapsed summary')).toBeInTheDocument()
    fireEvent.click(olderTurnToggle)

    await waitFor(() => {
      expect(getAgentTurnBody).toHaveBeenCalledWith(
        'cli-abc',
        'turn-2',
        expect.objectContaining({ signal: expect.any(AbortSignal), revision: 2 }),
      )
    })
    expect(await screen.findByText('Expanded older turn body')).toBeInTheDocument()
  })

  it('skips sdk.attach and preserves content on split when session is fully hydrated', async () => {
    const store = makeStore()

    const pane: AgentChatPaneContent = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-1',
      sessionId: 'sess-1',
      status: 'idle',
      resumeSessionId: 'cli-abc',
    }

    // Build a fully-hydrated session: snapshot + timeline page received
    store.dispatch(sessionInit({
      sessionId: 'sess-1',
      cliSessionId: 'cli-abc',
      model: 'claude-opus-4-6',
    }))
    store.dispatch(sessionSnapshotReceived({
      sessionId: 'sess-1',
      latestTurnId: 'turn-1',
      status: 'idle',
      revision: 3,
    }))
    store.dispatch(timelinePageReceived({
      sessionId: 'sess-1',
      items: [
        makeTimelineItem('turn-1', 'assistant', 'Hello from Claude', {
          sessionId: 'cli-abc',
          ordinal: 1,
          timestamp: '2026-03-10T10:00:00.000Z',
        }),
      ],
      nextCursor: null,
      revision: 3,
      replace: true,
      bodies: {
        'turn-1': makeTimelineTurn('turn-1', 'assistant', 'Hello from Claude — full body', {
          sessionId: 'cli-abc',
          ordinal: 1,
          timestamp: '2026-03-10T10:00:00.000Z',
        }),
      },
    }))
    store.dispatch(initLayout({ tabId: 't1', content: pane, paneId: 'p1' }))

    // Verify historyLoaded is true before the test
    expect(store.getState().agentChat.sessions['sess-1']!.historyLoaded).toBe(true)

    // First render — fully loaded, content visible
    const { unmount } = render(
      <Provider store={store}>
        <ReactiveWrapper store={store} tabId="t1" paneId="p1" />
      </Provider>,
    )
    expect(await screen.findByText('Hello from Claude — full body')).toBeInTheDocument()

    // Simulate split: unmount + remount
    unmount()
    wsSend.mockClear()
    getAgentTimelinePage.mockClear()

    render(
      <Provider store={store}>
        <ReactiveWrapper store={store} tabId="t1" paneId="p1" />
      </Provider>,
    )

    // Content should still be visible immediately — no "Restoring session..." flash
    expect(screen.getByText('Hello from Claude — full body')).toBeInTheDocument()
    expect(screen.queryByText('Restoring session...')).not.toBeInTheDocument()

    // Should NOT have sent sdk.attach (session already hydrated, WS subscription persists)
    const attachCalls = wsSend.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'sdk.attach',
    )
    expect(attachCalls).toHaveLength(0)

    // Should NOT have re-fetched timeline (historyLoaded is still true)
    expect(getAgentTimelinePage).not.toHaveBeenCalled()

    // Should NOT have sent sdk.create
    const createCalls = wsSend.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'sdk.create',
    )
    expect(createCalls).toHaveLength(0)
  })

  it('still sends sdk.attach after page refresh when session is not in Redux', () => {
    const store = makeStore()

    // After a page refresh, pane content has sessionId but Redux session state is empty.
    // The session is NOT in agentChat.sessions, so historyLoaded is undefined.
    const pane: AgentChatPaneContent = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-1',
      sessionId: 'sess-1',
      status: 'connected',
      resumeSessionId: 'cli-abc',
    }

    store.dispatch(initLayout({ tabId: 't1', content: pane, paneId: 'p1' }))

    // No session state dispatched — simulates post-refresh state
    expect(store.getState().agentChat.sessions['sess-1']).toBeUndefined()

    render(
      <Provider store={store}>
        <ReactiveWrapper store={store} tabId="t1" paneId="p1" />
      </Provider>,
    )

    // Should have sent sdk.attach since session is not hydrated
    const attachCalls = wsSend.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'sdk.attach',
    )
    expect(attachCalls).toHaveLength(1)
    expect(attachCalls[0][0].sessionId).toBe('sess-1')
  })
})
