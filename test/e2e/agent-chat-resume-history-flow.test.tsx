import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, act, waitFor, fireEvent } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider, useSelector } from 'react-redux'
import AgentChatView from '@/components/agent-chat/AgentChatView'
import agentChatReducer from '@/store/agentChatSlice'
import panesReducer, { initLayout } from '@/store/panesSlice'
import tabsReducer, { addTab } from '@/store/tabsSlice'
import settingsReducer from '@/store/settingsSlice'
import type { AgentChatPaneContent, PaneNode } from '@/store/paneTypes'
import { handleSdkMessage } from '@/lib/sdk-message-handler'
import { sessionMetadataKey } from '@/lib/session-metadata'

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
      tabs: tabsReducer,
      settings: settingsReducer,
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

describe('agent chat resume history flow', () => {
  afterEach(() => {
    cleanup()
    wsSend.mockClear()
    getAgentTimelinePage.mockReset()
    getAgentTurnBody.mockReset()
    setSessionMetadata.mockClear()
  })

  it('hydrates durable history after sdk.created for a resumed create', async () => {
    const canonicalSessionId = '00000000-0000-4000-8000-000000000225'
    getAgentTimelinePage.mockResolvedValue({
      sessionId: canonicalSessionId,
      items: [
        {
          turnId: 'turn-older-user',
          sessionId: canonicalSessionId,
          role: 'user',
          summary: 'Older question',
          timestamp: '2026-03-10T10:00:00.000Z',
        },
        {
          turnId: 'turn-older-assistant',
          sessionId: canonicalSessionId,
          role: 'assistant',
          summary: 'Older answer',
          timestamp: '2026-03-10T10:00:20.000Z',
        },
        {
          turnId: 'turn-new-user',
          sessionId: canonicalSessionId,
          role: 'user',
          summary: 'New prompt',
          timestamp: '2026-03-10T10:01:00.000Z',
        },
        {
          turnId: 'turn-new-assistant',
          sessionId: canonicalSessionId,
          role: 'assistant',
          summary: 'New reply',
          timestamp: '2026-03-10T10:01:20.000Z',
        },
      ],
      nextCursor: null,
      revision: 4,
      bodies: {
        'turn-older-user': {
          sessionId: canonicalSessionId,
          turnId: 'turn-older-user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Older durable question' }],
            timestamp: '2026-03-10T10:00:00.000Z',
          },
        },
        'turn-older-assistant': {
          sessionId: canonicalSessionId,
          turnId: 'turn-older-assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Older durable answer' }],
            timestamp: '2026-03-10T10:00:20.000Z',
          },
        },
        'turn-new-user': {
          sessionId: canonicalSessionId,
          turnId: 'turn-new-user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'New live prompt' }],
            timestamp: '2026-03-10T10:01:00.000Z',
          },
        },
        'turn-new-assistant': {
          sessionId: canonicalSessionId,
          turnId: 'turn-new-assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hydrated from durable history' }],
            timestamp: '2026-03-10T10:01:20.000Z',
          },
        },
      },
    })

    const store = makeStore()
    store.dispatch(initLayout({
      tabId: 't1',
      paneId: 'p1',
      content: {
        kind: 'agent-chat',
        provider: 'freshclaude',
        createRequestId: 'req-resume',
        status: 'creating',
        resumeSessionId: canonicalSessionId,
      },
    }))

    render(
      <Provider store={store}>
        <ReactivePane store={store} />
      </Provider>,
    )

    expect(wsSend).toHaveBeenCalledWith(expect.objectContaining({
      type: 'sdk.create',
      requestId: 'req-resume',
      resumeSessionId: canonicalSessionId,
    }))

    act(() => {
      handleSdkMessage(store.dispatch, {
        type: 'sdk.created',
        requestId: 'req-resume',
        sessionId: 'sdk-sess-1',
      })
      handleSdkMessage(store.dispatch, {
        type: 'sdk.session.snapshot',
        sessionId: 'sdk-sess-1',
        latestTurnId: 'turn-2',
        status: 'idle',
        timelineSessionId: canonicalSessionId,
        revision: 4,
      })
    })

    expect(screen.getByText(/restoring session/i)).toBeInTheDocument()

    await waitFor(() => {
      expect(getAgentTimelinePage).toHaveBeenCalledWith(
        canonicalSessionId,
        expect.objectContaining({ priority: 'visible', includeBodies: true, revision: 4 }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    })
    expect(getAgentTurnBody).not.toHaveBeenCalled()

    await waitFor(() => {
      const renderedMessages = screen.getAllByRole('article')
        .map((node) => node.textContent?.replace(/\s+/g, ' ').trim())
      expect(renderedMessages).toEqual([
        'Older durable question',
        'Older durable answer',
        'New live prompt',
        'Hydrated from durable history',
      ])
    })
    expect(screen.queryByText(/restoring session/i)).not.toBeInTheDocument()
  })

  it('upgrades a live-only named resume in place when a later timeline page exposes the canonical durable id', async () => {
    const canonicalSessionId = '00000000-0000-4000-8000-000000000777'
    getAgentTurnBody.mockResolvedValue({
      sessionId: canonicalSessionId,
      turnId: 'turn-durable-1',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Older durable question' }],
        timestamp: '2026-03-10T10:00:00.000Z',
      },
    })
    getAgentTimelinePage
      .mockResolvedValueOnce({
        sessionId: 'sdk-live-only',
        items: [
          {
            turnId: 'turn-live-1',
            sessionId: 'sdk-live-only',
            role: 'assistant',
            summary: 'Live-only reply',
            timestamp: '2026-03-10T10:01:20.000Z',
          },
        ],
        nextCursor: null,
        revision: 1,
        bodies: {
          'turn-live-1': {
            sessionId: 'sdk-live-only',
            turnId: 'turn-live-1',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Live-only full body' }],
              timestamp: '2026-03-10T10:01:20.000Z',
            },
          },
        },
      })
      .mockResolvedValueOnce({
        sessionId: canonicalSessionId,
        items: [
          {
            turnId: 'turn-live-2',
            sessionId: canonicalSessionId,
            role: 'assistant',
            summary: 'Post-watermark live delta',
            timestamp: '2026-03-10T10:01:40.000Z',
          },
          {
            turnId: 'turn-durable-2',
            sessionId: canonicalSessionId,
            role: 'assistant',
            summary: 'Older durable answer',
            timestamp: '2026-03-10T10:00:20.000Z',
          },
          {
            turnId: 'turn-durable-1',
            sessionId: canonicalSessionId,
            role: 'user',
            summary: 'Older durable question',
            timestamp: '2026-03-10T10:00:00.000Z',
          },
        ],
        nextCursor: null,
        revision: 2,
        bodies: {
          'turn-durable-2': {
            sessionId: canonicalSessionId,
            turnId: 'turn-durable-2',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Older durable answer' }],
              timestamp: '2026-03-10T10:00:20.000Z',
            },
          },
          'turn-live-2': {
            sessionId: canonicalSessionId,
            turnId: 'turn-live-2',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Post-watermark live delta' }],
              timestamp: '2026-03-10T10:01:40.000Z',
            },
          },
        },
      })
      .mockResolvedValueOnce({
        sessionId: canonicalSessionId,
        items: [
          {
            turnId: 'turn-live-2',
            sessionId: canonicalSessionId,
            role: 'assistant',
            summary: 'Post-watermark live delta',
            timestamp: '2026-03-10T10:01:40.000Z',
          },
          {
            turnId: 'turn-durable-2',
            sessionId: canonicalSessionId,
            role: 'assistant',
            summary: 'Older durable answer',
            timestamp: '2026-03-10T10:00:20.000Z',
          },
          {
            turnId: 'turn-durable-1',
            sessionId: canonicalSessionId,
            role: 'user',
            summary: 'Older durable question',
            timestamp: '2026-03-10T10:00:00.000Z',
          },
        ],
        nextCursor: null,
        revision: 3,
        bodies: {
          'turn-durable-1': {
            sessionId: canonicalSessionId,
            turnId: 'turn-durable-1',
            message: {
              role: 'user',
              content: [{ type: 'text', text: 'Older durable question' }],
              timestamp: '2026-03-10T10:00:00.000Z',
            },
          },
          'turn-durable-2': {
            sessionId: canonicalSessionId,
            turnId: 'turn-durable-2',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Older durable answer' }],
              timestamp: '2026-03-10T10:00:20.000Z',
            },
          },
          'turn-live-2': {
            sessionId: canonicalSessionId,
            turnId: 'turn-live-2',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Post-watermark live delta' }],
              timestamp: '2026-03-10T10:01:40.000Z',
            },
          },
        },
      })

    const store = makeStore()
    store.dispatch(addTab({
      id: 't1',
      title: 'FreshClaude Tab',
      mode: 'claude',
      status: 'running',
      createRequestId: 'req-live-only',
      resumeSessionId: 'named-resume',
      codingCliProvider: 'claude',
      sessionMetadataByKey: {
        [sessionMetadataKey('claude', 'named-resume')]: {
          sessionType: 'freshclaude',
          firstUserMessage: 'Original named resume prompt',
        },
      },
    }))
    store.dispatch(initLayout({
      tabId: 't1',
      paneId: 'p1',
      content: {
        kind: 'agent-chat',
        provider: 'freshclaude',
        createRequestId: 'req-live-only',
        status: 'creating',
        resumeSessionId: 'named-resume',
      },
    }))

    render(
      <Provider store={store}>
        <ReactivePane store={store} />
      </Provider>,
    )

    act(() => {
      handleSdkMessage(store.dispatch, {
        type: 'sdk.created',
        requestId: 'req-live-only',
        sessionId: 'sdk-live-only',
      })
      handleSdkMessage(store.dispatch, {
        type: 'sdk.session.snapshot',
        sessionId: 'sdk-live-only',
        latestTurnId: 'turn-live-1',
        status: 'idle',
        revision: 1,
      })
    })

    await waitFor(() => {
      expect(getAgentTimelinePage).toHaveBeenCalledWith(
        'sdk-live-only',
        expect.objectContaining({ priority: 'visible', includeBodies: true, revision: 1 }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    })
    expect(await screen.findByText('Live-only full body')).toBeInTheDocument()

    act(() => {
      handleSdkMessage(store.dispatch, {
        type: 'sdk.assistant',
        sessionId: 'sdk-live-only',
        content: [{ type: 'text', text: 'Post-watermark live delta' }],
      })
    })
    expect(screen.getByText('Post-watermark live delta')).toBeInTheDocument()

    act(() => {
      handleSdkMessage(store.dispatch, {
        type: 'sdk.session.snapshot',
        sessionId: 'sdk-live-only',
        latestTurnId: 'turn-live-2',
        status: 'idle',
        revision: 2,
      })
    })

    await waitFor(() => {
      expect(getAgentTimelinePage).toHaveBeenNthCalledWith(
        2,
        'sdk-live-only',
        expect.objectContaining({ priority: 'visible', includeBodies: true, revision: 2 }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    })

    await waitFor(() => {
      expect(screen.getByText('Post-watermark live delta')).toBeInTheDocument()
      expect(screen.getByText('Older durable answer')).toBeInTheDocument()
      expect(screen.getByText('Older durable question')).toBeInTheDocument()
    })
    expect(screen.queryByText('Live-only full body')).not.toBeInTheDocument()
    expect(screen.getAllByText('Post-watermark live delta')).toHaveLength(1)

    const pane = findLeaf(store.getState().panes.layouts.t1!, 'p1')
    expect(pane?.content.kind === 'agent-chat' ? pane.content.resumeSessionId : undefined).toBe(canonicalSessionId)
    const tab = store.getState().tabs.tabs.find((entry) => entry.id === 't1')
    expect(tab?.resumeSessionId).toBe(canonicalSessionId)
    expect(tab?.sessionMetadataByKey).toEqual({
      [sessionMetadataKey('claude', canonicalSessionId)]: {
        sessionType: 'freshclaude',
        firstUserMessage: 'Original named resume prompt',
      },
    })

    const expandButtons = screen.getAllByLabelText('Expand turn')
    fireEvent.click(expandButtons[0]!)
    expect(getAgentTurnBody).toHaveBeenCalledWith(
      canonicalSessionId,
      'turn-durable-1',
      expect.objectContaining({ signal: expect.any(AbortSignal), revision: 2 }),
    )
    await waitFor(() => {
      const renderedMessages = screen.getAllByRole('article')
        .map((node) => node.textContent?.replace(/\s+/g, ' ').trim())
      expect(renderedMessages).toContain('Older durable question')
    })

    act(() => {
      handleSdkMessage(store.dispatch, {
        type: 'sdk.session.snapshot',
        sessionId: 'sdk-live-only',
        latestTurnId: 'turn-live-2',
        status: 'idle',
        timelineSessionId: canonicalSessionId,
        revision: 3,
      })
    })

    await waitFor(() => {
      expect(getAgentTimelinePage).toHaveBeenNthCalledWith(
        3,
        canonicalSessionId,
        expect.objectContaining({ priority: 'visible', includeBodies: true, revision: 3 }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    })
  })

  it('restores a persisted pane through the canonical durable id after restart when the sdk session id is stale, then immediately recovers', async () => {
    const canonicalSessionId = '00000000-0000-4000-8000-000000000778'
    getAgentTimelinePage.mockResolvedValue({
      sessionId: canonicalSessionId,
      items: [
        {
          turnId: 'turn-durable-1',
          sessionId: canonicalSessionId,
          role: 'user',
          summary: 'Recovered durable question',
          timestamp: '2026-03-10T10:00:00.000Z',
        },
        {
          turnId: 'turn-durable-2',
          sessionId: canonicalSessionId,
          role: 'assistant',
          summary: 'Recovered durable answer',
          timestamp: '2026-03-10T10:00:20.000Z',
        },
      ],
      nextCursor: null,
      revision: 5,
      bodies: {
        'turn-durable-1': {
          sessionId: canonicalSessionId,
          turnId: 'turn-durable-1',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Recovered durable question' }],
            timestamp: '2026-03-10T10:00:00.000Z',
          },
        },
        'turn-durable-2': {
          sessionId: canonicalSessionId,
          turnId: 'turn-durable-2',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Recovered durable answer' }],
            timestamp: '2026-03-10T10:00:20.000Z',
          },
        },
      },
    })

    const store = makeStore()
    store.dispatch(initLayout({
      tabId: 't1',
      paneId: 'p1',
      content: {
        kind: 'agent-chat',
        provider: 'freshclaude',
        createRequestId: 'req-restart',
        sessionId: 'sdk-stale-778',
        resumeSessionId: canonicalSessionId,
        status: 'idle',
      },
    }))

    render(
      <Provider store={store}>
        <ReactivePane store={store} />
      </Provider>,
    )

    await waitFor(() => {
      expect(wsSend).toHaveBeenCalledWith({
        type: 'sdk.attach',
        sessionId: 'sdk-stale-778',
        resumeSessionId: canonicalSessionId,
      })
    })
    wsSend.mockClear()

    act(() => {
      handleSdkMessage(store.dispatch, {
        type: 'sdk.session.snapshot',
        sessionId: 'sdk-stale-778',
        latestTurnId: 'turn-durable-2',
        status: 'idle',
        timelineSessionId: canonicalSessionId,
        revision: 5,
      })
      handleSdkMessage(store.dispatch, {
        type: 'sdk.error',
        sessionId: 'sdk-stale-778',
        code: 'INVALID_SESSION_ID',
        message: 'SDK session not found',
      })
    })

    await waitFor(() => {
      expect(getAgentTimelinePage).toHaveBeenCalledWith(
        canonicalSessionId,
        expect.objectContaining({ priority: 'visible', includeBodies: true, revision: 5 }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    })

    await waitFor(() => {
      const renderedMessages = screen.getAllByRole('article')
        .map((node) => node.textContent?.replace(/\s+/g, ' ').trim())
      expect(renderedMessages).toEqual([
        'Recovered durable question',
        'Recovered durable answer',
      ])
    })

    await waitFor(() => {
      expect(wsSend).toHaveBeenCalledWith(expect.objectContaining({
        type: 'sdk.create',
        resumeSessionId: canonicalSessionId,
      }))
    })

    const pane = findLeaf(store.getState().panes.layouts.t1!, 'p1')
    expect(pane?.content.kind === 'agent-chat' ? pane.content.resumeSessionId : undefined).toBe(canonicalSessionId)
    expect(pane?.content.kind === 'agent-chat' ? pane.content.sessionId : undefined).toBeUndefined()
  })
})
