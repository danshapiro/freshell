import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, render, screen, cleanup, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider, useSelector } from 'react-redux'
import FreshAgentView from '@/components/fresh-agent/FreshAgentView'
import agentChatReducer from '@/store/agentChatSlice'
import freshAgentReducer from '@/store/freshAgentSlice'
import panesReducer, { initLayout } from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
import tabsReducer from '@/store/tabsSlice'
import type { FreshAgentPaneContent, PaneNode } from '@/store/paneTypes'
import type { Tab } from '@/store/types'

const wsHarness = vi.hoisted(() => {
  const reconnectHandlers = new Set<() => void>()
  const messageHandlers = new Set<(message: any) => void>()
  const send = vi.fn()
  const onMessage = vi.fn((handler: (message: any) => void) => {
    messageHandlers.add(handler)
    return () => messageHandlers.delete(handler)
  })
  const onReconnect = vi.fn((handler: () => void) => {
    reconnectHandlers.add(handler)
    return () => reconnectHandlers.delete(handler)
  })
  return {
    send,
    onMessage,
    onReconnect,
    reconnect: () => {
      for (const handler of [...reconnectHandlers]) {
        handler()
      }
    },
    emit: (message: any) => {
      for (const handler of [...messageHandlers]) {
        handler(message)
      }
    },
    reset: () => {
      reconnectHandlers.clear()
      messageHandlers.clear()
      send.mockReset()
      onMessage.mockReset()
      onMessage.mockImplementation((handler: (message: any) => void) => {
        messageHandlers.add(handler)
        return () => messageHandlers.delete(handler)
      })
      onReconnect.mockClear()
    },
    freshAgentCreates: () => send.mock.calls
      .map(([message]) => message)
      .filter((message: any) => message?.type === 'freshAgent.create'),
  }
})

const wsSend = wsHarness.send
const getFreshAgentThreadSnapshot = vi.fn()

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsHarness.send,
    onMessage: wsHarness.onMessage,
    onReconnect: wsHarness.onReconnect,
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getFreshAgentThreadSnapshot: (...args: unknown[]) => getFreshAgentThreadSnapshot(...args),
  }
})

function makeStore(tabOverrides: Partial<Tab> = {}) {
  return configureStore({
    reducer: {
      agentChat: agentChatReducer,
      freshAgent: freshAgentReducer,
      panes: panesReducer,
      settings: settingsReducer,
      tabs: tabsReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [
          {
            id: 't1',
            createRequestId: 't1',
            title: 'FreshClaude Tab',
            mode: 'claude',
            shell: 'system',
            status: 'running',
            createdAt: 1,
            codingCliProvider: 'claude',
            ...tabOverrides,
          },
        ],
        activeTabId: 't1',
        renameRequestTabId: null,
      },
    },
  })
}

function findLeaf(node: PaneNode, paneId: string): Extract<PaneNode, { type: 'leaf' }> | null {
  if (node.type === 'leaf') return node.id === paneId ? node : null
  return findLeaf(node.children[0], paneId) || findLeaf(node.children[1], paneId)
}

function ReactivePane({ store }: { store: ReturnType<typeof makeStore> }) {
  const content = useSelector((s: ReturnType<typeof store.getState>) => {
    const root = s.panes.layouts.t1
    if (!root) return undefined
    const leaf = findLeaf(root, 'p1')
    return leaf?.content.kind === 'fresh-agent' ? leaf.content : undefined
  })

  if (!content) return null
  return <FreshAgentView tabId="t1" paneId="p1" paneContent={content} />
}

describe('fresh-agent restore flow', () => {
  afterEach(() => {
    cleanup()
    wsHarness.reset()
    getFreshAgentThreadSnapshot.mockReset()
  })

  it('restores a reloaded freshclaude pane from the canonical fresh-agent snapshot and keeps the durable id in pane and tab state', async () => {
    const canonicalSessionId = '00000000-0000-4000-8000-000000000777'
    getFreshAgentThreadSnapshot.mockResolvedValue({
      revision: 2,
      status: 'running',
      summary: 'Recovered durable history',
      capabilities: { send: true, interrupt: true, approvals: false, questions: false, fork: false },
      turns: [
        {
          id: 'turn-1',
          role: 'assistant',
          items: [{ id: 'item-1', kind: 'text', text: 'Hydrated from restore flow' }],
        },
      ],
    })

    const store = makeStore({
      resumeSessionId: canonicalSessionId,
      sessionMetadataByKey: {
        [`claude:${canonicalSessionId}`]: {
          sessionType: 'freshclaude',
          firstUserMessage: 'Continue from the old tab',
        },
      },
    })
    store.dispatch(initLayout({
      tabId: 't1',
      paneId: 'p1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-reload',
        sessionId: canonicalSessionId,
        resumeSessionId: canonicalSessionId,
        status: 'idle',
      } satisfies FreshAgentPaneContent,
    }))

    render(
      <Provider store={store}>
        <ReactivePane store={store} />
      </Provider>,
    )

    await waitFor(() => {
      expect(getFreshAgentThreadSnapshot).toHaveBeenCalledWith(
        'freshclaude',
        'claude',
        canonicalSessionId,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    })
    await waitFor(() => {
      expect(screen.getByText('Recovered durable history')).toBeInTheDocument()
      expect(screen.getByText('Hydrated from restore flow')).toBeInTheDocument()
    })

    const root = store.getState().panes.layouts.t1
    const leaf = root && findLeaf(root, 'p1')
    expect(leaf?.content.kind === 'fresh-agent' ? leaf.content.resumeSessionId : undefined).toBe(canonicalSessionId)

    const tab = store.getState().tabs.tabs.find((entry) => entry.id === 't1')
    expect(tab?.resumeSessionId).toBe(canonicalSessionId)
    expect(tab?.sessionMetadataByKey?.[`claude:${canonicalSessionId}`]).toEqual(expect.objectContaining({
      sessionType: 'freshclaude',
      firstUserMessage: 'Continue from the old tab',
    }))
    expect(wsSend).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'sdk.attach' }))
  })

  it('surfaces a visible restore failure when the fresh-agent snapshot cannot be loaded', async () => {
    getFreshAgentThreadSnapshot.mockRejectedValue(new Error('Stale restore revision'))

    const canonicalSessionId = '00000000-0000-4000-8000-000000000888'
    const store = makeStore({
      resumeSessionId: canonicalSessionId,
      sessionMetadataByKey: {
        [`claude:${canonicalSessionId}`]: {
          sessionType: 'freshclaude',
        },
      },
    })
    store.dispatch(initLayout({
      tabId: 't1',
      paneId: 'p1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-stale',
        sessionId: canonicalSessionId,
        resumeSessionId: canonicalSessionId,
        status: 'idle',
      } satisfies FreshAgentPaneContent,
    }))

    render(
      <Provider store={store}>
        <ReactivePane store={store} />
      </Provider>,
    )

    await waitFor(() => {
      expect(getFreshAgentThreadSnapshot).toHaveBeenCalledWith(
        'freshclaude',
        'claude',
        canonicalSessionId,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    })
    expect(await screen.findByText('Stale restore revision')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Stale restore revision')
  })

  it('reconnect after freshAgent.create but before freshAgent.created resends the same request and binds one session without a retry loop', async () => {
    getFreshAgentThreadSnapshot.mockResolvedValue({
      revision: 1,
      status: 'idle',
      summary: 'Fresh-agent reconnected',
      capabilities: { send: true, interrupt: true, approvals: false, questions: false, fork: false },
      turns: [],
    })
    const store = makeStore()
    const pane = {
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      createRequestId: 'req-reconnect-create',
      status: 'creating',
    } satisfies FreshAgentPaneContent

    store.dispatch(initLayout({
      tabId: 't1',
      paneId: 'p1',
      content: pane,
    }))

    render(
      <Provider store={store}>
        <ReactivePane store={store} />
      </Provider>,
    )

    await waitFor(() => {
      expect(wsHarness.freshAgentCreates()).toEqual([
        expect.objectContaining({
          type: 'freshAgent.create',
          requestId: 'req-reconnect-create',
          sessionType: 'freshclaude',
          provider: 'claude',
        }),
      ])
    })

    act(() => {
      wsHarness.reconnect()
    })

    await waitFor(() => {
      expect(wsHarness.freshAgentCreates()).toEqual([
        expect.objectContaining({
          type: 'freshAgent.create',
          requestId: 'req-reconnect-create',
        }),
        expect.objectContaining({
          type: 'freshAgent.create',
          requestId: 'req-reconnect-create',
        }),
      ])
    })

    act(() => {
      wsHarness.emit({
        type: 'freshAgent.created',
        requestId: 'req-reconnect-create',
        sessionId: 'fresh-agent-reconnected-1',
        sessionType: 'freshclaude',
        provider: 'claude',
      })
    })

    await waitFor(() => {
      const root = store.getState().panes.layouts.t1
      const leaf = root && findLeaf(root, 'p1')
      expect(leaf?.content.kind === 'fresh-agent' ? leaf.content.sessionId : undefined).toBe('fresh-agent-reconnected-1')
    })

    act(() => {
      wsHarness.reconnect()
    })

    expect(wsHarness.freshAgentCreates()).toHaveLength(2)
    const root = store.getState().panes.layouts.t1
    const leaf = root && findLeaf(root, 'p1')
    expect(leaf?.content.kind === 'fresh-agent' ? leaf.content : undefined).toEqual(expect.objectContaining({
      sessionId: 'fresh-agent-reconnected-1',
      status: 'idle',
    }))
  })
})
