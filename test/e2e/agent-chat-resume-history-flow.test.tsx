import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider, useSelector } from 'react-redux'
import AgentChatView from '@/components/agent-chat/AgentChatView'
import agentChatReducer from '@/store/agentChatSlice'
import panesReducer, { initLayout } from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
import type { AgentChatPaneContent, PaneNode } from '@/store/paneTypes'
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

function makeStore() {
  return configureStore({
    reducer: {
      agentChat: agentChatReducer,
      panes: panesReducer,
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
    getAgentTimelinePage.mockResolvedValue({
      sessionId: 'cli-session-1',
      items: [
        {
          turnId: 'turn-older-user',
          sessionId: 'cli-session-1',
          role: 'user',
          summary: 'Older question',
          timestamp: '2026-03-10T10:00:00.000Z',
        },
        {
          turnId: 'turn-older-assistant',
          sessionId: 'cli-session-1',
          role: 'assistant',
          summary: 'Older answer',
          timestamp: '2026-03-10T10:00:20.000Z',
        },
        {
          turnId: 'turn-new-user',
          sessionId: 'cli-session-1',
          role: 'user',
          summary: 'New prompt',
          timestamp: '2026-03-10T10:01:00.000Z',
        },
        {
          turnId: 'turn-new-assistant',
          sessionId: 'cli-session-1',
          role: 'assistant',
          summary: 'New reply',
          timestamp: '2026-03-10T10:01:20.000Z',
        },
      ],
      nextCursor: null,
      revision: 4,
      bodies: {
        'turn-older-user': {
          sessionId: 'cli-session-1',
          turnId: 'turn-older-user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Older durable question' }],
            timestamp: '2026-03-10T10:00:00.000Z',
          },
        },
        'turn-older-assistant': {
          sessionId: 'cli-session-1',
          turnId: 'turn-older-assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Older durable answer' }],
            timestamp: '2026-03-10T10:00:20.000Z',
          },
        },
        'turn-new-user': {
          sessionId: 'cli-session-1',
          turnId: 'turn-new-user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'New live prompt' }],
            timestamp: '2026-03-10T10:01:00.000Z',
          },
        },
        'turn-new-assistant': {
          sessionId: 'cli-session-1',
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
        resumeSessionId: 'cli-session-1',
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
      resumeSessionId: 'cli-session-1',
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
        timelineSessionId: 'cli-session-1',
      })
    })

    expect(screen.getByText(/restoring session/i)).toBeInTheDocument()

    await waitFor(() => {
      expect(getAgentTimelinePage).toHaveBeenCalledWith(
        'cli-session-1',
        expect.objectContaining({ priority: 'visible', includeBodies: true }),
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

  it('upgrades a live-only named resume in place to the canonical durable id after the first visible timeline read', async () => {
    const canonicalSessionId = '00000000-0000-4000-8000-000000000777'
    getAgentTimelinePage
      .mockResolvedValueOnce({
        sessionId: 'named-resume',
        items: [
          {
            turnId: 'turn-live-1',
            sessionId: 'named-resume',
            role: 'assistant',
            summary: 'Live-only reply',
            timestamp: '2026-03-10T10:01:20.000Z',
          },
        ],
        nextCursor: null,
        revision: 1,
        bodies: {
          'turn-live-1': {
            sessionId: 'named-resume',
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
            turnId: 'turn-durable-1',
            sessionId: canonicalSessionId,
            role: 'user',
            summary: 'Older durable question',
            timestamp: '2026-03-10T10:00:00.000Z',
          },
          {
            turnId: 'turn-durable-2',
            sessionId: canonicalSessionId,
            role: 'assistant',
            summary: 'Older durable answer',
            timestamp: '2026-03-10T10:00:20.000Z',
          },
          {
            turnId: 'turn-live-1',
            sessionId: canonicalSessionId,
            role: 'assistant',
            summary: 'Live delta',
            timestamp: '2026-03-10T10:01:20.000Z',
          },
        ],
        nextCursor: null,
        revision: 2,
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
          'turn-live-1': {
            sessionId: canonicalSessionId,
            turnId: 'turn-live-1',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Live-only full body' }],
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
        timelineSessionId: 'named-resume',
        revision: 1,
      })
    })

    await waitFor(() => {
      expect(getAgentTimelinePage).toHaveBeenCalledWith(
        'named-resume',
        expect.objectContaining({ priority: 'visible', includeBodies: true, revision: 1 }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    })
    expect(await screen.findByText('Live-only full body')).toBeInTheDocument()

    act(() => {
      handleSdkMessage(store.dispatch, {
        type: 'sdk.session.metadata',
        sessionId: 'sdk-live-only',
        cliSessionId: canonicalSessionId,
      })
    })

    await waitFor(() => {
      const attachCalls = wsSend.mock.calls.filter((call) => call[0]?.type === 'sdk.attach')
      expect(attachCalls).toHaveLength(1)
      expect(attachCalls[0]?.[0]).toEqual({
        type: 'sdk.attach',
        sessionId: 'sdk-live-only',
      })
    })
    expect(getAgentTimelinePage).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Live-only full body')).not.toBeInTheDocument()

    act(() => {
      handleSdkMessage(store.dispatch, {
        type: 'sdk.session.snapshot',
        sessionId: 'sdk-live-only',
        latestTurnId: 'turn-live-1',
        status: 'idle',
        timelineSessionId: canonicalSessionId,
        revision: 2,
      })
    })

    await waitFor(() => {
      expect(getAgentTimelinePage).toHaveBeenCalledWith(
        canonicalSessionId,
        expect.objectContaining({ priority: 'visible', includeBodies: true, revision: 2 }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    })

    await waitFor(() => {
      const renderedMessages = screen.getAllByRole('article')
        .map((node) => node.textContent?.replace(/\s+/g, ' ').trim())
      expect(renderedMessages).toEqual([
        'Older durable question',
        'Older durable answer',
        'Live-only full body',
      ])
    })

    const pane = findLeaf(store.getState().panes.layouts.t1!, 'p1')
    expect(pane?.content.kind === 'agent-chat' ? pane.content.resumeSessionId : undefined).toBe(canonicalSessionId)
  })
})
