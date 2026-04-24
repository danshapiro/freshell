import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider, useSelector } from 'react-redux'
import AgentChatView from '@/components/agent-chat/AgentChatView'
import agentChatReducer, { markSessionLost, sessionCreated, sessionInit, sessionSnapshotReceived, setSessionStatus } from '@/store/agentChatSlice'
import panesReducer, { initLayout } from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
import type { AgentChatPaneContent } from '@/store/paneTypes'
import type { PaneNode } from '@/store/paneTypes'
import { buildRestoreError } from '@shared/session-contract'

// jsdom doesn't implement scrollIntoView
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

const wsSend = vi.fn()
const getAgentTimelinePage = vi.fn()
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

describe('AgentChatView — immediate recovery when session is lost', () => {
  afterEach(() => {
    cleanup()
    wsSend.mockClear()
    getAgentTimelinePage.mockReset()
    setSessionMetadata.mockClear()
    vi.useRealTimers()
  })

  it('does not restart from a mutable named resume token when session is marked as lost', async () => {
    const store = makeStore()
    const pane: AgentChatPaneContent = {
      kind: 'agent-chat', provider: 'freshclaude',
      createRequestId: 'req-stale',
      sessionId: 'dead-session-id',
      status: 'idle',
      resumeSessionId: 'cli-session-to-resume',
    }

    store.dispatch(initLayout({ tabId: 't1', content: pane, paneId: 'p1' }))

    // Use a wrapper that reads pane content reactively from the store
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

    // Initially shows restoring (sessionId exists but no session in Redux yet)
    expect(screen.getByText(/restoring/i)).toBeInTheDocument()

    wsSend.mockClear()

    // Simulate server responding to sdk.attach with INVALID_SESSION_ID:
    // The sdk-message-handler dispatches markSessionLost which creates the
    // session entry with lost=true and historyLoaded=true.
    act(() => {
      store.dispatch(markSessionLost({ sessionId: 'dead-session-id' }))
    })

    // The dead live SDK session should be cleared, but the client must not
    // restart from a mutable named resume token once no canonical durable id exists.
    await waitFor(() => {
      const content = getPaneContent(store, 't1', 'p1')
      expect(content).toBeDefined()
      expect(content!.sessionId).toBeUndefined()
    })

    const content = getPaneContent(store, 't1', 'p1')!
    expect(content.status).toBe('idle')
    expect(content.restoreError).toEqual(buildRestoreError('dead_live_handle'))
    // The pane may still carry the original mutable name for display, but it
    // must not be used as a restore target.
    expect(content.resumeSessionId).toBe('cli-session-to-resume')
    const createCalls = wsSend.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'sdk.create',
    )
    expect(createCalls).toHaveLength(0)
  })

  it('recovers with timelineSessionId from sdk.session.snapshot even when the session is marked lost before sdk.session.init', async () => {
    const canonicalSessionId = '00000000-0000-4000-8000-000000000211'
    let resolveTimelinePage: ((value: {
      sessionId: string
      items: Array<Record<string, unknown>>
      nextCursor: null
      revision: number
      bodies: Record<string, unknown>
    }) => void) | undefined
    getAgentTimelinePage.mockImplementationOnce(() => new Promise((resolve) => {
      resolveTimelinePage = resolve
    }))

    const store = makeStore()
    const pane = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-stale',
      sessionId: 'sdk-stale-1',
      status: 'idle',
      resumeSessionId: 'named-resume',
    } satisfies AgentChatPaneContent

    store.dispatch(initLayout({ tabId: 't1', paneId: 'p1', content: pane }))

    function Wrapper() {
      const root = useSelector((s: ReturnType<typeof store.getState>) => s.panes.layouts.t1)
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

    act(() => {
      store.dispatch(sessionSnapshotReceived({
        sessionId: 'sdk-stale-1',
        latestTurnId: 'turn-2',
        status: 'idle',
        timelineSessionId: canonicalSessionId,
        revision: 2,
      }))
      store.dispatch(markSessionLost({ sessionId: 'sdk-stale-1' }))
    })

    await waitFor(() => {
      expect(getAgentTimelinePage).toHaveBeenCalledWith(
        canonicalSessionId,
        expect.objectContaining({ priority: 'visible', revision: 2, includeBodies: true }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    })

    expect(wsSend.mock.calls.some((call: any[]) => call[0]?.type === 'sdk.create')).toBe(false)

    await act(async () => {
      resolveTimelinePage?.({
        sessionId: canonicalSessionId,
        items: [
          {
            turnId: 'turn-2',
            sessionId: canonicalSessionId,
            role: 'assistant',
            summary: 'Recovered answer',
            timestamp: '2026-03-10T10:00:20.000Z',
          },
        ],
        nextCursor: null,
        revision: 2,
        bodies: {
          'turn-2': {
            sessionId: canonicalSessionId,
            turnId: 'turn-2',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Recovered durable answer' }],
              timestamp: '2026-03-10T10:00:20.000Z',
            },
          },
        },
      })
      await Promise.resolve()
    })

    await waitFor(() => {
      const createCalls = wsSend.mock.calls.filter((call: any[]) => call[0]?.type === 'sdk.create')
      expect(createCalls.at(-1)?.[0]?.resumeSessionId).toBe(canonicalSessionId)
    })
  })
})

describe('AgentChatView — remount resilience (split pane bug)', () => {
  afterEach(() => {
    cleanup()
    wsSend.mockClear()
    vi.useRealTimers()
  })

  it('does not get stuck after remount when session is already established', () => {
    const store = makeStore()
    const pane: AgentChatPaneContent = {
      kind: 'agent-chat', provider: 'freshclaude',
      createRequestId: 'req-1',
      sessionId: 'sess-1',
      status: 'idle',
    }

    // Pre-populate the Redux session as if sdk.created + sdk.session.init already happened
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(sessionInit({
      sessionId: 'sess-1',
      cliSessionId: 'cli-abc',
      model: 'claude-opus-4-6',
    }))

    store.dispatch(initLayout({ tabId: 't1', content: pane, paneId: 'p1' }))

    // First mount (simulating the original render)
    const { unmount } = render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={pane} />
      </Provider>,
    )

    // Should NOT show restoring — session is already established with historyLoaded=true
    expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()

    // Composer should be interactive (not "Waiting for connection")
    const textarea = screen.getByRole('textbox')
    expect(textarea).not.toBeDisabled()

    // Now simulate unmount + remount (what happens during split)
    unmount()
    wsSend.mockClear()

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={pane} />
      </Provider>,
    )

    // After remount, should still NOT show restoring
    expect(screen.queryByText(/restoring/i)).not.toBeInTheDocument()

    // Composer should still be interactive
    const textarea2 = screen.getByRole('textbox')
    expect(textarea2).not.toBeDisabled()

    // Should send sdk.attach (to re-subscribe), but that's fine
    const attachCalls = wsSend.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'sdk.attach',
    )
    expect(attachCalls).toHaveLength(1)

    // Should NOT have sent sdk.create
    const createCalls = wsSend.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'sdk.create',
    )
    expect(createCalls).toHaveLength(0)
  })

  it('pane status remains interactive after remount (not reset to starting)', () => {
    const store = makeStore()
    const pane: AgentChatPaneContent = {
      kind: 'agent-chat', provider: 'freshclaude',
      createRequestId: 'req-1',
      sessionId: 'sess-1',
      status: 'connected',
    }

    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(sessionInit({
      sessionId: 'sess-1',
      cliSessionId: 'cli-abc',
      model: 'claude-opus-4-6',
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'connected' }))

    store.dispatch(initLayout({ tabId: 't1', content: pane, paneId: 'p1' }))

    // Simulate unmount + remount
    const { unmount } = render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={pane} />
      </Provider>,
    )
    unmount()

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={pane} />
      </Provider>,
    )

    // Status bar should show "Connected", not "Starting Claude Code..."
    expect(screen.getByText('Connected')).toBeInTheDocument()
    expect(screen.queryByText(/starting/i)).not.toBeInTheDocument()
  })

  it('does not regress to "starting" when sdk.status arrives after remount for a still-initializing session', () => {
    const store = makeStore()
    const pane: AgentChatPaneContent = {
      kind: 'agent-chat', provider: 'freshclaude',
      createRequestId: 'req-1',
      sessionId: 'sess-1',
      status: 'starting',
    }

    // Session just created — still in 'starting' status, not yet 'connected'
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))

    store.dispatch(initLayout({ tabId: 't1', content: pane, paneId: 'p1' }))

    // First mount
    const { unmount } = render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={pane} />
      </Provider>,
    )

    // Simulate unmount + remount (what happens during split)
    unmount()
    wsSend.mockClear()

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={pane} />
      </Provider>,
    )

    // Should send sdk.attach (to re-subscribe)
    const attachCalls = wsSend.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'sdk.attach',
    )
    expect(attachCalls).toHaveLength(1)

    // Simulate server responding to sdk.attach with sdk.status: 'starting'
    // (because the session hasn't finished initializing yet)
    act(() => {
      store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'starting' }))
    })

    // Pane should still show "Starting Claude Code..." — that's fine for now
    // The key thing is: when the session later transitions to 'connected',
    // the pane should update accordingly
    act(() => {
      store.dispatch(sessionInit({
        sessionId: 'sess-1',
        cliSessionId: 'cli-abc',
        model: 'claude-opus-4-6',
      }))
      store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'connected' }))
    })

    // Now the status should have progressed — no longer stuck on 'starting'
    const content = getPaneContent(store, 't1', 'p1')
    expect(content!.status).toBe('connected')
  })
})
