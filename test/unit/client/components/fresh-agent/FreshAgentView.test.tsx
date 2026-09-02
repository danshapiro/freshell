import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, createEvent, cleanup, act, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { previewServerSettingsPatch, updateSettingsLocal } from '@/store/settingsSlice'
import sessionsReducer, { applySessionsPatch, applyContextUsageExtras } from '@/store/sessionsSlice'
import freshAgentReducer, { sessionInit, setSessionStatus, markSessionLost } from '@/store/freshAgentSlice'
import tabsReducer from '@/store/tabsSlice'
import connectionReducer from '@/store/connectionSlice'
import { FreshAgentView, IDLE_INCOMPLETE_MAX_RETRIES } from '@/components/fresh-agent/FreshAgentView'
import { FreshAgentSettingsButton } from '@/components/fresh-agent/FreshAgentSettingsButton'
import { initLayout, requestPaneRefresh, setActivePane, updatePaneContent, updatePaneTitle } from '@/store/panesSlice'
import { useAppSelector } from '@/store/hooks'
import { updateTab } from '@/store/tabsSlice'
import { handleFreshAgentMessage } from '@/lib/fresh-agent-ws'
import { ApiError } from '@/lib/api'
import { resetSnapshotSchedulerForTests } from '@/lib/fresh-agent-snapshot-scheduler'
import type { PaneNode } from '@/store/paneTypes'

const CLAUDE_THREAD_ID = '550e8400-e29b-41d4-a716-446655440000'

// STATUS-STRIP meter seeding helper: usage lands in the unified store map
// (sessions.contextUsageByKey) exactly as a committed refresh would stamp it
// — fresh-page rows and extras share the map, and the strip reads nothing else.
function seedStripUsage(
  store: ReturnType<typeof createStore>,
  compactPercent: number,
  contextTokens = 96_000,
  sessionId = 'claude-strip-usage',
) {
  store.dispatch(applyContextUsageExtras({
    entries: [{
      provider: 'claude',
      sessionId,
      tokenUsage: {
        inputTokens: 1, outputTokens: 1, cachedTokens: 0, totalTokens: 2,
        contextTokens, compactPercent, compactThresholdTokens: 200_000,
      },
    }],
    sourceSeq: 0,
    paneKeys: [`claude:${sessionId}`],
  }))
}
const CLAUDE_RESTORE_THREAD_ID = '550e8400-e29b-41d4-a716-446655440001'

const wsMock = vi.hoisted(() => ({
  send: vi.fn(),
  onMessage: vi.fn(() => () => {}),
  onReconnect: vi.fn(() => () => {}),
}))

const apiMock = vi.hoisted(() => ({
  getFreshAgentThreadSnapshot: vi.fn(),
  getFreshAgentModelCapabilities: vi.fn(),
  post: vi.fn(),
  setSessionMetadata: vi.fn().mockResolvedValue(undefined),
}))

const saveServerSettingsPatchSpy = vi.hoisted(() => vi.fn((patch: unknown) => ({
  type: 'settings/saveServerSettingsPatch',
  payload: patch,
})))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => wsMock,
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    api: { ...actual.api, post: apiMock.post },
    getFreshAgentThreadSnapshot: apiMock.getFreshAgentThreadSnapshot,
    getFreshAgentModelCapabilities: apiMock.getFreshAgentModelCapabilities,
    setSessionMetadata: apiMock.setSessionMetadata,
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
      tabs: tabsReducer,
      // FreshAgentView reads connection.status to gate the .lost recovery
      // driver; preload ready so tests keep the pre-gate behavior.
      connection: connectionReducer,
      // The status-strip context meter reads the session indexer's tokenUsage
      // from this slice (wsSnapshotReceived un-gates applySessionsPatch).
      sessions: sessionsReducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({
        // sessions.expandedProjects is a Set by slice design (same ignore as
        // PaneContainer.test.tsx's createStore).
        serializableCheck: {
          ignoredPaths: ['sessions.expandedProjects'],
        },
      }),
    preloadedState: {
      connection: {
        status: 'ready' as const,
        platform: null,
        availableClis: {},
        featureFlags: {},
      },
      sessions: {
        projects: [],
        expandedProjects: new Set(),
        wsSnapshotReceived: true,
      },
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

function freshopencodeSnapshot(text: string, revision: number) {
  return {
    sessionType: 'freshopencode',
    provider: 'opencode',
    threadId: 'ses_late_change',
    sessionId: 'ses_late_change',
    status: 'idle',
    latestTurnId: 'msg_assistant_1',
    revision,
    summary: 'OpenCode done',
    capabilities: { send: true, interrupt: true, fork: true },
    pendingApprovals: [],
    pendingQuestions: [],
    diffs: [],
    worktrees: [],
    turns: [
      { id: 'msg_user_1', turnId: 'msg_user_1', role: 'user', summary: 'go', items: [{ id: 'user-text', kind: 'text', text: 'go' }] },
      { id: 'msg_assistant_1', turnId: 'msg_assistant_1', role: 'assistant', summary: text, items: [{ id: 'assistant-text', kind: 'text', text }] },
    ],
  }
}

beforeEach(() => {
  resetSnapshotSchedulerForTests()
  wsMock.send.mockReset()
  wsMock.onMessage.mockReset()
  wsMock.onReconnect.mockReset()
  wsMock.onMessage.mockImplementation(() => () => {})
  wsMock.onReconnect.mockImplementation(() => () => {})
  window.sessionStorage.clear()
  window.localStorage.removeItem('fresh-agent-prompt-history:freshcodex')
  window.localStorage.removeItem('fresh-agent-prompt-history:freshclaude')
  apiMock.getFreshAgentThreadSnapshot.mockReset()
  apiMock.getFreshAgentModelCapabilities.mockReset()
  apiMock.post.mockReset()
  apiMock.setSessionMetadata.mockReset()
  apiMock.post.mockResolvedValue({ title: null, source: 'none' })
  apiMock.setSessionMetadata.mockResolvedValue(undefined)
  saveServerSettingsPatchSpy.mockClear()
  window.localStorage.removeItem('freshopencode.modelMru.v2')
  window.localStorage.removeItem('freshopencode.modelLevelMru.v1')
  window.localStorage.removeItem('freshcodex.modelMru.v2')
  window.localStorage.removeItem('freshcodex.modelLevelMru.v1')
  apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({
    status: 'idle',
    summary: 'Codex summary',
    capabilities: { send: true, interrupt: true, fork: true },
    diffs: [{ id: 'diff-1', title: 'README.md' }],
    worktrees: [{ id: 'wt-1', path: '/tmp/worktree', branch: 'feature/x' }],
    turns: [{ id: 'turn-1', role: 'assistant', items: [{ id: 'item-1', kind: 'text', text: 'Codex turn' }] }],
  })
  apiMock.getFreshAgentModelCapabilities.mockResolvedValue({
    ok: true,
    sessionType: 'freshopencode',
    runtimeProvider: 'opencode',
    status: 'fresh',
    fetchedAt: 1_000,
    models: [
      {
        id: 'opencode-go/deepseek-v4-flash',
        displayName: 'DeepSeek V4 Flash',
        provider: 'opencode',
        source: { id: 'opencode-go', displayName: 'opencode-go' },
        supportsEffort: true,
        supportedEffortLevels: ['minimal', 'low', 'medium', 'high', 'max'],
        supportsAdaptiveThinking: true,
      },
      {
        id: 'opencode-go/glm-5.1',
        displayName: 'GLM 5.1',
        provider: 'opencode',
        source: { id: 'opencode-go', displayName: 'opencode-go' },
        supportsEffort: true,
        supportedEffortLevels: ['minimal', 'low', 'medium', 'high', 'max'],
        supportsAdaptiveThinking: true,
      },
      {
        id: 'opencode-go/glm-5.2',
        displayName: 'GLM 5.2',
        provider: 'opencode',
        source: { id: 'opencode-go', displayName: 'opencode-go' },
        supportsEffort: true,
        supportedEffortLevels: ['minimal', 'low', 'medium', 'high', 'max'],
        supportsAdaptiveThinking: true,
      },
      {
        id: 'provider/model',
        displayName: 'Kimi k2.7',
        provider: 'opencode',
        source: { id: 'provider', displayName: 'provider' },
        supportsEffort: true,
        supportedEffortLevels: ['minimal', 'low', 'medium', 'high', 'max'],
        supportsAdaptiveThinking: true,
      },
    ],
  })
})

afterEach(() => {
  cleanup()
})

describe('FreshAgentView', () => {
  it('renders freshclaude capability prompts in the shared shell and answers approvals/questions over fresh-agent WS', async () => {
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
      decision: { behavior: 'allow' },
    })
    const approvalCall = (wsMock.send as any).mock.calls.find((call: any[]) =>
      call[0].requestId === 'approval-1'
    )
    expect('updatedInput' in approvalCall[0].decision).toBe(false)
    expect(wsMock.send).toHaveBeenCalledWith({
      type: 'freshAgent.question.respond',
      sessionId: CLAUDE_THREAD_ID,
      sessionType: 'freshclaude',
      provider: 'claude',
      requestId: 'question-1',
      answers: { 'How should Claude proceed?': 'Continue' },
    })
  })

  it('routes FreshOpenCode approval and question responses through the pane cwd', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
      status: 'running',
      summary: 'OpenCode summary',
      capabilities: { send: true, interrupt: true, approvals: true, questions: true, fork: true },
      pendingApprovals: [{
        requestId: 'approval-route',
        toolName: 'Bash',
        input: { command: 'pwd' },
      }],
      pendingQuestions: [{
        requestId: 'question-route',
        questions: [{
          header: 'Next step',
          question: 'Continue?',
          options: [{ label: 'Yes', description: 'Proceed' }],
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
            sessionType: 'freshopencode',
            provider: 'opencode',
            createRequestId: 'req-route-responses',
            sessionId: 'ses_route_responses',
            initialCwd: '/repo/route-aware',
            status: 'running',
          }}
        />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByRole('alert', { name: /permission request for bash/i })).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: /allow tool use/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))

    expect(wsMock.send).toHaveBeenCalledWith({
      type: 'freshAgent.approval.respond',
      sessionId: 'ses_route_responses',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/route-aware',
      requestId: 'approval-route',
      decision: { behavior: 'allow' },
    })
    const approvalRouteCall = (wsMock.send as any).mock.calls.find((call: any[]) =>
      call[0].requestId === 'approval-route'
    )
    expect('updatedInput' in approvalRouteCall[0].decision).toBe(false)
    expect(wsMock.send).toHaveBeenCalledWith({
      type: 'freshAgent.question.respond',
      sessionId: 'ses_route_responses',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/route-aware',
      requestId: 'question-route',
      answers: { 'Continue?': 'Yes' },
    })
  })

  it('honors pane display overrides ahead of global fresh-agent settings', async () => {
    const store = createStore()
    store.dispatch(updateSettingsLocal({
      freshAgent: {
        showThinking: false,
        showTools: false,
        showTimecodes: false,
      },
    }))
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
      status: 'idle',
      summary: 'Display summary',
      capabilities: { send: true, interrupt: true, fork: false },
      turns: [{
        id: 'turn-display',
        turnId: 'turn-display',
        role: 'assistant',
        timestamp: '2026-06-15T12:34:56.000Z',
        model: 'claude-opus-4-6',
        summary: 'used tools',
        items: [
          { id: 'think-display', kind: 'thinking', text: 'pane-level thinking' },
          {
            id: 'tool-display',
            kind: 'tool_use',
            toolUseId: 'call-display',
            name: 'Bash',
            input: { command: 'npm run display-check' },
          },
        ],
      }],
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
            createRequestId: 'req-display',
            sessionId: CLAUDE_THREAD_ID,
            status: 'connected',
            showThinking: true,
            showTools: true,
            showTimecodes: true,
          }}
        />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByText('npm run display-check')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Thinking' })).toBeInTheDocument()
    expect(screen.getByText('claude-opus-4-6')).toBeInTheDocument()
    // Local time h:mm AM/PM — no seconds, never UTC.
    const expectedTimecode = new Date('2026-06-15T12:34:56.000Z')
      .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true })
    const timecodeEl = screen.getByText(expectedTimecode)
    expect(timecodeEl.tagName).toBe('TIME')
    expect(timecodeEl.textContent).toMatch(/^\d{1,2}:\d{2}\s?(AM|PM)$/i)
  })

  it('does not pin the provider snapshot summary above the transcript', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
      status: 'idle',
      summary: 'Do not pin this session summary',
      capabilities: { send: true, interrupt: true, fork: false },
      turns: [{
        id: 'turn-summary-visibility',
        turnId: 'turn-summary-visibility',
        role: 'assistant',
        summary: 'Visible transcript answer',
        items: [{ id: 'item-summary-visibility', kind: 'text', text: 'Visible transcript answer' }],
      }],
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
            createRequestId: 'req-no-summary-pin',
            sessionId: CLAUDE_THREAD_ID,
            status: 'connected',
          }}
        />
      </Provider>,
    )

    expect(await screen.findByText('Visible transcript answer')).toBeInTheDocument()
    expect(screen.queryByText('Do not pin this session summary')).not.toBeInTheDocument()
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

  it('applies the mono terminal style to the view root', async () => {
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
            createRequestId: 'req-render-mono',
            sessionId: 'thread-render-mono',
            status: 'idle',
            style: 'mono',
          }}
        />
      </Provider>,
    )

    const root = await waitFor(() => document.querySelector('[data-context="fresh-agent"]') as HTMLElement)
    expect(root).toHaveAttribute('data-style', 'mono')
    expect(root).toHaveClass('fresh-agent-style-mono')
  })

  it('exposes a durable sessionRef as the fresh-agent context session id', async () => {
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
            createRequestId: 'req-context-session',
            status: 'idle',
            sessionRef: {
              provider: 'codex',
              sessionId: '019ec8c9-2b12-7001-a11d-e2e089860320',
            },
          }}
        />
      </Provider>,
    )

    await waitFor(() => expect(getFreshAgentSessionId()).toBe('019ec8c9-2b12-7001-a11d-e2e089860320'))
  })

  it('only exposes the stop action while the agent is working', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
      status: 'idle',
      capabilities: { send: true, interrupt: true, fork: false },
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
            createRequestId: 'req-stop-idle',
            sessionId: CLAUDE_THREAD_ID,
            status: 'idle',
          }}
        />
      </Provider>,
    )

    await screen.findByRole('textbox', { name: 'Chat message input' })
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()

    cleanup()

    const runningStore = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
      status: 'running',
      capabilities: { send: false, interrupt: true, fork: false },
      turns: [],
    })

    render(
      <Provider store={runningStore}>
        <FreshAgentView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={{
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            createRequestId: 'req-stop-running',
            sessionId: CLAUDE_RESTORE_THREAD_ID,
            status: 'running',
          }}
        />
      </Provider>,
    )

    expect(await screen.findByRole('button', { name: 'Stop' })).toBeEnabled()
  })

  it('routes FreshOpenCode interrupt through the pane cwd', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
      status: 'running',
      capabilities: { send: false, interrupt: true, fork: true },
      turns: [],
    })

    render(
      <Provider store={store}>
        <FreshAgentView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={{
            kind: 'fresh-agent',
            sessionType: 'freshopencode',
            provider: 'opencode',
            createRequestId: 'req-stop-route',
            sessionId: 'ses_stop_route',
            initialCwd: '/repo/route-aware',
            status: 'running',
          }}
        />
      </Provider>,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }))

    expect(wsMock.send).toHaveBeenCalledWith({
      type: 'freshAgent.interrupt',
      sessionId: 'ses_stop_route',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/route-aware',
    })
  })

  it('marks the fresh-agent body with pane and session flavor context metadata', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        sessionId: CLAUDE_THREAD_ID,
        createRequestId: 'req-context',
        status: 'idle',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    const root = document.querySelector('.fresh-agent-pane') as HTMLElement
    expect(root.dataset.context).toBe('fresh-agent')
    expect(root.dataset.tabId).toBe('tab-1')
    expect(root.dataset.paneId).toBe('pane-1')
    expect(root.dataset.sessionId).toBe(CLAUDE_THREAD_ID)
    expect(root.dataset.provider).toBe('claude')
    expect(root.dataset.sessionType).toBe('freshclaude')
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
            initialCwd: '/repo/from-ref',
            status: 'connected',
          }}
        />
      </Provider>,
    )

    await waitFor(() => {
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledWith(
        'freshcodex',
        'codex',
        'thread-from-ref',
        expect.objectContaining({ cwd: '/repo/from-ref' }),
      )
    })
    expect(await screen.findByText('Codex turn')).toBeInTheDocument()
  })

  it('restores a fresh-agent split pane remount without creating a replacement session', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-split-restore',
        sessionId: 'thread-split-restore',
        status: 'idle',
      },
    }))

    const first = render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await screen.findByRole('textbox', { name: 'Chat message input' })
    first.unmount()
    wsMock.send.mockClear()

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await screen.findByRole('textbox', { name: 'Chat message input' })
    expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledWith('freshcodex', 'codex', 'thread-split-restore', expect.any(Object))
    expect(sentFreshAgentMessages('freshAgent.create')).toHaveLength(0)
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

  it('tags durable FreshAgent created events as materialized metadata', async () => {
    const listeners: Array<(message: any) => void> = []
    wsMock.onMessage.mockImplementation((listener) => {
      listeners.push(listener)
      return () => {}
    })
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-created',
        status: 'creating',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    act(() => {
      listeners.forEach((listener) => listener({
        type: 'freshAgent.created',
        requestId: 'req-created',
        sessionId: 'codex-thread-1',
        sessionType: 'freshcodex',
        provider: 'codex',
        runtimeProvider: 'codex',
        sessionRef: { provider: 'codex', sessionId: 'codex-thread-1' },
      }))
    })

    await waitFor(() => {
      expect(apiMock.setSessionMetadata).toHaveBeenCalledWith('codex', 'codex-thread-1', 'freshcodex', {
        sessionTypeSource: 'materialized',
      })
    })
  })

  it('tags durable FreshAgent created events without sessionRef as materialized metadata', async () => {
    const listeners: Array<(message: any) => void> = []
    wsMock.onMessage.mockImplementation((listener) => {
      listeners.push(listener)
      return () => {}
    })
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-created-no-ref',
        status: 'creating',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    act(() => {
      listeners.forEach((listener) => listener({
        type: 'freshAgent.created',
        requestId: 'req-created-no-ref',
        sessionId: 'codex-thread-no-ref-1',
        sessionType: 'freshcodex',
        provider: 'codex',
        runtimeProvider: 'codex',
      }))
    })

    await waitFor(() => {
      expect(apiMock.setSessionMetadata).toHaveBeenCalledWith('codex', 'codex-thread-no-ref-1', 'freshcodex', {
        sessionTypeSource: 'materialized',
      })
    })
  })

  it('logs when FreshAgent materialized metadata tagging fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    apiMock.setSessionMetadata.mockRejectedValueOnce(new Error('metadata write failed'))
    const listeners: Array<(message: any) => void> = []
    wsMock.onMessage.mockImplementation((listener) => {
      listeners.push(listener)
      return () => {}
    })
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-created-log-failure',
        status: 'creating',
      },
    }))

    try {
      render(
        <Provider store={store}>
          <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
        </Provider>,
      )

      act(() => {
        listeners.forEach((listener) => listener({
          type: 'freshAgent.created',
          requestId: 'req-created-log-failure',
          sessionId: 'codex-thread-log-failure-1',
          sessionType: 'freshcodex',
          provider: 'codex',
          runtimeProvider: 'codex',
        }))
      })

      await waitFor(() => {
        expect(warnSpy).toHaveBeenCalledWith('[FreshAgentView]', expect.objectContaining({
          event: 'fresh_agent_session_metadata_tag_failed',
          provider: 'codex',
          sessionId: 'codex-thread-log-failure-1',
          sessionType: 'freshcodex',
        }))
      })
    } finally {
      warnSpy.mockRestore()
    }
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

  it('does not double-project non-idempotent freshAgent.event messages when App and view both receive them', async () => {
    const store = createStore()
    const sessionId = 'thread-single-projection-owner'
    const sessionKey = `freshcodex:codex:${sessionId}`
    let onMessage: ((message: Record<string, unknown>) => void) | undefined
    wsMock.onMessage.mockImplementation((handler: (message: Record<string, unknown>) => void) => {
      onMessage = handler
      return () => {}
    })
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: sessionId,
      revision: 1,
      latestTurnId: null,
      status: 'idle',
      summary: 'Empty thread',
      capabilities: { send: true, interrupt: true, approvals: true, questions: true, fork: true },
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      pendingApprovals: [],
      pendingQuestions: [],
      worktrees: [],
      diffs: [],
      childThreads: [],
      turns: [],
      extensions: {},
    })
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-single-projection-owner',
        sessionId,
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

    const deliverThroughAppAndMountedView = (event: Record<string, unknown>) => {
      const message = {
        type: 'freshAgent.event',
        sessionId,
        sessionType: 'freshcodex',
        provider: 'codex',
        event: { sessionId, ...event },
      }
      let handled = false
      act(() => {
        handled = handleFreshAgentMessage(store.dispatch, message)
        onMessage?.(message)
      })
      expect(handled).toBe(true)
    }

    deliverThroughAppAndMountedView({
      type: 'freshAgent.stream',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
    })
    expect(store.getState().freshAgent.sessions[sessionKey].streamingText).toBe('partial')

    deliverThroughAppAndMountedView({
      type: 'freshAgent.assistant',
      model: 'codex-5',
      content: [{ type: 'text', text: 'Final answer' }],
    })
    const assistantSession = store.getState().freshAgent.sessions[sessionKey]
    expect(assistantSession.turns).toHaveLength(1)
    expect(assistantSession.turns[0]).toMatchObject({
      role: 'assistant',
      model: 'codex-5',
      summary: '',
    })

    deliverThroughAppAndMountedView({
      type: 'freshAgent.result',
      costUsd: 0.07,
      usage: { input_tokens: 11, output_tokens: 13 },
    })
    expect(store.getState().freshAgent.sessions[sessionKey]).toMatchObject({
      totalCostUsd: 0.07,
      totalInputTokens: 11,
      totalOutputTokens: 13,
    })
  })

  it('tags durable FreshAgent materialization events and ignores placeholders', async () => {
    const listeners: Array<(message: any) => void> = []
    wsMock.onMessage.mockImplementation((listener) => {
      listeners.push(listener)
      return () => {}
    })
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        sessionId: 'freshopencode-req-provisional',
        createRequestId: 'req-provisional',
        status: 'connected',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    act(() => {
      listeners.forEach((listener) => listener({
        type: 'freshAgent.session.materialized',
        previousSessionId: 'freshopencode-req-provisional',
        sessionId: 'freshopencode-req-still-placeholder',
        sessionType: 'freshopencode',
        provider: 'opencode',
        sessionRef: { provider: 'opencode', sessionId: 'freshopencode-req-still-placeholder' },
      }))
    })
    expect(apiMock.setSessionMetadata).not.toHaveBeenCalled()

    act(() => {
      listeners.forEach((listener) => listener({
        type: 'freshAgent.session.materialized',
        previousSessionId: 'freshopencode-req-still-placeholder',
        sessionId: 'ses_real_1',
        sessionType: 'freshopencode',
        provider: 'opencode',
        sessionRef: { provider: 'opencode', sessionId: 'ses_real_1' },
      }))
    })

    await waitFor(() => {
      expect(apiMock.setSessionMetadata).toHaveBeenCalledWith('opencode', 'ses_real_1', 'freshopencode', {
        sessionTypeSource: 'materialized',
      })
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
        sessionRef: { provider: 'opencode', sessionId: 'freshopencode--gP4qyCL7bwp8-xbw9G7b' },
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

  it('attaches materialized FreshOpenCode panes with durable route metadata on mount and reconnect', async () => {
    const store = createStore()
    let reconnectHandler: (() => void) | undefined
    wsMock.onReconnect.mockImplementation((handler: () => void) => {
      reconnectHandler = handler
      return () => {}
    })
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-attach-route',
        sessionId: 'ses_attach_route',
        sessionRef: { provider: 'opencode', sessionId: 'ses_attach_route' },
        resumeSessionId: 'ses_attach_route',
        initialCwd: '/repo/route-aware',
        status: 'idle',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(wsMock.send).toHaveBeenCalledWith({
        type: 'freshAgent.attach',
        sessionId: 'ses_attach_route',
        sessionType: 'freshopencode',
        provider: 'opencode',
        sessionRef: { provider: 'opencode', sessionId: 'ses_attach_route' },
        cwd: '/repo/route-aware',
      })
    })
    expect(reconnectHandler).toBeTypeOf('function')

    wsMock.send.mockClear()
    act(() => {
      reconnectHandler?.()
    })

    await waitFor(() => {
      expect(wsMock.send).toHaveBeenCalledWith({
        type: 'freshAgent.attach',
        sessionId: 'ses_attach_route',
        sessionType: 'freshopencode',
        provider: 'opencode',
        sessionRef: { provider: 'opencode', sessionId: 'ses_attach_route' },
        cwd: '/repo/route-aware',
      })
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
      expect(screen.getByRole('textbox', { name: 'Chat message input' })).not.toBeDisabled()
    })

    wsMock.send.mockClear()

    expect(screen.queryByRole('radio', { name: 'GPT-5.5' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Thinking level' })).not.toBeInTheDocument()

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'Ship it' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(wsMock.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'freshAgent.send',
      requestId: expect.any(String),
      sessionId: 'thread-1',
      sessionType: 'freshcodex',
      provider: 'codex',
      text: 'Ship it',
      settings: {
        cwd: '/repo',
        model: 'gpt-5.3-codex-spark',
        effort: 'max',
      },
    }))

    expect(screen.queryByRole('button', { name: 'Interrupt' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Fork' })).not.toBeInTheDocument()
  })

  it('uses send acknowledgements to patch checkpoints and clear local echo only on the submitted user display turn', async () => {
    const store = createStore()
    const checkpoint = createDeferred<{ id: string; ts: number; label: string; requestId: string }>()
    let onMessage: ((message: Record<string, unknown>) => void) | undefined
    wsMock.onMessage.mockImplementation((handler: (message: Record<string, unknown>) => void) => {
      onMessage = handler
      return () => {}
    })
    apiMock.getFreshAgentThreadSnapshot
      .mockResolvedValueOnce({
        status: 'idle',
        summary: 'empty',
        capabilities: { send: true, interrupt: true, fork: true },
        turns: [],
      })
      .mockResolvedValueOnce({
        status: 'idle',
        summary: 'answered',
        capabilities: { send: true, interrupt: true, fork: true },
        turns: [
          {
            id: 'native-user-turn',
            turnId: 'display-user-1',
            role: 'user',
            summary: 'Ship it',
            items: [{ id: 'user-text-1', kind: 'text', text: 'Ship it' }],
          },
          {
            id: 'native-assistant-turn',
            turnId: 'display-assistant-1',
            role: 'assistant',
            summary: 'Done',
            items: [{ id: 'assistant-text-1', kind: 'text', text: 'Done.' }],
          },
        ],
      })
    apiMock.post.mockImplementation((url: string, body: Record<string, unknown>) => {
      if (url === '/api/fresh-agent/checkpoints') return checkpoint.promise
      if (url === '/api/fresh-agent/checkpoints/metadata') return Promise.resolve({ ok: true, body })
      return Promise.resolve({ title: null, source: 'none' })
    })
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-normalized-send',
        sessionId: 'thread-normalized-send',
        status: 'idle',
        initialCwd: '/repo',
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

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'Ship it' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    const send = sentFreshAgentMessages('freshAgent.send').at(-1)
    expect(send).toMatchObject({
      type: 'freshAgent.send',
      sessionId: 'thread-normalized-send',
      sessionType: 'freshcodex',
      provider: 'codex',
      text: 'Ship it',
    })
    expect(send?.requestId).toEqual(expect.any(String))
    const requestId = String(send?.requestId)
    expect(apiMock.post).toHaveBeenCalledWith('/api/fresh-agent/checkpoints', {
      cwd: '/repo',
      label: 'Ship it',
      requestId,
    })
    expect(screen.getByText('Ship it')).toBeInTheDocument()

    expect(onMessage).toBeTypeOf('function')
    act(() => {
      onMessage?.({
        type: 'freshAgent.send.accepted',
        requestId,
        submittedTurnId: 'display-user-1',
      })
    })
    await act(async () => {
      checkpoint.resolve({
        id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        ts: 1,
        label: 'Ship it',
        requestId,
      })
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/api/fresh-agent/checkpoints/metadata', {
        cwd: '/repo',
        id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        requestId,
        turnId: 'display-user-1',
      })
    })
    await waitFor(() => {
      expect(screen.getByText('Done.')).toBeInTheDocument()
    })
    expect(screen.getAllByText('Ship it')).toHaveLength(1)
    const transcriptTurns = screen.getAllByRole('article')
    expect(transcriptTurns.at(-1)).toHaveTextContent('Done.')
  })

  it('persists a pending local echo so a remounted pane keeps the submitted prompt visible', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({
      status: 'idle',
      summary: 'empty',
      capabilities: { send: true, interrupt: true, fork: true },
      turns: [],
    })
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-pending-echo',
        sessionId: 'freshopencode-pending-echo',
        status: 'idle',
      },
    }))

    const rendered = render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Chat message input' })).not.toBeDisabled()
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'Do not disappear on reload' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    const send = sentFreshAgentMessages('freshAgent.send').at(-1)
    const requestId = String(send?.requestId)
    await waitFor(() => {
      expect(getFreshAgentPaneContent(store)).toMatchObject({
        status: 'running',
        pendingLocalEcho: {
          requestId,
          text: 'Do not disappear on reload',
        },
      })
    })
    expect(screen.getByText('Do not disappear on reload')).toBeInTheDocument()

    rendered.unmount()
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    expect(screen.getByText('Do not disappear on reload')).toBeInTheDocument()
  })

  it('re-attaches with the route cwd and resends once when a send fails with FRESH_AGENT_LOST_SESSION', async () => {
    const store = createStore()
    let onMessage: ((message: Record<string, unknown>) => void) | undefined
    wsMock.onMessage.mockImplementation((handler: (message: Record<string, unknown>) => void) => {
      onMessage = handler
      return () => {}
    })
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({
      status: 'idle',
      summary: 'empty',
      capabilities: { send: true, interrupt: true, fork: true },
      turns: [],
    })
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-lost-session',
        sessionId: 'ses_9',
        status: 'idle',
        initialCwd: '/w',
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
    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'hello again' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    const sendFrame = sentFreshAgentMessages('freshAgent.send').at(-1)
    expect(sendFrame).toBeTruthy()
    expect(sendFrame?.text).toBe('hello again')
    await waitFor(() => {
      expect(getFreshAgentPaneContent(store)).toMatchObject({ status: 'running' })
    })
    wsMock.send.mockClear()

    // Act: server rejects with the lost-session code for that request
    expect(onMessage).toBeTypeOf('function')
    act(() => {
      onMessage?.({
        type: 'error',
        code: 'FRESH_AGENT_LOST_SESSION',
        requestId: sendFrame?.requestId,
        message: 'not tracked',
        timestamp: Date.now(),
      })
    })

    // Assert: exactly one attach (with cwd) then one resend of the same text
    await waitFor(() => {
      const attaches = sentFreshAgentMessages('freshAgent.attach')
      expect(attaches.some((m) => m.sessionId === 'ses_9' && m.cwd === '/w')).toBe(true)
      expect(sentFreshAgentMessages('freshAgent.send').filter((m) => m.text === 'hello again')).toHaveLength(1)
    })
    // The echo stays visible while the retry is in flight
    expect(screen.getByText('hello again')).toBeInTheDocument()

    // Second failure for the retried request must NOT loop...
    const retried = sentFreshAgentMessages('freshAgent.send').at(-1)
    expect(retried?.requestId).toEqual(expect.any(String))
    expect(retried?.requestId).not.toBe(sendFrame?.requestId)
    wsMock.send.mockClear()
    act(() => {
      onMessage?.({
        type: 'error',
        code: 'FRESH_AGENT_LOST_SESSION',
        requestId: retried?.requestId,
        message: 'still not tracked',
        timestamp: Date.now(),
      })
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100))
    })
    expect(sentFreshAgentMessages('freshAgent.send')).toHaveLength(0)
    expect(sentFreshAgentMessages('freshAgent.attach')).toHaveLength(0)

    // ...and the cleanup fall-through must fire for the final failure:
    await waitFor(() => {
      expect(screen.queryByText('hello again')).not.toBeInTheDocument() // stale local echo cleared
    })
    expect(getFreshAgentPaneContent(store).pendingLocalEcho).toBeUndefined() // Redux copy cleared too (dual-write)
    expect(getFreshAgentPaneContent(store).status).not.toBe('running') // optimistic busy released
  })

  it('keeps placeholder-session lost-session failures on the normal cleanup path without a retry', async () => {
    const store = createStore()
    let onMessage: ((message: Record<string, unknown>) => void) | undefined
    wsMock.onMessage.mockImplementation((handler: (message: Record<string, unknown>) => void) => {
      onMessage = handler
      return () => {}
    })
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({
      status: 'idle',
      summary: 'empty',
      capabilities: { send: true, interrupt: true, fork: true },
      turns: [],
    })
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-placeholder-lost',
        sessionId: 'freshopencode-req-placeholder-lost',
        status: 'idle',
        initialCwd: '/w',
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
    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'hello placeholder' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    const sendFrame = sentFreshAgentMessages('freshAgent.send').at(-1)
    expect(sendFrame?.text).toBe('hello placeholder')
    await waitFor(() => {
      expect(getFreshAgentPaneContent(store)).toMatchObject({ status: 'running' })
    })
    wsMock.send.mockClear()

    expect(onMessage).toBeTypeOf('function')
    act(() => {
      onMessage?.({
        type: 'error',
        code: 'FRESH_AGENT_LOST_SESSION',
        requestId: sendFrame?.requestId,
        message: 'not tracked',
        timestamp: Date.now(),
      })
    })

    // No retry for a placeholder (non-ses_) session: cleanup path only.
    await waitFor(() => {
      expect(screen.queryByText('hello placeholder')).not.toBeInTheDocument()
    })
    expect(sentFreshAgentMessages('freshAgent.attach')).toHaveLength(0)
    expect(sentFreshAgentMessages('freshAgent.send')).toHaveLength(0)
    expect(getFreshAgentPaneContent(store).pendingLocalEcho).toBeUndefined()
    expect(getFreshAgentPaneContent(store).status).not.toBe('running')
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

    expect(wsMock.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'freshAgent.send',
      requestId: expect.any(String),
      sessionId: 'freshopencode-req-opencode-send-policy',
      sessionType: 'freshopencode',
      provider: 'opencode',
      text: 'Use local OpenCode policy',
      settings: {
        cwd: '/repo',
        model: 'opencode-go/deepseek-v4-flash',
        effort: 'max',
      },
    }))
  })

  it('creates Freshopencode panes with modelSelection when persisted model is absent after reload', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-reload-opencode-model',
        status: 'creating',
        modelSelection: { kind: 'exact', modelId: 'opencode-go/glm-5.2' },
        effort: 'max',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(sentFreshAgentMessages('freshAgent.create')).toContainEqual(expect.objectContaining({
        type: 'freshAgent.create',
        sessionType: 'freshopencode',
        provider: 'opencode',
        model: 'opencode-go/glm-5.2',
        modelSelection: { kind: 'exact', modelId: 'opencode-go/glm-5.2' },
      }))
    })
  })

  it('creates Freshopencode panes with the saved provider model when the pane has no model preference', async () => {
    const store = createStore()
    store.dispatch(previewServerSettingsPatch({
      freshAgent: {
        providers: {
          freshopencode: {
            modelSelection: { kind: 'exact', modelId: 'provider/model' },
            effort: 'high',
          },
        },
      },
    }))
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-provider-default-opencode-model',
        status: 'creating',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(sentFreshAgentMessages('freshAgent.create')).toContainEqual(expect.objectContaining({
        type: 'freshAgent.create',
        sessionType: 'freshopencode',
        provider: 'opencode',
        model: 'provider/model',
        effort: 'high',
      }))
    })
  })

  it('sends Freshopencode messages with modelSelection when pane model is absent', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-send-opencode-model',
        sessionId: 'freshopencode-req-send-opencode-model',
        status: 'idle',
        modelSelection: { kind: 'exact', modelId: 'deepseek/deepseek-v4-pro' },
        effort: 'high',
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

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'hello' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(sentFreshAgentMessages('freshAgent.send')).toContainEqual(expect.objectContaining({
      type: 'freshAgent.send',
      settings: expect.objectContaining({
        model: 'deepseek/deepseek-v4-pro',
        effort: 'high',
      }),
    }))
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

  it('clears stale running session state when a freshcodex REST snapshot reports idle', async () => {
    const store = createStore()
    const sessionId = '019efd2e-3270-71d0-a3c9-e097537be604'
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: sessionId,
      sessionId,
      status: 'idle',
      revision: 123,
      latestTurnId: null,
      capabilities: { send: true, interrupt: true, fork: true },
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      turns: [],
      pendingApprovals: [],
      pendingQuestions: [],
    })
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        sessionId,
        sessionRef: { provider: 'codex', sessionId },
        resumeSessionId: sessionId,
        createRequestId: 'req-freshcodex-stale-running',
        status: 'running',
        initialCwd: '/home/dan/code/freshell',
      },
    }))
    store.dispatch(setSessionStatus({
      sessionId,
      sessionType: 'freshcodex',
      provider: 'codex',
      status: 'running',
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(store.getState().freshAgent.sessions[`freshcodex:codex:${sessionId}`]?.status).toBe('idle')
    })
    expect(getFreshAgentPaneContent(store).status).toBe('idle')
    expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledWith(
      'freshcodex',
      'codex',
      sessionId,
      expect.objectContaining({ cwd: '/home/dan/code/freshell' }),
    )
    expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(1)
  })

  it('does not clear running session state from a freshcodex REST snapshot while another pane for the same session has unresolved local echo', async () => {
    const store = createStore()
    const sessionId = '019efd2e-3270-71d0-a3c9-e097537be604'
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
      sessionType: 'freshcodex',
      provider: 'codex',
      threadId: sessionId,
      sessionId,
      status: 'idle',
      revision: 124,
      latestTurnId: null,
      capabilities: { send: true, interrupt: true, fork: true },
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      turns: [],
      pendingApprovals: [],
      pendingQuestions: [],
    })
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        sessionId,
        sessionRef: { provider: 'codex', sessionId },
        resumeSessionId: sessionId,
        createRequestId: 'req-freshcodex-current',
        status: 'running',
        initialCwd: '/home/dan/code/freshell',
      },
    }))
    store.dispatch(initLayout({
      tabId: 'tab-2',
      paneId: 'pane-2',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        sessionId,
        sessionRef: { provider: 'codex', sessionId },
        resumeSessionId: sessionId,
        createRequestId: 'req-freshcodex-sibling',
        status: 'running',
        initialCwd: '/home/dan/code/freshell',
        pendingLocalEcho: {
          requestId: 'req-local-send',
          text: 'still sending',
        },
      },
    }))
    store.dispatch(setSessionStatus({
      sessionId,
      sessionType: 'freshcodex',
      provider: 'codex',
      status: 'running',
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(getFreshAgentPaneContent(store).status).toBe('idle')
    })
    expect(store.getState().freshAgent.sessions[`freshcodex:codex:${sessionId}`]?.status).toBe('running')
  })

  it('does not let an older idle REST response overwrite a newer same-valued running session status', async () => {
    const store = createStore()
    const sessionId = 'thread-rest-race'
    const snapshot = createDeferred<Record<string, unknown>>()
    apiMock.getFreshAgentThreadSnapshot.mockReturnValueOnce(snapshot.promise)
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        sessionId,
        sessionRef: { provider: 'codex', sessionId },
        resumeSessionId: sessionId,
        createRequestId: 'req-rest-race',
        status: 'running',
        initialCwd: '/home/dan/code/freshell',
      },
    }))
    store.dispatch(setSessionStatus({
      sessionId,
      sessionType: 'freshcodex',
      provider: 'codex',
      status: 'running',
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(1)
    })
    const versionAtRequest = (
      store.getState().freshAgent.sessions[`freshcodex:codex:${sessionId}`] as { statusVersion?: number } | undefined
    )?.statusVersion
    await act(async () => {
      store.dispatch(setSessionStatus({
        sessionId,
        sessionType: 'freshcodex',
        provider: 'codex',
        status: 'running',
      }))
    })
    expect((
      store.getState().freshAgent.sessions[`freshcodex:codex:${sessionId}`] as { statusVersion?: number } | undefined
    )?.statusVersion).toBeGreaterThan(versionAtRequest ?? -1)
    await act(async () => {
      snapshot.resolve({
        sessionType: 'freshcodex',
        provider: 'codex',
        threadId: sessionId,
        sessionId,
        status: 'idle',
        revision: 125,
        latestTurnId: null,
        capabilities: { send: true, interrupt: true, fork: true },
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
        turns: [],
        pendingApprovals: [],
        pendingQuestions: [],
      })
    })

    await waitFor(() => {
      expect(getFreshAgentPaneContent(store).status).toBe('idle')
    })
    expect(store.getState().freshAgent.sessions[`freshcodex:codex:${sessionId}`]?.status).toBe('running')
  })

  it('clears stale opencode busy state from a live-reconciled idle HTTP snapshot', async () => {
    const store = createStore()
    const sessionId = 'ses_1'
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
      sessionType: 'freshopencode',
      provider: 'opencode',
      threadId: sessionId,
      sessionId,
      status: 'idle',
      revision: 210,
      latestTurnId: null,
      capabilities: { send: true, interrupt: true, fork: true },
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      turns: [],
      pendingApprovals: [],
      pendingQuestions: [],
      extensions: { opencode: { statusFromLiveState: true } },
    })
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        sessionId,
        sessionRef: { provider: 'opencode', sessionId },
        resumeSessionId: sessionId,
        createRequestId: 'req-freshopencode-stale-running',
        status: 'running',
        initialCwd: '/home/dan/code/freshell',
      },
    }))
    store.dispatch(setSessionStatus({
      sessionId,
      sessionType: 'freshopencode',
      provider: 'opencode',
      status: 'running',
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(store.getState().freshAgent.sessions[`freshopencode:opencode:${sessionId}`]?.status).toBe('idle')
    })
    expect(getFreshAgentPaneContent(store).status).toBe('idle')
    expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledWith(
      'freshopencode',
      'opencode',
      sessionId,
      expect.objectContaining({ cwd: '/home/dan/code/freshell' }),
    )
  })

  it('does NOT clear opencode busy state from an idle snapshot that is not live-reconciled', async () => {
    const store = createStore()
    const sessionId = 'ses_1'
    // Restore-window default idle: untracked (adapter liveState?.status ?? 'idle')
    // or mid-reconcile -- the snapshot carries no statusFromLiveState marker.
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
      sessionType: 'freshopencode',
      provider: 'opencode',
      threadId: sessionId,
      sessionId,
      status: 'idle',
      revision: 211,
      latestTurnId: null,
      capabilities: { send: true, interrupt: true, fork: true },
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
      turns: [],
      pendingApprovals: [],
      pendingQuestions: [],
    })
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        sessionId,
        sessionRef: { provider: 'opencode', sessionId },
        resumeSessionId: sessionId,
        createRequestId: 'req-freshopencode-not-live-reconciled',
        status: 'running',
        initialCwd: '/home/dan/code/freshell',
      },
    }))
    store.dispatch(setSessionStatus({
      sessionId,
      sessionType: 'freshopencode',
      provider: 'opencode',
      status: 'running',
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    // The pane content still adopts the snapshot status (pre-existing behavior);
    // waiting on it proves the snapshot was fully applied before we assert.
    await waitFor(() => {
      expect(getFreshAgentPaneContent(store).status).toBe('idle')
    })
    expect(store.getState().freshAgent.sessions[`freshopencode:opencode:${sessionId}`]?.status).toBe('running')
  })

  it('preserves loaded transcript history when a submit refresh returns only the in-flight turn', async () => {
    const store = createStore()
    let onMessage: ((message: Record<string, unknown>) => void) | undefined
    wsMock.onMessage.mockImplementation((handler: (message: Record<string, unknown>) => void) => {
      onMessage = handler
      return () => {}
    })
    apiMock.getFreshAgentThreadSnapshot
      .mockResolvedValueOnce({
        sessionType: 'freshcodex',
        provider: 'codex',
        threadId: 'thread-partial-refresh',
        status: 'idle',
        summary: 'Loaded history',
        capabilities: { send: true, interrupt: true, fork: true },
        turns: [
          {
            id: 'turn-old-user',
            turnId: 'turn-old-user',
            role: 'user',
            summary: 'Older user request',
            items: [{ id: 'item-old-user', kind: 'text', text: 'Older user request' }],
          },
          {
            id: 'turn-old-assistant',
            turnId: 'turn-old-assistant',
            role: 'assistant',
            summary: 'Older assistant answer',
            items: [{ id: 'item-old-assistant', kind: 'text', text: 'Older assistant answer' }],
          },
        ],
      })
      .mockResolvedValueOnce({
        sessionType: 'freshcodex',
        provider: 'codex',
        threadId: 'thread-partial-refresh',
        status: 'running',
        summary: 'Partial in-flight turn',
        capabilities: { send: false, interrupt: true, fork: true },
        turns: [
          {
            id: 'turn-new-user',
            turnId: 'turn-new-user',
            role: 'user',
            summary: 'New user request',
            items: [{ id: 'item-new-user', kind: 'text', text: 'New user request' }],
          },
        ],
      })
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-partial-refresh',
        sessionId: 'thread-partial-refresh',
        status: 'idle',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByText('Older assistant answer')).toBeInTheDocument()
    })

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'New user request' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    const send = sentFreshAgentMessages('freshAgent.send').at(-1)
    const requestId = String(send?.requestId)

    expect(screen.getByText('Older user request')).toBeInTheDocument()
    expect(screen.getByText('Older assistant answer')).toBeInTheDocument()

    expect(onMessage).toBeTypeOf('function')
    act(() => {
      onMessage?.({
        type: 'freshAgent.send.accepted',
        requestId,
        submittedTurnId: 'turn-new-user',
      })
      onMessage?.({
        type: 'freshAgent.event',
        sessionId: 'thread-partial-refresh',
        sessionType: 'freshcodex',
        provider: 'codex',
        event: {
          type: 'freshAgent.session.snapshot',
          sessionId: 'thread-partial-refresh',
          latestTurnId: 'turn-new-user',
          status: 'running',
          revision: 2,
        },
      })
    })

    await waitFor(() => {
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(2)
    })
    expect(screen.getByText('Older user request')).toBeInTheDocument()
    expect(screen.getByText('Older assistant answer')).toBeInTheDocument()
    expect(screen.getByText('New user request')).toBeInTheDocument()
  })

  it('replaces prior history when a settled same-session snapshot intentionally has fewer turns', async () => {
    const store = createStore()
    let onMessage: ((message: Record<string, unknown>) => void) | undefined
    wsMock.onMessage.mockImplementation((handler: (message: Record<string, unknown>) => void) => {
      onMessage = handler
      return () => {}
    })
    apiMock.getFreshAgentThreadSnapshot
      .mockResolvedValueOnce({
        sessionType: 'freshcodex',
        provider: 'codex',
        threadId: 'thread-authoritative-refresh',
        revision: 1,
        status: 'idle',
        summary: 'Loaded history',
        capabilities: { send: true, interrupt: true, fork: true },
        turns: [
          {
            id: 'turn-prior-user',
            turnId: 'turn-prior-user',
            role: 'user',
            summary: 'Prior user request',
            items: [{ id: 'item-prior-user', kind: 'text', text: 'Prior user request' }],
          },
          {
            id: 'turn-prior-assistant',
            turnId: 'turn-prior-assistant',
            role: 'assistant',
            summary: 'Prior assistant answer',
            items: [{ id: 'item-prior-assistant', kind: 'text', text: 'Prior assistant answer' }],
          },
        ],
      })
      .mockResolvedValueOnce({
        sessionType: 'freshcodex',
        provider: 'codex',
        threadId: 'thread-authoritative-refresh',
        revision: 2,
        status: 'idle',
        summary: 'Authoritative shorter history',
        capabilities: { send: true, interrupt: true, fork: true },
        turns: [
          {
            id: 'turn-authoritative-user',
            turnId: 'turn-authoritative-user',
            role: 'user',
            summary: 'Authoritative replacement request',
            items: [{ id: 'item-authoritative-user', kind: 'text', text: 'Authoritative replacement request' }],
          },
        ],
      })
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-authoritative-refresh',
        sessionId: 'thread-authoritative-refresh',
        status: 'idle',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByText('Prior assistant answer')).toBeInTheDocument()
    })

    expect(onMessage).toBeTypeOf('function')
    act(() => {
      onMessage?.({
        type: 'freshAgent.event',
        sessionId: 'thread-authoritative-refresh',
        sessionType: 'freshcodex',
        provider: 'codex',
        event: {
          type: 'freshAgent.session.snapshot',
          sessionId: 'thread-authoritative-refresh',
          latestTurnId: 'turn-authoritative-user',
          status: 'idle',
          revision: 2,
        },
      })
    })

    await waitFor(() => {
      expect(screen.getByText('Authoritative replacement request')).toBeInTheDocument()
    })
    expect(screen.queryByText('Prior user request')).not.toBeInTheDocument()
    expect(screen.queryByText('Prior assistant answer')).not.toBeInTheDocument()
  })

  it('ignores an older same-session snapshot revision after newer history is already rendered', async () => {
    const store = createStore()
    let onMessage: ((message: Record<string, unknown>) => void) | undefined
    wsMock.onMessage.mockImplementation((handler: (message: Record<string, unknown>) => void) => {
      onMessage = handler
      return () => {}
    })
    apiMock.getFreshAgentThreadSnapshot
      .mockResolvedValueOnce({
        sessionType: 'freshcodex',
        provider: 'codex',
        threadId: 'thread-stale-revision',
        revision: 8,
        status: 'idle',
        summary: 'Current history',
        capabilities: { send: true, interrupt: true, fork: true },
        turns: [
          {
            id: 'turn-current',
            turnId: 'turn-current',
            role: 'assistant',
            summary: 'Current rendered answer',
            items: [{ id: 'item-current', kind: 'text', text: 'Current rendered answer' }],
          },
        ],
      })
      .mockResolvedValueOnce({
        sessionType: 'freshcodex',
        provider: 'codex',
        threadId: 'thread-stale-revision',
        revision: 7,
        status: 'running',
        summary: 'Stale history',
        capabilities: { send: false, interrupt: true, fork: true },
        turns: [
          {
            id: 'turn-stale',
            turnId: 'turn-stale',
            role: 'assistant',
            summary: 'Stale older answer',
            items: [{ id: 'item-stale', kind: 'text', text: 'Stale older answer' }],
          },
        ],
      })
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-stale-revision',
        sessionId: 'thread-stale-revision',
        status: 'idle',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByText('Current rendered answer')).toBeInTheDocument()
    })

    expect(onMessage).toBeTypeOf('function')
    act(() => {
      onMessage?.({
        type: 'freshAgent.event',
        sessionId: 'thread-stale-revision',
        sessionType: 'freshcodex',
        provider: 'codex',
        event: {
          type: 'freshAgent.session.snapshot',
          sessionId: 'thread-stale-revision',
          latestTurnId: 'turn-stale',
          status: 'running',
          revision: 7,
        },
      })
    })

    await waitFor(() => {
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(2)
    })
    expect(screen.getByText('Current rendered answer')).toBeInTheDocument()
    expect(screen.queryByText('Stale older answer')).not.toBeInTheDocument()
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
        initialCwd: '/repo/route-aware',
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
      cwd: '/repo/route-aware',
      instructions: 'keep implementation notes',
    })
  })

  it('routes FreshOpenCode new-conversation kill through the pane cwd', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-new-route',
        sessionId: 'ses_new_route',
        initialCwd: '/repo/route-aware',
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
      target: { value: '/new' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(wsMock.send).toHaveBeenCalledWith({
      type: 'freshAgent.kill',
      sessionId: 'ses_new_route',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/route-aware',
    })
  })

  it('routes FreshOpenCode forks through the pane cwd', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
      status: 'idle',
      summary: 'OpenCode summary',
      capabilities: { send: true, interrupt: true, fork: true },
      turns: [
        {
          id: 'turn-route-fork',
          turnId: 'turn-route-fork',
          role: 'assistant',
          summary: 'Ready to fork',
          items: [{ id: 'item-route-fork', kind: 'text', text: 'Ready to fork' }],
        },
      ],
    })
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-fork-route',
        sessionId: 'ses_fork_route',
        initialCwd: '/repo/route-aware',
        status: 'idle',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Fork conversation from here' }))

    expect(wsMock.send).toHaveBeenCalledWith({
      type: 'freshAgent.fork',
      requestId: 'req-fork-route',
      sessionId: 'ses_fork_route',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/route-aware',
      input: { atTurnId: 'turn-route-fork' },
    })
  })

  it('lets Freshcodex settings choose model and thinking level from the gear popover’s Change… dialog', async () => {
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
    // Retired from the freshcodex popover: the radio model list and the
    // separate Thinking dropdown. Only the compact Model row remains.
    expect(screen.queryByRole('radiogroup', { name: 'Model' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Thinking level' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /GPT-5\.5 · max.*Change/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Change/ }))
    await screen.findByRole('dialog', { name: 'Model and thinking level' })
    fireEvent.click(screen.getByRole('option', { name: /GPT-5\.4 Flash/ }))

    // GPT-5.4 Flash declares none..high (no xhigh/max); levels arrive in
    // canonical order.
    const levelsList = screen.getByRole('listbox', { name: 'Thinking levels for GPT-5.4 Flash' })
    const levelTexts = Array.from(levelsList.querySelectorAll('[role="option"]')).map((el) => el.textContent)
    expect(levelTexts.map((text) => text?.replace(/last used|highest|current|●/g, '').trim())).toEqual(
      ['none', 'minimal', 'low', 'medium', 'high'],
    )

    fireEvent.click(screen.getByRole('button', { name: 'Use GPT-5.4 Flash · high' }))

    await waitFor(() => {
      const layout = store.getState().panes.layouts['tab-1']
      expect(layout?.type).toBe('leaf')
      expect(layout?.type === 'leaf' && layout.content.kind === 'fresh-agent' ? layout.content.model : null).toBe('gpt-5.4-flash')
      expect(layout?.type === 'leaf' && layout.content.kind === 'fresh-agent' ? layout.content.effort : null).toBe('high')
    })
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
    // Thinking now persists through the Change… dialog, not a retired dropdown.
    fireEvent.click(screen.getByRole('button', { name: /GPT-5\.4 Flash · medium.*Change/ }))
    await screen.findByRole('dialog', { name: 'Model and thinking level' })
    const levelsList = screen.getByRole('listbox', { name: 'Thinking levels for GPT-5.4 Flash' })
    const highOption = Array.from(levelsList.querySelectorAll('[role="option"]')).find((el) => el.textContent?.includes('high'))
    expect(highOption).toBeDefined()
    fireEvent.click(highOption!)
    fireEvent.click(screen.getByRole('button', { name: 'Use GPT-5.4 Flash · high' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Permission mode' }), {
      target: { value: 'never' },
    })

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

  it('lets a Freshcodex pane choose the mono terminal style', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-mono-style',
        sessionId: 'thread-mono-style',
        status: 'idle',
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
    expect(Array.from(styleSelect.querySelectorAll('option')).map((option) => option.textContent)).toEqual(['Sans', 'Serif', 'Mono'])

    fireEvent.change(styleSelect, { target: { value: 'mono' } })

    const layout = store.getState().panes.layouts['tab-1']
    expect(layout?.type === 'leaf' && layout.content.kind === 'fresh-agent' ? layout.content.style : null).toBe('mono')
    expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
      freshAgent: {
        providers: {
          freshcodex: { style: 'mono' },
        },
      },
    })
  })

  it('lets Freshopencode settings choose model and thinking level from the gear popover’s Change… dialog', async () => {
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
    // The popover keeps only a compact Model row now; tiles, the one-column
    // browser, and the separate Thinking dropdown are retired.
    expect(await screen.findByRole('button', { name: /DeepSeek V4 Flash · max.*Change/ })).toBeVisible()
    expect(screen.queryByRole('combobox', { name: 'Thinking level' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Change/ }))
    await screen.findByRole('dialog', { name: 'Model and thinking level' })
    fireEvent.click(screen.getByRole('option', { name: /GLM 5\.1/ }))
    const levelsList = screen.getByRole('listbox', { name: 'Thinking levels for GLM 5.1' })
    const highOption = Array.from(levelsList.querySelectorAll('[role="option"]')).find((el) => el.textContent?.includes('high'))
    expect(highOption).toBeDefined()
    fireEvent.click(highOption!)
    fireEvent.click(screen.getByRole('button', { name: 'Use GLM 5.1 · high' }))

    await waitFor(() => {
      const paneContent = (store.getState().panes.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>).content
      expect(paneContent.kind).toBe('fresh-agent')
      if (paneContent.kind === 'fresh-agent') {
        expect(paneContent.model).toBe('opencode-go/glm-5.1')
        expect(paneContent.effort).toBe('high')
      }
    })
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
        sessionRef: { provider: 'codex', sessionId: 'thread-refresh' },
      })
    })
    await waitFor(() => {
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledWith('freshcodex', 'codex', 'thread-refresh', expect.any(Object))
    })
    expect(store.getState().panes.refreshRequestsByPane?.['tab-1']?.['pane-1']).toBeUndefined()
  })

  it('refreshes freshopencode on session.changed without reopening the bouncer', async () => {
    const store = createStore()
    let wsHandler: ((message: any) => void) | undefined
    wsMock.onMessage.mockImplementation((handler) => {
      wsHandler = handler
      return () => {}
    })

    apiMock.getFreshAgentThreadSnapshot
      .mockResolvedValueOnce(freshopencodeSnapshot('done', 10))
      .mockResolvedValueOnce(freshopencodeSnapshot('done updated', 11))

    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-late-change',
        sessionId: 'ses_late_change',
        sessionRef: { provider: 'opencode', sessionId: 'ses_late_change' },
        resumeSessionId: 'ses_late_change',
        status: 'idle',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByText('done')).toBeInTheDocument()
    })

    act(() => {
      wsHandler?.({
        type: 'freshAgent.event',
        sessionId: 'ses_late_change',
        sessionType: 'freshopencode',
        provider: 'opencode',
        event: {
          type: 'freshAgent.session.changed',
          sessionId: 'ses_late_change',
          reason: 'opencode-message',
        },
      })
    })

    await waitFor(() => {
      expect(screen.getByText('done updated')).toBeInTheDocument()
    })
    expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(2)
    expect(getFreshAgentPaneContent(store)).toMatchObject({
      sessionId: 'ses_late_change',
      status: 'idle',
    })
  })

  it('coalesces owned snapshot invalidations and ignores non-owner or non-snapshot events', async () => {
    const store = createStore()
    let wsHandler: ((message: any) => void) | undefined
    wsMock.onMessage.mockImplementation((handler) => {
      wsHandler = handler
      return () => {}
    })
    apiMock.getFreshAgentThreadSnapshot
      .mockResolvedValueOnce({
        sessionType: 'freshopencode',
        provider: 'opencode',
        threadId: 'ses_scoped_refresh',
        status: 'idle',
        summary: 'initial',
        capabilities: { send: true, interrupt: true, fork: true },
        turns: [],
      })
      .mockResolvedValueOnce({
        sessionType: 'freshopencode',
        provider: 'opencode',
        threadId: 'ses_scoped_refresh',
        status: 'idle',
        summary: 'updated',
        capabilities: { send: true, interrupt: true, fork: true },
        turns: [
          {
            id: 'turn-scoped-user',
            turnId: 'turn-scoped-user',
            role: 'user',
            summary: 'Refresh this pane',
            items: [{ id: 'item-scoped-user', kind: 'text', text: 'Refresh this pane' }],
          },
        ],
      })
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-scoped-refresh',
        sessionId: 'ses_scoped_refresh',
        sessionRef: { provider: 'opencode', sessionId: 'ses_scoped_refresh' },
        resumeSessionId: 'ses_scoped_refresh',
        initialCwd: '/repo/scoped-refresh',
        status: 'idle',
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
    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'Refresh this pane' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    const send = sentFreshAgentMessages('freshAgent.send').at(-1)
    const requestId = String(send?.requestId)

    expect(wsHandler).toBeTypeOf('function')
    act(() => {
      wsHandler?.({
        type: 'freshAgent.send.accepted',
        requestId: 'foreign-request',
        submittedTurnId: 'foreign-turn',
        sessionId: 'ses_scoped_refresh',
        sessionType: 'freshopencode',
        provider: 'opencode',
        cwd: '/repo/scoped-refresh',
      })
      wsHandler?.({
        type: 'freshAgent.send.accepted',
        requestId,
        submittedTurnId: 'wrong-route-turn',
        sessionId: 'ses_scoped_refresh',
        sessionType: 'freshopencode',
        provider: 'opencode',
        cwd: '/repo/other-pane',
      })
      wsHandler?.({
        type: 'freshAgent.event',
        sessionId: 'ses_scoped_refresh',
        sessionType: 'freshopencode',
        provider: 'opencode',
        event: {
          type: 'freshAgent.stream',
          sessionId: 'ses_scoped_refresh',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
        },
      })
      wsHandler?.({
        type: 'freshAgent.event',
        sessionId: 'ses_scoped_refresh',
        sessionType: 'freshopencode',
        provider: 'opencode',
        event: {
          type: 'freshAgent.status',
          sessionId: 'ses_scoped_refresh',
          status: 'running',
        },
      })
      wsHandler?.({
        type: 'freshAgent.event',
        sessionId: 'ses_scoped_refresh',
        sessionType: 'freshopencode',
        provider: 'opencode',
        event: {
          type: 'freshAgent.session.metadata',
          sessionId: 'ses_scoped_refresh',
          cwd: '/repo/scoped-refresh',
        },
      })
      wsHandler?.({
        type: 'freshAgent.event',
        sessionId: 'ses_other_pane',
        sessionType: 'freshopencode',
        provider: 'opencode',
        event: {
          type: 'freshAgent.session.changed',
          sessionId: 'ses_other_pane',
        },
      })
    })

    expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(1)

    act(() => {
      wsHandler?.({
        type: 'freshAgent.send.accepted',
        requestId,
        submittedTurnId: 'turn-scoped-user',
        sessionId: 'ses_scoped_refresh',
        sessionType: 'freshopencode',
        provider: 'opencode',
        cwd: '/repo/scoped-refresh',
      })
      wsHandler?.({
        type: 'freshAgent.event',
        sessionId: 'ses_scoped_refresh',
        sessionType: 'freshopencode',
        provider: 'opencode',
        event: {
          type: 'freshAgent.session.changed',
          sessionId: 'ses_scoped_refresh',
        },
      })
      wsHandler?.({
        type: 'freshAgent.event',
        sessionId: 'ses_scoped_refresh',
        sessionType: 'freshopencode',
        provider: 'opencode',
        event: {
          type: 'freshAgent.permission.request',
          sessionId: 'ses_scoped_refresh',
          requestId: 'permission-scoped',
          tool: { name: 'Bash', input: { command: 'pwd' } },
        },
      })
    })

    await waitFor(() => {
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(2)
    })
  })

  it('coalesces real async accepted and snapshot events delivered close together', async () => {
    const store = createStore()
    let wsHandler: ((message: any) => void) | undefined
    wsMock.onMessage.mockImplementation((handler) => {
      wsHandler = handler
      return () => {}
    })
    apiMock.getFreshAgentThreadSnapshot
      .mockResolvedValueOnce({
        sessionType: 'freshopencode',
        provider: 'opencode',
        threadId: 'ses_async_coalesce',
        status: 'idle',
        capabilities: { send: true, interrupt: true, fork: true },
        turns: [],
      })
      .mockResolvedValueOnce({
        sessionType: 'freshopencode',
        provider: 'opencode',
        threadId: 'ses_async_coalesce',
        status: 'idle',
        capabilities: { send: true, interrupt: true, fork: true },
        turns: [
          {
            id: 'turn-async-user',
            turnId: 'turn-async-user',
            role: 'user',
            summary: 'Async burst prompt',
            items: [{ id: 'item-async-user', kind: 'text', text: 'Async burst prompt' }],
          },
        ],
      })
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-async-coalesce',
        sessionId: 'ses_async_coalesce',
        sessionRef: { provider: 'opencode', sessionId: 'ses_async_coalesce' },
        resumeSessionId: 'ses_async_coalesce',
        initialCwd: '/repo/async-coalesce',
        status: 'idle',
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
    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'Async burst prompt' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    const send = sentFreshAgentMessages('freshAgent.send').at(-1)
    const requestId = String(send?.requestId)

    act(() => {
      wsHandler?.({
        type: 'freshAgent.send.accepted',
        requestId,
        submittedTurnId: 'turn-async-user',
        sessionId: 'ses_async_coalesce',
        sessionType: 'freshopencode',
        provider: 'opencode',
        cwd: '/repo/async-coalesce',
      })
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    act(() => {
      wsHandler?.({
        type: 'freshAgent.event',
        sessionId: 'ses_async_coalesce',
        sessionType: 'freshopencode',
        provider: 'opencode',
        event: {
          type: 'freshAgent.session.snapshot',
          sessionId: 'ses_async_coalesce',
          status: 'idle',
          latestTurnId: 'turn-async-user',
          revision: 2,
        },
      })
    })

    await waitFor(() => {
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(2)
    })
  })

  it('coalesces a final send acceptance landing during an earlier invalidation debounce into one shared refresh', async () => {
    const store = createStore()
    let wsHandler: ((message: any) => void) | undefined
    wsMock.onMessage.mockImplementation((handler) => {
      wsHandler = handler
      return () => {}
    })
    apiMock.getFreshAgentThreadSnapshot
      .mockResolvedValueOnce({
        sessionType: 'freshopencode',
        provider: 'opencode',
        threadId: 'ses_final_race',
        status: 'idle',
        capabilities: { send: true, interrupt: true, fork: true },
        turns: [],
      })
      .mockResolvedValueOnce({
        sessionType: 'freshopencode',
        provider: 'opencode',
        threadId: 'ses_final_race',
        revision: 3,
        status: 'idle',
        capabilities: { send: true, interrupt: true, fork: true },
        turns: [
          {
            id: 'turn-final-user',
            turnId: 'turn-final-user',
            role: 'user',
            summary: 'Race final prompt',
            items: [{ id: 'item-final-user', kind: 'text', text: 'Race final prompt' }],
          },
          {
            id: 'turn-final-assistant',
            turnId: 'turn-final-assistant',
            role: 'assistant',
            summary: 'Final answer after durable history catches up',
            items: [{ id: 'item-final-assistant', kind: 'text', text: 'Final answer after durable history catches up' }],
          },
        ],
      })
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-final-race',
        sessionId: 'ses_final_race',
        sessionRef: { provider: 'opencode', sessionId: 'ses_final_race' },
        resumeSessionId: 'ses_final_race',
        initialCwd: '/repo/final-race',
        status: 'idle',
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
    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'Race final prompt' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    const send = sentFreshAgentMessages('freshAgent.send').at(-1)
    const requestId = String(send?.requestId)

    act(() => {
      wsHandler?.({
        type: 'freshAgent.event',
        sessionId: 'ses_final_race',
        sessionType: 'freshopencode',
        provider: 'opencode',
        event: {
          type: 'freshAgent.session.changed',
          sessionId: 'ses_final_race',
          reason: 'opencode-message',
        },
      })
      wsHandler?.({
        type: 'freshAgent.send.accepted',
        requestId,
        sessionId: 'ses_final_race',
        sessionType: 'freshopencode',
        provider: 'opencode',
        cwd: '/repo/final-race',
      })
    })

    await waitFor(() => {
      expect(screen.getByText('Final answer after durable history catches up')).toBeInTheDocument()
    })
    // The invalidation debounce and the send acceptance coalesce into ONE
    // shared scheduler run (initial fetch + one refresh), not a follow-up chain.
    expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(2)
  })

  it('clears stale local echo after an idle recovered snapshot without the submitted turn', async () => {
    const store = createStore()
    let wsHandler: ((message: any) => void) | undefined
    wsMock.onMessage.mockImplementation((handler) => {
      wsHandler = handler
      return () => {}
    })
    apiMock.getFreshAgentThreadSnapshot
      .mockResolvedValueOnce({
        sessionType: 'freshopencode',
        provider: 'opencode',
        threadId: 'ses_stale_echo',
        status: 'idle',
        summary: 'initial',
        capabilities: { send: true, interrupt: true, fork: true },
        turns: [],
      })
    // Task 16: every subsequent fetch returns a FRESH recovered snapshot that
    // still lacks the submitted turn — acceptance is by object identity, so a
    // shared instance would skip the stale-echo path for the wrong reason.
    let recoveredRevision = 2
    apiMock.getFreshAgentThreadSnapshot.mockImplementation(async () => ({
      sessionType: 'freshopencode',
      provider: 'opencode',
      threadId: 'ses_stale_echo',
      status: 'idle',
      summary: 'recovered',
      revision: recoveredRevision++,
      capabilities: { send: true, interrupt: true, fork: true },
      turns: [
        {
          id: 'turn-existing-assistant',
          turnId: 'turn-existing-assistant',
          role: 'assistant',
          summary: 'Recovered idle snapshot',
          items: [{ id: 'item-existing-assistant', kind: 'text', text: 'Recovered idle snapshot' }],
        },
      ],
    }))
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-stale-echo',
        sessionId: 'ses_stale_echo',
        sessionRef: { provider: 'opencode', sessionId: 'ses_stale_echo' },
        resumeSessionId: 'ses_stale_echo',
        status: 'idle',
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
    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'Orphan prompt' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    const send = sentFreshAgentMessages('freshAgent.send').at(-1)
    const requestId = String(send?.requestId)
    expect(screen.getByText('Orphan prompt')).toBeInTheDocument()

    act(() => {
      wsHandler?.({
        type: 'freshAgent.send.accepted',
        requestId,
        submittedTurnId: 'turn-orphan-user',
        sessionId: 'ses_stale_echo',
        sessionType: 'freshopencode',
        provider: 'opencode',
      })
      wsHandler?.({
        type: 'freshAgent.event',
        sessionId: 'ses_stale_echo',
        sessionType: 'freshopencode',
        provider: 'opencode',
        event: {
          type: 'freshAgent.session.snapshot',
          sessionId: 'ses_stale_echo',
          status: 'idle',
          latestTurnId: 'turn-existing-assistant',
          revision: 2,
        },
      })
    })

    await waitFor(() => {
      expect(screen.getByText('Recovered idle snapshot')).toBeInTheDocument()
    })
    // Task 16 contract change: the echo is the idle-incomplete re-poll loop's
    // marker, so the FIRST incomplete idle snapshot must NOT clear it...
    expect(screen.getByText('Orphan prompt')).toBeInTheDocument()
    // ...but once the bounded retry budget is exhausted, the stale echo
    // clears exactly as before (real timers: 5 retries x 1s + settle).
    await waitFor(() => {
      expect(screen.queryByText('Orphan prompt')).not.toBeInTheDocument()
    }, { timeout: 15_000 })
    expect(getFreshAgentPaneContent(store).pendingLocalEcho).toBeUndefined()
  }, 25_000)

  it('keeps re-polling (bounded) when an idle snapshot is missing the just-sent turn', async () => {
    const store = createStore()
    let wsHandler: ((message: any) => void) | undefined
    wsMock.onMessage.mockImplementation((handler) => {
      wsHandler = handler
      return () => {}
    })
    // HARNESS TRAP (fresh-eyes i3): return a FRESH snapshot object per fetch.
    // Acceptance is by OBJECT IDENTITY (`snapshotAccepted = displaySnapshot
    // !== previousSnapshot`; mergeSnapshotForDisplay does no content
    // comparison). A shared mockResolvedValue(...) instance makes
    // snapshotAccepted false, skips the stale-echo clear for the wrong
    // reason, and lets a broken loop pass vacuously.
    let rev = 1
    apiMock.getFreshAgentThreadSnapshot.mockImplementation(
      async () => freshopencodeSnapshot('unrelated earlier turn', rev++),
    )
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-idle-incomplete',
        sessionId: 'ses_late_change',
        sessionRef: { provider: 'opencode', sessionId: 'ses_late_change' },
        resumeSessionId: 'ses_late_change',
        status: 'idle',
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
    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'question?' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    const send = sentFreshAgentMessages('freshAgent.send').at(-1)
    const requestId = String(send?.requestId)
    act(() => {
      wsHandler?.({
        type: 'freshAgent.send.accepted',
        requestId,
        sessionId: 'ses_late_change',
        sessionType: 'freshopencode',
        provider: 'opencode',
      })
    })

    const calls = () => apiMock.getFreshAgentThreadSnapshot.mock.calls.length
    const before = calls()
    // SUSTAINED loop — a single extra fetch must NOT satisfy this test:
    await waitFor(() => expect(calls()).toBeGreaterThanOrEqual(before + 2), { timeout: 8_000 })
    // ...and it runs to the cap...
    await waitFor(
      () => expect(calls()).toBeGreaterThanOrEqual(before + IDLE_INCOMPLETE_MAX_RETRIES),
      { timeout: 10_000 },
    )
    // ...then the exhaustion pass clears the echo (the loop's marker)...
    await waitFor(() => {
      expect(screen.queryByText('question?')).not.toBeInTheDocument()
    }, { timeout: 8_000 })
    // ...and STOPS (bounded — no unbounded polling):
    const atCap = calls()
    await new Promise((r) => setTimeout(r, 1_500))
    expect(calls()).toBe(atCap)
  }, 25_000) // real timers (this suite uses none fake); 5 retries x 1s + settle needs a raised test timeout

  it('clears local echo as soon as a fresh snapshot contains the submitted text', async () => {
    const store = createStore()
    let wsHandler: ((message: any) => void) | undefined
    wsMock.onMessage.mockImplementation((handler) => {
      wsHandler = handler
      return () => {}
    })
    apiMock.getFreshAgentThreadSnapshot
      .mockResolvedValueOnce({
        sessionType: 'freshopencode',
        provider: 'opencode',
        threadId: 'ses_echo_landed_by_text',
        revision: 1,
        status: 'idle',
        capabilities: { send: true, interrupt: true, fork: true },
        turns: [],
      })
      .mockResolvedValueOnce({
        sessionType: 'freshopencode',
        provider: 'opencode',
        threadId: 'ses_echo_landed_by_text',
        revision: 2,
        status: 'running',
        capabilities: { send: false, interrupt: true, fork: true },
        turns: [
          {
            id: 'turn-real-user',
            turnId: 'turn-real-user',
            role: 'user',
            summary: 'Do the thing',
            items: [{ id: 'item-real-user', kind: 'text', text: 'Do the thing' }],
          },
          {
            id: 'turn-real-assistant',
            turnId: 'turn-real-assistant',
            role: 'assistant',
            summary: 'Working',
            items: [{ id: 'item-real-assistant', kind: 'text', text: 'Working' }],
          },
        ],
      })
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-echo-landed-by-text',
        sessionId: 'ses_echo_landed_by_text',
        sessionRef: { provider: 'opencode', sessionId: 'ses_echo_landed_by_text' },
        resumeSessionId: 'ses_echo_landed_by_text',
        status: 'idle',
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
    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'Do the thing' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    const send = sentFreshAgentMessages('freshAgent.send').at(-1)
    const requestId = String(send?.requestId)
    expect(screen.getByText('Do the thing')).toBeInTheDocument()

    act(() => {
      wsHandler?.({
        type: 'freshAgent.event',
        sessionId: 'ses_echo_landed_by_text',
        sessionType: 'freshopencode',
        provider: 'opencode',
        event: {
          type: 'freshAgent.session.snapshot',
          sessionId: 'ses_echo_landed_by_text',
          status: 'running',
          latestTurnId: 'turn-real-assistant',
          revision: 2,
        },
      })
    })

    await waitFor(() => {
      expect(screen.getByText('Working')).toBeInTheDocument()
    })
    expect(screen.getAllByText('Do the thing')).toHaveLength(1)
    expect(getFreshAgentPaneContent(store).pendingLocalEcho).toBeUndefined()
    expect(sentFreshAgentMessages('freshAgent.send').at(-1)?.requestId).toBe(requestId)
  })

  it('keeps local echo when an older snapshot response is ignored after send acceptance', async () => {
    const store = createStore()
    let wsHandler: ((message: any) => void) | undefined
    wsMock.onMessage.mockImplementation((handler) => {
      wsHandler = handler
      return () => {}
    })
    apiMock.getFreshAgentThreadSnapshot
      .mockResolvedValueOnce({
        sessionType: 'freshopencode',
        provider: 'opencode',
        threadId: 'ses_older_echo',
        revision: 8,
        status: 'idle',
        capabilities: { send: true, interrupt: true, fork: true },
        turns: [
          {
            id: 'turn-existing',
            turnId: 'turn-existing',
            role: 'assistant',
            summary: 'Existing answer',
            items: [{ id: 'item-existing', kind: 'text', text: 'Existing answer' }],
          },
        ],
      })
      .mockResolvedValueOnce({
        sessionType: 'freshopencode',
        provider: 'opencode',
        threadId: 'ses_older_echo',
        revision: 7,
        status: 'idle',
        capabilities: { send: true, interrupt: true, fork: true },
        turns: [],
      })
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-older-echo',
        sessionId: 'ses_older_echo',
        sessionRef: { provider: 'opencode', sessionId: 'ses_older_echo' },
        resumeSessionId: 'ses_older_echo',
        status: 'idle',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByText('Existing answer')).toBeInTheDocument()
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'Keep this echo' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    const send = sentFreshAgentMessages('freshAgent.send').at(-1)
    const requestId = String(send?.requestId)
    expect(screen.getByText('Keep this echo')).toBeInTheDocument()

    act(() => {
      wsHandler?.({
        type: 'freshAgent.send.accepted',
        requestId,
        submittedTurnId: 'turn-keep-echo',
        sessionId: 'ses_older_echo',
        sessionType: 'freshopencode',
        provider: 'opencode',
      })
      wsHandler?.({
        type: 'freshAgent.event',
        sessionId: 'ses_older_echo',
        sessionType: 'freshopencode',
        provider: 'opencode',
        event: {
          type: 'freshAgent.session.snapshot',
          sessionId: 'ses_older_echo',
          status: 'idle',
          latestTurnId: 'turn-existing',
          revision: 7,
        },
      })
    })

    await waitFor(() => {
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(2)
    })
    expect(screen.getByText('Keep this echo')).toBeInTheDocument()
    expect(getFreshAgentPaneContent(store).pendingLocalEcho).toEqual(expect.objectContaining({
      requestId,
      submittedTurnId: 'turn-keep-echo',
      text: 'Keep this echo',
    }))
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

  it('attempts a bounded resume for a codex pane whose session was marked lost (INVALID_SESSION_ID)', async () => {
    // Regression test for the claude-only .lost recovery bug: markSessionLost
    // is dispatched generically for any provider (fresh-agent-ws.ts reacts to
    // INVALID_SESSION_ID regardless of provider), but only claude's
    // triggerRecovery effect ever reacted to it. A codex pane used to sit
    // permanently abandoned.
    const store = createStore()
    store.dispatch(sessionInit({
      sessionId: 'codex-thread-lost',
      sessionType: 'freshcodex',
      provider: 'codex',
      model: 'gpt-5.5',
    }))
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-codex-lost',
        sessionId: 'codex-thread-lost',
        sessionRef: { provider: 'codex', sessionId: 'codex-thread-lost' },
        status: 'connected',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalled()
    })

    act(() => {
      store.dispatch(markSessionLost({
        sessionId: 'codex-thread-lost',
        sessionType: 'freshcodex',
        provider: 'codex',
      }))
    })

    // A bounded resume attempt: the pane re-requests session creation using
    // its canonical resumable session id, rather than sitting abandoned.
    await waitFor(() => {
      const layout = store.getState().panes.layouts['tab-1']
      if (!layout || layout.type !== 'leaf' || layout.content.kind !== 'fresh-agent') {
        throw new Error('Expected fresh-agent leaf')
      }
      expect(layout.content.status).toBe('creating')
      expect(layout.content.resumeSessionId).toBe('codex-thread-lost')
    })
  })

  it('keeps an established freshclaude pane interactive after remount when snapshot loading is unavailable', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockRejectedValue(new TypeError('Failed to parse URL from /api/fresh-agent/threads/claude/sess-1'))
    store.dispatch(sessionInit({
      sessionId: 'sess-1',
      sessionType: 'freshclaude',
      provider: 'claude',
      cliSessionId: 'cli-abc',
      model: 'claude-opus-4-6',
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', sessionType: 'freshclaude', provider: 'claude', status: 'idle' }))

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
      sessionType: 'freshclaude',
      provider: 'claude',
      cliSessionId: 'cli-abc',
      model: 'claude-opus-4-6',
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', sessionType: 'freshclaude', provider: 'claude', status: 'idle' }))
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
      sessionType: 'freshclaude',
      provider: 'claude',
      model: 'claude-opus-4-6',
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-live-only', sessionType: 'freshclaude', provider: 'claude', status: 'idle' }))
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

    const snapshotMessage = {
      type: 'freshAgent.event',
      sessionId: 'dead-session-id',
      sessionType: 'freshclaude',
      provider: 'claude',
      event: {
        type: 'freshAgent.session.snapshot',
        sessionId: 'dead-session-id',
        latestTurnId: 'turn-1',
        status: 'idle',
        timelineSessionId: durableSessionId,
        revision: 2,
      },
    }
    act(() => {
      handleFreshAgentMessage(store.dispatch, snapshotMessage)
      onMessage(snapshotMessage)
    })

    await waitFor(() => {
      const layout = store.getState().panes.layouts['tab-1']
      expect(layout?.type === 'leaf' && layout.content.kind === 'fresh-agent'
        ? layout.content.resumeSessionId
        : null).toBe(durableSessionId)
    })
    expect(screen.queryByText(/failed to parse url/i)).not.toBeInTheDocument()

    const lostMessage = {
      type: 'freshAgent.event',
      sessionId: 'dead-session-id',
      sessionType: 'freshclaude',
      provider: 'claude',
      event: {
        type: 'freshAgent.error',
        sessionId: 'dead-session-id',
        code: 'INVALID_SESSION_ID',
        message: 'Session no longer exists',
      },
    }
    act(() => {
      handleFreshAgentMessage(store.dispatch, lostMessage)
      onMessage(lostMessage)
    })

    await waitFor(() => {
      expect(wsMock.send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'freshAgent.create',
        sessionType: 'freshclaude',
        provider: 'claude',
        sessionRef: { provider: 'claude', sessionId: durableSessionId },
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
          sessionRef: { provider: 'codex', sessionId: 'codex-thread-disabled' },
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

  describe('transcript keyboard scroll (faz3)', () => {
    async function setupScrollablePane(initialScrollTop = 500) {
      const store = createStore()
      apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
        status: 'idle',
        capabilities: { send: true, interrupt: true, fork: false },
        turns: [
          { id: 'turn-0', role: 'user', items: [{ id: 'item-0', kind: 'text', text: 'User message' }] },
          { id: 'turn-1', role: 'assistant', items: [{ id: 'item-1', kind: 'text', text: 'Assistant reply' }] },
        ],
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
              createRequestId: 'req-scroll-test',
              sessionId: 'thread-scroll-test',
              status: 'idle',
            }}
          />
        </Provider>,
      )
      await waitFor(() => expect(screen.getByText('Assistant reply')).toBeInTheDocument())
      const root = document.querySelector('[data-context="fresh-agent"]') as HTMLElement
      const scroller = document.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
      Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 200 })
      Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 1000 })
      scroller.scrollTop = initialScrollTop
      fireEvent.scroll(scroller)
      return { root, scroller }
    }

    it('scrolls down by one line on ArrowDown when the pane root has focus', async () => {
      const { root, scroller } = await setupScrollablePane(500)
      const event = createEvent.keyDown(root, { key: 'ArrowDown' })
      fireEvent(root, event)
      expect(event.defaultPrevented).toBe(true)
      expect(scroller.scrollTop).toBe(540)
    })

    it('scrolls up by one line on ArrowUp when the pane root has focus', async () => {
      const { root, scroller } = await setupScrollablePane(500)
      const event = createEvent.keyDown(root, { key: 'ArrowUp' })
      fireEvent(root, event)
      expect(event.defaultPrevented).toBe(true)
      expect(scroller.scrollTop).toBe(460)
    })

    it('scrolls down by one page on PageDown when the pane root has focus', async () => {
      const { root, scroller } = await setupScrollablePane(100)
      const event = createEvent.keyDown(root, { key: 'PageDown' })
      fireEvent(root, event)
      expect(event.defaultPrevented).toBe(true)
      expect(scroller.scrollTop).toBe(260)
    })

    it('scrolls up by one page on PageUp when the pane root has focus', async () => {
      const { root, scroller } = await setupScrollablePane(500)
      const event = createEvent.keyDown(root, { key: 'PageUp' })
      fireEvent(root, event)
      expect(event.defaultPrevented).toBe(true)
      expect(scroller.scrollTop).toBe(340)
    })

    it('jumps to top on Home when the pane root has focus', async () => {
      const { root, scroller } = await setupScrollablePane(500)
      const event = createEvent.keyDown(root, { key: 'Home' })
      fireEvent(root, event)
      expect(event.defaultPrevented).toBe(true)
      expect(scroller.scrollTop).toBe(0)
    })

    it('jumps to bottom on End when the pane root has focus', async () => {
      const { root, scroller } = await setupScrollablePane(500)
      const event = createEvent.keyDown(root, { key: 'End' })
      fireEvent(root, event)
      expect(event.defaultPrevented).toBe(true)
      expect(scroller.scrollTop).toBe(1000)
    })

    it('does not scroll or preventDefault when the composer textarea has focus', async () => {
      const { scroller } = await setupScrollablePane(500)
      const textbox = screen.getByRole('textbox', { name: 'Chat message input' })
      const before = scroller.scrollTop
      for (const key of ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End']) {
        const event = createEvent.keyDown(textbox, { key })
        fireEvent(textbox, event)
        expect(event.defaultPrevented).toBe(false)
        expect(scroller.scrollTop).toBe(before)
      }
    })

    it('dismisses the scroll-to-bottom button after pressing End', async () => {
      const { root } = await setupScrollablePane(500)
      expect(screen.getByRole('button', { name: 'Scroll to bottom' })).toBeInTheDocument()
      fireEvent(root, createEvent.keyDown(root, { key: 'End' }))
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: 'Scroll to bottom' })).not.toBeInTheDocument()
      })
    })

    it('shows the scroll-to-bottom button after pressing Home', async () => {
      const { root } = await setupScrollablePane(800)
      expect(screen.queryByRole('button', { name: 'Scroll to bottom' })).not.toBeInTheDocument()
      fireEvent(root, createEvent.keyDown(root, { key: 'Home' }))
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Scroll to bottom' })).toBeInTheDocument()
      })
    })

    it('shows the scroll-to-bottom button after pressing PageUp', async () => {
      const { root } = await setupScrollablePane(800)
      expect(screen.queryByRole('button', { name: 'Scroll to bottom' })).not.toBeInTheDocument()
      fireEvent(root, createEvent.keyDown(root, { key: 'PageUp' }))
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Scroll to bottom' })).toBeInTheDocument()
      })
    })

    it('does not regress the plain-text key funnel into the composer', async () => {
      const { root } = await setupScrollablePane(500)
      const textbox = screen.getByRole('textbox', { name: 'Chat message input' }) as HTMLTextAreaElement
      fireEvent(root, createEvent.keyDown(root, { key: 'h' }))
      expect(textbox.value).toBe('h')
    })
  })

  describe('composer focus on pane activation (0bc6)', () => {
    async function flushFrames() {
      await act(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      })
    }

    function renderFocusPane(options?: { sessionId?: string; status?: string }) {
      const store = createStore()
      const sessionId = options && 'sessionId' in options ? options.sessionId : 'thread-focus-0bc6'
      render(
        <Provider store={store}>
          <FreshAgentView
            tabId="tab-1"
            paneId="pane-1"
            paneContent={{
              kind: 'fresh-agent',
              sessionType: 'freshcodex',
              provider: 'codex',
              createRequestId: 'req-focus-0bc6',
              sessionId,
              status: options?.status ?? 'idle',
            }}
          />
        </Provider>,
      )
      return { store }
    }

    it('focuses the composer exactly once when the pane becomes the active pane of the active tab', async () => {
      const { store } = renderFocusPane()
      const textbox = await screen.findByRole('textbox', { name: 'Chat message input' }) as HTMLTextAreaElement
      await waitFor(() => expect(textbox).not.toBeDisabled())
      await flushFrames()
      const focusSpy = vi.spyOn(textbox, 'focus')

      act(() => {
        store.dispatch(setActivePane({ tabId: 'tab-1', paneId: 'pane-1' }))
      })

      await waitFor(() => expect(focusSpy).toHaveBeenCalledTimes(1))
      expect(document.activeElement).toBe(textbox)
    })

    it('does not re-focus the composer when it already has focus on activation', async () => {
      const { store } = renderFocusPane()
      const textbox = await screen.findByRole('textbox', { name: 'Chat message input' }) as HTMLTextAreaElement
      await waitFor(() => expect(textbox).not.toBeDisabled())
      act(() => {
        store.dispatch(setActivePane({ tabId: 'tab-1', paneId: 'pane-1' }))
      })
      await waitFor(() => expect(document.activeElement).toBe(textbox))

      const focusSpy = vi.spyOn(textbox, 'focus')
      act(() => {
        store.dispatch(setActivePane({ tabId: 'tab-1', paneId: 'pane-other' }))
      })
      act(() => {
        store.dispatch(setActivePane({ tabId: 'tab-1', paneId: 'pane-1' }))
      })
      await flushFrames()

      expect(focusSpy).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(textbox)
    })

    it('does not steal focus from another editable element inside the pane on activation', async () => {
      const { store } = renderFocusPane()
      const textbox = await screen.findByRole('textbox', { name: 'Chat message input' }) as HTMLTextAreaElement
      await waitFor(() => expect(textbox).not.toBeDisabled())
      const root = document.querySelector('[data-context="fresh-agent"]') as HTMLElement
      const other = document.createElement('input')
      other.setAttribute('aria-label', 'Other editable')
      root.appendChild(other)
      other.focus()
      expect(document.activeElement).toBe(other)

      const focusSpy = vi.spyOn(textbox, 'focus')
      act(() => {
        store.dispatch(setActivePane({ tabId: 'tab-1', paneId: 'pane-1' }))
      })
      await flushFrames()

      expect(focusSpy).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(other)
      root.removeChild(other)
    })

    it('leaves focus on the pane root when the composer is disabled on activation', async () => {
      const { store } = renderFocusPane({ sessionId: undefined, status: 'creating' })
      const root = await waitFor(() => document.querySelector('[data-context="fresh-agent"]') as HTMLElement)
      const textbox = screen.getByRole('textbox', { name: 'Chat message input' }) as HTMLTextAreaElement
      expect(textbox).toBeDisabled()
      const focusSpy = vi.spyOn(textbox, 'focus')

      act(() => {
        store.dispatch(setActivePane({ tabId: 'tab-1', paneId: 'pane-1' }))
      })

      await waitFor(() => expect(document.activeElement).toBe(root))
      expect(focusSpy).not.toHaveBeenCalled()
    })
  })
})

describe('snapshot scheduler integration (zrrj)', () => {
  const SCHED_SESSION_ID = 'ses_late_change'

  function schedulerPaneContent(createRequestId: string) {
    return {
      kind: 'fresh-agent',
      sessionType: 'freshopencode',
      provider: 'opencode',
      createRequestId,
      sessionId: SCHED_SESSION_ID,
      sessionRef: { provider: 'opencode', sessionId: SCHED_SESSION_ID },
      resumeSessionId: SCHED_SESSION_ID,
      status: 'idle',
    } as const
  }

  /**
   * Capture EVERY ws.onMessage subscription and broadcast to all of them,
   * like the real ws client does. Last-handler capture (the older pattern)
   * only reaches one pane, which would hide the N-pane fan-out this task
   * collapses.
   */
  function captureWsBroadcast() {
    const handlers: Array<(message: unknown) => void> = []
    wsMock.onMessage.mockImplementation((handler) => {
      handlers.push(handler)
      return () => {}
    })
    return (message: unknown) => {
      act(() => {
        for (const handler of [...handlers]) handler(message)
      })
    }
  }

  function sessionChanged() {
    return {
      type: 'freshAgent.event',
      sessionId: SCHED_SESSION_ID,
      sessionType: 'freshopencode',
      provider: 'opencode',
      event: {
        type: 'freshAgent.session.changed',
        sessionId: SCHED_SESSION_ID,
        reason: 'opencode-message',
      },
    }
  }

  /** Real-timer sleep wrapped in act so late state updates never warn. */
  const flushMs = (ms: number) => act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })

  it('coalesces a burst of freshopencode session.changed events across sibling panes into one snapshot GET', async () => {
    const store = createStore()
    const broadcast = captureWsBroadcast()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue(freshopencodeSnapshot('done', 10))

    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: schedulerPaneContent('req-sched-a') }))
    store.dispatch(initLayout({ tabId: 'tab-2', paneId: 'pane-2', content: schedulerPaneContent('req-sched-b') }))
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
        <StoreBackedFreshAgentView tabId="tab-2" paneId="pane-2" />
      </Provider>,
    )
    // Let the identity fetches (immediate + trailing coalesce for the sibling)
    // fully settle before measuring the burst.
    await waitFor(() => expect(screen.getAllByText('done').length).toBeGreaterThan(0))
    await flushMs(400)
    apiMock.getFreshAgentThreadSnapshot.mockClear()

    for (let i = 0; i < 10; i += 1) {
      broadcast(sessionChanged())
    }

    // Exactly one trailing GET shared by both panes, not one per event/pane.
    await waitFor(() => expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(1))
    await flushMs(400)
    expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(1)
  })

  it('keeps the last good snapshot visible and stops fetching during 429 backoff', async () => {
    const store = createStore()
    const broadcast = captureWsBroadcast()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce(freshopencodeSnapshot('hello world', 10))

    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: schedulerPaneContent('req-sched-429') }))
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )
    await screen.findByText('hello world')
    apiMock.getFreshAgentThreadSnapshot.mockRejectedValue(new ApiError(429, 'Too many requests', undefined, 60_000))

    broadcast(sessionChanged())
    await waitFor(() => expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(2))
    await flushMs(50)
    // Last good transcript stays visible; no load-error banner.
    expect(screen.getByText('hello world')).toBeInTheDocument()
    expect(screen.queryByText(/Too many requests/)).not.toBeInTheDocument()

    // Further invalidations during backoff are suppressed without network.
    broadcast(sessionChanged())
    await flushMs(400)
    expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(2)
    expect(screen.getByText('hello world')).toBeInTheDocument()
  })

  it('does not refetch when another session sends (send.accepted for a foreign request)', async () => {
    const store = createStore()
    const broadcast = captureWsBroadcast()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue(freshopencodeSnapshot('done', 10))

    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: schedulerPaneContent('req-sched-foreign') }))
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )
    await waitFor(() => expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(1))
    apiMock.getFreshAgentThreadSnapshot.mockClear()

    broadcast({
      type: 'freshAgent.send.accepted',
      requestId: 'someone-elses-request',
      sessionId: SCHED_SESSION_ID,
      sessionType: 'freshopencode',
      provider: 'opencode',
    })
    await flushMs(400)
    expect(apiMock.getFreshAgentThreadSnapshot).not.toHaveBeenCalled()
  })

  it('scheduler-path fetches carry no abort signal (shared runs must survive one pane unmounting)', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue(freshopencodeSnapshot('done', 10))

    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: schedulerPaneContent('req-sched-signal') }))
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )
    await waitFor(() => expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(1))
    // 4th positional arg is the query/options bag ({ revision?, cwd?, signal? }).
    const options = apiMock.getFreshAgentThreadSnapshot.mock.calls[0][3]
    expect(options?.signal).toBeUndefined()
  })
})

describe('FreshAgentView /model slash command', () => {
  function modelCommandPaneContent(content: Record<string, unknown>) {
    return {
      kind: 'fresh-agent',
      createRequestId: 'req-model-cmd',
      sessionId: 'ses_model_cmd',
      status: 'idle',
      initialCwd: '/repo/project-a',
      ...content,
    }
  }

  it('opens the shared model dialog when /model is typed into a freshopencode composer', async () => {
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue(freshopencodeSnapshot('done', 1))
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: modelCommandPaneContent({
        sessionType: 'freshopencode',
        provider: 'opencode',
        model: 'opencode-go/glm-5.2',
        effort: 'max',
      }),
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Chat message input' })).not.toBeDisabled())
    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: '/model' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(await screen.findByRole('dialog', { name: 'Model and thinking level' })).toBeInTheDocument()
    expect(screen.getByRole('searchbox', { name: 'Filter models' })).toBeInTheDocument()
    // the composer text is consumed as a command, not sent to the agent
    expect(sentFreshAgentMessages('freshAgent.send')).toHaveLength(0)
  })

  it('opens the shared model dialog for freshcodex without any catalog probe', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: modelCommandPaneContent({
        sessionType: 'freshcodex',
        provider: 'codex',
        model: 'gpt-5.5',
        effort: 'max',
      }),
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Chat message input' })).not.toBeDisabled())
    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: '/model' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(await screen.findByRole('dialog', { name: 'Model and thinking level' })).toBeInTheDocument()
    expect(apiMock.getFreshAgentModelCapabilities).not.toHaveBeenCalled()
  })

  it('shows the shared catalog-unavailable notice instead of an empty dialog when the freshopencode probe fails', async () => {
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue(freshopencodeSnapshot('done', 1))
    apiMock.getFreshAgentModelCapabilities.mockResolvedValue({
      ok: false,
      sessionType: 'freshopencode',
      runtimeProvider: 'opencode',
      status: 'unavailable',
      models: [],
      error: { code: 'CAPABILITY_PROBE_FAILED', message: 'nope' },
    })
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: modelCommandPaneContent({
        sessionType: 'freshopencode',
        provider: 'opencode',
        model: 'opencode-go/glm-5.2',
        effort: 'max',
      }),
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Chat message input' })).not.toBeDisabled())
    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: '/model' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Model catalog unavailable — try again')
    expect(screen.queryByRole('dialog', { name: 'Model and thinking level' })).not.toBeInTheDocument()
  })
})

describe('FreshAgentView session status strip', () => {
  it('renders the chip with the effective model display name when the pane has no explicit model', () => {
    const store = createStore()
    // Provider defaults live in server settings (mirrors the "saved provider
    // model" pattern above) — the pane itself stages no model.
    store.dispatch(previewServerSettingsPatch({
      freshAgent: {
        providers: {
          freshclaude: { modelSelection: { kind: 'exact', modelId: 'opus[1m]' } },
        },
      },
    }))

    render(
      <Provider store={store}>
        <FreshAgentView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={{
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            createRequestId: 'req-strip-default-model',
            sessionId: CLAUDE_THREAD_ID,
            status: 'connected',
          }}
        />
      </Provider>,
    )

    const chip = screen.getByRole('button', { name: 'Model: Claude Opus 5 (1M context) — change model' })
    expect(chip).toHaveAttribute('title', 'opus[1m] · effort high')
  })

  it('hides the chip when the model matches no static option and no probe matches it — raw ids never render, and never the default option label', async () => {
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
            createRequestId: 'req-strip-raw-id',
            sessionId: CLAUDE_THREAD_ID,
            status: 'connected',
            model: 'custom-blend-x',
          }}
        />
      </Provider>,
    )

    // No chip at all while the label is unresolved (raw ids are tooltip-only,
    // and the default option label is a mislabel — neither may render).
    expect(screen.queryByRole('button', { name: /^Model: / })).toBeNull()
    await waitFor(() => {
      expect(apiMock.getFreshAgentModelCapabilities).toHaveBeenCalled()
    })
    await act(async () => {
      await Promise.resolve()
    })
    // Probe resolved without a match: still no raw id on the chip.
    expect(screen.queryByRole('button', { name: /custom-blend-x/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Model: Claude Opus 5 (1M context) — change model' })).toBeNull()
  })

  it('shows the live session model ahead of the staged pane model on the chip', async () => {
    apiMock.getFreshAgentModelCapabilities.mockResolvedValue({
      ok: true,
      sessionType: 'freshclaude',
      runtimeProvider: 'claude',
      status: 'fresh',
      fetchedAt: 1_000,
      models: [{
        id: 'claude-live-99',
        displayName: 'Live Ninety Nine',
        provider: 'claude',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high'],
        supportsAdaptiveThinking: true,
      }],
    })
    const store = createStore()
    store.dispatch(sessionInit({
      sessionId: CLAUDE_THREAD_ID,
      sessionType: 'freshclaude',
      provider: 'claude',
      model: 'claude-live-99',
    }))
    render(
      <Provider store={store}>
        <FreshAgentView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={{
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            createRequestId: 'req-strip-live-model',
            sessionId: CLAUDE_THREAD_ID,
            status: 'connected',
            model: 'opus[1m]',
          }}
        />
      </Provider>,
    )

    // The live raw id never renders; once the probe matches it, its display
    // name wins over the staged pane model's static label.
    expect(screen.queryByRole('button', { name: /claude-live-99/ })).toBeNull()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Model: Live Ninety Nine — change model' })).toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: 'Model: Claude Opus 5 (1M context) — change model' })).toBeNull()
    expect(apiMock.getFreshAgentModelCapabilities).toHaveBeenCalledWith('freshclaude', expect.anything())
  })

  it('pairs the chip tooltip effort with the displayed live model — never the staged model\'s effort under a live id', async () => {
    apiMock.getFreshAgentModelCapabilities.mockResolvedValue({
      ok: true,
      sessionType: 'freshclaude',
      runtimeProvider: 'claude',
      status: 'fresh',
      fetchedAt: 1_000,
      models: [{
        id: 'claude-live-99',
        displayName: 'Live Ninety Nine',
        provider: 'claude',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high'],
        supportsAdaptiveThinking: true,
      }],
    })
    const store = createStore()
    store.dispatch(sessionInit({
      sessionId: CLAUDE_THREAD_ID,
      sessionType: 'freshclaude',
      provider: 'claude',
      model: 'claude-live-99',
    }))
    render(
      <Provider store={store}>
        <FreshAgentView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={{
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            createRequestId: 'req-strip-live-tooltip',
            sessionId: CLAUDE_THREAD_ID,
            status: 'connected',
            model: 'opus[1m]',
            effort: 'high',
          }}
        />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Model: Live Ninety Nine — change model' })).toBeInTheDocument()
    })
    // The chip's raw-id+effort tooltip must describe the DISPLAYED (live)
    // model; the staged opus[1m]/'high' pairing must not leak under it.
    const chip = screen.getByRole('button', { name: 'Model: Live Ninety Nine — change model' })
    // The tooltip carries the LIVE model id and its session effort — the pane
    // was created with 'high', and no live snapshot effort overrides it.
    expect(chip).toHaveAttribute('title', 'claude-live-99 · effort high')
  })

  it('uses the REST snapshot\'s settings.model when no session-init model exists (restored/MCP panes)', async () => {
    apiMock.getFreshAgentModelCapabilities.mockResolvedValue({
      ok: true,
      sessionType: 'freshclaude',
      runtimeProvider: 'claude',
      status: 'fresh',
      fetchedAt: 1_000,
      models: [{
        id: 'claude-live-99',
        displayName: 'Live Ninety Nine',
        provider: 'claude',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high'],
        supportsAdaptiveThinking: true,
      }],
    })
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({
      status: 'idle',
      summary: 'summary',
      capabilities: { send: true, interrupt: true, fork: true },
      turns: [],
      settings: { model: 'claude-live-99', effort: 'low' },
    } as never)
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
            createRequestId: 'req-strip-snap-model',
            sessionId: CLAUDE_THREAD_ID,
            status: 'connected',
            // No live session/model staged: resolveEffective… would serve the
            // provider default — the snapshot's active model must win.
            resumeSessionId: CLAUDE_THREAD_ID,
            effort: 'high',
          }}
        />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Model: Live Ninety Nine — change model' })).toBeInTheDocument()
    })
    expect(apiMock.getFreshAgentModelCapabilities).toHaveBeenCalled()
    // Tooltip pairs the live id with the live effort (not the pane's 'high').
    expect(screen.getByRole('button', { name: 'Model: Live Ninety Nine — change model' }))
      .toHaveAttribute('title', 'claude-live-99 · effort low')
  })

  it('a live-reported snapshot effort wins the chip tooltip', async () => {
    apiMock.getFreshAgentModelCapabilities.mockResolvedValue({
      ok: true,
      sessionType: 'freshclaude',
      runtimeProvider: 'claude',
      status: 'fresh',
      fetchedAt: 1_000,
      models: [{
        id: 'claude-live-99',
        displayName: 'Live Ninety Nine',
        provider: 'claude',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high'],
        supportsAdaptiveThinking: true,
      }],
    })
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({
      status: 'idle',
      summary: 'summary',
      capabilities: { send: true, interrupt: true, fork: true },
      turns: [],
      settings: { effort: 'low' },
    } as never)
    const store = createStore()
    store.dispatch(sessionInit({
      sessionId: CLAUDE_THREAD_ID,
      sessionType: 'freshclaude',
      provider: 'claude',
      model: 'claude-live-99',
    }))
    render(
      <Provider store={store}>
        <FreshAgentView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={{
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            createRequestId: 'req-strip-live-effort',
            sessionId: CLAUDE_THREAD_ID,
            status: 'connected',
            model: 'opus[1m]',
            effort: 'high',
            resumeSessionId: CLAUDE_THREAD_ID,
          }}
        />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Model: Live Ninety Nine — change model' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Model: Live Ninety Nine — change model' }))
        .toHaveAttribute('title', 'claude-live-99 · effort low')
    })
  })

  it('renders the context meter with the exact-token tooltip from the indexed session usage', () => {
    const store = createStore()
    seedStripUsage(store, 47)

    render(
      <Provider store={store}>
        <FreshAgentView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={{
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            createRequestId: 'req-strip-meter',
            sessionId: CLAUDE_THREAD_ID,
            resumeSessionId: 'claude-strip-usage',
            status: 'connected',
          }}
        />
      </Provider>,
    )

    const meter = screen.getByRole('meter', { name: 'Context window used' })
    expect(meter).toHaveAttribute('aria-valuenow', '47')
    expect(meter).toHaveAttribute('title', '96,000 / 200,000 tokens (47% full) — compacts at 100%')
  })

  it('renders muted "context —" with no meter when no indexed usage exists', () => {
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
            createRequestId: 'req-strip-unknown',
            sessionId: CLAUDE_THREAD_ID,
            status: 'connected',
          }}
        />
      </Provider>,
    )

    expect(screen.getByText('context —')).toBeInTheDocument()
    expect(screen.queryByRole('meter')).toBeNull()
  })

  it('opens the model dialog (with claude rows) when the chip is clicked', async () => {
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
            createRequestId: 'req-strip-dialog',
            sessionId: CLAUDE_THREAD_ID,
            status: 'connected',
            model: 'opus[1m]',
          }}
        />
      </Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Model: Claude Opus 5 (1M context) — change model' }))

    const dialog = await screen.findByRole('dialog', { name: 'Model and thinking level' })
    expect(within(dialog).getByText('Claude Opus 5 (1M context)')).toBeInTheDocument()
  })

  it('renders NO clickable model affordance when no model is set at all (chip hidden; gear + /model remain)', async () => {
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
            createRequestId: 'req-strip-nomodel',
            sessionId: CLAUDE_THREAD_ID,
            status: 'connected',
          }}
        />
      </Provider>,
    )

    // Pane-type labels are not model display names — no chip renders.
    expect(screen.queryByRole('button', { name: /^Model: / })).toBeNull()
    expect(screen.queryByRole('button', { name: /Freshclaude — change model/ })).toBeNull()
    // The strip still renders with the unknown-context lug (strip exists even
    // without the chip; the meter is anchored to the right edge).
    expect(screen.getByText('context —')).toBeInTheDocument()
  })

  it('keeps the last known meter when the sessions window drops the row (window churn never blanks a reported meter)', async () => {
    const store = createStore()
    seedStripUsage(store, 47)

    render(
      <Provider store={store}>
        <FreshAgentView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={{
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            createRequestId: 'req-strip-churn',
            sessionId: CLAUDE_THREAD_ID,
            resumeSessionId: 'claude-strip-usage',
            status: 'connected',
          }}
        />
      </Provider>,
    )

    const meter = screen.getByRole('meter', { name: 'Context window used' })
    expect(meter).toHaveAttribute('aria-valuenow', '47')

    // Sidebar search returns / the 50-session cap eviction REPLACE the projects
    // window wholesale — the meter reads the unified usage map, so neither can
    // blank a reported reading.
    act(() => {
      store.dispatch(applySessionsPatch({ upsertProjects: [], removeProjectPaths: ['/repo/strip'] }))
    })

    expect(meter).toHaveAttribute('aria-valuenow', '47')
    expect(screen.queryByText('context —')).toBeNull()
  })

  it('keeps the meter live from includeKeys extras while the sessions window excludes the row', async () => {
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
            createRequestId: 'req-strip-extras',
            sessionId: CLAUDE_THREAD_ID,
            resumeSessionId: 'claude-strip-usage',
            status: 'connected',
          }}
        />
      </Provider>,
    )

    // The pane's session is NOT in the sidebar window (search excludes it) —
    // but the every-refresh includeKeys side-channel still delivers usage.
    // The meter must move with each extras refresh, never freezing at a
    // previously-safe reading as the session climbs past the thresholds.
    act(() => {
      store.dispatch(applyContextUsageExtras({
        entries: [{
          provider: 'claude',
          sessionId: 'claude-strip-usage',
          tokenUsage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, totalTokens: 2, contextTokens: 96000, compactPercent: 47, compactThresholdTokens: 200000 },
        }],
        sourceSeq: 0,
        paneKeys: ['claude:claude-strip-usage'],
      }))
    })
    const meter = screen.getByRole('meter', { name: 'Context window used' })
    expect(meter).toHaveAttribute('aria-valuenow', '47')

    act(() => {
      store.dispatch(applyContextUsageExtras({
        entries: [{
          provider: 'claude',
          sessionId: 'claude-strip-usage',
          tokenUsage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0, totalTokens: 2, contextTokens: 140000, compactPercent: 70, compactThresholdTokens: 200000 },
        }],
        sourceSeq: 0,
        paneKeys: ['claude:claude-strip-usage'],
      }))
    })
    expect(meter).toHaveAttribute('aria-valuenow', '70')
  })

  it('a current usage reading survives past the boundary via revalidation, and blanks only after the grace window without one', () => {
    vi.useFakeTimers()
    try {
      const store = createStore()
      seedStripUsage(store, 47)
      render(
        <Provider store={store}>
          <FreshAgentView
            tabId="tab-1"
            paneId="pane-1"
            paneContent={{
              kind: 'fresh-agent',
              sessionType: 'freshclaude',
              provider: 'claude',
              createRequestId: 'req-strip-validity',
              sessionId: CLAUDE_THREAD_ID,
              resumeSessionId: 'claude-strip-usage',
              status: 'connected',
            }}
          />
        </Provider>,
      )
      expect(screen.getByRole('meter', { name: 'Context window used' })).toHaveAttribute('aria-valuenow', '47')

      // Past the validity boundary: a revalidation was dispatched, and the
      // meter stays live while awaiting it (never blanks an accurate reading).
      act(() => {
        vi.advanceTimersByTime(61_000)
      })
      expect(screen.getByRole('meter', { name: 'Context window used' })).toHaveAttribute('aria-valuenow', '47')

      // No re-stamp arrives (channel silent): past the grace window the strip
      // drops to the honest unknown state.
      act(() => {
        vi.advanceTimersByTime(31_000)
      })
      expect(screen.queryByRole('meter')).toBeNull()
      expect(screen.getByText('context —')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a fresher commit supersedes an older usage reading (fresh-page rows and extras share one timestamped map)', () => {
    const store = createStore()
    seedStripUsage(store, 47)
    render(
      <Provider store={store}>
        <FreshAgentView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={{
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            createRequestId: 'req-strip-stale-retained',
            sessionId: CLAUDE_THREAD_ID,
            resumeSessionId: 'claude-strip-usage',
            status: 'connected',
          }}
        />
      </Provider>,
    )
    const meter = screen.getByRole('meter', { name: 'Context window used' })
    expect(meter).toHaveAttribute('aria-valuenow', '47')

    // The next refresh commits a newer reading (regardless of whether the row
    // was window-covered or out-of-band that cycle): the meter must cross the
    // threshold, never freeze on the earlier value.
    act(() => {
      seedStripUsage(store, 70, 140_000)
    })
    expect(meter).toHaveAttribute('aria-valuenow', '70')
  })

  it('shows the pick-time display label for a catalog-only model immediately, with no probe', async () => {
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
            createRequestId: 'req-strip-stamp',
            sessionId: 'ses_strip_stamp',
            status: 'connected',
            model: 'claude-ish/sonnet-future',
            modelLabel: { modelId: 'claude-ish/sonnet-future', label: 'Sonnet Future' },
          }}
        />
      </Provider>,
    )

    expect(screen.getByRole('button', { name: 'Model: Sonnet Future — change model' })).toBeInTheDocument()
    // Raw id never appears, and the stamp answers before (and instead of) the
    // catalog probe.
    expect(screen.queryByRole('button', { name: 'Model: claude-ish/sonnet-future — change model' })).toBeNull()
    await act(async () => { await Promise.resolve() })
    expect(apiMock.getFreshAgentModelCapabilities).not.toHaveBeenCalled()
  })

  it('ignores a stamp that no longer matches the effective model and falls back to the probe', async () => {
    apiMock.getFreshAgentModelCapabilities.mockResolvedValue({
      ok: true,
      sessionType: 'freshclaude',
      runtimeProvider: 'claude',
      status: 'fresh',
      fetchedAt: 1_000,
      models: [{
        id: 'claude-ish/opus-future',
        displayName: 'Opus Future',
        provider: 'claude',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high'],
        supportsAdaptiveThinking: true,
      }],
    })
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
            createRequestId: 'req-strip-stamp-stale',
            sessionId: 'ses_strip_stamp_stale',
            status: 'connected',
            model: 'claude-ish/opus-future',
            modelLabel: { modelId: 'claude-ish/sonnet-future', label: 'Sonnet Future' },
          }}
        />
      </Provider>,
    )

    // Mismatched stamp must not render (a model change that skipped restamping
    // can never mislabel the chip).
    expect(screen.queryByRole('button', { name: 'Model: Sonnet Future — change model' })).toBeNull()
    await waitFor(() => {
      expect(apiMock.getFreshAgentModelCapabilities).toHaveBeenCalledWith('freshclaude', expect.anything())
      expect(screen.getByRole('button', { name: 'Model: Opus Future — change model' })).toBeInTheDocument()
    })
  })

  it.each([
    ['freshclaude', 'claude-ish/sonnet-future', 'Sonnet Future', 'claude'],
    ['kilroy', 'claude-ish/sonnet-future', 'Sonnet Future', 'claude'],
  ] as const)('upgrades a catalog-only %s model on the chip once the probe resolves (its display name wins over the raw id)', async (sessionType, modelId, displayName, provider) => {
    apiMock.getFreshAgentModelCapabilities.mockResolvedValue({
      ok: true,
      sessionType,
      runtimeProvider: provider,
      status: 'fresh',
      fetchedAt: 1_000,
      models: [{
        id: modelId,
        displayName,
        provider,
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high'],
        supportsAdaptiveThinking: true,
      }],
    })
    const store = createStore()
    render(
      <Provider store={store}>
        <FreshAgentView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={{
            kind: 'fresh-agent',
            sessionType,
            provider,
            createRequestId: `req-strip-catalog-${sessionType}`,
            sessionId: `ses_strip_catalog_${sessionType}`,
            status: 'connected',
            model: modelId,
          }}
        />
      </Provider>,
    )

    // Raw model ids never render on the chip (user directive): a restored
    // pane with an unresolvable id shows NO chip until the probe resolves.
    expect(screen.queryByRole('button', { name: /^Model: / })).toBeNull()

    await waitFor(() => {
      expect(screen.getByRole('button', { name: `Model: ${displayName} — change model` })).toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: `Model: ${modelId} — change model` })).toBeNull()
    expect(apiMock.getFreshAgentModelCapabilities).toHaveBeenCalledWith(sessionType, expect.anything())
  })

  it('upgrades a catalog-only freshopencode model to its catalog display name once the probe resolves', async () => {
    apiMock.getFreshAgentModelCapabilities.mockResolvedValue({
      ok: true,
      sessionType: 'freshopencode',
      runtimeProvider: 'opencode',
      status: 'fresh',
      fetchedAt: 1_000,
      models: [{
        id: 'opencode-go/glm-5.2',
        displayName: 'GLM 5.2',
        provider: 'opencode',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high', 'max'],
        supportsAdaptiveThinking: true,
      }],
    })
    const store = createStore()
    render(
      <Provider store={store}>
        <FreshAgentView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={{
            kind: 'fresh-agent',
            sessionType: 'freshopencode',
            provider: 'opencode',
            createRequestId: 'req-strip-catalog-upgrade',
            sessionId: 'ses_strip_catalog_upgrade',
            status: 'connected',
            model: 'opencode-go/glm-5.2',
          }}
        />
      </Provider>,
    )

    // No chip at all while the label is unresolved (raw ids are tooltip-only).
    expect(screen.queryByRole('button', { name: /^Model: / })).toBeNull()

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Model: GLM 5.2 — change model' })).toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: 'Model: opencode-go/glm-5.2 — change model' })).toBeNull()
  })

  it('keeps the chip hidden when the freshopencode catalog probe fails — raw ids never render', async () => {
    apiMock.getFreshAgentModelCapabilities.mockRejectedValue(new Error('catalog down'))
    const store = createStore()
    render(
      <Provider store={store}>
        <FreshAgentView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={{
            kind: 'fresh-agent',
            sessionType: 'freshopencode',
            provider: 'opencode',
            createRequestId: 'req-strip-catalog-fail',
            sessionId: 'ses_strip_catalog_fail',
            status: 'connected',
            model: 'opencode-go/glm-5.2',
          }}
        />
      </Provider>,
    )

    expect(screen.queryByRole('button', { name: /^Model: / })).toBeNull()
    await waitFor(() => {
      expect(apiMock.getFreshAgentModelCapabilities).toHaveBeenCalled()
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(screen.queryByRole('button', { name: /opencode-go\/glm-5\.2/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /GLM 5\.2/ })).toBeNull()
  })

  it('keeps the chip hidden when the catalog row\'s displayName echoes the raw id (no-name fallback)', async () => {
    apiMock.getFreshAgentModelCapabilities.mockResolvedValue({
      ok: true,
      sessionType: 'freshopencode',
      runtimeProvider: 'opencode',
      status: 'fresh',
      fetchedAt: 1_000,
      models: [{
        id: 'opencode-go/unnamed-9',
        displayName: 'opencode-go/unnamed-9',
        provider: 'opencode',
        supportsEffort: false,
        supportedEffortLevels: [],
        supportsAdaptiveThinking: false,
      }],
    })
    const store = createStore()
    render(
      <Provider store={store}>
        <FreshAgentView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={{
            kind: 'fresh-agent',
            sessionType: 'freshopencode',
            provider: 'opencode',
            createRequestId: 'req-strip-echo-id',
            sessionId: 'ses_strip_echo_id',
            status: 'connected',
            model: 'opencode-go/unnamed-9',
          }}
        />
      </Provider>,
    )

    await waitFor(() => {
      expect(apiMock.getFreshAgentModelCapabilities).toHaveBeenCalled()
    })
    await act(async () => {
      await Promise.resolve()
    })
    // The probed "display name" IS the raw id — the chip stays hidden rather
    // than render it.
    expect(screen.queryByRole('button', { name: /opencode-go\/unnamed-9/ })).toBeNull()
    // The strip itself still renders with its unknown-context lug.
    expect(screen.getByText('context —')).toBeInTheDocument()
  })

  it('never mislabels the previous probed label onto a just-switched catalog-only model', async () => {
    let resolveSecondProbe: ((value: unknown) => void) | undefined
    apiMock.getFreshAgentModelCapabilities
      .mockResolvedValueOnce({
        ok: true,
        sessionType: 'freshopencode',
        runtimeProvider: 'opencode',
        status: 'fresh',
        fetchedAt: 1_000,
        models: [
          { id: 'opencode-go/alpha-x', displayName: 'Alpha Claude', provider: 'opencode', supportsEffort: true, supportedEffortLevels: ['low'], supportsAdaptiveThinking: true },
          { id: 'opencode-go/beta-y', displayName: 'Beta Claude', provider: 'opencode', supportsEffort: true, supportedEffortLevels: ['low'], supportsAdaptiveThinking: true },
        ],
      })
      .mockReturnValueOnce(new Promise((resolve) => { resolveSecondProbe = resolve }))
    const store = createStore()
    store.dispatch(sessionInit({
      sessionId: 'ses-strip-swap',
      sessionType: 'freshopencode',
      provider: 'opencode',
      model: 'opencode-go/alpha-x',
    }))
    render(
      <Provider store={store}>
        <FreshAgentView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={{
            kind: 'fresh-agent',
            sessionType: 'freshopencode',
            provider: 'opencode',
            createRequestId: 'req-strip-swap',
            sessionId: 'ses-strip-swap',
            status: 'connected',
            model: 'opencode-go/alpha-x',
          }}
        />
      </Provider>,
    )
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Model: Alpha Claude — change model' })).toBeInTheDocument()
    })

    // Live session model switches to a new catalog-only id; the previous
    // label must not render even for a frame while the new probe is in flight.
    act(() => {
      store.dispatch(sessionInit({
        sessionId: 'ses-strip-swap',
        sessionType: 'freshopencode',
        provider: 'opencode',
        model: 'opencode-go/beta-y',
      }))
    })
    expect(screen.queryByRole('button', { name: 'Model: Alpha Claude — change model' })).toBeNull()
    expect(screen.queryByRole('button', { name: /opencode-go\/beta-y/ })).toBeNull()

    resolveSecondProbe!({
      ok: true,
      sessionType: 'freshopencode',
      runtimeProvider: 'opencode',
      status: 'fresh',
      fetchedAt: 1_001,
      models: [{ id: 'opencode-go/beta-y', displayName: 'Beta Claude', provider: 'opencode', supportsEffort: true, supportedEffortLevels: ['low'], supportsAdaptiveThinking: true }],
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Model: Beta Claude — change model' })).toBeInTheDocument()
    })
  })
})

describe('FreshAgentView provider-advertised session commands', () => {
  function sessionCommandPaneContent() {
    return {
      kind: 'fresh-agent' as const,
      sessionType: 'freshopencode' as const,
      provider: 'opencode' as const,
      createRequestId: 'req-session-commands',
      sessionId: 'ses_session_commands',
      status: 'idle' as const,
    }
  }

  function renderSessionCommandPane(store: ReturnType<typeof createStore>) {
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: sessionCommandPaneContent(),
    }))
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )
  }

  it('lists snapshot-advertised commands in an Agent session group after the pane actions', async () => {
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({
      ...freshopencodeSnapshot('done', 1),
      commands: [
        { name: 'review', description: 'Review the current diff', argumentHint: '[file]' },
        { name: 'init', description: 'Scan the project and write AGENTS.md' },
      ],
    })
    const store = createStore()
    renderSessionCommandPane(store)

    await screen.findByText('done')
    fireEvent.click(screen.getByRole('button', { name: 'Slash commands' }))

    const menu = await screen.findByRole('menu', { name: 'Slash commands' })
    const paneActions = await within(menu).findByRole('group', { name: 'Pane actions' })
    const agentSession = within(menu).getByRole('group', { name: 'Agent session' })
    // Static pane actions survive verbatim (ungated /new remains listed).
    expect(within(paneActions).getByRole('menuitem', { name: /\/new/ })).toBeInTheDocument()
    // Session rows arrive from the snapshot with description + argumentHint.
    const reviewRow = within(agentSession).getByRole('menuitem', { name: /\/review/ })
    expect(reviewRow).toHaveTextContent('Review the current diff')
    expect(reviewRow).toHaveTextContent('[file]')
    expect(within(agentSession).getByRole('menuitem', { name: /\/init/ })).toBeInTheDocument()
  })

  it('renders the flat static-only menu when the snapshot advertises no commands', async () => {
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue(freshopencodeSnapshot('done', 1))
    const store = createStore()
    renderSessionCommandPane(store)

    await screen.findByText('done')
    fireEvent.click(screen.getByRole('button', { name: 'Slash commands' }))

    const menu = await screen.findByRole('menu', { name: 'Slash commands' })
    expect(within(menu).queryByRole('group')).toBeNull()
    expect(within(menu).queryByText('Agent session')).toBeNull()
    expect(within(menu).getByRole('menuitem', { name: /\/new/ })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: /\/model/ })).toBeInTheDocument()
  })

  it('keeps /fork capability-gated while snapshot commands surface ungated', async () => {
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({
      ...freshopencodeSnapshot('done', 1),
      capabilities: { send: true, interrupt: true, fork: false },
      commands: [{ name: 'review', description: 'Review the current diff' }],
    })
    const store = createStore()
    renderSessionCommandPane(store)

    await screen.findByText('done')
    fireEvent.click(screen.getByRole('button', { name: 'Slash commands' }))

    const menu = await screen.findByRole('menu', { name: 'Slash commands' })
    await within(menu).findByRole('group', { name: 'Agent session' })
    expect(within(menu).queryByRole('menuitem', { name: /\/fork/ })).toBeNull()
    expect(within(menu).getByRole('menuitem', { name: /\/review/ })).toBeInTheDocument()
  })
})
