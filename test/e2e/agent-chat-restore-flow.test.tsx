import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider, useSelector } from 'react-redux'
import AgentChatView from '@/components/agent-chat/AgentChatView'
import agentChatReducer from '@/store/agentChatSlice'
import panesReducer, { hydratePanes, initLayout } from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
import tabsReducer from '@/store/tabsSlice'
import type { AgentChatPaneContent, PaneNode } from '@/store/paneTypes'
import type { Tab } from '@/store/types'
import { handleSdkMessage } from '@/lib/sdk-message-handler'

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

function ReactivePaneById({ store, paneId }: { store: ReturnType<typeof makeStore>; paneId: string }) {
  const content = useSelector((s: ReturnType<typeof store.getState>) => {
    const root = s.panes.layouts.t1
    if (!root) return undefined
    const leaf = findLeaf(root, paneId)
    return leaf?.content.kind === 'agent-chat' ? leaf.content : undefined
  })

  if (!content) return null
  return <AgentChatView tabId="t1" paneId={paneId} paneContent={content} />
}

describe('agent chat restore flow', () => {
  afterEach(() => {
    cleanup()
    wsSend.mockClear()
    getAgentTimelinePage.mockReset()
    getAgentTurnBody.mockReset()
    setSessionMetadata.mockClear()
  })

  it('restores a reloaded pane from sdk.session.snapshot, persists the durable id into pane and tab state, and shows partial output without a blank running gap', async () => {
    const canonicalSessionId = '00000000-0000-4000-8000-000000000224'
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
      sessionId: canonicalSessionId,
      items: [
        {
          turnId: 'turn-2',
          sessionId: canonicalSessionId,
          role: 'assistant',
          summary: 'Recent summary',
          timestamp: '2026-03-10T10:01:00.000Z',
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
        timelineSessionId: canonicalSessionId,
        revision: 2,
        streamingActive: true,
        streamingText: 'partial reply',
      })
    })

    expect(screen.getByText('partial reply')).toBeInTheDocument()
    expect(screen.queryByLabelText('Claude is thinking')).not.toBeInTheDocument()

    await waitFor(() => {
      expect(getAgentTimelinePage).toHaveBeenCalledWith(
        canonicalSessionId,
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
      expect(leaf?.content.kind === 'agent-chat' ? leaf.content.sessionRef : undefined).toEqual({
        provider: 'claude',
        sessionId: canonicalSessionId,
      })

      const tab = store.getState().tabs.tabs.find((entry) => entry.id === 't1')
      expect(tab?.resumeSessionId).toBeUndefined()
      expect(tab?.sessionRef).toEqual({
        provider: 'claude',
        sessionId: canonicalSessionId,
      })
      expect(tab?.sessionMetadataByKey?.[`claude:${canonicalSessionId}`]).toEqual(expect.objectContaining({
        sessionType: 'freshclaude',
        firstUserMessage: 'Continue from the old tab',
      }))
    })
  })

  it('restores split agent-chat panes without looping shared tab fallback identity updates', async () => {
    const firstDurableSessionId = '00000000-0000-4000-8000-000000000411'
    const secondDurableSessionId = '00000000-0000-4000-8000-000000000412'
    const store = makeStore()
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    store.dispatch(hydratePanes({
      layouts: {
        t1: {
          type: 'split',
          id: 'split-root',
          direction: 'horizontal',
          sizes: [50, 50],
          children: [
            {
              type: 'leaf',
              id: 'p1',
              content: {
                kind: 'agent-chat',
                provider: 'freshclaude',
                createRequestId: 'req-split-1',
                sessionId: 'sdk-split-1',
                status: 'idle',
              },
            },
            {
              type: 'leaf',
              id: 'p2',
              content: {
                kind: 'agent-chat',
                provider: 'freshclaude',
                createRequestId: 'req-split-2',
                sessionId: 'sdk-split-2',
                status: 'idle',
              },
            },
          ],
        } as PaneNode,
      },
      activePane: { t1: 'p1' },
      paneTitles: {},
    }))

    render(
      <Provider store={store}>
        <ReactivePaneById store={store} paneId="p1" />
        <ReactivePaneById store={store} paneId="p2" />
      </Provider>,
    )

    expect(() => {
      act(() => {
        handleSdkMessage(store.dispatch, {
          type: 'sdk.session.snapshot',
          sessionId: 'sdk-split-1',
          latestTurnId: 'turn-1',
          status: 'idle',
          timelineSessionId: firstDurableSessionId,
          revision: 1,
        })
        handleSdkMessage(store.dispatch, {
          type: 'sdk.session.snapshot',
          sessionId: 'sdk-split-2',
          latestTurnId: 'turn-2',
          status: 'idle',
          timelineSessionId: secondDurableSessionId,
          revision: 1,
        })
      })
    }).not.toThrow()

    await waitFor(() => {
      const root = store.getState().panes.layouts.t1
      expect(findLeaf(root as PaneNode, 'p1')?.content.kind === 'agent-chat'
        ? findLeaf(root as PaneNode, 'p1')?.content.sessionRef
        : undefined).toEqual({
        provider: 'claude',
        sessionId: firstDurableSessionId,
      })
      expect(findLeaf(root as PaneNode, 'p2')?.content.kind === 'agent-chat'
        ? findLeaf(root as PaneNode, 'p2')?.content.sessionRef
        : undefined).toEqual({
        provider: 'claude',
        sessionId: secondDurableSessionId,
      })
      const tab = store.getState().tabs.tabs.find((entry) => entry.id === 't1')
      expect(tab?.sessionRef).toBeUndefined()
    })

    consoleErrorSpy.mockRestore()
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
      const attachCalls = wsSend.mock.calls.filter((call) => call[0]?.type === 'sdk.attach')
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
      expect(wsSend).toHaveBeenCalledWith({
        type: 'sdk.attach',
        sessionId: 'sdk-live-only',
      })
    })

    wsSend.mockClear()

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

    expect(wsSend.mock.calls.some(([msg]) => msg?.type === 'sdk.create')).toBe(false)
  })
})
