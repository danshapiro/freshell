import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider, useSelector } from 'react-redux'
import AgentChatView from '@/components/agent-chat/AgentChatView'
import agentChatReducer from '@/store/agentChatSlice'
import panesReducer, { initLayout } from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
import tabsReducer from '@/store/tabsSlice'
import type { AgentChatPaneContent, PaneNode } from '@/store/paneTypes'
import type { Tab } from '@/store/types'
import { handleSdkMessage } from '@/lib/sdk-message-handler'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

const wsHarness = vi.hoisted(() => {
  const reconnectHandlers = new Set<() => void>()
  const sent: unknown[] = []
  const inFlightSdkCreates = new Map<string, unknown>()

  const send = vi.fn((msg: unknown) => {
    sent.push(msg)
    if (!msg || typeof msg !== 'object') return
    const candidate = msg as { type?: unknown; requestId?: unknown }
    if (candidate.type === 'sdk.create' && typeof candidate.requestId === 'string') {
      inFlightSdkCreates.set(candidate.requestId, msg)
    }
  })

  return {
    send,
    onReconnect: vi.fn((handler: () => void) => {
      reconnectHandlers.add(handler)
      return () => reconnectHandlers.delete(handler)
    }),
    reconnect() {
      for (const handler of reconnectHandlers) {
        handler()
      }
      for (const create of inFlightSdkCreates.values()) {
        send(create)
      }
    },
    clearInFlight(requestId: string) {
      inFlightSdkCreates.delete(requestId)
    },
    sdkCreates() {
      return sent.filter((msg) => (msg as { type?: unknown })?.type === 'sdk.create')
    },
    reset() {
      reconnectHandlers.clear()
      sent.length = 0
      inFlightSdkCreates.clear()
      send.mockClear()
      this.onReconnect.mockClear()
    },
  }
})
const getAgentTimelinePage = vi.fn()
const getAgentTurnBody = vi.fn()
const setSessionMetadata = vi.fn(() => Promise.resolve(undefined))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsHarness.send,
    onReconnect: wsHarness.onReconnect,
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

function makeStore(tabOverrides: Partial<Tab> = {}) {
  return configureStore({
    reducer: {
      agentChat: agentChatReducer,
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
    return leaf?.content.kind === 'agent-chat' ? leaf.content : undefined
  })

  if (!content) return null
  return <AgentChatView tabId="t1" paneId="p1" paneContent={content} />
}

describe('agent chat restore flow', () => {
  afterEach(() => {
    cleanup()
    wsHarness.reset()
    getAgentTimelinePage.mockReset()
    getAgentTurnBody.mockReset()
    setSessionMetadata.mockClear()
  })

  it('restores a reloaded pane from sdk.session.snapshot, persists the durable id into pane and tab state, and shows partial output without a blank running gap', async () => {
    const store = makeStore({
      resumeSessionId: 'named-resume',
      sessionMetadataByKey: {
        'claude:named-resume': {
          sessionType: 'freshclaude',
          firstUserMessage: 'Continue from the old tab',
        },
      },
    })
    const pane = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-reload',
      sessionId: 'sdk-sess-1',
      status: 'idle',
    } satisfies AgentChatPaneContent

    store.dispatch(initLayout({
      tabId: 't1',
      paneId: 'p1',
      content: pane,
    }))

    getAgentTimelinePage.mockResolvedValue({
      sessionId: 'cli-session-1',
      items: [
        {
          turnId: 'turn-2',
          sessionId: 'cli-session-1',
          role: 'assistant',
          summary: 'Recent summary',
          timestamp: '2026-03-10T10:01:00.000Z',
        },
      ],
      nextCursor: null,
      revision: 2,
      bodies: {
        'turn-2': {
          sessionId: 'cli-session-1',
          turnId: 'turn-2',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hydrated from restore flow' }],
            timestamp: '2026-03-10T10:01:00.000Z',
          },
        },
      },
    })

    render(
      <Provider store={store}>
        <ReactivePane store={store} />
      </Provider>,
    )

    act(() => {
      handleSdkMessage(store.dispatch, {
        type: 'sdk.session.snapshot',
        sessionId: 'sdk-sess-1',
        latestTurnId: 'turn-2',
        status: 'running',
        timelineSessionId: 'cli-session-1',
        revision: 2,
        streamingActive: true,
        streamingText: 'partial reply',
      })
    })

    expect(screen.getByText('partial reply')).toBeInTheDocument()
    expect(screen.queryByLabelText('Claude is thinking')).not.toBeInTheDocument()

    await waitFor(() => {
      expect(getAgentTimelinePage).toHaveBeenCalledWith(
        'cli-session-1',
        expect.objectContaining({ priority: 'visible', includeBodies: true }),
        expect.anything(),
      )
    })

    expect(getAgentTurnBody).not.toHaveBeenCalled()
    expect(await screen.findByText('Hydrated from restore flow')).toBeInTheDocument()
    expect(screen.queryByText(/restoring session/i)).not.toBeInTheDocument()

    await waitFor(() => {
      const root = store.getState().panes.layouts.t1
      const leaf = root && findLeaf(root, 'p1')
      expect(leaf?.content.kind === 'agent-chat' ? leaf.content.resumeSessionId : undefined).toBe('cli-session-1')

      const tab = store.getState().tabs.tabs.find((entry) => entry.id === 't1')
      expect(tab?.resumeSessionId).toBe('cli-session-1')
      expect(tab?.sessionMetadataByKey?.['claude:cli-session-1']).toEqual(expect.objectContaining({
        sessionType: 'freshclaude',
        firstUserMessage: 'Continue from the old tab',
      }))
    })
  })

  it('retries stale-revision restore once, then surfaces a visible failure on the second stale response', async () => {
    const canonicalSessionId = '00000000-0000-4000-8000-000000000888'
    const makeStaleRevisionError = (currentRevision: number) => Object.assign(
      new Error('Stale restore revision'),
      {
        status: 409,
        details: {
          code: 'RESTORE_STALE_REVISION',
          currentRevision,
        },
      },
    )

    getAgentTimelinePage
      .mockRejectedValueOnce(makeStaleRevisionError(13))
      .mockRejectedValueOnce(makeStaleRevisionError(14))

    const store = makeStore({
      resumeSessionId: canonicalSessionId,
      sessionMetadataByKey: {
        [`claude:${canonicalSessionId}`]: {
          sessionType: 'freshclaude',
        },
      },
    })
    const pane = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-stale',
      sessionId: 'sdk-stale-1',
      status: 'idle',
      resumeSessionId: canonicalSessionId,
    } satisfies AgentChatPaneContent

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

    act(() => {
      handleSdkMessage(store.dispatch, {
        type: 'sdk.session.snapshot',
        sessionId: 'sdk-stale-1',
        latestTurnId: 'turn-2',
        status: 'idle',
        timelineSessionId: canonicalSessionId,
        revision: 12,
      })
    })

    await waitFor(() => {
      const attachCalls = wsHarness.send.mock.calls.filter((call) => call[0]?.type === 'sdk.attach')
      expect(attachCalls).toHaveLength(2)
    })

    act(() => {
      handleSdkMessage(store.dispatch, {
        type: 'sdk.session.snapshot',
        sessionId: 'sdk-stale-1',
        latestTurnId: 'turn-2',
        status: 'idle',
        timelineSessionId: canonicalSessionId,
        revision: 13,
      })
    })

    await waitFor(() => {
      expect(getAgentTimelinePage).toHaveBeenCalledTimes(2)
    })

    expect(await screen.findByText('Session restore failed')).toBeInTheDocument()
    expect(screen.getByText('Stale restore revision')).toBeInTheDocument()
    expect(screen.queryByText('Restoring session...')).not.toBeInTheDocument()
  })

  it('surfaces restore-unavailable instead of recreating a live-only FreshClaude session after INVALID_SESSION_ID', async () => {
    const store = makeStore()
    const pane = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-live-only',
      sessionId: 'sdk-live-only',
      status: 'idle',
    } satisfies AgentChatPaneContent

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
      expect(wsHarness.send).toHaveBeenCalledWith({
        type: 'sdk.attach',
        sessionId: 'sdk-live-only',
      })
    })

    wsHarness.send.mockClear()

    act(() => {
      handleSdkMessage(store.dispatch, {
        type: 'sdk.error',
        sessionId: 'sdk-live-only',
        code: 'INVALID_SESSION_ID',
        message: 'Live SDK session not found',
      })
    })

    await waitFor(() => {
      expect(store.getState().agentChat.sessions['sdk-live-only']).toMatchObject({
        restoreFailureCode: 'RESTORE_UNAVAILABLE',
        restoreFailureMessage: expect.any(String),
        historyLoaded: true,
      })
    })

    expect(wsHarness.send.mock.calls.some(([msg]) => msg?.type === 'sdk.create')).toBe(false)
  })
  it('reconnect after sdk.create but before sdk.created resends the same request and binds one session without a retry loop', async () => {
    const store = makeStore()
    const pane = {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-reconnect-create',
      status: 'creating',
    } satisfies AgentChatPaneContent

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
      expect(wsHarness.sdkCreates()).toEqual([
        expect.objectContaining({
          type: 'sdk.create',
          requestId: 'req-reconnect-create',
        }),
      ])
    })

    act(() => {
      wsHarness.reconnect()
    })

    await waitFor(() => {
      expect(wsHarness.sdkCreates()).toEqual([
        expect.objectContaining({
          type: 'sdk.create',
          requestId: 'req-reconnect-create',
        }),
        expect.objectContaining({
          type: 'sdk.create',
          requestId: 'req-reconnect-create',
        }),
      ])
    })

    act(() => {
      wsHarness.clearInFlight('req-reconnect-create')
      handleSdkMessage(store.dispatch, {
        type: 'sdk.created',
        requestId: 'req-reconnect-create',
        sessionId: 'sdk-reconnected-1',
      })
      handleSdkMessage(store.dispatch, {
        type: 'sdk.session.init',
        sessionId: 'sdk-reconnected-1',
        model: 'claude-sonnet-4-5-20250929',
        cwd: '/tmp/project',
        tools: [],
      })
    })

    await waitFor(() => {
      const root = store.getState().panes.layouts.t1
      const leaf = root && findLeaf(root, 'p1')
      expect(leaf?.content.kind === 'agent-chat' ? leaf.content.sessionId : undefined).toBe('sdk-reconnected-1')
    })

    act(() => {
      wsHarness.reconnect()
    })

    expect(wsHarness.sdkCreates()).toHaveLength(2)
    const root = store.getState().panes.layouts.t1
    const leaf = root && findLeaf(root, 'p1')
    expect(leaf?.content.kind === 'agent-chat' ? leaf.content : undefined).toEqual(expect.objectContaining({
      sessionId: 'sdk-reconnected-1',
      status: 'connected',
    }))
  })
})
