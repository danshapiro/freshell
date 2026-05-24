import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, act, waitFor, fireEvent } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider, useSelector } from 'react-redux'
import FreshAgentView from '@/components/fresh-agent/FreshAgentView'
import freshAgentReducer from '@/store/freshAgentSlice'
import agentChatReducer from '@/store/agentChatSlice'
import panesReducer, { initLayout } from '@/store/panesSlice'
import tabsReducer from '@/store/tabsSlice'
import settingsReducer from '@/store/settingsSlice'
import type { FreshAgentPaneContent, PaneNode } from '@/store/paneTypes'

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
    return leaf?.content.kind === 'fresh-agent' ? leaf.content : undefined
  })

  if (!content) return null
  return <FreshAgentView tabId="t1" paneId="p1" paneContent={content} />
}

describe('fresh-agent resume history flow', () => {
  afterEach(() => {
    cleanup()
    wsSend.mockReset()
    wsOnMessage.mockReset()
    wsOnMessage.mockImplementation(() => () => {})
    getFreshAgentThreadSnapshot.mockReset()
  })

  it('creates a resumed freshclaude pane through freshAgent.create and hydrates from the fresh-agent snapshot', async () => {
    const canonicalSessionId = '00000000-0000-4000-8000-000000000441'
    getFreshAgentThreadSnapshot.mockResolvedValue({
      revision: 4,
      status: 'idle',
      summary: 'Hydrated fresh-agent history',
      capabilities: { send: true, interrupt: true, approvals: false, questions: false, fork: false },
      turns: [{
        id: 'turn-new-assistant',
        role: 'assistant',
        items: [{ id: 'item-1', kind: 'text', text: 'Hydrated from durable history' }],
      }],
    })

    const store = makeStore()
    store.dispatch(initLayout({
      tabId: 't1',
      paneId: 'p1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-resume',
        status: 'creating',
        resumeSessionId: canonicalSessionId,
      } satisfies FreshAgentPaneContent,
    }))

    render(
      <Provider store={store}>
        <ReactivePane store={store} />
      </Provider>,
    )

    expect(wsSend).toHaveBeenCalledWith(expect.objectContaining({
      type: 'freshAgent.create',
      requestId: 'req-resume',
      sessionType: 'freshclaude',
      provider: 'claude',
      resumeSessionId: canonicalSessionId,
    }))

    const onMessage = wsOnMessage.mock.calls[0]?.[0]
    expect(onMessage).toBeTypeOf('function')

    act(() => {
      onMessage({
        type: 'freshAgent.created',
        requestId: 'req-resume',
        sessionId: 'sdk-sess-1',
        sessionType: 'freshclaude',
        provider: 'claude',
        runtimeProvider: 'claude',
      })
    })

    await waitFor(() => {
      expect(getFreshAgentThreadSnapshot).toHaveBeenCalledWith(
        'freshclaude',
        'claude',
        canonicalSessionId,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    })
    await waitFor(() => {
      expect(screen.getByText('Hydrated fresh-agent history')).toBeInTheDocument()
      expect(screen.getByText('Hydrated from durable history')).toBeInTheDocument()
    })
  })

  it('restores an existing freshclaude pane by reading the canonical durable snapshot instead of sending sdk.attach', async () => {
    getFreshAgentThreadSnapshot.mockResolvedValue({
      revision: 5,
      status: 'idle',
      summary: 'Recovered durable history',
      capabilities: { send: true, interrupt: true, approvals: false, questions: false, fork: false },
      turns: [
        {
          id: 'turn-durable-1',
          role: 'user',
          items: [{ id: 'item-1', kind: 'text', text: 'Recovered durable question' }],
        },
        {
          id: 'turn-durable-2',
          role: 'assistant',
          items: [{ id: 'item-2', kind: 'text', text: 'Recovered durable answer' }],
        },
      ],
    })

    const canonicalSessionId = '00000000-0000-4000-8000-000000000778'
    const store = makeStore()
    store.dispatch(initLayout({
      tabId: 't1',
      paneId: 'p1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-restart',
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
      expect(screen.getByText('Recovered durable question')).toBeInTheDocument()
      expect(screen.getByText('Recovered durable answer')).toBeInTheDocument()
    })
    expect(wsSend).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'sdk.attach' }))
  })

  it('answers freshclaude approvals and questions through the fresh-agent transport', async () => {
    getFreshAgentThreadSnapshot.mockResolvedValue({
      revision: 1,
      status: 'running',
      summary: 'Approval flow',
      capabilities: { send: true, interrupt: true, approvals: true, questions: true, fork: false },
      pendingApprovals: [{
        requestId: 'approval-1',
        toolName: 'Bash',
        input: { command: 'echo hello-from-fresh-agent' },
      }],
      pendingQuestions: [{
        requestId: 'question-1',
        questions: [{
          header: 'Approve plan',
          question: 'How should Claude proceed?',
          options: [
            { label: 'Continue', description: 'Keep going' },
            { label: 'Stop', description: 'Pause the task' },
          ],
          multiSelect: false,
        }],
      }],
      turns: [],
    })

    const canonicalSessionId = '00000000-0000-4000-8000-000000000991'
    const store = makeStore()
    store.dispatch(initLayout({
      tabId: 't1',
      paneId: 'p1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-approval',
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
      expect(screen.getByRole('alert', { name: /permission request for bash/i })).toBeInTheDocument()
      expect(screen.getByRole('region', { name: /question from claude/i })).toBeInTheDocument()
    })

    wsSend.mockClear()
    fireEvent.click(screen.getByRole('button', { name: /allow tool use/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(wsSend).toHaveBeenCalledWith({
      type: 'freshAgent.approval.respond',
      sessionId: canonicalSessionId,
      sessionType: 'freshclaude',
      provider: 'claude',
      requestId: 'approval-1',
      decision: { behavior: 'allow', updatedInput: {} },
    })
    expect(wsSend).toHaveBeenCalledWith({
      type: 'freshAgent.question.respond',
      sessionId: canonicalSessionId,
      sessionType: 'freshclaude',
      provider: 'claude',
      requestId: 'question-1',
      answers: { 'How should Claude proceed?': 'Continue' },
    })
  })
})
