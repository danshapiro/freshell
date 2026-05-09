import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { FreshAgentView } from '@/components/fresh-agent/FreshAgentView'
import panesReducer, { addPane, initLayout } from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
import freshAgentReducer from '@/store/freshAgentSlice'
import agentChatReducer, { sessionInit, setSessionStatus } from '@/store/agentChatSlice'
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

function findLeaf(node: PaneNode, paneId: string): Extract<PaneNode, { type: 'leaf' }> | null {
  if (node.type === 'leaf') return node.id === paneId ? node : null
  return findLeaf(node.children[0], paneId) || findLeaf(node.children[1], paneId)
}

function StoreBackedFreshAgentView({ store, tabId, paneId }: {
  store: ReturnType<typeof createStore>
  tabId: string
  paneId: string
}) {
  const paneContent = useAppSelector((state) => {
    const layout = state.panes.layouts[tabId]
    if (!layout) throw new Error(`Missing layout for ${tabId}`)
    const leaf = findLeaf(layout, paneId)
    if (!leaf || leaf.content.kind !== 'fresh-agent') throw new Error(`Missing pane ${paneId}`)
    return leaf.content
  })
  return <FreshAgentView tabId={tabId} paneId={paneId} paneContent={paneContent} />
}

describe('Fresh-agent split-pane regression coverage', () => {
  beforeEach(() => {
    wsMock.send.mockReset()
    wsMock.onMessage.mockReset()
    wsMock.onMessage.mockImplementation(() => () => {})
    apiMock.getFreshAgentThreadSnapshot.mockReset()
    apiMock.getFreshAgentThreadSnapshot.mockRejectedValue(new TypeError('Failed to parse URL from /api/fresh-agent/threads/claude/sess-1'))
  })

  afterEach(() => {
    cleanup()
  })

  it('keeps an established freshclaude pane interactive after a remount', async () => {
    const store = createStore()
    store.dispatch(sessionInit({
      sessionId: 'sess-1',
      cliSessionId: 'cli-abc',
      model: 'claude-opus-4-6',
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-1',
        sessionId: 'sess-1',
        status: 'idle',
        resumeSessionId: 'cli-abc',
      },
    }))

    const { unmount } = render(
      <Provider store={store}>
        <StoreBackedFreshAgentView store={store} tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getAllByText('Ready').length).toBeGreaterThan(0)
    })
    expect(screen.getByRole('textbox', { name: 'Chat message input' })).not.toBeDisabled()

    unmount()
    wsMock.send.mockClear()

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView store={store} tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByText('Ready')).toBeInTheDocument()
    })
    expect(screen.getByRole('textbox', { name: 'Chat message input' })).not.toBeDisabled()
    expect(screen.queryByText(/failed to parse url/i)).not.toBeInTheDocument()
    expect(wsMock.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'freshAgent.create' }))
  })

  it('preserves the original fresh-agent pane through addPane tree restructuring', async () => {
    const store = createStore()
    store.dispatch(sessionInit({
      sessionId: 'sess-1',
      cliSessionId: 'cli-abc',
      model: 'claude-opus-4-6',
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-1',
        sessionId: 'sess-1',
        status: 'idle',
        resumeSessionId: 'cli-abc',
      },
    }))

    const { rerender } = render(
      <Provider store={store}>
        <StoreBackedFreshAgentView store={store} tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByText('Ready')).toBeInTheDocument()
    })

    store.dispatch(addPane({
      tabId: 'tab-1',
      newContent: { kind: 'picker' },
    }))

    rerender(
      <Provider store={store}>
        <StoreBackedFreshAgentView store={store} tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getAllByText('Ready').length).toBeGreaterThan(0)
    })
    expect(screen.getByRole('textbox', { name: 'Chat message input' })).not.toBeDisabled()
    expect(findLeaf(store.getState().panes.layouts['tab-1'], 'pane-1')?.content).toMatchObject({
      kind: 'fresh-agent',
      sessionId: 'sess-1',
      status: 'idle',
    })
  })

  it('still sends freshAgent.attach after page refresh when the session is not in Redux', () => {
    const store = createStore()

    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-refresh',
        sessionId: 'sess-refresh',
        status: 'connected',
        resumeSessionId: 'cli-refresh',
      },
    }))

    expect(store.getState().freshAgent.sessions).toEqual({})

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView store={store} tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    expect(wsMock.send).toHaveBeenCalledWith({
      type: 'freshAgent.attach',
      sessionId: 'sess-refresh',
      sessionType: 'freshclaude',
      provider: 'claude',
      resumeSessionId: 'cli-refresh',
    })
  })

  it('resumes a sessionRef-only freshcodex pane through freshAgent.create after split', () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-fx-sessionref',
        status: 'creating',
        sessionRef: { provider: 'codex', sessionId: 'codex-thread-split' },
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView store={store} tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    expect(wsMock.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'freshAgent.create',
      requestId: 'req-fx-sessionref',
      sessionRef: { provider: 'codex', sessionId: 'codex-thread-split' },
    }))
  })
})
