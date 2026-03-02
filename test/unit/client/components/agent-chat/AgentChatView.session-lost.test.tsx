import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider, useSelector } from 'react-redux'
import AgentChatView from '@/components/agent-chat/AgentChatView'
import agentChatReducer, { markSessionLost, sessionCreated, sessionInit, setSessionStatus } from '@/store/agentChatSlice'
import panesReducer, { initLayout } from '@/store/panesSlice'
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
    vi.useRealTimers()
  })

  it('recovers immediately when session is marked as lost (INVALID_SESSION_ID)', async () => {
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

    // Should recover IMMEDIATELY — clear the dead sessionId and begin creating
    // a new SDK session, without waiting for the 5-second timeout.
    // The recovery goes through a useEffect chain (markSessionLost → re-render →
    // sessionLost effect → triggerRecovery dispatch → re-render → sdk.create effect).
    await waitFor(() => {
      const content = getPaneContent(store, 't1', 'p1')
      expect(content).toBeDefined()
      expect(content!.sessionId).toBeUndefined()
    })

    const content = getPaneContent(store, 't1', 'p1')!
    // Status will be 'starting' because the sdk.create effect fires immediately
    // after recovery sets status to 'creating', transitioning to 'starting'
    expect(content.status).toBe('starting')
    // resumeSessionId should be preserved so the new session resumes the CLI session
    expect(content.resumeSessionId).toBe('cli-session-to-resume')
    // Should have sent sdk.create with the resumeSessionId
    const createCalls = wsSend.mock.calls.filter(
      (c: any[]) => c[0]?.type === 'sdk.create',
    )
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0][0].resumeSessionId).toBe('cli-session-to-resume')
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
