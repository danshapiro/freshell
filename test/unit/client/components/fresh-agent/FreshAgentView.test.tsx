import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import panesReducer from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
import freshAgentReducer from '@/store/freshAgentSlice'
import agentChatReducer from '@/store/agentChatSlice'
import { FreshAgentView } from '@/components/fresh-agent/FreshAgentView'
import { initLayout } from '@/store/panesSlice'
import { useAppSelector } from '@/store/hooks'
import { sessionInit, setSessionStatus } from '@/store/agentChatSlice'

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

vi.mock('@/components/agent-chat/AgentChatView', () => ({
  default: ({ paneContent }: { paneContent: { provider: string } }) => <div>agent:{paneContent.provider}</div>,
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

function StoreBackedFreshAgentView({
  tabId,
  paneId,
}: {
  tabId: string
  paneId: string
}) {
  const paneContent = useAppSelector((state) => {
    const layout = state.panes.layouts[tabId]
    if (!layout || layout.type !== 'leaf' || layout.id !== paneId || layout.content.kind !== 'fresh-agent') {
      throw new Error(`Missing fresh-agent pane ${paneId}`)
    }
    return layout.content
  })
  return <FreshAgentView tabId={tabId} paneId={paneId} paneContent={paneContent} />
}

beforeEach(() => {
  wsMock.send.mockReset()
  wsMock.onMessage.mockReset()
  wsMock.onMessage.mockImplementation(() => () => {})
  apiMock.getFreshAgentThreadSnapshot.mockReset()
  apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({
    status: 'idle',
    summary: 'Codex summary',
    capabilities: { send: true, interrupt: true, fork: true },
    diffs: [{ id: 'diff-1', title: 'README.md' }],
    worktrees: [{ id: 'wt-1', path: '/tmp/worktree', branch: 'feature/x' }],
    turns: [{ id: 'turn-1', role: 'assistant', items: [{ id: 'item-1', kind: 'text', text: 'Codex turn' }] }],
  })
})

afterEach(() => {
  cleanup()
})

describe('FreshAgentView', () => {
  it('renders freshclaude in the shared shell and answers approvals/questions over fresh-agent WS', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
      status: 'running',
      summary: 'Claude summary',
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

    render(
      <Provider store={store}>
        <FreshAgentView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={{
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            createRequestId: 'req-1',
            sessionId: 'claude-thread-1',
            status: 'connected',
          }}
        />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByText('Claude summary')).toBeInTheDocument()
    })
    expect(screen.queryByText('agent:freshclaude')).not.toBeInTheDocument()

    const permissionBanner = screen.getByRole('alert', { name: /permission request for bash/i })
    expect(permissionBanner).toHaveTextContent('echo hello-from-fresh-agent')
    fireEvent.click(screen.getByRole('button', { name: /allow tool use/i }))

    const questionBanner = screen.getByRole('region', { name: /question from claude/i })
    expect(questionBanner).toHaveTextContent('How should Claude proceed?')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(wsMock.send).toHaveBeenCalledWith({
      type: 'freshAgent.approval.respond',
      sessionId: 'claude-thread-1',
      sessionType: 'freshclaude',
      provider: 'claude',
      requestId: 'approval-1',
      decision: { behavior: 'allow', updatedInput: {} },
    })
    expect(wsMock.send).toHaveBeenCalledWith({
      type: 'freshAgent.question.respond',
      sessionId: 'claude-thread-1',
      sessionType: 'freshclaude',
      provider: 'claude',
      requestId: 'question-1',
      answers: { 'How should Claude proceed?': 'Continue' },
    })
  })

  it('renders Codex review and fork metadata in the shared shell', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
      status: 'running',
      summary: 'Codex summary',
      capabilities: { send: false, interrupt: false, questions: true, fork: false },
      pendingQuestions: [{
        requestId: 'question-codex',
        questions: [{
          header: 'Choose path',
          question: 'How should Codex continue?',
          options: [
            { label: 'Patch', description: 'Apply the diff' },
            { label: 'Explain', description: 'Describe the change' },
          ],
          multiSelect: false,
        }],
      }],
      diffs: [{ id: 'diff-1', title: 'README.md' }],
      worktrees: [{ id: 'wt-1', path: '/tmp/worktree', branch: 'feature/x' }],
      extensions: {
        codex: {
          review: { id: 'review-1', status: 'pending' },
          fork: { parentThreadId: 'thread-parent-1' },
        },
      },
      turns: [{ id: 'turn-1', role: 'assistant', items: [{ id: 'item-1', kind: 'text', text: 'Codex turn' }] }],
    })

    render(
      <Provider store={store}>
        <FreshAgentView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={{
            kind: 'fresh-agent',
            sessionType: 'freshcodex',
            provider: 'codex',
            createRequestId: 'req-2',
            sessionId: 'thread-1',
            status: 'connected',
          }}
        />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByText('Codex summary')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Fork' })).toBeDisabled()
    expect(screen.getByText('README.md')).toBeInTheDocument()
    expect(screen.getByText(/feature\/x/)).toBeInTheDocument()
    expect(screen.getByText('Review')).toBeInTheDocument()
    expect(screen.getByText('review-1')).toBeInTheDocument()
    expect(screen.getByText('pending')).toBeInTheDocument()
    expect(screen.getByText('Fork lineage')).toBeInTheDocument()
    expect(screen.getByText('thread-parent-1')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: /question from codex/i })).toHaveTextContent('Codex has a question')
  })

  it('acquires a session id for a new non-Claude fresh-agent pane after freshAgent.created', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-create',
        status: 'creating',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    expect(wsMock.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'freshAgent.create',
      requestId: 'req-create',
      sessionType: 'freshcodex',
      provider: 'codex',
    }))

    const onMessage = wsMock.onMessage.mock.calls[0]?.[0]
    expect(onMessage).toBeTypeOf('function')
    onMessage({
      type: 'freshAgent.created',
      requestId: 'req-create',
      sessionId: 'thread-created',
      sessionType: 'freshcodex',
      provider: 'codex',
      runtimeProvider: 'codex',
    })

    await waitFor(() => {
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledWith('freshcodex', 'codex', 'thread-created', expect.any(Object))
    })
  })

  it('sends, interrupts, and forks through fresh-agent WS actions when the capability is available', async () => {
    const store = createStore()
    render(
      <Provider store={store}>
        <FreshAgentView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={{
            kind: 'fresh-agent',
            sessionType: 'freshcodex',
            provider: 'codex',
            createRequestId: 'req-2',
            sessionId: 'thread-1',
            status: 'running',
          }}
        />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByText('Codex summary')).toBeInTheDocument()
    })

    wsMock.send.mockClear()

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'Ship it' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(wsMock.send).toHaveBeenCalledWith({
      type: 'freshAgent.send',
      sessionId: 'thread-1',
      sessionType: 'freshcodex',
      provider: 'codex',
      text: 'Ship it',
    })

    fireEvent.click(screen.getByRole('button', { name: 'Interrupt' }))
    expect(wsMock.send).toHaveBeenCalledWith({
      type: 'freshAgent.interrupt',
      sessionId: 'thread-1',
      sessionType: 'freshcodex',
      provider: 'codex',
    })

    fireEvent.click(screen.getByRole('button', { name: 'Fork' }))
    expect(wsMock.send).toHaveBeenCalledWith({
      type: 'freshAgent.fork',
      sessionId: 'thread-1',
      sessionType: 'freshcodex',
      provider: 'codex',
    })
  })

  it('keeps an established freshclaude pane interactive after remount when snapshot loading is unavailable', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockRejectedValue(new TypeError('Failed to parse URL from /api/fresh-agent/threads/claude/sess-1'))
    store.dispatch(sessionInit({
      sessionId: 'sess-1',
      cliSessionId: 'cli-abc',
      model: 'claude-opus-4-6',
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))

    const paneContent = {
      kind: 'fresh-agent' as const,
      sessionType: 'freshclaude' as const,
      provider: 'claude' as const,
      createRequestId: 'req-remount',
      sessionId: 'sess-1',
      status: 'idle' as const,
      resumeSessionId: 'cli-abc',
    }

    const { unmount } = render(
      <Provider store={store}>
        <FreshAgentView tabId="tab-1" paneId="pane-1" paneContent={paneContent} />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByText('Ready')).toBeInTheDocument()
    })
    expect(screen.getByRole('textbox', { name: 'Chat message input' })).not.toBeDisabled()
    expect(screen.queryByText(/failed to parse url/i)).not.toBeInTheDocument()

    unmount()
    wsMock.send.mockClear()

    render(
      <Provider store={store}>
        <FreshAgentView tabId="tab-1" paneId="pane-1" paneContent={paneContent} />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByText('Ready')).toBeInTheDocument()
    })
    expect(screen.getByRole('textbox', { name: 'Chat message input' })).not.toBeDisabled()
    expect(wsMock.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'freshAgent.create' }))
    expect(screen.queryByText(/failed to parse url/i)).not.toBeInTheDocument()
  })

  it('recreates a lost freshclaude session through fresh-agent transport events with the durable resume id', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockRejectedValue(new TypeError('Failed to parse URL from /api/fresh-agent/threads/claude/dead-session-id'))
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-lost',
        sessionId: 'dead-session-id',
        status: 'idle',
        resumeSessionId: 'named-resume',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    const onMessage = wsMock.onMessage.mock.calls[0]?.[0]
    expect(onMessage).toBeTypeOf('function')

    act(() => {
      onMessage({
        type: 'freshAgent.event',
        sessionId: 'dead-session-id',
        sessionType: 'freshclaude',
        provider: 'claude',
        event: {
          type: 'sdk.session.snapshot',
          sessionId: 'dead-session-id',
          latestTurnId: 'turn-1',
          status: 'idle',
          timelineSessionId: 'cli-session-abc-123',
          revision: 2,
        },
      })
    })

    await waitFor(() => {
      expect(screen.getAllByText(/restoring/i).length).toBeGreaterThan(0)
    })
    expect(screen.queryByText(/failed to parse url/i)).not.toBeInTheDocument()

    act(() => {
      onMessage({
        type: 'freshAgent.event',
        sessionId: 'dead-session-id',
        sessionType: 'freshclaude',
        provider: 'claude',
        event: {
          type: 'sdk.error',
          sessionId: 'dead-session-id',
          code: 'INVALID_SESSION_ID',
          message: 'Session no longer exists',
        },
      })
    })

    await waitFor(() => {
      expect(wsMock.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'freshAgent.create',
        sessionType: 'freshclaude',
        provider: 'claude',
        resumeSessionId: 'cli-session-abc-123',
      }))
    })
  })

  it('shows the underlying snapshot-load error when a freshclaude restore has no session-state failure message', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockRejectedValueOnce(new Error('Stale restore revision'))

    render(
      <Provider store={store}>
        <FreshAgentView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={{
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            createRequestId: 'req-error',
            sessionId: 'claude-thread-restore',
            status: 'idle',
            resumeSessionId: 'claude-thread-restore',
          }}
        />
      </Provider>,
    )

    expect(await screen.findByText('Stale restore revision')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Stale restore revision')
  })
})
