import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup, act } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { updateSettingsLocal } from '@/store/settingsSlice'
import freshAgentReducer from '@/store/freshAgentSlice'
import agentChatReducer from '@/store/agentChatSlice'
import tabsReducer from '@/store/tabsSlice'
import { FreshAgentView } from '@/components/fresh-agent/FreshAgentView'
import { FreshAgentSettingsButton } from '@/components/fresh-agent/FreshAgentSettingsButton'
import { initLayout, requestPaneRefresh, updatePaneContent, updatePaneTitle } from '@/store/panesSlice'
import { useAppSelector } from '@/store/hooks'
import { sessionInit, setSessionStatus } from '@/store/agentChatSlice'
import { updateTab } from '@/store/tabsSlice'
import type { PaneNode } from '@/store/paneTypes'

const CLAUDE_THREAD_ID = '550e8400-e29b-41d4-a716-446655440000'
const CLAUDE_RESTORE_THREAD_ID = '550e8400-e29b-41d4-a716-446655440001'

const wsMock = vi.hoisted(() => ({
  send: vi.fn(),
  onMessage: vi.fn(() => () => {}),
}))

const apiMock = vi.hoisted(() => ({
  getFreshAgentThreadSnapshot: vi.fn(),
  post: vi.fn(),
}))

const saveServerSettingsPatchSpy = vi.hoisted(() => vi.fn((patch: unknown) => ({
  type: 'settings/saveServerSettingsPatch',
  payload: patch,
})))

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
    api: { ...actual.api, post: apiMock.post },
    getFreshAgentThreadSnapshot: apiMock.getFreshAgentThreadSnapshot,
  }
})

vi.mock('@/store/settingsThunks', () => ({
  saveServerSettingsPatch: (patch: unknown) => saveServerSettingsPatchSpy(patch),
}))

function createStore(tabTitleSetByUser = false) {
  return configureStore({
    reducer: {
      panes: panesReducer,
      settings: settingsReducer,
      freshAgent: freshAgentReducer,
      agentChat: agentChatReducer,
      tabs: tabsReducer,
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
      tabs: {
        tabs: [{
          id: 'tab-1',
          createRequestId: 'tab-1',
          title: tabTitleSetByUser ? 'Pinned title' : 'Tab 1',
          titleSetByUser: tabTitleSetByUser,
          status: 'running',
          mode: 'shell',
          shell: 'system',
          createdAt: Date.now(),
        }],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
        tombstones: [],
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

function getFreshAgentSessionId() {
  return document.querySelector('[data-context="fresh-agent"]')?.getAttribute('data-session-id')
}

function getFreshAgentPaneContent(store: ReturnType<typeof createStore>) {
  const layout = store.getState().panes.layouts['tab-1']
  if (!layout || layout.type !== 'leaf' || layout.content.kind !== 'fresh-agent') {
    throw new Error('Expected fresh-agent leaf content')
  }
  return layout.content
}

function sentFreshAgentMessages(type: string) {
  return wsMock.send.mock.calls
    .map(([message]) => message)
    .filter((message): message is Record<string, unknown> => (
      !!message
      && typeof message === 'object'
      && !Array.isArray(message)
      && (message as { type?: unknown }).type === type
    ))
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  wsMock.send.mockReset()
  wsMock.onMessage.mockReset()
  wsMock.onMessage.mockImplementation(() => () => {})
  apiMock.getFreshAgentThreadSnapshot.mockReset()
  apiMock.post.mockReset()
  apiMock.post.mockResolvedValue({ title: null, source: 'none' })
  saveServerSettingsPatchSpy.mockClear()
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

  it('shows the provider watermark behind the workspace and redirects pane typing into the composer', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-watermark',
        sessionId: 'thread-watermark',
        status: 'idle',
        model: 'gpt-5.4-mini',
        effort: 'medium',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    const textbox = await screen.findByRole('textbox', { name: 'Chat message input' }) as HTMLTextAreaElement
    await waitFor(() => expect(textbox).not.toBeDisabled())
    expect(screen.getByTestId('fresh-agent-watermark')).toBeInTheDocument()

    const root = document.querySelector('[data-context="fresh-agent"]') as HTMLElement
    fireEvent.keyDown(root, { key: 'h' })

    expect(textbox.value).toBe('h')
  })

  it('applies the resolved fresh-agent style to the view root', async () => {
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
            createRequestId: 'req-render-style',
            sessionId: 'thread-render-style',
            status: 'idle',
            style: 'serif',
          }}
        />
      </Provider>,
    )

    const root = await waitFor(() => document.querySelector('[data-context="fresh-agent"]') as HTMLElement)
    expect(root).toHaveAttribute('data-style', 'serif')
    expect(root).toHaveClass('fresh-agent-style-serif')
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

  it('loads a non-Claude fresh-agent snapshot from durable sessionRef after persistence strips sessionId', async () => {
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
            createRequestId: 'req-restored-codex',
            sessionRef: { provider: 'codex', sessionId: 'thread-from-ref' },
            status: 'connected',
          }}
        />
      </Provider>,
    )

    await waitFor(() => {
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledWith('freshcodex', 'codex', 'thread-from-ref', expect.any(Object))
    })
    expect(await screen.findByText('Codex turn')).toBeInTheDocument()
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
      effort: 'max',
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

  it('promotes Freshopencode panes when freshAgent.session.materialized arrives', async () => {
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
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-opencode-materialize',
        sessionId: 'freshopencode-req-opencode-materialize',
        sessionRef: { provider: 'opencode', sessionId: 'freshopencode-req-opencode-materialize' },
        resumeSessionId: 'freshopencode-req-opencode-materialize',
        status: 'idle',
        model: 'opencode-go/deepseek-v4-flash',
        effort: 'max',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    const textbox = await screen.findByRole('textbox', { name: 'Chat message input' })
    fireEvent.change(textbox, { target: { value: 'before materialized' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(sentFreshAgentMessages('freshAgent.send').at(-1)).toMatchObject({
      sessionId: 'freshopencode-req-opencode-materialize',
    })

    await waitFor(() => {
      expect(onMessage).toBeTypeOf('function')
    })
    act(() => {
      onMessage?.({
        type: 'freshAgent.session.materialized',
        previousSessionId: 'freshopencode-req-opencode-materialize',
        sessionId: 'ses_real_materialized_1',
        sessionType: 'freshopencode',
        provider: 'opencode',
        sessionRef: { provider: 'opencode', sessionId: 'ses_real_materialized_1' },
      })
    })

    await waitFor(() => {
      const content = getFreshAgentPaneContent(store)
      expect(content.sessionId).toBe('ses_real_materialized_1')
      expect(content.sessionRef).toEqual({ provider: 'opencode', sessionId: 'ses_real_materialized_1' })
      expect(content.resumeSessionId).toBe('ses_real_materialized_1')
      expect(content.restoreError).toBeUndefined()
    })

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'after materialized' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(sentFreshAgentMessages('freshAgent.send').at(-1)).toMatchObject({
      sessionId: 'ses_real_materialized_1',
    })
  })

  it('sends tab restore context when recreating a legacy freshopencode placeholder', async () => {
    const store = createStore()
    store.dispatch(updateTab({
      id: 'tab-1',
      updates: {
        title: 'Identifying skills from GitHub repos',
        createdAt: 1_781_291_230_743,
      },
    }))
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: '-gP4qyCL7bwp8-xbw9G7b',
        sessionRef: { provider: 'opencode', sessionId: 'freshopencode--gP4qyCL7bwp8-xbw9G7b' },
        initialCwd: '/home/dan/code',
        status: 'connected',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(sentFreshAgentMessages('freshAgent.create').at(-1)).toMatchObject({
        requestId: '-gP4qyCL7bwp8-xbw9G7b',
        sessionType: 'freshopencode',
        provider: 'opencode',
        cwd: '/home/dan/code',
        resumeSessionId: 'freshopencode--gP4qyCL7bwp8-xbw9G7b',
        legacyRestoreContext: {
          title: 'Identifying skills from GitHub repos',
          createdAt: 1_781_291_230_743,
          updatedAt: expect.any(Number),
        },
      })
    })
    expect(apiMock.getFreshAgentThreadSnapshot).not.toHaveBeenCalledWith(
      'freshopencode',
      'opencode',
      'freshopencode--gP4qyCL7bwp8-xbw9G7b',
      expect.any(Object),
    )
  })

  it('clears a restored Freshopencode placeholder when history reports FRESH_AGENT_LOST_SESSION', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockRejectedValueOnce({
      status: 404,
      message: 'OpenCode fresh-agent placeholder freshopencode-restored is not restorable.',
      details: {
        code: 'FRESH_AGENT_LOST_SESSION',
      },
    })
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-restored-opencode',
        sessionId: 'freshopencode-restored',
        sessionRef: { provider: 'opencode', sessionId: 'freshopencode-restored' },
        resumeSessionId: 'freshopencode-restored',
        status: 'connected',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      const content = getFreshAgentPaneContent(store)
      expect(content.sessionId).toBeUndefined()
      expect(content.sessionRef).toBeUndefined()
      expect(content.resumeSessionId).toBeUndefined()
      expect(content.status).toBe('idle')
      expect(content.restoreError).toEqual({
        code: 'RESTORE_UNAVAILABLE',
        reason: 'durable_artifact_missing',
      })
    })
    expect(sentFreshAgentMessages('freshAgent.create')).toHaveLength(0)
    expect(sentFreshAgentMessages('freshAgent.attach')).toHaveLength(1)
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
      expect(screen.getByRole('textbox', { name: 'Chat message input' })).not.toBeDisabled()
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
        effort: 'max',
      },
    })

    expect(screen.queryByRole('button', { name: 'Interrupt' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Fork' })).not.toBeInTheDocument()
  })

  it('does not transmit stale Freshopencode permissionMode on create or send', async () => {
    const creatingStore = createStore()
    creatingStore.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-opencode-policy',
        status: 'creating',
        initialCwd: '/repo',
        model: 'opencode-go/deepseek-v4-flash',
        effort: 'max',
        permissionMode: 'bypassPermissions',
      },
    }))

    render(
      <Provider store={creatingStore}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    const createMessage = wsMock.send.mock.calls
      .map(([message]) => message)
      .find((message) => message?.type === 'freshAgent.create')
    expect(createMessage).toBeDefined()
    expect(createMessage).not.toHaveProperty('permissionMode')

    cleanup()
    wsMock.send.mockClear()

    const sendingStore = createStore()
    sendingStore.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-opencode-send-policy',
        sessionId: 'freshopencode-req-opencode-send-policy',
        status: 'idle',
        initialCwd: '/repo',
        model: 'opencode-go/deepseek-v4-flash',
        effort: 'max',
        permissionMode: 'bypassPermissions',
      },
    }))

    render(
      <Provider store={sendingStore}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Chat message input' })).not.toBeDisabled()
    })
    wsMock.send.mockClear()

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'Use local OpenCode policy' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(wsMock.send).toHaveBeenCalledWith({
      type: 'freshAgent.send',
      sessionId: 'freshopencode-req-opencode-send-policy',
      sessionType: 'freshopencode',
      provider: 'opencode',
      text: 'Use local OpenCode policy',
      settings: {
        cwd: '/repo',
        model: 'opencode-go/deepseek-v4-flash',
        effort: 'max',
      },
    })
  })

  it('auto-titles the fresh-agent pane and tab from the first user message', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-auto-title',
        sessionId: 'thread-auto-title',
        status: 'idle',
        initialCwd: '/home/dan/code/freshell',
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

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'Research tab naming behavior\nUse existing code paths.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    const state = store.getState()
    expect(state.panes.paneTitles?.['tab-1']?.['pane-1']).toBe('Research tab naming behavior')
    expect(state.panes.paneTitleSetByUser?.['tab-1']?.['pane-1'] ?? false).toBe(false)
    expect(state.tabs.tabs.find((tab) => tab.id === 'tab-1')?.title).toBe('Research tab naming behavior')
    expect(state.tabs.tabs.find((tab) => tab.id === 'tab-1')?.titleSetByUser).toBe(false)
    expect(wsMock.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'freshAgent.send',
      text: 'Research tab naming behavior\nUse existing code paths.',
    }))
  })

  it('does not replace a user-set tab title when auto-titling the first fresh-agent message', async () => {
    const store = createStore(true)
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-auto-title-user-tab',
        sessionId: 'thread-auto-title-user-tab',
        status: 'idle',
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

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'Do not override my tab title' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    const state = store.getState()
    expect(state.panes.paneTitles?.['tab-1']?.['pane-1']).toBe('Do not override my tab title')
    expect(state.tabs.tabs.find((tab) => tab.id === 'tab-1')?.title).toBe('Pinned title')
    expect(state.tabs.tabs.find((tab) => tab.id === 'tab-1')?.titleSetByUser).toBe(true)
    expect(wsMock.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'freshAgent.send',
      text: 'Do not override my tab title',
    }))
  })

  it('auto-titles a freshly created freshclaude conversation after freshAgent.created before snapshot history exists', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockRejectedValue(new TypeError('Snapshot not ready yet'))
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-claude-created-auto-title',
        status: 'creating',
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
        type: 'freshAgent.created',
        requestId: 'req-claude-created-auto-title',
        sessionId: 'claude-live-session-1',
        sessionType: 'freshclaude',
        provider: 'claude',
        runtimeProvider: 'claude',
      })
    })

    await waitFor(() => {
      expect(getFreshAgentSessionId()).toBe('claude-live-session-1')
      expect(screen.getByRole('textbox', { name: 'Chat message input' })).not.toBeDisabled()
    })

    wsMock.send.mockClear()

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'Fresh Claude title' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    const state = store.getState()
    expect(state.panes.paneTitles?.['tab-1']?.['pane-1']).toBe('Fresh Claude title')
    expect(state.tabs.tabs.find((tab) => tab.id === 'tab-1')?.title).toBe('Fresh Claude title')
    expect(wsMock.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'freshAgent.send',
      sessionId: 'claude-live-session-1',
      text: 'Fresh Claude title',
    }))
  })

  it('auto-titles after freshopencode materializes to a live session id before follow-up snapshot lands', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot
      .mockResolvedValueOnce({
        sessionId: 'ses_real_materialized_1',
        status: 'idle',
        summary: 'OpenCode summary',
        capabilities: { send: true, interrupt: true, fork: false },
        turns: [],
      })
      .mockImplementationOnce(() => new Promise(() => {}))
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-opencode-materialize-auto-title',
        sessionId: 'freshopencode-req-materialize',
        sessionRef: { provider: 'opencode', sessionId: 'freshopencode-req-materialize' },
        resumeSessionId: 'freshopencode-req-materialize',
        status: 'idle',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(getFreshAgentSessionId()).toBe('ses_real_materialized_1')
      expect(screen.getByRole('textbox', { name: 'Chat message input' })).not.toBeDisabled()
    })

    wsMock.send.mockClear()

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'Materialized OpenCode title' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    const state = store.getState()
    expect(state.panes.paneTitles?.['tab-1']?.['pane-1']).toBe('Materialized OpenCode title')
    expect(state.tabs.tabs.find((tab) => tab.id === 'tab-1')?.title).toBe('Materialized OpenCode title')
    expect(wsMock.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'freshAgent.send',
      sessionId: 'ses_real_materialized_1',
      text: 'Materialized OpenCode title',
    }))
  })

  it('keeps the first auto-title when two sends happen before snapshot user turns arrive', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-auto-title-race',
        sessionId: 'thread-auto-title-race',
        status: 'idle',
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

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'First title' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'Second title' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    const state = store.getState()
    expect(state.panes.paneTitles?.['tab-1']?.['pane-1']).toBe('First title')
    expect(state.tabs.tabs.find((tab) => tab.id === 'tab-1')?.title).toBe('First title')
    expect(wsMock.send.mock.calls).toEqual(expect.arrayContaining([
      [expect.objectContaining({ type: 'freshAgent.send', text: 'First title' })],
      [expect.objectContaining({ type: 'freshAgent.send', text: 'Second title' })],
    ]))
  })

  it('does not reopen auto-title when the live session handle changes for the same conversation', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-auto-title-restore',
        sessionId: 'live-session-1',
        sessionRef: { provider: 'claude', sessionId: CLAUDE_THREAD_ID },
        resumeSessionId: CLAUDE_THREAD_ID,
        status: 'idle',
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

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'First durable title' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    act(() => {
      store.dispatch(updatePaneContent({
        tabId: 'tab-1',
        paneId: 'pane-1',
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshclaude',
          provider: 'claude',
          createRequestId: 'req-auto-title-restore',
          sessionId: 'live-session-2',
          sessionRef: { provider: 'claude', sessionId: CLAUDE_THREAD_ID },
          resumeSessionId: CLAUDE_THREAD_ID,
          status: 'idle',
        },
      }))
    })
    await waitFor(() => {
      expect(getFreshAgentSessionId()).toBe('live-session-2')
    })

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'Second durable title' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    const state = store.getState()
    expect(state.panes.paneTitles?.['tab-1']?.['pane-1']).toBe('First durable title')
    expect(state.tabs.tabs.find((tab) => tab.id === 'tab-1')?.title).toBe('First durable title')
    expect(wsMock.send.mock.calls).toEqual(expect.arrayContaining([
      [expect.objectContaining({ type: 'freshAgent.send', sessionId: 'live-session-1', text: 'First durable title' })],
      [expect.objectContaining({ type: 'freshAgent.send', sessionId: 'live-session-2', text: 'Second durable title' })],
    ]))
  })

  it('does not reopen auto-title when a live-only freshclaude pane gains durable identity', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-auto-title-refinement-bootstrap',
        status: 'creating',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    wsMock.send.mockClear()

    act(() => {
      store.dispatch(updatePaneContent({
        tabId: 'tab-1',
        paneId: 'pane-1',
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshclaude',
          provider: 'claude',
          createRequestId: 'req-auto-title-refinement',
          sessionId: 'live-session-refine-1',
          status: 'idle',
        },
      }))
    })
    await waitFor(() => {
      expect(getFreshAgentSessionId()).toBe('live-session-refine-1')
      expect(screen.getByRole('textbox', { name: 'Chat message input' })).not.toBeDisabled()
    })

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'First refined title' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    act(() => {
      store.dispatch(updatePaneContent({
        tabId: 'tab-1',
        paneId: 'pane-1',
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshclaude',
          provider: 'claude',
          createRequestId: 'req-auto-title-refinement',
          sessionId: 'live-session-refine-2',
          sessionRef: { provider: 'claude', sessionId: CLAUDE_THREAD_ID },
          resumeSessionId: CLAUDE_THREAD_ID,
          status: 'idle',
        },
      }))
    })
    await waitFor(() => {
      expect(getFreshAgentSessionId()).toBe('live-session-refine-2')
    })

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'Second refined title' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    const state = store.getState()
    expect(state.panes.paneTitles?.['tab-1']?.['pane-1']).toBe('First refined title')
    expect(state.tabs.tabs.find((tab) => tab.id === 'tab-1')?.title).toBe('First refined title')
    expect(wsMock.send.mock.calls).toEqual(expect.arrayContaining([
      [expect.objectContaining({ type: 'freshAgent.send', sessionId: 'live-session-refine-1', text: 'First refined title' })],
      [expect.objectContaining({ type: 'freshAgent.send', sessionId: 'live-session-refine-2', text: 'Second refined title' })],
    ]))
  })

  it('does not reopen auto-title when freshopencode materializes a live session id for the same durable thread', async () => {
    const store = createStore()
    let onMessage: ((message: Record<string, unknown>) => void) | undefined
    wsMock.onMessage.mockImplementation((handler: (message: Record<string, unknown>) => void) => {
      onMessage = handler
      return () => {}
    })
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-opencode-auto-title',
        sessionId: 'freshopencode-req-1',
        sessionRef: { provider: 'opencode', sessionId: 'freshopencode-req-1' },
        resumeSessionId: 'freshopencode-req-1',
        status: 'idle',
      },
    }))

    apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
      sessionId: 'freshopencode-req-1',
      status: 'idle',
      summary: 'OpenCode summary',
      capabilities: { send: true, interrupt: true, fork: false },
      turns: [{ id: 'turn-1', role: 'assistant', items: [{ id: 'item-1', kind: 'text', text: 'Codex turn' }] }],
    })

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByText('Codex turn')).toBeInTheDocument()
    })

    wsMock.send.mockClear()

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'First opencode title' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        '/api/sessions/opencode%3Afreshopencode-req-1/generate-title',
        { firstMessage: 'First opencode title' },
      )
      expect(onMessage).toBeTypeOf('function')
    })

    act(() => {
      onMessage?.({
        type: 'freshAgent.session.materialized',
        previousSessionId: 'freshopencode-req-1',
        sessionId: 'ses_real_1',
        sessionType: 'freshopencode',
        provider: 'opencode',
        sessionRef: { provider: 'opencode', sessionId: 'ses_real_1' },
      })
    })
    await waitFor(() => {
      expect(getFreshAgentSessionId()).toBe('ses_real_1')
      expect(apiMock.post).toHaveBeenCalledWith(
        '/api/sessions/opencode%3Ases_real_1/generate-title',
        { firstMessage: 'First opencode title' },
      )
    })

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'Second opencode title' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    const state = store.getState()
    expect(state.panes.paneTitles?.['tab-1']?.['pane-1']).toBe('First opencode title')
    expect(state.tabs.tabs.find((tab) => tab.id === 'tab-1')?.title).toBe('First opencode title')
    expect(wsMock.send.mock.calls).toEqual(expect.arrayContaining([
      [expect.objectContaining({ type: 'freshAgent.send', sessionId: 'freshopencode-req-1', text: 'First opencode title' })],
      [expect.objectContaining({ type: 'freshAgent.send', sessionId: 'ses_real_1', text: 'Second opencode title' })],
    ]))
  })

  it('resets auto-title for a genuinely new conversation in the same pane', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-old-conversation',
        sessionId: 'thread-old-conversation',
        status: 'idle',
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

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'Old title' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    act(() => {
      store.dispatch(updatePaneContent({
        tabId: 'tab-1',
        paneId: 'pane-1',
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshcodex',
          provider: 'codex',
          createRequestId: 'req-new-conversation',
          sessionId: 'thread-new-conversation',
          status: 'idle',
        },
      }))
    })
    await waitFor(() => {
      expect(getFreshAgentSessionId()).toBe('thread-new-conversation')
    })

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'New title' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    const state = store.getState()
    expect(state.panes.paneTitles?.['tab-1']?.['pane-1']).toBe('New title')
    expect(state.tabs.tabs.find((tab) => tab.id === 'tab-1')?.title).toBe('New title')
    expect(wsMock.send.mock.calls).toEqual(expect.arrayContaining([
      [expect.objectContaining({ type: 'freshAgent.send', sessionId: 'thread-old-conversation', text: 'Old title' })],
      [expect.objectContaining({ type: 'freshAgent.send', sessionId: 'thread-new-conversation', text: 'New title' })],
    ]))
  })

  it('does not reopen auto-title when createRequestId changes but full effective identity stays the same', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-same-identity-old',
        sessionId: 'thread-same-identity',
        status: 'idle',
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

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'Codex same identity title' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    act(() => {
      store.dispatch(updatePaneContent({
        tabId: 'tab-1',
        paneId: 'pane-1',
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshcodex',
          provider: 'codex',
          createRequestId: 'req-same-identity-new',
          sessionId: 'thread-same-identity',
          status: 'idle',
        },
      }))
    })
    await waitFor(() => {
      expect(getFreshAgentSessionId()).toBe('thread-same-identity')
    })

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'Should not replace codex same identity title' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    const state = store.getState()
    expect(state.panes.paneTitles?.['tab-1']?.['pane-1']).toBe('Codex same identity title')
    expect(state.tabs.tabs.find((tab) => tab.id === 'tab-1')?.title).toBe('Codex same identity title')
    expect(wsMock.send.mock.calls).toEqual(expect.arrayContaining([
      [expect.objectContaining({ type: 'freshAgent.send', sessionId: 'thread-same-identity', text: 'Codex same identity title' })],
      [expect.objectContaining({ type: 'freshAgent.send', sessionId: 'thread-same-identity', text: 'Should not replace codex same identity title' })],
    ]))
  })

  it('does not reopen auto-title when createRequestId changes but durable identity stays the same', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-same-durable-old',
        sessionId: 'live-same-durable-1',
        sessionRef: { provider: 'claude', sessionId: CLAUDE_THREAD_ID },
        resumeSessionId: CLAUDE_THREAD_ID,
        status: 'idle',
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

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'Durable title' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    act(() => {
      store.dispatch(updatePaneContent({
        tabId: 'tab-1',
        paneId: 'pane-1',
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshclaude',
          provider: 'claude',
          createRequestId: 'req-same-durable-new',
          sessionId: 'live-same-durable-2',
          sessionRef: { provider: 'claude', sessionId: CLAUDE_THREAD_ID },
          resumeSessionId: CLAUDE_THREAD_ID,
          status: 'idle',
        },
      }))
    })
    await waitFor(() => {
      expect(getFreshAgentSessionId()).toBe('live-same-durable-2')
    })

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'Should not replace durable title' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    const state = store.getState()
    expect(state.panes.paneTitles?.['tab-1']?.['pane-1']).toBe('Durable title')
    expect(state.tabs.tabs.find((tab) => tab.id === 'tab-1')?.title).toBe('Durable title')
    expect(wsMock.send.mock.calls).toEqual(expect.arrayContaining([
      [expect.objectContaining({ type: 'freshAgent.send', sessionId: 'live-same-durable-1', text: 'Durable title' })],
      [expect.objectContaining({ type: 'freshAgent.send', sessionId: 'live-same-durable-2', text: 'Should not replace durable title' })],
    ]))
  })

  it('fetches the initial snapshot once and does not refetch from its own pane update', async () => {
    const store = createStore()
    // First fetch returns a distinct snapshot; the default mockResolvedValue
    // ("Codex turn") would answer any *second* fetch. The snapshot-load effect
    // persists resumeSessionId via updatePaneContent, and if that self-update
    // retriggers the effect, the redundant second fetch overwrites the loaded
    // content with the default — a wasteful double network request in production
    // and an order-dependent flake in tests.
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
      status: 'idle',
      summary: 'Codex summary',
      capabilities: { send: true, interrupt: true, fork: true },
      turns: [
        { id: 'turn-user-1', role: 'user', items: [{ id: 'item-user-1', kind: 'text', text: 'Loaded user turn' }] },
        { id: 'turn-assistant-1', role: 'assistant', items: [{ id: 'item-assistant-1', kind: 'text', text: 'Loaded assistant turn' }] },
      ],
    })
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-single-fetch',
        sessionId: 'thread-single-fetch',
        status: 'idle',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    // Wait until the effect has persisted resumeSessionId back into pane content
    // (the self-update that previously retriggered the effect).
    await waitFor(() => {
      const layout = store.getState().panes.layouts['tab-1']
      const resumeSessionId = layout?.type === 'leaf' && layout.content.kind === 'fresh-agent'
        ? layout.content.resumeSessionId
        : undefined
      expect(resumeSessionId).toBe('thread-single-fetch')
    })
    // Let any spurious self-triggered refetch run before asserting.
    await act(async () => { await Promise.resolve() })

    expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(1)
    // The loaded snapshot stays rendered (not overwritten by a second fetch).
    expect(screen.getByText('Loaded assistant turn')).toBeInTheDocument()
  })

  it('resets auto-title for a new conversation even if the stale prior snapshot had user turns', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
      status: 'idle',
      summary: 'Codex summary',
      capabilities: { send: true, interrupt: true, fork: true },
      turns: [
        { id: 'turn-user-1', role: 'user', items: [{ id: 'item-user-1', kind: 'text', text: 'Old user turn' }] },
        { id: 'turn-assistant-1', role: 'assistant', items: [{ id: 'item-assistant-1', kind: 'text', text: 'Old assistant turn' }] },
      ],
    })
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-stale-snapshot-old',
        sessionId: 'thread-stale-snapshot-old',
        status: 'idle',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByText('Old assistant turn')).toBeInTheDocument()
    })

    wsMock.send.mockClear()

    act(() => {
      store.dispatch(updatePaneContent({
        tabId: 'tab-1',
        paneId: 'pane-1',
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshcodex',
          provider: 'codex',
          createRequestId: 'req-stale-snapshot-new',
          sessionId: 'thread-stale-snapshot-new',
          status: 'idle',
        },
      }))
    })
    await waitFor(() => {
      expect(getFreshAgentSessionId()).toBe('thread-stale-snapshot-new')
    })

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'New stale-safe title' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    const state = store.getState()
    expect(state.panes.paneTitles?.['tab-1']?.['pane-1']).toBe('New stale-safe title')
    expect(state.tabs.tabs.find((tab) => tab.id === 'tab-1')?.title).toBe('New stale-safe title')
    expect(wsMock.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'freshAgent.send',
      sessionId: 'thread-stale-snapshot-new',
      text: 'New stale-safe title',
    }))
  })

  it('ignores a late stale snapshot with user turns after switching to a new conversation', async () => {
    const store = createStore()
    const staleSnapshot = createDeferred<{
      status: string
      summary: string
      capabilities: { send: boolean; interrupt: boolean; fork: boolean }
      turns: Array<{ id: string; role: 'user' | 'assistant'; items: Array<{ id: string; kind: 'text'; text: string }> }>
    }>()
    apiMock.getFreshAgentThreadSnapshot
      .mockImplementationOnce(() => staleSnapshot.promise as any)
      .mockImplementationOnce(() => new Promise(() => {}))
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-stale-old',
        sessionId: 'sess-stale-old',
        status: 'idle',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(getFreshAgentSessionId()).toBe('sess-stale-old')
    })

    act(() => {
      store.dispatch(updatePaneContent({
        tabId: 'tab-1',
        paneId: 'pane-1',
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshclaude',
          provider: 'claude',
          createRequestId: 'req-stale-new',
          sessionId: 'sess-stale-new',
          status: 'idle',
        },
      }))
    })
    await waitFor(() => {
      expect(getFreshAgentSessionId()).toBe('sess-stale-new')
    })

    await act(async () => {
      staleSnapshot.resolve({
        status: 'idle',
        summary: 'Old snapshot',
        capabilities: { send: true, interrupt: true, fork: true },
        turns: [
          { id: 'turn-old-user', role: 'user', items: [{ id: 'item-old-user', kind: 'text', text: 'Old user turn' }] },
          { id: 'turn-old-assistant', role: 'assistant', items: [{ id: 'item-old-assistant', kind: 'text', text: 'Old assistant turn' }] },
        ],
      })
      await Promise.resolve()
    })

    wsMock.send.mockClear()

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'New conversation title after stale race' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    const state = store.getState()
    expect(state.panes.paneTitles?.['tab-1']?.['pane-1']).toBe('New conversation title after stale race')
    expect(state.tabs.tabs.find((tab) => tab.id === 'tab-1')?.title).toBe('New conversation title after stale race')
    expect(wsMock.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'freshAgent.send',
      sessionId: 'sess-stale-new',
      text: 'New conversation title after stale race',
    }))
  })

  it('ignores a late stale codex snapshot failure after switching to a new conversation', async () => {
    const store = createStore()
    const staleSnapshot = createDeferred<never>()
    apiMock.getFreshAgentThreadSnapshot
      .mockImplementationOnce(() => staleSnapshot.promise as any)
      .mockImplementationOnce(() => new Promise(() => {}))
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-stale-codex-old',
        sessionId: 'thread-stale-codex-old',
        status: 'idle',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(getFreshAgentSessionId()).toBe('thread-stale-codex-old')
    })

    act(() => {
      store.dispatch(updatePaneContent({
        tabId: 'tab-1',
        paneId: 'pane-1',
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshcodex',
          provider: 'codex',
          createRequestId: 'req-stale-codex-new',
          sessionId: 'thread-stale-codex-new',
          status: 'idle',
        },
      }))
    })
    await waitFor(() => {
      expect(getFreshAgentSessionId()).toBe('thread-stale-codex-new')
    })

    await act(async () => {
      staleSnapshot.reject(new Error('no rollout found for thread id thread-stale-codex-old'))
      await Promise.resolve()
    })

    const layout = store.getState().panes.layouts['tab-1']
    expect(layout?.type).toBe('leaf')
    if (layout?.type !== 'leaf' || layout.content.kind !== 'fresh-agent') {
      throw new Error('Expected fresh-agent leaf')
    }
    expect(layout.content.sessionId).toBe('thread-stale-codex-new')
    expect(layout.content.restoreError).toBeUndefined()
    expect(screen.queryByText(/durable artifact/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/no rollout found for thread id/i)).not.toBeInTheDocument()
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
        effort: 'max',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentSettingsButton tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))
    expect(screen.queryByRole('combobox', { name: 'Model' })).not.toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: 'Model' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'GPT-5.4 Flash' }))
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'GPT-5.4 Flash' })).toBeChecked()
    })

    const thinking = screen.getByRole('combobox', { name: 'Thinking level' })
    expect(thinking).toHaveValue('high')
    expect(screen.queryByRole('option', { name: 'xhigh' })).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'high' })).toBeInTheDocument()

    const layout = store.getState().panes.layouts['tab-1']
    expect(layout?.type).toBe('leaf')
    expect(layout?.type === 'leaf' && layout.content.kind === 'fresh-agent' ? layout.content.model : null).toBe('gpt-5.4-flash')
    expect(layout?.type === 'leaf' && layout.content.kind === 'fresh-agent' ? layout.content.effort : null).toBe('high')
    expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
      freshAgent: {
        providers: {
          freshcodex: {
            modelSelection: { kind: 'exact', modelId: 'gpt-5.4-flash' },
            effort: 'high',
          },
        },
      },
    })
  })

  it('persists Freshcodex thinking and permission settings as fresh-agent provider defaults', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-persist-settings',
        sessionId: 'thread-persist-settings',
        status: 'idle',
        model: 'gpt-5.4-flash',
        permissionMode: 'on-request',
        effort: 'medium',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentSettingsButton tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Thinking level' }), {
      target: { value: 'high' },
    })
    fireEvent.change(screen.getByRole('combobox', { name: 'Permission mode' }), {
      target: { value: 'never' },
    })

    expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
      freshAgent: {
        providers: {
          freshcodex: { effort: 'high' },
        },
      },
    })
    expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
      freshAgent: {
        providers: {
          freshcodex: { defaultPermissionMode: 'never' },
        },
      },
    })
  })

  it('lets a Freshcodex pane choose style and persists it as a per-sessionType default', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-style',
        sessionId: 'thread-style',
        status: 'idle',
        model: 'gpt-5.4-flash',
        effort: 'high',
        style: 'sans',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentSettingsButton tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))
    const styleSelect = screen.getByRole('combobox', { name: 'Style' })
    expect(styleSelect).toHaveValue('sans')

    fireEvent.change(styleSelect, { target: { value: 'serif' } })

    const layout = store.getState().panes.layouts['tab-1']
    expect(layout?.type === 'leaf' && layout.content.kind === 'fresh-agent' ? layout.content.style : null).toBe('serif')
    expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
      freshAgent: {
        providers: {
          freshcodex: { style: 'serif' },
        },
      },
    })
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
    expect(screen.queryByRole('combobox', { name: 'Model' })).not.toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'DeepSeek V4 Flash' })).toBeChecked()
    expect(screen.getByRole('combobox', { name: 'Thinking level' })).toHaveValue('max')

    fireEvent.click(screen.getByRole('radio', { name: 'GLM 5.1' }))
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'GLM 5.1' })).toBeChecked()
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
        effort: 'xhigh',
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
      effort: 'max',
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
      settings: expect.objectContaining({ effort: 'max' }),
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

  it('does not auto-title an established freshclaude pane when snapshot history is unavailable', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockRejectedValue(new TypeError('Failed to parse URL from /api/fresh-agent/threads/claude/sess-1'))
    store.dispatch(sessionInit({
      sessionId: 'sess-1',
      cliSessionId: 'cli-abc',
      model: 'claude-opus-4-6',
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))
    store.dispatch(updatePaneTitle({ tabId: 'tab-1', paneId: 'pane-1', title: 'Existing title', setByUser: false }))

    const paneContent = {
      kind: 'fresh-agent' as const,
      sessionType: 'freshclaude' as const,
      provider: 'claude' as const,
      createRequestId: 'req-established-no-snapshot',
      sessionId: 'sess-1',
      status: 'idle' as const,
      resumeSessionId: 'cli-abc',
    }

    render(
      <Provider store={store}>
        <FreshAgentView tabId="tab-1" paneId="pane-1" paneContent={paneContent} />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Chat message input' })).not.toBeDisabled()
    })

    wsMock.send.mockClear()

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'Do not retitle this established chat' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    const state = store.getState()
    expect(state.panes.paneTitles?.['tab-1']?.['pane-1']).toBe('Existing title')
    expect(state.tabs.tabs.find((tab) => tab.id === 'tab-1')?.title).toBe('Tab 1')
    expect(wsMock.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'freshAgent.send',
      sessionId: 'sess-1',
      text: 'Do not retitle this established chat',
    }))
  })

  it('does not auto-title a live-only established freshclaude pane when snapshot history is unavailable', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockRejectedValue(new TypeError('Failed to parse URL from /api/fresh-agent/threads/claude/sess-live-only'))
    store.dispatch(sessionInit({
      sessionId: 'sess-live-only',
      model: 'claude-opus-4-6',
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-live-only', status: 'idle' }))
    store.dispatch(updatePaneTitle({ tabId: 'tab-1', paneId: 'pane-1', title: 'Existing live-only pane title', setByUser: false }))
    store.dispatch(updateTab({ id: 'tab-1', updates: { title: 'Existing live-only tab title' } }))

    const paneContent = {
      kind: 'fresh-agent' as const,
      sessionType: 'freshclaude' as const,
      provider: 'claude' as const,
      createRequestId: 'req-live-only-established',
      sessionId: 'sess-live-only',
      status: 'idle' as const,
    }

    render(
      <Provider store={store}>
        <FreshAgentView tabId="tab-1" paneId="pane-1" paneContent={paneContent} />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Chat message input' })).not.toBeDisabled()
    })

    wsMock.send.mockClear()

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'Do not retitle this live-only established chat' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    const state = store.getState()
    expect(state.panes.paneTitles?.['tab-1']?.['pane-1']).toBe('Existing live-only pane title')
    expect(state.tabs.tabs.find((tab) => tab.id === 'tab-1')?.title).toBe('Existing live-only tab title')
    expect(wsMock.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'freshAgent.send',
      sessionId: 'sess-live-only',
      text: 'Do not retitle this live-only established chat',
    }))
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
        effort: 'high',
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

  it('allows retrying a disabled fresh-client create after settings change', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-disabled-create',
        status: 'creating',
        sessionRef: { provider: 'codex', sessionId: 'codex-thread-disabled' },
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    const onMessage = wsMock.onMessage.mock.calls[0]?.[0]
    act(() => {
      onMessage({
        type: 'freshAgent.create.failed',
        requestId: 'req-disabled-create',
        code: 'FRESH_CLIENTS_DISABLED',
        message: 'Fresh clients are disabled',
        retryable: true,
      })
    })

    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))

    await waitFor(() => {
      const leaf = store.getState().panes.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
      expect(leaf.content.kind).toBe('fresh-agent')
      if (leaf.content.kind === 'fresh-agent') {
        expect(leaf.content.status).toBe('creating')
        expect(leaf.content.createError).toBeUndefined()
        expect(leaf.content.createRequestId).not.toBe('req-disabled-create')
        expect(wsMock.send).toHaveBeenCalledWith(expect.objectContaining({
          type: 'freshAgent.create',
          requestId: leaf.content.createRequestId,
          resumeSessionId: 'codex-thread-disabled',
        }))
      }
    })
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

describe('FreshAgentView transcript font size', () => {
  const freshClaudePane = {
    kind: 'fresh-agent',
    sessionType: 'freshclaude',
    provider: 'claude',
    createRequestId: 'req-1',
    sessionId: CLAUDE_THREAD_ID,
    status: 'connected',
  } as const

  it('inherits the default terminal font size without transforming pane geometry', async () => {
    const store = createStore()
    render(
      <Provider store={store}>
        <FreshAgentView tabId="tab-1" paneId="pane-1" paneContent={freshClaudePane} />
      </Provider>,
    )

    const root = document.querySelector('[data-context="fresh-agent"]') as HTMLElement
    expect(root).toBeTruthy()
    expect(root.style.getPropertyValue('--fresh-transcript-font-size')).toBe('16px')
    expect(root.style.getPropertyValue('--fresh-font-scale')).toBe('')
    expect(root.querySelector('.fresh-agent-layout')).toBeTruthy()
    expect(root.querySelector('.fresh-agent-scaled-content')).toBeNull()

    await act(async () => {
      await Promise.resolve()
    })
  })

  it('updates the transcript font size live when the terminal font size changes', async () => {
    const store = createStore()
    render(
      <Provider store={store}>
        <FreshAgentView tabId="tab-1" paneId="pane-1" paneContent={freshClaudePane} />
      </Provider>,
    )

    const root = document.querySelector('[data-context="fresh-agent"]') as HTMLElement
    expect(root.style.getPropertyValue('--fresh-transcript-font-size')).toBe('16px')

    await act(async () => {
      store.dispatch(updateSettingsLocal({
        terminal: { fontSize: 20 },
      }))
    })

    expect(root.style.getPropertyValue('--fresh-transcript-font-size')).toBe('20px')
  })
})
