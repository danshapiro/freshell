import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import panesReducer from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
import freshAgentReducer from '@/store/freshAgentSlice'
import agentChatReducer from '@/store/agentChatSlice'
import { FreshAgentView } from '@/components/fresh-agent/FreshAgentView'
import { FreshAgentSettingsButton } from '@/components/fresh-agent/FreshAgentSettingsButton'
import { initLayout, requestPaneRefresh } from '@/store/panesSlice'
import { useAppSelector } from '@/store/hooks'
import { sessionInit, setSessionStatus } from '@/store/agentChatSlice'
import type { PaneNode } from '@/store/paneTypes'

const CLAUDE_THREAD_ID = '550e8400-e29b-41d4-a716-446655440000'
const CLAUDE_RESTORE_THREAD_ID = '550e8400-e29b-41d4-a716-446655440001'

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

function StoreBackedFreshAgentSettingsButton({
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
  return <FreshAgentSettingsButton tabId={tabId} paneId={paneId} paneContent={paneContent} />
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
            sessionId: CLAUDE_THREAD_ID,
            status: 'connected',
          }}
        />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByRole('alert', { name: /permission request for bash/i })).toBeInTheDocument()
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
      sessionId: CLAUDE_THREAD_ID,
      sessionType: 'freshclaude',
      provider: 'claude',
      requestId: 'approval-1',
      decision: { behavior: 'allow', updatedInput: {} },
    })
    expect(wsMock.send).toHaveBeenCalledWith({
      type: 'freshAgent.question.respond',
      sessionId: CLAUDE_THREAD_ID,
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
      expect(screen.getByText('Codex turn')).toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: 'Interrupt' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Fork' })).not.toBeInTheDocument()
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
      model: 'gpt-5.5',
      effort: 'xhigh',
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

  it('sends through fresh-agent WS actions with pane settings when available', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-2',
        sessionId: 'thread-1',
        status: 'idle',
        initialCwd: '/repo',
        model: 'gpt-5.3-codex-spark',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByText('Codex turn')).toBeInTheDocument()
    })

    wsMock.send.mockClear()

    expect(screen.queryByRole('radio', { name: 'GPT-5.5' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Thinking level' })).not.toBeInTheDocument()

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
      settings: {
        cwd: '/repo',
        model: 'gpt-5.3-codex-spark',
        effort: 'xhigh',
      },
    })

    expect(screen.queryByRole('button', { name: 'Interrupt' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Fork' })).not.toBeInTheDocument()
  })

  it('shows provider slash commands from the command menu without hidden aliases', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-slash-menu',
        sessionId: 'thread-slash-menu',
        status: 'idle',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Slash commands' })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Slash commands' }))

    expect(screen.getByRole('menu', { name: 'Slash commands' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /\/new/i })).toHaveTextContent('Start a new conversation')
    expect(screen.getByRole('menuitem', { name: /\/compact/i })).toHaveTextContent('compact')
    expect(screen.queryByText('/reset')).not.toBeInTheDocument()
    expect(screen.queryByText('/compress')).not.toBeInTheDocument()
  })

  it('runs slash command aliases without listing them', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-reset-alias',
        sessionId: 'thread-reset-alias',
        status: 'idle',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => expect(screen.getByText('Codex turn')).toBeInTheDocument())
    wsMock.send.mockClear()

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: '/reset' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(wsMock.send).toHaveBeenCalledWith({
      type: 'freshAgent.kill',
      sessionId: 'thread-reset-alias',
      sessionType: 'freshcodex',
      provider: 'codex',
    })
    await waitFor(() => {
      expect(wsMock.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'freshAgent.create',
        sessionType: 'freshcodex',
        provider: 'codex',
      }))
    })

    const leaf = store.getState().panes.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
    expect(leaf.content.kind).toBe('fresh-agent')
    if (leaf.content.kind === 'fresh-agent') {
      expect(leaf.content.sessionId).toBeUndefined()
      expect(leaf.content.resumeSessionId).toBeUndefined()
      expect(leaf.content.createRequestId).not.toBe('req-reset-alias')
      expect(leaf.content.status).toBe('creating')
    }
  })

  it('dispatches slash compact with optional instructions over the fresh-agent channel', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-compact',
        sessionId: 'freshopencode-req-compact',
        status: 'idle',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Chat message input' })).not.toBeDisabled())
    wsMock.send.mockClear()

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: '/compact keep implementation notes' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(wsMock.send).toHaveBeenCalledWith({
      type: 'freshAgent.compact',
      sessionId: 'freshopencode-req-compact',
      sessionType: 'freshopencode',
      provider: 'opencode',
      instructions: 'keep implementation notes',
    })
  })

  it('lets Freshcodex settings choose model and thinking substrings verbatim from the gear popover', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-flash',
        sessionId: 'thread-flash',
        status: 'idle',
        model: 'gpt-5.5',
        effort: 'xhigh',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentSettingsButton tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), {
      target: { value: 'gpt-5.4-flash' },
    })
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('gpt-5.4-flash')
    })

    const thinking = screen.getByRole('combobox', { name: 'Thinking level' })
    expect(thinking).toHaveValue('high')
    expect(screen.queryByRole('option', { name: 'xhigh' })).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'high' })).toBeInTheDocument()

    const layout = store.getState().panes.layouts['tab-1']
    expect(layout?.type).toBe('leaf')
    expect(layout?.type === 'leaf' && layout.content.kind === 'fresh-agent' ? layout.content.model : null).toBe('gpt-5.4-flash')
    expect(layout?.type === 'leaf' && layout.content.kind === 'fresh-agent' ? layout.content.effort : null).toBe('high')
  })

  it('lets Freshopencode settings choose model and thinking controls from the gear popover', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-opencode',
        sessionId: 'freshopencode-req-opencode',
        status: 'idle',
        initialCwd: '/repo',
        model: 'opencode-go/deepseek-v4-flash',
        effort: 'max',
      },
    }))
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
      status: 'idle',
      summary: 'OpenCode summary',
      capabilities: { send: true, interrupt: true, fork: false },
      turns: [],
    })

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentSettingsButton tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('opencode-go/deepseek-v4-flash')
    expect(screen.getByRole('combobox', { name: 'Thinking level' })).toHaveValue('max')

    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), {
      target: { value: 'opencode-go/glm-5.1' },
    })
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('opencode-go/glm-5.1')
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Thinking level' }), {
      target: { value: 'high' },
    })

    const layout = store.getState().panes.layouts['tab-1']
    expect(layout?.type).toBe('leaf')
    expect(layout?.type === 'leaf' && layout.content.kind === 'fresh-agent' ? layout.content.model : null)
      .toBe('opencode-go/glm-5.1')
    expect(layout?.type === 'leaf' && layout.content.kind === 'fresh-agent' ? layout.content.effort : null).toBe('high')
  })

  it('promotes Freshopencode placeholders to durable OpenCode session ids from snapshots', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
      sessionId: 'ses_real_opencode_1',
      status: 'idle',
      summary: 'OpenCode summary',
      capabilities: { send: true, interrupt: true, fork: false },
      turns: [],
    })
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-opencode',
        sessionId: 'freshopencode-req-opencode',
        status: 'idle',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      const paneContent = (store.getState().panes.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).content
      expect(paneContent.kind).toBe('fresh-agent')
      if (paneContent.kind === 'fresh-agent') {
        expect(paneContent.sessionId).toBe('ses_real_opencode_1')
        expect(paneContent.sessionRef).toEqual({ provider: 'opencode', sessionId: 'ses_real_opencode_1' })
        expect(paneContent.resumeSessionId).toBe('ses_real_opencode_1')
      }
    })
  })

  it('refreshes an existing fresh-agent pane by reattaching and reloading the snapshot', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-refresh',
        sessionId: 'thread-refresh',
        status: 'idle',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledWith('freshcodex', 'codex', 'thread-refresh', expect.any(Object))
    })
    apiMock.getFreshAgentThreadSnapshot.mockClear()
    wsMock.send.mockClear()

    store.dispatch(requestPaneRefresh({ tabId: 'tab-1', paneId: 'pane-1' }))

    await waitFor(() => {
      expect(wsMock.send).toHaveBeenCalledWith({
        type: 'freshAgent.attach',
        sessionId: 'thread-refresh',
        sessionType: 'freshcodex',
        provider: 'codex',
        resumeSessionId: 'thread-refresh',
      })
    })
    await waitFor(() => {
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledWith('freshcodex', 'codex', 'thread-refresh', expect.any(Object))
    })
    expect(store.getState().panes.refreshRequestsByPane?.['tab-1']?.['pane-1']).toBeUndefined()
  })

  it('normalizes obsolete Freshcodex models to the default radio option', async () => {
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
            createRequestId: 'req-custom-model',
            sessionId: 'thread-1',
            status: 'idle',
            model: 'custom-codex-model',
          }}
        />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByText('Codex turn')).toBeInTheDocument()
    })

    expect(screen.getByText('Codex turn')).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: 'GPT-5.5' })).not.toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: 'custom-codex-model' })).not.toBeInTheDocument()
  })

  it('normalizes stale Freshcodex thinking effort before create and send', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-stale-effort',
        status: 'creating',
        effort: 'max',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    expect(wsMock.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'freshAgent.create',
      requestId: 'req-stale-effort',
      effort: 'xhigh',
    }))

    const onMessage = wsMock.onMessage.mock.calls[0]?.[0]
    expect(onMessage).toBeTypeOf('function')
    act(() => {
      onMessage({
        type: 'freshAgent.created',
        requestId: 'req-stale-effort',
        sessionId: 'thread-stale-effort',
        sessionType: 'freshcodex',
        provider: 'codex',
        runtimeProvider: 'codex',
      })
    })

    await waitFor(() => expect(screen.getByText('Codex turn')).toBeInTheDocument())
    wsMock.send.mockClear()

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'reply ok' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(wsMock.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'freshAgent.send',
      settings: expect.objectContaining({ effort: 'xhigh' }),
    }))
  })

  it('switches the pane to the forked Freshcodex thread when the server reports fork success', async () => {
    const store = createStore()
    let onMessage: ((message: Record<string, unknown>) => void) | undefined
    wsMock.onMessage.mockImplementation((handler) => {
      onMessage = handler
      return () => {}
    })
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-2',
        sessionId: 'thread-1',
        status: 'idle',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(onMessage).toBeTypeOf('function')
    })

    act(() => {
      onMessage?.({
        type: 'freshAgent.forked',
        requestId: 'req-2',
        parentSessionId: 'thread-1',
        sessionId: 'thread-forked',
        sessionType: 'freshcodex',
        provider: 'codex',
        runtimeProvider: 'codex',
      })
    })

    await waitFor(() => {
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledWith('freshcodex', 'codex', 'thread-forked', expect.any(Object))
    })
    const layout = store.getState().panes.layouts['tab-1']
    expect(layout?.type).toBe('leaf')
    if (layout?.type !== 'leaf' || layout.content.kind !== 'fresh-agent') {
      throw new Error('Expected fresh-agent leaf')
    }
    expect(layout.content.sessionId).toBe('thread-forked')
    expect(layout.content.sessionRef).toEqual({ provider: 'codex', sessionId: 'thread-forked' })
    expect(layout.content.createRequestId).not.toBe('req-2')
    expect(wsMock.send).toHaveBeenCalledWith({
      type: 'freshAgent.kill',
      sessionId: 'thread-1',
      sessionType: 'freshcodex',
      provider: 'codex',
    })
  })

  it('ignores Freshcodex fork responses for a different pane request', async () => {
    const store = createStore()
    let onMessage: ((message: Record<string, unknown>) => void) | undefined
    wsMock.onMessage.mockImplementation((handler) => {
      onMessage = handler
      return () => {}
    })
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-this-pane',
        sessionId: 'thread-1',
        status: 'idle',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(onMessage).toBeTypeOf('function')
    })
    wsMock.send.mockClear()

    act(() => {
      onMessage?.({
        type: 'freshAgent.forked',
        requestId: 'req-other-pane',
        parentSessionId: 'thread-1',
        sessionId: 'thread-forked',
        sessionType: 'freshcodex',
        provider: 'codex',
        runtimeProvider: 'codex',
      })
    })

    const layout = store.getState().panes.layouts['tab-1']
    expect(layout?.type).toBe('leaf')
    if (layout?.type !== 'leaf' || layout.content.kind !== 'fresh-agent') {
      throw new Error('Expected fresh-agent leaf')
    }
    expect(layout.content.sessionId).toBe('thread-1')
    expect(wsMock.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'freshAgent.kill',
      sessionId: 'thread-1',
    }))
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
      expect(screen.getByRole('textbox', { name: 'Chat message input' })).not.toBeDisabled()
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
      expect(screen.getByRole('textbox', { name: 'Chat message input' })).not.toBeDisabled()
    })
    expect(screen.getByRole('textbox', { name: 'Chat message input' })).not.toBeDisabled()
    expect(wsMock.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'freshAgent.create' }))
    expect(screen.queryByText(/failed to parse url/i)).not.toBeInTheDocument()
  })

  it('recreates a lost freshclaude session through fresh-agent transport events with the durable resume id', async () => {
    const store = createStore()
    const durableSessionId = '00000000-0000-4000-8000-000000000441'
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
          timelineSessionId: durableSessionId,
          revision: 2,
        },
      })
    })

    await waitFor(() => {
      const layout = store.getState().panes.layouts['tab-1']
      expect(layout?.type === 'leaf' && layout.content.kind === 'fresh-agent'
        ? layout.content.resumeSessionId
        : null).toBe(durableSessionId)
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
        resumeSessionId: durableSessionId,
        effort: 'max',
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
            sessionId: CLAUDE_RESTORE_THREAD_ID,
            status: 'idle',
            resumeSessionId: CLAUDE_RESTORE_THREAD_ID,
          }}
        />
      </Provider>,
    )

    expect(await screen.findByText('Stale restore revision')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Stale restore revision')
  })

  it('renders restoreError pane and suppresses automatic freshAgent.create', () => {
    const store = createStore()
    render(
      <Provider store={store}>
        <FreshAgentView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={{
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            createRequestId: 'req-restore-error',
            status: 'create-failed',
            restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'missing_canonical_identity' },
          }}
        />
      </Provider>,
    )

    expect(wsMock.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'freshAgent.create' }))
    expect(wsMock.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'freshAgent.attach' }))
  })

  it('recovers using sessionRef.sessionId for a pane with only sessionRef', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-sessionref-only',
        status: 'creating',
        sessionRef: { provider: 'codex', sessionId: 'codex-thread-recover' },
      },
    }))

    const { unmount } = render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    expect(wsMock.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'freshAgent.create',
      requestId: 'req-sessionref-only',
      resumeSessionId: 'codex-thread-recover',
      sessionRef: { provider: 'codex', sessionId: 'codex-thread-recover' },
    }))
    expect(apiMock.getFreshAgentThreadSnapshot).not.toHaveBeenCalled()

    const onMessage = wsMock.onMessage.mock.calls[0]?.[0]
    onMessage({
      type: 'freshAgent.created',
      requestId: 'req-sessionref-only',
      sessionId: 'created-thread-456',
      sessionType: 'freshcodex',
      provider: 'codex',
      runtimeProvider: 'codex',
      sessionRef: { provider: 'codex', sessionId: 'codex-thread-recover' },
    })

    await waitFor(() => {
      const state = store.getState()
      const leaf = state.panes.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
      expect(leaf.content.sessionRef).toEqual({ provider: 'codex', sessionId: 'codex-thread-recover' })
      expect(leaf.content.sessionId).toBe('created-thread-456')
      expect(leaf.content.status).toBe('connected')
    })
    unmount()
  })

  it('surfaces a missing Freshcodex rollout as a restore error instead of replacing the thread', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockRejectedValueOnce(new Error('no rollout found for thread id codex-thread-missing'))
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-missing-rollout',
        status: 'idle',
        sessionId: 'codex-thread-missing',
        resumeSessionId: 'codex-thread-missing',
        sessionRef: { provider: 'codex', sessionId: 'codex-thread-missing' },
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      const leaf = store.getState().panes.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
      expect(leaf.content.kind).toBe('fresh-agent')
      if (leaf.content.kind === 'fresh-agent') {
        expect(leaf.content.restoreError).toEqual({ code: 'RESTORE_UNAVAILABLE', reason: 'durable_artifact_missing' })
        expect(leaf.content.resumeSessionId).toBe('codex-thread-missing')
        expect(leaf.content.sessionRef).toBeUndefined()
        expect(leaf.content.status).toBe('idle')
      }
    })
    expect(wsMock.send).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'freshAgent.create',
      requestId: expect.not.stringMatching(/^req-missing-rollout$/),
    }))
  })

  it('clears stale restoreError when a valid sessionRef appears', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-clear-error',
        status: 'creating',
        restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'missing_canonical_identity' },
        sessionRef: { provider: 'codex', sessionId: 'codex-durable-id' },
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    const onMessage = wsMock.onMessage.mock.calls[0]?.[0]
    onMessage({
      type: 'freshAgent.created',
      requestId: 'req-clear-error',
      sessionId: 'created-789',
      sessionType: 'freshcodex',
      provider: 'codex',
      runtimeProvider: 'codex',
      sessionRef: { provider: 'codex', sessionId: 'codex-durable-id' },
    })

    await waitFor(() => {
      const state = store.getState()
      const leaf = state.panes.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
      expect(leaf.content.sessionRef).toEqual({ provider: 'codex', sessionId: 'codex-durable-id' })
      expect(leaf.content.restoreError).toBeUndefined()
    })
  })

  it('freshAgent.created does not write sessionRef for Claude when message has no sessionRef', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-claude-noref',
        status: 'creating',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    const onMessage = wsMock.onMessage.mock.calls[0]?.[0]
    onMessage({
      type: 'freshAgent.created',
      requestId: 'req-claude-noref',
      sessionId: 'runtime-sdk-session-id',
      sessionType: 'freshclaude',
      provider: 'claude',
      runtimeProvider: 'claude',
    })

    await waitFor(() => {
      const state = store.getState()
      const leaf = state.panes.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
      expect(leaf.content.sessionId).toBe('runtime-sdk-session-id')
      expect(leaf.content.sessionRef).toBeUndefined()
      expect(leaf.content.resumeSessionId).toBeUndefined()
    })
    expect(apiMock.getFreshAgentThreadSnapshot).not.toHaveBeenCalled()
  })

  it('does not clobber newer modelSelection when freshAgent.created arrives late', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-late-created',
        status: 'creating',
        modelSelection: { kind: 'exact', modelId: 'ui-selected-model' },
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    const onMessage = wsMock.onMessage.mock.calls[0]?.[0]
    // Simulate a late arriving created message that represents a much older snapshot
    onMessage({
      type: 'freshAgent.created',
      requestId: 'req-late-created',
      sessionId: 'runtime-id',
      sessionType: 'freshclaude',
      provider: 'claude',
      runtimeProvider: 'claude',
    })

    await waitFor(() => {
      const state = store.getState()
      const leaf = state.panes.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
      expect(leaf.content.sessionId).toBe('runtime-id')
      expect(leaf.content.modelSelection).toEqual({ kind: 'exact', modelId: 'ui-selected-model' })
    })
  })
})
