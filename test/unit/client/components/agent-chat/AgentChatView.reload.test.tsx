import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider, useSelector } from 'react-redux'
import FreshAgentView from '@/components/fresh-agent/FreshAgentView'
import agentChatReducer from '@/store/agentChatSlice'
import freshAgentReducer from '@/store/freshAgentSlice'
import panesReducer, { initLayout } from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
import type { FreshAgentPaneContent } from '@/store/paneTypes'

const wsSend = vi.fn()
const wsOnMessage = vi.fn(() => () => {})
const getFreshAgentThreadSnapshot = vi.fn()

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsSend,
    onMessage: wsOnMessage,
    onReconnect: vi.fn(() => vi.fn()),
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getFreshAgentThreadSnapshot: (...args: unknown[]) => getFreshAgentThreadSnapshot(...args),
  }
})

function makeStore() {
  return configureStore({
    reducer: {
      agentChat: agentChatReducer,
      freshAgent: freshAgentReducer,
      panes: panesReducer,
      settings: settingsReducer,
    },
  })
}

function StoreBackedFreshAgentView({
  tabId,
  paneId,
}: {
  tabId: string
  paneId: string
}) {
  const paneContent = useSelector((state: ReturnType<ReturnType<typeof makeStore>['getState']>) => {
    const layout = state.panes.layouts[tabId]
    if (!layout || layout.type !== 'leaf' || layout.id !== paneId || layout.content.kind !== 'fresh-agent') {
      throw new Error(`Missing fresh-agent pane ${paneId}`)
    }
    return layout.content
  })
  return <FreshAgentView tabId={tabId} paneId={paneId} paneContent={paneContent} />
}

describe('FreshAgentView reload/restore behavior', () => {
  afterEach(() => {
    cleanup()
    wsSend.mockReset()
    wsOnMessage.mockReset()
    wsOnMessage.mockImplementation(() => () => {})
    getFreshAgentThreadSnapshot.mockReset()
  })

  it('attaches a persisted fresh-agent pane and hydrates from the canonical snapshot without sending freshAgent.create', async () => {
    getFreshAgentThreadSnapshot.mockResolvedValue({
      revision: 2,
      status: 'idle',
      summary: 'Recovered durable history',
      capabilities: { send: true, interrupt: true, fork: false },
      turns: [
        {
          id: 'turn-1',
          role: 'assistant',
          items: [{ id: 'item-1', kind: 'text', text: 'Hydrated from snapshot' }],
        },
      ],
    })

    const store = makeStore()
    const paneContent: FreshAgentPaneContent = {
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      createRequestId: 'req-reload',
      sessionId: 'sdk-session-1',
      resumeSessionId: 'cli-session-1',
      status: 'idle',
    }

    render(
      <Provider store={store}>
        <FreshAgentView tabId="t1" paneId="p1" paneContent={paneContent} />
      </Provider>,
    )

    await waitFor(() => {
      expect(wsSend).toHaveBeenCalledWith({
        type: 'freshAgent.attach',
        sessionId: 'sdk-session-1',
        sessionType: 'freshclaude',
        resumeSessionId: 'cli-session-1',
      })
      expect(getFreshAgentThreadSnapshot).toHaveBeenCalledWith(
        'claude',
        'sdk-session-1',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    })
    await waitFor(() => {
      expect(screen.getByText('Recovered durable history')).toBeInTheDocument()
      expect(screen.getByText('Hydrated from snapshot')).toBeInTheDocument()
    })

    expect(wsSend).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'freshAgent.create' }))
  })

  it('shows create failure retry UI and only retries freshAgent.create on click', async () => {
    const store = makeStore()
    store.dispatch(initLayout({
      tabId: 't1',
      paneId: 'p1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-create-failed',
        status: 'creating',
        resumeSessionId: 'cli-session-1',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="t1" paneId="p1" />
      </Provider>,
    )

    await waitFor(() => {
      const createCalls = wsSend.mock.calls.filter((call) => call[0]?.type === 'freshAgent.create')
      expect(createCalls).toHaveLength(1)
      expect(createCalls[0]?.[0]).toEqual(expect.objectContaining({
        requestId: 'req-create-failed',
        resumeSessionId: 'cli-session-1',
      }))
    })

    const onMessage = wsOnMessage.mock.calls[0]?.[0]
    expect(onMessage).toBeTypeOf('function')

    act(() => {
      onMessage({
        type: 'freshAgent.create.failed',
        requestId: 'req-create-failed',
        code: 'RESTORE_INTERNAL',
        message: 'Restore bootstrap failed',
        retryable: true,
      })
    })

    expect(await screen.findByText('Restore bootstrap failed')).toBeInTheDocument()

    const createCallsAfterFailure = wsSend.mock.calls.filter((call) => call[0]?.type === 'freshAgent.create')
    expect(createCallsAfterFailure).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => {
      const createCalls = wsSend.mock.calls.filter((call) => call[0]?.type === 'freshAgent.create')
      expect(createCalls).toHaveLength(2)
    })
  })

  it('refreshes the visible transcript when a matching fresh-agent live event arrives after reload', async () => {
    getFreshAgentThreadSnapshot
      .mockResolvedValueOnce({
        revision: 1,
        status: 'idle',
        summary: 'Initial snapshot',
        capabilities: { send: true, interrupt: true, fork: false },
        turns: [
          {
            id: 'turn-1',
            role: 'assistant',
            items: [{ id: 'item-1', kind: 'text', text: 'Before live update' }],
          },
        ],
      })
      .mockResolvedValueOnce({
        revision: 2,
        status: 'running',
        summary: 'Updated snapshot',
        capabilities: { send: true, interrupt: true, fork: false },
        turns: [
          {
            id: 'turn-1',
            role: 'assistant',
            items: [{ id: 'item-1', kind: 'text', text: 'After live update' }],
          },
        ],
      })

    const store = makeStore()

    render(
      <Provider store={store}>
        <FreshAgentView
          tabId="t1"
          paneId="p1"
          paneContent={{
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            createRequestId: 'req-live',
            sessionId: 'sdk-session-live',
            resumeSessionId: 'cli-session-live',
            status: 'idle',
          }}
        />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByText('Before live update')).toBeInTheDocument()
    })

    const onMessage = wsOnMessage.mock.calls[0]?.[0]
    expect(onMessage).toBeTypeOf('function')

    act(() => {
      onMessage({
        type: 'freshAgent.event',
        sessionId: 'sdk-session-live',
        event: { kind: 'thread.updated' },
      })
    })

    await waitFor(() => {
      expect(getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      expect(screen.getByText('After live update')).toBeInTheDocument()
      expect(screen.queryByText('Before live update')).not.toBeInTheDocument()
    })
  })
})
