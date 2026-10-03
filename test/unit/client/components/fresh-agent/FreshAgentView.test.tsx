import savedCodexTools from '../../../../fixtures/managed-native-history/codex-tools.json'
import savedClaudeNativeHistory from '../../../../fixtures/managed-native-history/claude.json'
import savedCodexNativeHistory from '../../../../fixtures/managed-native-history/codex.json'
import savedOpenCodeNativeHistory from '../../../../fixtures/managed-native-history/opencode.json'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, createEvent, cleanup, act, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore, type Middleware } from '@reduxjs/toolkit'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { previewServerSettingsPatch, updateSettingsLocal } from '@/store/settingsSlice'
import sessionsReducer, { applySessionsPatch, applyContextUsageExtras } from '@/store/sessionsSlice'
import freshAgentReducer, { applyRuntimeOwner, historyPageReceived, sessionError, sessionExited, sessionInit, sessionMetadataReceived, sessionSnapshotReceived, setSessionStatus, markSessionLost } from '@/store/freshAgentSlice'
import { selectPaneOwnerFence } from '@/store/selectors/runtimeOwner'
import tabsReducer, { closeTab } from '@/store/tabsSlice'
import connectionReducer from '@/store/connectionSlice'
import managedRuntimeReducer from '@/store/managedRuntimeSlice'
import { FreshAgentView, IDLE_INCOMPLETE_MAX_RETRIES, locatorMatchesPane } from '@/components/fresh-agent/FreshAgentView'
import { FreshAgentSettingsButton } from '@/components/fresh-agent/FreshAgentSettingsButton'
import {
  initLayout,
  applyFreshAgentReconcileAttach,
  requestPaneRefresh,
  resetFreshAgentPaneForReconcileCreate,
  setActivePane,
  setPaneHandoffError,
  updatePaneContent,
  updatePaneTitle,
} from '@/store/panesSlice'
import { useAppSelector } from '@/store/hooks'
import { updateTab } from '@/store/tabsSlice'
import { handleFreshAgentMessage } from '@/lib/fresh-agent-ws'
import { ApiError } from '@/lib/api'
import { resetSnapshotSchedulerForTests, SNAPSHOT_DEBOUNCE_MS } from '@/lib/fresh-agent-snapshot-scheduler'
import { SESSION_HANDOFF_RETRY_BACKOFF_MS } from '@/lib/session-handoff'
import {
  ROLLBACK_BUSY_REDO_NOTICE,
  ROLLBACK_BUSY_UNDO_NOTICE,
  REDO_CODEX_UNSUPPORTED_NOTICE,
  UNDO_REFILL_NOTICE,
  rollbackUnsupportedNotice,
} from '@/lib/fresh-agent-rollback'
import { getFreshAgentPaneActions } from '@/lib/pane-action-registry'
import type { PaneNode } from '@/store/paneTypes'
import { resetManagedRuntimeRefreshForTest } from '@/lib/recovery/managed-runtime-recovery'
import { FreshAgentSnapshotSchema } from '@shared/fresh-agent-contract'

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
  requestSessionHandoff: vi.fn(),
  setSessionMetadata: vi.fn().mockResolvedValue(undefined),
  getManagedRuntimeInventory: vi.fn(),
  retryManagedRuntimeSoul: vi.fn(),
  stopManagedRuntimeSoul: vi.fn(),
  updateManagedRuntimeViewVisibility: vi.fn(),
  getManagedRuntimeSoul: vi.fn(),
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
    requestSessionHandoff: apiMock.requestSessionHandoff,
    setSessionMetadata: apiMock.setSessionMetadata,
    getManagedRuntimeInventory: apiMock.getManagedRuntimeInventory,
    retryManagedRuntimeSoul: apiMock.retryManagedRuntimeSoul,
    stopManagedRuntimeSoul: apiMock.stopManagedRuntimeSoul,
    updateManagedRuntimeViewVisibility: apiMock.updateManagedRuntimeViewVisibility,
    getManagedRuntimeSoul: apiMock.getManagedRuntimeSoul,
  }
})

vi.mock('@/store/settingsThunks', () => ({
  saveServerSettingsPatch: (patch: unknown) => saveServerSettingsPatchSpy(patch),
}))

function createStore(tabTitleSetByUser = false, extraMiddleware: Middleware[] = []) {
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
      managedRuntime: managedRuntimeReducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({
        // sessions.expandedProjects is a Set by slice design (same ignore as
        // PaneContainer.test.tsx's createStore).
        serializableCheck: {
          ignoredPaths: ['sessions.expandedProjects'],
        },
      }).concat(extraMiddleware),
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
  hidden = false,
}: {
  tabId: string
  paneId: string
  hidden?: boolean
}) {
  const paneContent = useAppSelector((state) => {
    const layout = state.panes.layouts[tabId]
    if (!layout || layout.type !== 'leaf' || layout.id !== paneId || layout.content.kind !== 'fresh-agent') {
      throw new Error(`Missing fresh-agent pane ${paneId}`)
    }
    return layout.content
  })
  return <FreshAgentView tabId={tabId} paneId={paneId} paneContent={paneContent} hidden={hidden} />
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

function finishOutgoingTurn(store: ReturnType<typeof createStore>) {
  const content = getFreshAgentPaneContent(store)
  const locator = { sessionId: content.sessionId!, sessionType: content.sessionType, provider: content.provider }
  act(() => store.dispatch(setSessionStatus({ ...locator, status: 'running' })))
  act(() => store.dispatch(setSessionStatus({ ...locator, status: 'idle' })))
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
  apiMock.requestSessionHandoff.mockReset()
  apiMock.setSessionMetadata.mockReset()
  apiMock.getManagedRuntimeInventory.mockReset()
  apiMock.retryManagedRuntimeSoul.mockReset()
  apiMock.stopManagedRuntimeSoul.mockReset()
  apiMock.updateManagedRuntimeViewVisibility.mockReset()
  apiMock.getManagedRuntimeSoul.mockReset()
  apiMock.post.mockResolvedValue({ title: null, source: 'none' })
  apiMock.requestSessionHandoff.mockResolvedValue({
    ok: true,
    operationId: 'handoff-default',
    generation: 1,
    owner: { kind: 'terminal', terminalId: 't-default', mode: 'codex' },
  })
  apiMock.setSessionMetadata.mockResolvedValue(undefined)
  apiMock.retryManagedRuntimeSoul.mockResolvedValue(undefined)
  apiMock.getManagedRuntimeInventory.mockResolvedValue({
    revision: 1,
    readiness: {
      inventoryRevision: 1,
      initialScanState: 'complete',
      blockedSubsystems: [],
      startupRecoveryConcurrencyLimit: 1,
      startupRecoveryPeak: 0,
    },
    souls: [],
    viewIntents: [],
    pendingProjectionCount: 0,
  })
  resetManagedRuntimeRefreshForTest()
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
  it('renders and dismisses a failed close while keeping the stopped managed conversation', async () => {
    const store = createStore()
    const handlers = new Set<(message: unknown) => void>()
    wsMock.onMessage.mockImplementation((handler) => {
      handlers.add(handler)
      return () => { handlers.delete(handler) }
    })
    wsMock.send.mockImplementation((message) => {
      if (message.type === 'panes.closed') {
        for (const handler of [...handlers]) handler({
          type: 'panes.closed.result', requestId: message.requestId, success: true,
        })
      }
    })
    apiMock.updateManagedRuntimeViewVisibility
      .mockRejectedValueOnce(new Error('View update refused'))
      .mockResolvedValue({ visibility: 'visible', revision: 4, soulIntentRevision: 8 })
    apiMock.getManagedRuntimeSoul.mockResolvedValue({
      soul: { soulId: 'close-retained-soul', intentRevision: 8 },
      viewIntents: [{ viewId: 'close-retained-view', visibility: 'visible', revision: 3, soulIntentRevision: 8 }],
    })
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({ status: 'exited', turns: [
      { id: 'saved-turn', role: 'assistant', items: [{ id: 'saved-text', kind: 'text', text: 'Saved conversation remains here' }] },
    ] })
    const content = {
      kind: 'fresh-agent' as const, sessionType: 'freshcodex' as const, provider: 'codex' as const,
      createRequestId: 'close-retained-create', sessionId: 'close-retained-thread',
      sessionRef: { provider: 'codex' as const, sessionId: 'close-retained-thread' },
      soulId: 'close-retained-soul', viewIntentId: 'close-retained-view',
      viewIntentRevision: 2, soulIntentRevision: 7, status: 'exited' as const,
    }
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content }))
    store.dispatch(sessionInit({
      sessionType: 'freshcodex', provider: 'codex', sessionId: 'close-retained-thread',
    }))
    store.dispatch(sessionExited({
      sessionType: 'freshcodex', provider: 'codex', sessionId: 'close-retained-thread',
    }))
    render(<Provider store={store}><StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" /></Provider>)
    expect(await screen.findByText('Saved conversation remains here')).toBeInTheDocument()
    expect(screen.queryByText(/Close failed/)).toBeNull()
    await act(async () => { await store.dispatch(closeTab('tab-1')) })
    const notice = await screen.findByText('Close failed: The pane could not be closed, so it was left open. Try again.')
    expect(notice.closest('[role="alert"]')).toBeInTheDocument()
    expect(screen.queryByText(/Agent error:/)).toBeNull()
    expect(apiMock.updateManagedRuntimeViewVisibility).toHaveBeenCalled()
    expect(screen.getByText('Saved conversation remains here')).toBeInTheDocument()
    fireEvent.click(within(notice.closest('[role="alert"]') as HTMLElement).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText(/Close failed/)).toBeNull()
    expect(getFreshAgentPaneContent(store)).toMatchObject(content)
    expect(sentFreshAgentMessages('freshAgent.create')).toHaveLength(0)
    expect(sentFreshAgentMessages('freshAgent.kill')).toHaveLength(0)
  })

  describe('outgoing message queue', () => {
    async function setup(status = 'running', canSend = true, provider: 'codex' | 'claude' = 'codex') {
      const store = createStore()
      apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({
        status, capabilities: { send: canSend, interrupt: true }, turns: [],
      })
      const content = {
        kind: 'fresh-agent' as const, sessionType: provider === 'claude' ? 'freshclaude' as const : 'freshcodex' as const,
        provider, createRequestId: 'queue-create',
        sessionId: provider === 'claude' ? CLAUDE_THREAD_ID : 'queue-session', status: status as 'running' | 'idle',
      }
      const view = (nextStatus: string) => (
        <Provider store={store}>
          <FreshAgentView tabId="tab-1" paneId="pane-1" paneContent={{ ...content, status: nextStatus as 'idle' }} />
        </Provider>
      )
      const rendered = render(view(status))
      await waitFor(() => expect(screen.getByRole('textbox', { name: 'Chat message input' })).toBeEnabled())
      const send = (text: string) => {
        fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), { target: { value: text } })
        fireEvent.click(screen.getByRole('button', { name: 'Send' }))
      }
      return { send, store, status: (nextStatus: string) => {
        act(() => store.dispatch(setSessionStatus({
          sessionId: content.sessionId, sessionType: content.sessionType, provider,
          status: nextStatus as 'idle',
        })))
        rendered.rerender(view(nextStatus))
      } }
    }

    it('keeps queued work when the provider exits', async () => {
      const queue = await setup()
      queue.send('Keep this follow-up')
      queue.status('exited')
      expect(sentFreshAgentMessages('freshAgent.send')).toHaveLength(0)
      expect(screen.getByRole('status', { name: 'Queued messages' })).toHaveTextContent('1 queued')
    })

    it('sends queued messages one turn at a time', async () => {
      const queue = await setup()
      queue.send('First follow-up')
      queue.send('Second follow-up')
      queue.status('idle')
      await waitFor(() => expect(sentFreshAgentMessages('freshAgent.send')).toHaveLength(1))
      expect(sentFreshAgentMessages('freshAgent.send')[0]).toMatchObject({ text: 'First follow-up' })
      expect(screen.getByRole('status', { name: 'Queued messages' })).toHaveTextContent('1 queued')
      queue.status('running')
      queue.status('idle')
      await waitFor(() => expect(sentFreshAgentMessages('freshAgent.send')).toHaveLength(2))
      expect(sentFreshAgentMessages('freshAgent.send')[1]).toMatchObject({ text: 'Second follow-up' })
    })

    it('queues rapid sends before the provider reports running', async () => {
      const queue = await setup('idle')
      queue.send('First message')
      queue.send('Second message')
      expect(sentFreshAgentMessages('freshAgent.send')).toHaveLength(1)
      expect(screen.getByRole('status', { name: 'Queued messages' })).toHaveTextContent('1 queued')
    })

    it('advances after a fast interrupted turn whose status updates share one render', async () => {
      const queue = await setup('idle')
      queue.send('First message')
      queue.send('Second message')
      const locator = { sessionId: 'queue-session', sessionType: 'freshcodex' as const, provider: 'codex' as const }
      const listener = wsMock.onMessage.mock.calls.at(-1)?.[0] as unknown as (message: unknown) => void
      act(() => {
        listener({ type: 'freshAgent.event', ...locator, event: { type: 'freshAgent.status', status: 'running' } })
        queue.store.dispatch(setSessionStatus({ ...locator, status: 'running' }))
        queue.store.dispatch(setSessionStatus({ ...locator, status: 'idle' }))
      })
      await waitFor(() => expect(sentFreshAgentMessages('freshAgent.send')).toHaveLength(2))
    })

    it('advances after real Codex snapshot lifecycle frames complete within one render', async () => {
      const queue = await setup('idle')
      queue.send('First message')
      queue.send('Second message')
      const locator = { sessionId: 'queue-session', sessionType: 'freshcodex' as const, provider: 'codex' as const }
      const listener = wsMock.onMessage.mock.calls.at(-1)?.[0] as unknown as (message: unknown) => void
      act(() => {
        for (const status of ['running', 'idle']) {
          const message = { type: 'freshAgent.event', ...locator, event: { type: 'freshAgent.session.snapshot', sessionId: locator.sessionId, latestTurnId: null, timelineSessionId: locator.sessionId, status } }
          handleFreshAgentMessage(queue.store.dispatch, message)
          listener(message)
        }
      })
      await waitFor(() => expect(sentFreshAgentMessages('freshAgent.send')).toHaveLength(2))
      expect(sentFreshAgentMessages('freshAgent.send')[1]).toMatchObject({ text: 'Second message' })
    })

    it('does not unlock the next Codex send with an earlier turn HTTP response', async () => {
      const queue = await setup('idle')
      queue.send('Repeat this task')
      const first = sentFreshAgentMessages('freshAgent.send')[0]
      const snapshot = createDeferred<ReturnType<typeof freshopencodeSnapshot>>()
      apiMock.getFreshAgentThreadSnapshot.mockImplementationOnce(() => snapshot.promise)
      const locator = { sessionId: 'queue-session', sessionType: 'freshcodex' as const, provider: 'codex' as const }
      const listener = wsMock.onMessage.mock.calls.at(-1)?.[0] as unknown as (message: unknown) => void
      act(() => listener({ type: 'freshAgent.send.accepted', ...locator, requestId: first.requestId }))
      await waitFor(() => expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(2))
      queue.send('Repeat this task')
      queue.send('Last follow-up')
      act(() => {
        for (const status of ['running', 'idle']) {
          const message = { type: 'freshAgent.event', ...locator, event: { type: 'freshAgent.session.snapshot', sessionId: locator.sessionId, latestTurnId: null, timelineSessionId: locator.sessionId, status } }
          handleFreshAgentMessage(queue.store.dispatch, message)
          listener(message)
        }
      })
      expect(sentFreshAgentMessages('freshAgent.send')).toHaveLength(2)
      await act(async () => snapshot.resolve({
        ...freshopencodeSnapshot('finished first turn', 1),
        sessionType: 'freshcodex', provider: 'codex', sessionId: locator.sessionId, threadId: locator.sessionId,
        turns: [{ id: 'first-user-turn', turnId: 'first-user-turn', role: 'user', summary: 'Repeat this task', items: [{ id: 'first-user-text', kind: 'text', text: 'Repeat this task' }] }],
      }))
      expect(sentFreshAgentMessages('freshAgent.send')).toHaveLength(2)
      expect(screen.getByRole('status', { name: 'Queued messages' })).toHaveTextContent('1 queued')
    })

    it('advances after Claude streams and completes within one render', async () => {
      const queue = await setup('idle', true, 'claude')
      queue.send('First message')
      queue.send('Second message')
      const locator = { sessionId: CLAUDE_THREAD_ID, sessionType: 'freshclaude' as const, provider: 'claude' as const }
      const listener = wsMock.onMessage.mock.calls.at(-1)?.[0] as unknown as (message: unknown) => void
      act(() => {
        for (const event of [
          { type: 'freshAgent.stream', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
          { type: 'freshAgent.stream', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done' } } },
          { type: 'freshAgent.result' },
          { type: 'freshAgent.status', status: 'idle' },
        ]) {
          const message = { type: 'freshAgent.event', ...locator, event }
          handleFreshAgentMessage(queue.store.dispatch, message)
          listener(message)
        }
      })
      await waitFor(() => expect(sentFreshAgentMessages('freshAgent.send')).toHaveLength(2))
    })

    it.each(['codex', 'claude'] as const)('advances %s after reconnect when an authoritative idle snapshot contains the submitted turn', async (provider) => {
      const queue = await setup('idle', true, provider)
      queue.send('First message')
      queue.send('Second message')
      const first = sentFreshAgentMessages('freshAgent.send')[0]
      const reconnect = wsMock.onReconnect.mock.calls.at(-1)?.[0] as unknown as () => void
      act(() => queue.store.dispatch({ type: 'connection/setStatus', payload: 'disconnected' }))
      apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({
        sessionId: first.sessionId, status: 'idle', capabilities: { send: true, interrupt: true },
        extensions: provider === 'claude' ? { claude: { statusFromLiveState: true } } : {},
        turns: [{ id: 'completed-user-turn', role: 'user', requestId: first.requestId, items: [{ id: 'user-text', kind: 'text', text: 'First message' }] }],
      })
      act(() => {
        queue.store.dispatch({ type: 'connection/setStatus', payload: 'ready' })
        reconnect()
      })
      await waitFor(() => expect(sentFreshAgentMessages('freshAgent.send')).toHaveLength(2))
      expect(sentFreshAgentMessages('freshAgent.send')[1]).toMatchObject({ text: 'Second message' })
    })

    it('does not advance Claude from disk-only idle history after accepting a prompt', async () => {
      const queue = await setup('idle', true, 'claude')
      queue.send('Accepted but not finished')
      queue.send('Later follow-up')
      const first = sentFreshAgentMessages('freshAgent.send')[0]
      const beforeRefresh = apiMock.getFreshAgentThreadSnapshot.mock.calls.length
      apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({
        sessionId: CLAUDE_THREAD_ID, status: 'idle', capabilities: { send: true, interrupt: true },
        turns: [{ id: 'accepted-user-turn', role: 'user', requestId: first.requestId, items: [{ id: 'accepted-text', kind: 'text', text: 'Accepted but not finished' }] }],
        extensions: { claude: { liveSessionId: CLAUDE_THREAD_ID } },
      })
      const listener = wsMock.onMessage.mock.calls.at(-1)?.[0] as unknown as (message: unknown) => void
      act(() => listener({
        type: 'freshAgent.send.accepted', sessionId: CLAUDE_THREAD_ID,
        sessionType: 'freshclaude', provider: 'claude', requestId: first.requestId,
        submittedTurnId: 'accepted-user-turn',
      }))
      await waitFor(() => expect(apiMock.getFreshAgentThreadSnapshot.mock.calls.length).toBeGreaterThan(beforeRefresh))
      expect(sentFreshAgentMessages('freshAgent.send')).toHaveLength(1)
      expect(screen.getByRole('status', { name: 'Queued messages' })).toHaveTextContent('1 queued')
    })

    it('keeps the reservation when a reconnect idle snapshot does not contain the submitted turn', async () => {
      const queue = await setup('idle')
      queue.send('Still awaiting acceptance')
      queue.send('Later follow-up')
      const beforeRefresh = apiMock.getFreshAgentThreadSnapshot.mock.calls.length
      const reconnect = wsMock.onReconnect.mock.calls.at(-1)?.[0] as unknown as () => void
      act(() => reconnect())
      await waitFor(() => expect(apiMock.getFreshAgentThreadSnapshot.mock.calls.length).toBeGreaterThan(beforeRefresh))
      expect(sentFreshAgentMessages('freshAgent.send')).toHaveLength(1)
      expect(screen.getByRole('status', { name: 'Queued messages' })).toHaveTextContent('1 queued')
    })

    it('keeps queued work while the idle snapshot does not allow sends', async () => {
      const queue = await setup('running', false)
      queue.send('Wait for permission to send')
      queue.status('idle')
      expect(sentFreshAgentMessages('freshAgent.send')).toHaveLength(0)
      expect(screen.getByRole('status', { name: 'Queued messages' })).toHaveTextContent('1 queued')
    })

    it('keeps queued work while disconnected and sends after reconnect', async () => {
      const queue = await setup()
      queue.send('After reconnect')
      act(() => queue.store.dispatch({ type: 'connection/setStatus', payload: 'disconnected' }))
      queue.status('idle')
      expect(sentFreshAgentMessages('freshAgent.send')).toHaveLength(0)
      act(() => queue.store.dispatch({ type: 'connection/setStatus', payload: 'ready' }))
      await waitFor(() => expect(sentFreshAgentMessages('freshAgent.send')).toHaveLength(1))
    })

    it('checks current agent status when a shell command finishes', async () => {
      const queue = await setup('idle')
      let finishShell!: (result: { output: string; exitCode: number }) => void
      apiMock.post.mockImplementationOnce(() => new Promise((resolve) => { finishShell = resolve }))
      queue.send('!pwd')
      queue.status('running')
      await act(async () => finishShell({ output: '/workspace', exitCode: 0 }))
      expect(sentFreshAgentMessages('freshAgent.send')).toHaveLength(0)
      expect(screen.getByRole('status', { name: 'Queued messages' })).toHaveTextContent('1 queued')
      queue.status('idle')
      await waitFor(() => expect(sentFreshAgentMessages('freshAgent.send')[0]).toMatchObject({ text: expect.stringContaining('/workspace') }))
    })
  })

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

  it('flows expandThinking/expandTools from global settings into the transcript', async () => {
    const store = createStore()
    store.dispatch(updateSettingsLocal({
      freshAgent: {
        expandThinking: true,
        expandTools: true,
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
            // showTimecodes keeps its per-pane override (out of redesign
            // scope): the pane wins over the global default.
            showTimecodes: true,
          }}
        />
      </Provider>,
    )

    await waitFor(() => {
      // expandTools flows from the global settings: the strip mounts
      // EXPANDED, so the tool call detail renders with no click.
      expect(screen.getByText('npm run display-check')).toBeInTheDocument()
    })
    // expandThinking flows from the global settings: the Thinking row mounts
    // with its body already visible.
    expect(screen.getByText('pane-level thinking')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Thinking' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('claude-opus-4-6')).toBeInTheDocument()
    // Local time h:mm AM/PM — no seconds, never UTC.
    const expectedTimecode = new Date('2026-06-15T12:34:56.000Z')
      .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true })
    const timecodeEl = screen.getByText(expectedTimecode)
    expect(timecodeEl.tagName).toBe('TIME')
    expect(timecodeEl.textContent).toMatch(/^\d{1,2}:\d{2}\s?(AM|PM)$/i)
  })

  it('mounts a collapsed strip by default and gates thinking rows behind the strip toggle', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
      status: 'idle',
      summary: 'Display summary',
      capabilities: { send: true, interrupt: true, fork: false },
      turns: [{
        id: 'turn-defaults', turnId: 'turn-defaults', role: 'assistant',
        timestamp: '2026-06-15T12:34:56.000Z',
        model: 'claude-opus-4-6',
        summary: 'used tools',
        items: [
          { id: 'think-defaults', kind: 'thinking', text: 'default-visible thinking' },
          {
            id: 'tool-defaults', kind: 'tool_use', toolUseId: 'call-defaults',
            name: 'Bash', input: { command: 'npm run display-check' },
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
            createRequestId: 'req-defaults',
            sessionId: CLAUDE_THREAD_ID,
            status: 'connected',
          }}
        />
      </Provider>,
    )

    await waitFor(() => {
      // Compact defaults: the strip mounts COLLAPSED — the settled summary
      // replaces the tool detail.
      expect(screen.getByText('thought · 1 tool used')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Toggle activity details' })).toHaveAttribute('aria-expanded', 'false')
    // Compact defaults: a tool-bearing line collapses to the single summary
    // line — no hoisted Thinking trigger while the strip is collapsed.
    expect(screen.queryByRole('button', { name: 'Thinking' })).not.toBeInTheDocument()
    expect(screen.queryByText('default-visible thinking')).not.toBeInTheDocument()
    // Expanding the strip reveals the thinking row and the tool row; the
    // block itself starts collapsed (expandTools governs the strip's
    // starting state, not the per-block in-pane toggles) and opens on its
    // own click.
    fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
    expect(screen.getByRole('button', { name: 'Thinking' })).toBeInTheDocument()
    expect(screen.queryByText('default-visible thinking')).not.toBeInTheDocument()
    const toolButton = screen.getByRole('button', { name: 'Bash tool call' })
    expect(toolButton).toBeInTheDocument()
    fireEvent.click(toolButton)
    expect(screen.getByText('npm run display-check')).toBeInTheDocument()
  })

  it('applies a changed expandTools default on remount, not on live re-render', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({
      status: 'idle',
      summary: 'Display summary',
      capabilities: { send: true, interrupt: true, fork: false },
      turns: [{
        id: 'turn-live', turnId: 'turn-live', role: 'assistant',
        summary: 'used tools',
        items: [
          { id: 'think-live', kind: 'thinking', text: 'live toggle thinking' },
          { id: 'tool-live', kind: 'tool_use', toolUseId: 'call-live', name: 'Bash',
            input: { command: 'npm run live-check' } },
        ],
      }],
    })

    const { unmount } = render(
      <Provider store={store}>
        <FreshAgentView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={{
            kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude',
            createRequestId: 'req-live', sessionId: CLAUDE_THREAD_ID, status: 'connected',
          }}
        />
      </Provider>,
    )

    // Compact mount: the strip starts collapsed.
    await waitFor(() => {
      expect(screen.getByText('thought · 1 tool used')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Toggle activity details' })).toHaveAttribute('aria-expanded', 'false')

    // Flip expandTools on via the live store (the reducer path the Settings
    // toggle drives): the MOUNTED strip keeps its in-pane state — the
    // setting is a mount-time default, never a live override.
    act(() => {
      store.dispatch(updateSettingsLocal({
        freshAgent: { expandTools: true },
      }))
    })
    expect(screen.getByRole('button', { name: 'Toggle activity details' })).toHaveAttribute('aria-expanded', 'false')

    // Remount (the real single-tab flow: opening Settings unmounts the pane
    // tree): the new default applies at mount.
    unmount()
    render(
      <Provider store={store}>
        <FreshAgentView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={{
            kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude',
            createRequestId: 'req-live', sessionId: CLAUDE_THREAD_ID, status: 'connected',
          }}
        />
      </Provider>,
    )
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Toggle activity details' })).toHaveAttribute('aria-expanded', 'true')
    })
    expect(screen.getByText('npm run live-check')).toBeInTheDocument()
    unmount()
  })

  it('hides and shows the transcript minimap rail live when the setting changes', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
      status: 'idle',
      summary: 'Display summary',
      capabilities: { send: true, interrupt: true, fork: false },
      turns: [
        { id: 'mm-v-u1', turnId: 'mm-v-u1', role: 'user', summary: 'First minimap prompt', items: [{ id: 'mm-v-i1', kind: 'text', text: 'First minimap prompt' }] },
        { id: 'mm-v-a1', turnId: 'mm-v-a1', role: 'assistant', summary: 'r1', items: [{ id: 'mm-v-i2', kind: 'text', text: 'A'.repeat(400) }] },
        { id: 'mm-v-u2', turnId: 'mm-v-u2', role: 'user', summary: 'Second minimap prompt', items: [{ id: 'mm-v-i3', kind: 'text', text: 'Second minimap prompt' }] },
        { id: 'mm-v-a2', turnId: 'mm-v-a2', role: 'assistant', summary: 'r2', items: [{ id: 'mm-v-i4', kind: 'text', text: 'B'.repeat(400) }] },
      ],
    })

    const { container } = render(
      <Provider store={store}>
        <FreshAgentView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={{
            kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude',
            createRequestId: 'req-minimap-setting', sessionId: CLAUDE_THREAD_ID, status: 'connected',
          }}
        />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByText('Second minimap prompt')).toBeInTheDocument()
    })

    // Scrollable-geometry mocks (the minimap suite's canonical numbers) so
    // the rail would render under the default-ON setting.
    const scroller = container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 248 })
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 1000 })
    scroller.scrollTop = 376
    const userTurns = container.querySelectorAll('[data-turn-role="user"]')
    const mockRect = (el: Element, top: number, height = 50) => {
      el.getBoundingClientRect = () => ({
        top,
        bottom: top + height,
        left: 0,
        right: 800,
        width: 800,
        height,
        x: 0,
        y: top,
        toJSON: () => ({}),
      })
    }
    mockRect(scroller, 0)
    mockRect(userTurns[0], -376)
    mockRect(userTurns[1], 74)
    fireEvent.scroll(scroller)

    // Default ON: the rail renders.
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /Jump to prompt:/ })).toHaveLength(2)
    })

    // Flip the setting off through the live store (the reducer path the
    // Settings toggle drives): the transcript re-renders and the rail unmounts.
    act(() => {
      store.dispatch(updateSettingsLocal({ freshAgent: { showTranscriptMinimap: false } }))
    })
    expect(screen.queryByRole('button', { name: /Jump to prompt:/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Transcript minimap' })).not.toBeInTheDocument()

    // Flip back on: the rail returns.
    act(() => {
      store.dispatch(updateSettingsLocal({ freshAgent: { showTranscriptMinimap: true } }))
    })
    expect(screen.getAllByRole('button', { name: /Jump to prompt:/ })).toHaveLength(2)
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

  it('stamps freshAgent.create with the pane tab identity (D8 provenance)', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-tabid',
        status: 'creating',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    // D8 (restore-open-sessions-only): the server composes the ledger row's
    // tabKey as `deviceId:tabId` from the hello-stamped connection identity
    // plus this field; the D8 judgment never offers rows whose parent
    // evidence cannot see them, so a dropped tabId would silently orphan the
    // pane's placement on restore.
    expect(wsMock.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'freshAgent.create',
      requestId: 'req-tabid',
      tabId: 'tab-1',
    }))
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
      model: 'gpt-6-astra',
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

  it('re-creates (never snapshot-loads) a legacy freshopencode placeholder pane', async () => {
    const store = createStore()
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

    // The placeholder repair feature (legacyRestoreContext: tab title/created
    // hints consumed by the pre-Rust server to adopt a DB session) was
    // intentionally dropped with user approval — its migration window (panes
    // persisted by clients older than 2026-06) has elapsed and no current
    // code mints placeholder ids. The still-live contract: a legacy
    // placeholder pane re-creates server-side, and the snapshot route is
    // never called with the placeholder id (the
    // isFreshOpencodePlaceholderId guard in fresh-agent-snapshot-thread).
    await waitFor(() => {
      expect(sentFreshAgentMessages('freshAgent.create').at(-1)).toMatchObject({
        requestId: '-gP4qyCL7bwp8-xbw9G7b',
        sessionType: 'freshopencode',
        provider: 'opencode',
        cwd: '/home/dan/code',
        sessionRef: { provider: 'opencode', sessionId: 'freshopencode--gP4qyCL7bwp8-xbw9G7b' },
      })
      expect(sentFreshAgentMessages('freshAgent.create').at(-1)).not.toHaveProperty('legacyRestoreContext')
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

  // 2026-09-20 incident (log-validated): the daemon died, the snapshot GET
  // answered the typed 409 RESTORE_UNAVAILABLE for the pane's OWN stale
  // Live{FreshAgent, gen 1} claim, and the pane dead-ended on a dismiss-only
  // banner forever. The documented recovery is the generation-fenced attach +
  // refetch — drive it once.
  // LB-09: the mount attach already sends ONE freshAgent.attach on mount, so a
  // bare length assertion is vacuous — read the baseline AFTER the mount
  // settles and assert the POST-409 delta.
  it('recovers a freshopencode pane from a snapshot 409 with one fenced attach and a refetch', async () => {
    const store = createStore()
    // Seed the runtime-owner record and make the 409 name a NEWER generation —
    // the recovery attach MUST carry the 409's generation (fence bound to the
    // refusal, not the possibly-stale record), or the wired server refuses it
    // with FENCE_REQUIRED and the dead-end persists.
    store.dispatch(applyRuntimeOwner({
      type: 'session.runtimeOwner',
      provider: 'opencode',
      sessionId: 'ses_live',
      epoch: 1,
      generation: 1,
      ownerKind: 'fresh-agent',
      operationId: 'incident-live-claim',
      transition: 'handoff-committed',
    }))
    // DEFER the first rejection until after the baseline is read — an
    // immediately-rejected mock races the mount fetch (the recovery attach may
    // land before the test snapshots the count).
    let rejectFirstSnapshot!: (error: unknown) => void
    apiMock.getFreshAgentThreadSnapshot
      .mockImplementationOnce(() => new Promise<never>((_, reject) => {
        rejectFirstSnapshot = reject
      }))
      .mockResolvedValue({
        ...freshopencodeSnapshot('recovered transcript', 7),
        threadId: 'ses_live',
        sessionId: 'ses_live',
      })
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-live-409',
        sessionId: 'ses_live',
        sessionRef: { provider: 'opencode', sessionId: 'ses_live' },
        status: 'connected',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )
    await waitFor(() => expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(1))
    // The mount attach, settled (LB-09 baseline).
    const attachCountBeforeRecovery = sentFreshAgentMessages('freshAgent.attach').length
    expect(attachCountBeforeRecovery).toBe(1)
    await act(async () => {
      rejectFirstSnapshot(new ApiError(409, 'Session ses_live is still running on the server.', {
        code: 'RESTORE_UNAVAILABLE',
        ownerKind: 'fresh-agent',
        ownerGeneration: 2,
      }))
    })
    await waitFor(() => {
      expect(sentFreshAgentMessages('freshAgent.attach')).toHaveLength(attachCountBeforeRecovery + 1)
      const recoveryAttach = sentFreshAgentMessages('freshAgent.attach').at(-1)
      expect(recoveryAttach?.observedEpoch).toBe(1) // the record's epoch
      expect(recoveryAttach?.observedGeneration).toBe(2) // the 409's CURRENT generation, not the stale record's 1
    })
    await waitFor(() => {
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(2) // exactly one recovery refetch
    })
    // The pane kept its identity (the 409 is NOT the 404 lost-thread reset):
    expect(getFreshAgentPaneContent(store).sessionId).toBe('ses_live')
    expect(getFreshAgentPaneContent(store).createRequestId).toBe('req-live-409')
    // And no dead-end banner for the recovered pane:
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  // Task 5 review M2: a pane holding a superseded (alias) session id must
  // fold the 409's refusal fence onto the CANONICAL owner record — the same
  // record the recovery attach's fence read (selectPaneOwnerFence) resolves
  // through the stored aliasOf chain. Folding the pane's RAW id lands on the
  // inert alias mirror, the attach goes out with the canonical record's
  // STALE generation, and the wired server refuses it with FENCE_REQUIRED.
  it('recovers an aliased freshopencode pane from a snapshot 409 by folding the refusal onto the canonical owner record', async () => {
    const store = createStore()
    store.dispatch(applyRuntimeOwner({
      type: 'session.runtimeOwner',
      provider: 'opencode',
      sessionId: 'ses_canonical',
      epoch: 1,
      generation: 1,
      ownerKind: 'fresh-agent',
      operationId: 'incident-live-claim',
      transition: 'handoff-committed',
    }))
    // The rekey alias mirror (selectors-runtime-owner seeding pattern): the
    // pane's superseded id resolves through the stored aliasOf chain to the
    // canonical key.
    store.dispatch(applyRuntimeOwner({
      type: 'session.runtimeOwner',
      provider: 'opencode',
      sessionId: 'ses_alias',
      epoch: 1,
      generation: 1,
      ownerKind: 'fresh-agent',
      operationId: 'rekey-mirror',
      transition: 'handoff-committed',
      aliasOf: 'ses_canonical',
    }))
    let rejectFirstSnapshot!: (error: unknown) => void
    apiMock.getFreshAgentThreadSnapshot
      .mockImplementationOnce(() => new Promise<never>((_, reject) => {
        rejectFirstSnapshot = reject
      }))
      .mockResolvedValue({
        ...freshopencodeSnapshot('recovered transcript', 7),
        threadId: 'ses_alias',
        sessionId: 'ses_alias',
      })
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-alias-409',
        sessionId: 'ses_alias',
        sessionRef: { provider: 'opencode', sessionId: 'ses_alias' },
        status: 'connected',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )
    await waitFor(() => expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(1))
    // The mount attach, settled (LB-09 baseline).
    const attachCountBeforeRecovery = sentFreshAgentMessages('freshAgent.attach').length
    expect(attachCountBeforeRecovery).toBe(1)
    await act(async () => {
      rejectFirstSnapshot(new ApiError(409, 'Session ses_alias is still running on the server.', {
        code: 'RESTORE_UNAVAILABLE',
        ownerKind: 'fresh-agent',
        ownerGeneration: 2,
      }))
    })
    await waitFor(() => {
      expect(sentFreshAgentMessages('freshAgent.attach')).toHaveLength(attachCountBeforeRecovery + 1)
      const recoveryAttach = sentFreshAgentMessages('freshAgent.attach').at(-1)
      expect(recoveryAttach?.observedEpoch).toBe(1) // the canonical record's epoch
      expect(recoveryAttach?.observedGeneration).toBe(2) // the 409's CURRENT generation, not the canonical record's stale 1
    })
    // The fold landed on the CANONICAL record; the alias mirror stays inert.
    const owners = store.getState().freshAgent.runtimeOwners
    expect(owners['opencode:ses_canonical'].generation).toBe(2)
    expect(owners['opencode:ses_alias'].generation).toBe(1)
    await waitFor(() => {
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(2) // exactly one recovery refetch
    })
    // The pane kept its identity (the 409 is NOT the 404 lost-thread reset):
    expect(getFreshAgentPaneContent(store).sessionId).toBe('ses_alias')
    expect(getFreshAgentPaneContent(store).createRequestId).toBe('req-alias-409')
    // And no dead-end banner for the recovered pane:
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('does not loop recovery fetches on repeated 409s', async () => {
    vi.useFakeTimers()
    try {
      const store = createStore()
      // Every GET rejects with the same real ApiError (an Error instance) so
      // handleSnapshotError preserves the 409's own message on the banner.
      apiMock.getFreshAgentThreadSnapshot.mockRejectedValue(new ApiError(409, 'Session ses_live is still running on the server.', {
        code: 'RESTORE_UNAVAILABLE',
        ownerKind: 'fresh-agent',
        ownerGeneration: 2,
      }))
      store.dispatch(initLayout({
        tabId: 'tab-1',
        paneId: 'pane-1',
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshopencode',
          provider: 'opencode',
          createRequestId: 'req-live-409-loop',
          sessionId: 'ses_live',
          sessionRef: { provider: 'opencode', sessionId: 'ses_live' },
          status: 'connected',
        },
      }))
      render(
        <Provider store={store}>
          <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
        </Provider>,
      )
      // Settle the mount fetch and the single recovery refetch (the second 409
      // falls through to the honest banner — the recovery guard already
      // consumed this pane identity). Advance the fake clock deterministically
      // (the wall-clock debounce races under parallel suites — the sibling
      // scheduler tests' note).
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      const baseline = sentFreshAgentMessages('freshAgent.attach').length
      expect(screen.getByText(/still running on the server/i)).toBeInTheDocument()
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
      expect(sentFreshAgentMessages('freshAgent.attach')).toHaveLength(baseline) // one recovery total, not per fetch (LB-03)
      expect(apiMock.getFreshAgentThreadSnapshot.mock.calls.length).toBeLessThanOrEqual(3) // mount + recovery only — no loop
    } finally {
      cleanup()
      resetSnapshotSchedulerForTests()
      vi.useRealTimers()
    }
  })

  // Task 5 review M3 (LB-04): a 409 arriving on the REVEAL lane (snapshotDirty
  // armed by a hidden reconnect) must recover through requestRevealRefresh —
  // the success-path reveal-dirty clear only runs for reveal-tagged
  // refreshes, so a 'manual' refetch would leave the pane behind the
  // "Refreshing conversation" overlay forever. Fake timers drive the
  // debounced scheduler deterministically (the sibling loop test's pattern —
  // the wall-clock debounce races under parallel suites).
  it('recovers a reveal-lane 409 with snapshotDirty armed through the reveal refresh and clears the overlay', async () => {
    vi.useFakeTimers()
    try {
      const store = createStore()
      store.dispatch(applyRuntimeOwner({
        type: 'session.runtimeOwner',
        provider: 'opencode',
        sessionId: 'ses_reveal',
        epoch: 1,
        generation: 1,
        ownerKind: 'fresh-agent',
        operationId: 'incident-live-claim',
        transition: 'handoff-committed',
      }))
      let reconnectHandler: (() => void) | undefined
      wsMock.onReconnect.mockImplementation((handler: () => void) => {
        reconnectHandler = handler
        return () => {}
      })
      let rejectRevealSnapshot!: (error: unknown) => void
      let resolveRecoverySnapshot!: (value: unknown) => void
      apiMock.getFreshAgentThreadSnapshot
        .mockImplementationOnce(() => Promise.resolve({
          ...freshopencodeSnapshot('hidden transcript', 5),
          threadId: 'ses_reveal',
          sessionId: 'ses_reveal',
        }))
        .mockImplementationOnce(() => new Promise<never>((_, reject) => {
          rejectRevealSnapshot = reject
        }))
        .mockImplementationOnce(() => new Promise<unknown>((resolve) => {
          resolveRecoverySnapshot = resolve
        }))
      store.dispatch(initLayout({
        tabId: 'tab-1',
        paneId: 'pane-1',
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshopencode',
          provider: 'opencode',
          createRequestId: 'req-reveal-409',
          sessionId: 'ses_reveal',
          sessionRef: { provider: 'opencode', sessionId: 'ses_reveal' },
          status: 'connected',
        },
      }))

      const view = render(
        <Provider store={store}>
          <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" hidden />
        </Provider>,
      )
      // The hidden mount fetch (delay-0 'identity' trigger) lands its snapshot
      // BEFORE the reconnect arms the reveal-dirty marker (its revision
      // becomes the base the recovery refresh must beat). The 500ms drain
      // settles the hidden mount attach's rebind-queue slot (the sibling
      // hidden-rebind tests' pattern).
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(screen.getByText('hidden transcript')).toBeInTheDocument()
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(1)
      act(() => { reconnectHandler?.() })
      // Still hidden: the reconnect defers the refresh to reveal — no fetch.
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(1)
      view.rerender(
        <Provider store={store}>
          <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
        </Provider>,
      )
      // Reveal drives the reveal-tagged refresh (the 250ms debounce fires
      // within the advance; the reconnect attach's queue slot drains too).
      await act(async () => { await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS) })
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(2)
      expect(apiMock.getFreshAgentThreadSnapshot.mock.calls[1][3]).toMatchObject({ trigger: 'reveal' })
      // The mount + reconnect attaches are settled (LB-09 baseline).
      const attachCountBeforeRecovery = sentFreshAgentMessages('freshAgent.attach').length
      expect(attachCountBeforeRecovery).toBe(2)
      await act(async () => {
        rejectRevealSnapshot(new ApiError(409, 'Session ses_reveal is still running on the server.', {
          code: 'RESTORE_UNAVAILABLE',
          ownerKind: 'fresh-agent',
          ownerGeneration: 2,
        }))
        await vi.advanceTimersByTimeAsync(0)
      })
      // The recovery attach carries the 409's CURRENT generation...
      expect(sentFreshAgentMessages('freshAgent.attach')).toHaveLength(attachCountBeforeRecovery + 1)
      const recoveryAttach = sentFreshAgentMessages('freshAgent.attach').at(-1)
      expect(recoveryAttach?.observedEpoch).toBe(1)
      expect(recoveryAttach?.observedGeneration).toBe(2)
      // ...and the recovery refetch is REVEAL-tagged (LB-04), not manual.
      await act(async () => { await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS) })
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(3)
      expect(apiMock.getFreshAgentThreadSnapshot.mock.calls[2][3]).toMatchObject({ trigger: 'reveal' })
      // The reveal-dirty overlay is up while the recovery refresh is pending...
      expect(screen.getByRole('status', { name: 'Refreshing conversation' })).toBeInTheDocument()
      await act(async () => {
        resolveRecoverySnapshot({
          ...freshopencodeSnapshot('recovered transcript', 7),
          threadId: 'ses_reveal',
          sessionId: 'ses_reveal',
        })
        await vi.advanceTimersByTimeAsync(0)
      })
      // ...and clears when the reveal refresh lands — a 'manual' refetch would
      // leave it up forever.
      expect(screen.queryByRole('status', { name: 'Refreshing conversation' })).not.toBeInTheDocument()
      expect(screen.getByText('recovered transcript')).toBeInTheDocument()
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(3) // mount + reveal + recovery reveal
      // No spontaneous extra fetches or attaches beyond the one recovery.
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(3)
      expect(sentFreshAgentMessages('freshAgent.attach')).toHaveLength(attachCountBeforeRecovery + 1)
    } finally {
      cleanup()
      resetSnapshotSchedulerForTests()
      vi.useRealTimers()
    }
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

    expect(screen.queryByRole('radio', { name: 'GPT-6 Astra' })).not.toBeInTheDocument()
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

  /**
   * Unified agent names (Task 5): scoped fresh types (freshclaude,
   * freshcodex, freshopencode) NEVER run client-side naming — no first-send
   * finalize, no generate-title POST, no pane/tab title write, and no
   * pending-title migration on materialization/conversation switch. The
   * server's input-activity pipeline owns their fallback and AI naming, and
   * the accepted name arrives through the canonical session.name.updated
   * push. Kilroy keeps the legacy local finalize (below).
   */
  it('a scoped first send produces no client-side naming: no POST, no pane/tab title write', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-scoped-no-naming',
        status: 'creating',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    // Arm the first-message boundary the same way a real fresh conversation
    // does — through freshAgent.created — so the scoped gate is genuinely
    // exercised (not vacuously passed via a missing snapshot).
    const onMessage = wsMock.onMessage.mock.calls[0]?.[0]
    expect(onMessage).toBeTypeOf('function')
    act(() => {
      onMessage({
        type: 'freshAgent.created',
        requestId: 'req-scoped-no-naming',
        sessionId: CLAUDE_THREAD_ID,
        sessionType: 'freshclaude',
        provider: 'claude',
        runtimeProvider: 'claude',
      })
    })
    await waitFor(() => {
      expect(getFreshAgentSessionId()).toBe(CLAUDE_THREAD_ID)
    })

    wsMock.send.mockClear()
    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'Research tab naming behavior' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    const state = store.getState()
    // The pane keeps its derived default; nothing was titled client-side and
    // no generation POST fired. The send still goes out.
    expect(state.panes.paneTitles?.['tab-1']?.['pane-1']).toBe('Freshclaude')
    expect(state.tabs.tabs.find((tab) => tab.id === 'tab-1')?.title).toBe('Tab 1')
    expect(apiMock.post).not.toHaveBeenCalledWith(
      expect.stringContaining('generate-title'),
      expect.anything(),
    )
    expect(wsMock.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'freshAgent.send',
      sessionId: CLAUDE_THREAD_ID,
      text: 'Research tab naming behavior',
    }))
  })

  it('a scoped conversation switch never migrates the old conversation\'s pending title client-side', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-scoped-switch',
        sessionId: 'thread-scoped-old',
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

    wsMock.send.mockClear()
    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'Old conversation first message' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    act(() => {
      store.dispatch(updatePaneContent({
        tabId: 'tab-1',
        paneId: 'pane-1',
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshopencode',
          provider: 'opencode',
          createRequestId: 'req-scoped-switch',
          sessionId: 'thread-scoped-new',
          status: 'idle',
        },
      }))
    })
    await waitFor(() => {
      expect(getFreshAgentSessionId()).toBe('thread-scoped-new')
    })

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'New conversation first message' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    const state = store.getState()
    // Nothing was titled client-side on either side of the switch.
    expect(state.panes.paneTitles?.['tab-1']?.['pane-1']).toBe('Freshopencode')
    expect(apiMock.post).not.toHaveBeenCalledWith(
      expect.stringContaining('generate-title'),
      expect.anything(),
    )
    expect(wsMock.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'freshAgent.send',
      sessionId: 'thread-scoped-new',
      text: 'New conversation first message',
    }))
  })

  it('kilroy keeps the legacy first-message finalize (POST + local pane/tab title)', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'kilroy',
        provider: 'claude',
        createRequestId: 'req-kilroy-title',
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
        requestId: 'req-kilroy-title',
        sessionId: CLAUDE_THREAD_ID,
        sessionType: 'kilroy',
        provider: 'claude',
        runtimeProvider: 'claude',
      })
    })
    await waitFor(() => {
      expect(getFreshAgentSessionId()).toBe(CLAUDE_THREAD_ID)
    })

    wsMock.send.mockClear()
    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: 'Kilroy legacy naming message' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith(
        `/api/sessions/claude%3A${CLAUDE_THREAD_ID}/generate-title`,
        { firstMessage: 'Kilroy legacy naming message' },
      )
    })
    const state = store.getState()
    expect(state.panes.paneTitles?.['tab-1']?.['pane-1']).toBe('Kilroy legacy naming message')
    expect(state.panes.paneTitleSetByUser?.['tab-1']?.['pane-1'] ?? false).toBe(false)
    expect(wsMock.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'freshAgent.send',
      sessionId: CLAUDE_THREAD_ID,
      text: 'Kilroy legacy naming message',
    }))
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

    // The pane-content status echo mirrors the session-record gate: with an
    // unresolved same-session local echo the idle snapshot is not legal for
    // the record, and it must not clear the pane's 'running' either — the
    // two writes never disagree.
    await waitFor(() => {
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(1)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(getFreshAgentPaneContent(store).status).toBe('running')
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

    // The stale idle response must not overwrite the pane-content 'running'
    // either: the snapshot predates the newer running assertion, so the
    // pane-content echo keeps the same staleness protection the session
    // record has (the two writes never disagree).
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(getFreshAgentPaneContent(store).status).toBe('running')
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

    // The pane-content status echo now mirrors the session-record gate: an
    // idle snapshot that is not live-reconciled may not clear the pane's
    // 'running' (the freshopencode placeholder / restore-window idle default
    // would otherwise clobber a genuinely running turn) — the two writes
    // never disagree.
    await waitFor(() => {
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(1)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(getFreshAgentPaneContent(store).status).toBe('running')
    expect(store.getState().freshAgent.sessions[`freshopencode:opencode:${sessionId}`]?.status).toBe('running')
  })

  it('clears stale pane-content running once the session record itself has gone idle', async () => {
    const store = createStore()
    const sessionId = 'ses_record_idle'
    // The record went idle through the authoritative event path (the
    // server's idle broadcast); the pane-content 'running' is a stale echo,
    // and the idle REST snapshot (unauthorized for the session-record gate)
    // must still clear it — the pane-content echo agrees with the record.
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
      sessionType: 'freshopencode',
      provider: 'opencode',
      threadId: sessionId,
      sessionId,
      status: 'idle',
      revision: 212,
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
        createRequestId: 'req-record-idle',
        status: 'running',
        initialCwd: '/home/dan/code/freshell',
      },
    }))
    store.dispatch(setSessionStatus({
      sessionId,
      sessionType: 'freshopencode',
      provider: 'opencode',
      status: 'idle',
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => {
      expect(getFreshAgentPaneContent(store).status).toBe('idle')
    })
    expect(store.getState().freshAgent.sessions[`freshopencode:opencode:${sessionId}`]?.status).toBe('idle')
  })

  it('repairs a stranded pane-content running when the record clears busy after the gate refused an idle snapshot', async () => {
    const store = createStore()
    const sessionId = 'ses_stranded_echo'
    // Mid-turn idle snapshot (not live-reconciled): while the session record
    // asserts busy, the Task 4 gate refuses the pane-content status
    // adoption -- intended, and this test first proves the gate held.
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
      sessionType: 'freshopencode',
      provider: 'opencode',
      threadId: sessionId,
      sessionId,
      status: 'idle',
      revision: 213,
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
        createRequestId: 'req-stranded-echo',
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

    // The gate held: the pane-content echo stays 'running'.
    await waitFor(() => {
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(1)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(getFreshAgentPaneContent(store).status).toBe('running')

    // The turn now ends WITHOUT a snapshot-invalidating event, through a path
    // the server really sends: freshAgent.error -> sessionError drops a
    // 'running' record to idle (freshAgentSlice sessionError). None of the
    // event-shaped endings (freshAgent.error, freshAgent.exit, codex
    // stuck/exited) is in SNAPSHOT_INVALIDATING_FRESH_AGENT_EVENTS, so no new
    // snapshot fetch runs and the busy poll has torn down -- the record's
    // busy-clear edge is the only remaining authoritative signal, so the
    // stranded pane-content 'running' must be re-derived from it.
    await act(async () => {
      store.dispatch(sessionError({
        sessionId,
        sessionType: 'freshopencode',
        provider: 'opencode',
        message: 'hard error ends the turn',
      }))
    })

    await waitFor(() => {
      expect(getFreshAgentPaneContent(store).status).toBe('idle')
    })
    expect(store.getState().freshAgent.sessions[`freshopencode:opencode:${sessionId}`]?.status).toBe('idle')
  })

  it('re-derives pane-content status from the record busy→non-busy edge on freshAgent.exit (exited lands in saved pane content)', async () => {
    const store = createStore()
    const sessionId = 'ses_stranded_exited'
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
      sessionType: 'freshopencode',
      provider: 'opencode',
      threadId: sessionId,
      sessionId,
      status: 'idle',
      revision: 214,
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
        createRequestId: 'req-stranded-exited',
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
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(1)
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(getFreshAgentPaneContent(store).status).toBe('running')

    // freshAgent.exit -> sessionExited writes the record to 'exited' (a real
    // server-shaped ending with no snapshot refetch). The pane-content status
    // must re-derive to 'exited' too -- PaneContainer reads that saved value
    // for effectiveStatus after a reload.
    await act(async () => {
      store.dispatch(sessionExited({
        sessionId,
        sessionType: 'freshopencode',
        provider: 'opencode',
      }))
    })

    await waitFor(() => {
      expect(getFreshAgentPaneContent(store).status).toBe('exited')
    })
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

  it('does not title a new scoped conversation from the first message even after a stale snapshot with user turns', async () => {
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
    // Scoped: no client-side naming on either side of the switch — the stale
    // user-turn snapshot cannot suppress or fabricate a title, and the first
    // message of the new conversation never becomes one.
    expect(state.panes.paneTitles?.['tab-1']?.['pane-1']).toBe('Freshcodex')
    expect(state.tabs.tabs.find((tab) => tab.id === 'tab-1')?.title).toBe('Tab 1')
    expect(apiMock.post).not.toHaveBeenCalledWith(
      expect.stringContaining('generate-title'),
      expect.anything(),
    )
    expect(wsMock.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'freshAgent.send',
      sessionId: 'thread-stale-snapshot-new',
      text: 'New stale-safe title',
    }))
  })

  it('a late stale snapshot with user turns never titles a scoped conversation client-side', async () => {
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
    // Scoped: the stale snapshot resolving late changes nothing — no pane/tab
    // title is written and no generation POST fires.
    expect(state.panes.paneTitles?.['tab-1']?.['pane-1']).toBe('Freshclaude')
    expect(state.tabs.tabs.find((tab) => tab.id === 'tab-1')?.title).toBe('Tab 1')
    expect(apiMock.post).not.toHaveBeenCalledWith(
      expect.stringContaining('generate-title'),
      expect.anything(),
    )
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
    // The replacement conversation starts only once the durable close is
    // acknowledged (correlated close waits, focused-episode-6 round 2).
    const aliasHandlers = wsMock.onMessage.mock.calls.map(([h]) => h).filter(Boolean)
    act(() => {
      for (const handler of aliasHandlers) {
        ;(handler as (msg: unknown) => void)({
          type: 'freshAgent.killed',
          sessionId: 'thread-reset-alias',
          sessionType: 'freshcodex',
          provider: 'codex',
          success: true,
        })
      }
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
      requestId: expect.any(String),
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

  it('starts the new conversation only once the old session close is durably acknowledged', async () => {
    const handlers: Array<(msg: Record<string, unknown>) => void> = []
    wsMock.onMessage.mockReset()
    wsMock.onMessage.mockImplementation((listener: (msg: Record<string, unknown>) => void) => {
      handlers.push(listener)
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
        createRequestId: 'req-new-ack',
        sessionId: 'thread-new-ack',
        status: 'idle',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Chat message input' })).not.toBeDisabled())

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: '/new' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(wsMock.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'freshAgent.kill', sessionId: 'thread-new-ack' }),
    )
    // Ungated before: the pane stays on the OLD conversation until the close lands.
    const before = store.getState().panes.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
    expect(before.content).toMatchObject({ sessionId: 'thread-new-ack', status: 'idle' })

    for (const handler of handlers) {
      handler({
        type: 'freshAgent.killed',
        sessionId: 'thread-new-ack',
        sessionType: 'freshcodex',
        provider: 'codex',
        success: true,
      })
    }
    await waitFor(() => {
      const after = store.getState().panes.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
      expect(after.content).toMatchObject({ status: 'creating' })
      expect((after.content as { sessionId?: string }).sessionId).toBeUndefined()
    })
  })

  it('keeps the current conversation when the new-conversation close is not durably recorded', async () => {
    const handlers: Array<(msg: Record<string, unknown>) => void> = []
    wsMock.onMessage.mockReset()
    wsMock.onMessage.mockImplementation((listener: (msg: Record<string, unknown>) => void) => {
      handlers.push(listener)
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
        createRequestId: 'req-new-fail',
        sessionId: 'thread-new-fail',
        status: 'idle',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Chat message input' })).not.toBeDisabled())

    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: '/new' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    for (const handler of handlers) {
      handler({
        type: 'freshAgent.killed',
        sessionId: 'thread-new-fail',
        sessionType: 'freshcodex',
        provider: 'codex',
        success: false,
      })
    }
    await waitFor(() => {
      // The KILL_FAILED banner state is folded (close flows never drop the
      // conversation on an unrecorded close).
      expect(store.getState().freshAgent.sessions['freshcodex:codex:thread-new-fail']?.lastErrorCode).toBe('KILL_FAILED')
    })
    const after = store.getState().panes.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
    expect(after.content).toMatchObject({ sessionId: 'thread-new-fail', status: 'idle' })
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
      tabId: 'tab-1',
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
        model: 'gpt-6-astra',
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
    expect(screen.getByRole('button', { name: /GPT-6 Astra · max.*Change/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Change/ }))
    await screen.findByRole('dialog', { name: 'Model and thinking level' })
    fireEvent.click(screen.getByRole('option', { name: /GPT-5\.6 Luna/ }))

    // GPT-5.6 Luna declares the current GPT-5.6 reasoning levels in
    // canonical order.
    const levelsList = screen.getByRole('listbox', { name: 'Thinking levels for GPT-5.6 Luna' })
    const levelTexts = Array.from(levelsList.querySelectorAll('[role="option"]')).map((el) => el.textContent)
    expect(levelTexts.map((text) => text?.replace(/last used|highest|current|●/g, '').trim())).toEqual(
      ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    )

    fireEvent.click(screen.getByRole('button', { name: 'Use GPT-5.6 Luna · max' }))

    await waitFor(() => {
      const layout = store.getState().panes.layouts['tab-1']
      expect(layout?.type).toBe('leaf')
      expect(layout?.type === 'leaf' && layout.content.kind === 'fresh-agent' ? layout.content.model : null).toBe('gpt-5.6-luna')
      expect(layout?.type === 'leaf' && layout.content.kind === 'fresh-agent' ? layout.content.effort : null).toBe('max')
    })
    expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
      freshAgent: {
        providers: {
          freshcodex: {
            modelSelection: { kind: 'exact', modelId: 'gpt-5.6-luna' },
            effort: 'max',
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
        model: 'gpt-5.6-luna',
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
    fireEvent.click(screen.getByRole('button', { name: /GPT-5\.6 Luna · medium.*Change/ }))
    await screen.findByRole('dialog', { name: 'Model and thinking level' })
    const levelsList = screen.getByRole('listbox', { name: 'Thinking levels for GPT-5.6 Luna' })
    const highOption = Array.from(levelsList.querySelectorAll('[role="option"]')).find((el) => el.textContent?.includes('high'))
    expect(highOption).toBeDefined()
    fireEvent.click(highOption!)
    fireEvent.click(screen.getByRole('button', { name: 'Use GPT-5.6 Luna · high' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Permission mode' }), {
      target: { value: 'never' },
    })

    expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
      freshAgent: {
        providers: {
          freshcodex: {
            modelSelection: { kind: 'exact', modelId: 'gpt-5.6-luna' },
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
        model: 'gpt-5.6-luna',
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

  it('clears local echo when the server normalizes the submitted text (e.g. strips quoting)', async () => {
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
        threadId: 'ses_echo_normalized',
        revision: 1,
        status: 'idle',
        capabilities: { send: true, interrupt: true, fork: true },
        turns: [],
      })
      .mockResolvedValueOnce({
        sessionType: 'freshopencode',
        provider: 'opencode',
        threadId: 'ses_echo_normalized',
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
        createRequestId: 'req-echo-normalized',
        sessionId: 'ses_echo_normalized',
        sessionRef: { provider: 'opencode', sessionId: 'ses_echo_normalized' },
        resumeSessionId: 'ses_echo_normalized',
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
    // User wraps in quotes; the opencode normalizer strips them server-side
    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), {
      target: { value: '"Do the thing"' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    // The local echo shows the raw text (with quotes)
    expect(screen.getByText('"Do the thing"')).toBeInTheDocument()

    act(() => {
      wsHandler?.({
        type: 'freshAgent.event',
        sessionId: 'ses_echo_normalized',
        sessionType: 'freshopencode',
        provider: 'opencode',
        event: {
          type: 'freshAgent.session.snapshot',
          sessionId: 'ses_echo_normalized',
          status: 'running',
          latestTurnId: 'turn-real-assistant',
          revision: 2,
        },
      })
    })

    await waitFor(() => {
      expect(screen.getByText('Working')).toBeInTheDocument()
    })
    // The echo should be cleared — only the server's normalized turn should be visible
    expect(screen.getAllByText('Do the thing')).toHaveLength(1)
    expect(screen.queryByText('"Do the thing"')).not.toBeInTheDocument()
    expect(getFreshAgentPaneContent(store).pendingLocalEcho).toBeUndefined()
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
    expect(screen.queryByRole('radio', { name: 'GPT-6 Astra' })).not.toBeInTheDocument()
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

  it('does not stop the containing soul when the managed runtime already retired the fork parent', async () => {
    const store = createStore()
    let onMessage: ((message: Record<string, unknown>) => void) | undefined
    wsMock.onMessage.mockImplementation((handler) => { onMessage = handler; return () => {} })
    store.dispatch(initLayout({
      tabId: 'tab-1', paneId: 'pane-1', content: {
        kind: 'fresh-agent', sessionType: 'freshcodex', provider: 'codex',
        createRequestId: 'managed-fork-request', sessionId: 'thread-parent', status: 'idle',
      },
    }))
    render(<Provider store={store}><StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" /></Provider>)
    await waitFor(() => expect(onMessage).toBeTypeOf('function'))
    wsMock.send.mockClear()
    act(() => onMessage?.({
      type: 'freshAgent.forked', requestId: 'managed-fork-request',
      parentSessionId: 'thread-parent', sessionId: 'thread-child',
      sessionType: 'freshcodex', provider: 'codex', runtimeProvider: 'codex',
      parentRetiredByRuntime: true,
    }))
    await waitFor(() => {
      const layout = store.getState().panes.layouts['tab-1']
      if (layout?.type !== 'leaf' || layout.content.kind !== 'fresh-agent') throw new Error('expected fresh-agent pane')
      expect(layout.content.sessionId).toBe('thread-child')
    })
    expect(wsMock.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'freshAgent.kill' }))
  })

  it.each([
    ['freshclaude', 'claude', 'blocked'], ['freshclaude', 'claude', 'lost'],
    ['freshcodex', 'codex', 'blocked'], ['freshcodex', 'codex', 'lost'],
    ['freshopencode', 'opencode', 'blocked'], ['freshopencode', 'opencode', 'lost'],
  ] as const)('reloads saved %s/%s history during %s intervention without starting a runtime', async (sessionType, provider, recoveryState) => {
    const store = createStore()
    const sessionId = provider === 'claude' ? CLAUDE_THREAD_ID : 'saved-history-thread'
    const locator = { sessionId, sessionType, provider }
    store.dispatch(sessionInit(locator))
    store.dispatch(markSessionLost(locator))
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({
      status: 'idle', capabilities: { send: true, interrupt: true, fork: true },
      turns: [{ id: 'saved-turn', turnId: 'saved-turn', source: 'durable', role: 'assistant', summary: '',
        items: [{ id: 'saved-text', kind: 'text', text: 'Saved conversation before recovery' }] }],
    })
    const content = {
      kind: 'fresh-agent' as const, sessionType, provider, sessionId,
      sessionRef: { provider, sessionId }, resumeSessionId: sessionId,
      createRequestId: 'saved-history-request', status: 'stuck' as const,
      soulId: 'saved-history-soul', soulIntentRevision: 12,
      recoverySummary: {
        desiredState: 'running' as const, recoveryState, reason: 'provider_unavailable',
        durabilityState: 'resume_captured' as const, allocationState: 'verified_durable' as const,
      },
    }
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content }))
    render(<Provider store={store}><StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" /></Provider>)
    expect(await screen.findByText('Saved conversation before recovery')).toBeInTheDocument()
    expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledWith(sessionType, provider, sessionId, expect.objectContaining({ soulId: 'saved-history-soul' }))
    expect(screen.getByTestId('managed-runtime-recovery-card')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /restart sidecar and resume session/i })).not.toBeInTheDocument()
    const layout = store.getState().panes.layouts['tab-1']
    expect(layout?.type === 'leaf' && layout.content).toEqual(content)
    expect(wsMock.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: expect.stringMatching(/^freshAgent\.|^pane\.reconcile/) }))
    expect(apiMock.stopManagedRuntimeSoul).not.toHaveBeenCalled()
    expect(apiMock.retryManagedRuntimeSoul).not.toHaveBeenCalled()
  })

  it.each([
    ['freshclaude', 'claude', 'lost', savedClaudeNativeHistory],
    ['freshclaude', 'claude', 'blocked', savedClaudeNativeHistory],
    ['freshcodex', 'codex', 'lost', savedCodexNativeHistory],
    ['freshopencode', 'opencode', 'lost', savedOpenCodeNativeHistory],
  ] as const)(
    'shows actual history-only binary output on a cold %s/%s %s reload', async (sessionType, provider, recoveryState, captured) => {
      const store = createStore()
      const history = FreshAgentSnapshotSchema.parse(captured)
      apiMock.getFreshAgentThreadSnapshot.mockResolvedValue(history)
      const content = { kind: 'fresh-agent' as const, sessionType, provider, sessionId: history.threadId,
        createRequestId: 'native-reload', status: 'error' as const, soulId: 'durable-native-soul', soulIntentRevision: 7,
        recoverySummary: { desiredState: 'stopped' as const, recoveryState,
          durabilityState: 'resume_captured' as const, allocationState: 'verified_durable' as const } }
      store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content }))
      render(<Provider store={store}><StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" /></Provider>)
      expect(await screen.findByText(`Saved native ${provider === 'claude' ? 'Claude' : provider === 'codex' ? 'Codex' : 'OpenCode'} answer`)).toBeInTheDocument()
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledWith(sessionType, provider, history.threadId, expect.objectContaining({ soulId: content.soulId }))
      expect(getFreshAgentPaneContent(store)).toEqual(content)
      expect(sentFreshAgentMessages('freshAgent.create')).toHaveLength(0)
      expect(sentFreshAgentMessages('freshAgent.attach')).toHaveLength(0)
    },
  )

  it('renders persisted native Codex custom tool invocation and result after cold reload', async () => {
    const store = createStore()
    const history = FreshAgentSnapshotSchema.parse(savedCodexTools)
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue(history)
    const content = { kind: 'fresh-agent' as const, sessionType: 'freshcodex' as const, provider: 'codex' as const,
      sessionId: history.threadId, createRequestId: 'native-tools-reload', status: 'error' as const,
      soulId: 'tools-soul', soulIntentRevision: 7,
      recoverySummary: { desiredState: 'stopped' as const, recoveryState: 'lost' as const,
        durabilityState: 'resume_captured' as const, allocationState: 'verified_durable' as const } }
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content }))
    render(<Provider store={store}><StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" /></Provider>)
    fireEvent.click(await screen.findByRole('button', { name: 'Toggle activity details' }))
    const tool = await screen.findByRole('button', { name: 'apply_patch tool call' })
    expect(screen.getAllByRole('button', { name: 'apply_patch tool call' })).toHaveLength(1)
    fireEvent.click(tool)
    expect(await screen.findByText(/Patch saved/)).toBeInTheDocument()
    expect(screen.getByText(/\*\*\* Begin Patch/, { selector: 'pre' })).toBeInTheDocument()
    expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledWith('freshcodex', 'codex', history.threadId, expect.objectContaining({ soulId: content.soulId }))
    expect(getFreshAgentPaneContent(store)).toEqual(content)
    expect(sentFreshAgentMessages('freshAgent.create')).toHaveLength(0)
    expect(sentFreshAgentMessages('freshAgent.attach')).toHaveLength(0)
  })

  it.each([
    ['freshcodex', 'codex', savedCodexNativeHistory, 0],
    ['freshopencode', 'opencode', savedOpenCodeNativeHistory, 1000],
  ] as const)('uses distinct live and native revision bases across %s/%s recovery', async (sessionType, provider, captured, nativeRevision) => {
    const store = createStore()
    const native = FreshAgentSnapshotSchema.parse(captured)
    native.revision = nativeRevision
    const live = { ...native, revision: 100, extensions: { [provider]: { statusFromLiveState: true } },
      turns: [{ id: 'live-turn', turnId: 'live-turn', role: 'assistant' as const, source: 'durable' as const,
        summary: '', items: [{ id: 'live-text', kind: 'text' as const, text: 'Previously loaded live answer' }] }] }
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue(live)
    const content = { kind: 'fresh-agent' as const, sessionType, provider, sessionId: native.threadId,
      createRequestId: 'revision-source-request', status: 'idle' as const, soulId: 'revision-source-soul', soulIntentRevision: 5 }
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content }))
    render(<Provider store={store}><StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" /></Provider>)
    expect(await screen.findByText('Previously loaded live answer')).toBeInTheDocument()
    const loaded = getFreshAgentPaneContent(store)
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue(native)
    wsMock.send.mockClear()
    act(() => store.dispatch(updatePaneContent({ tabId: 'tab-1', paneId: 'pane-1', content: { ...loaded,
      recoverySummary: { desiredState: 'running', recoveryState: 'blocked', durabilityState: 'resume_captured', allocationState: 'verified_durable' } } })))
    expect(await screen.findByText(`Saved native ${provider === 'codex' ? 'Codex' : 'OpenCode'} answer`)).toBeInTheDocument()
    expect(screen.queryByText('Previously loaded live answer')).not.toBeInTheDocument()
    expect(getFreshAgentPaneContent(store).sessionId).toBe(native.threadId)
    expect(wsMock.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: expect.stringMatching(/^freshAgent\.|^pane\.reconcile/) }))
    // A resumed live read uses its own revision basis, even when below native history's.
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({ ...live, revision: 101,
      turns: [{ ...live.turns[0], items: [{ id: 'resumed-text', kind: 'text', text: 'Resumed live answer' }] }] })
    act(() => store.dispatch(updatePaneContent({ tabId: 'tab-1', paneId: 'pane-1', content: { ...loaded,
      recoverySummary: { desiredState: 'running', recoveryState: 'healthy', durabilityState: 'resume_captured', allocationState: 'verified_durable' } } })))
    expect(await screen.findByText('Resumed live answer')).toBeInTheDocument()
  })

  it.each([
    ['success', 5, 'race-soul'], ['failure', 5, 'race-soul'],
    ['success', 6, 'race-soul'], ['failure', 6, 'race-soul'],
    ['success', 5, 'replaced-race-soul'], ['failure', 5, 'replaced-race-soul'],
  ] as const)('ignores an ordinary snapshot %s after intervention history at revision %s for %s', async (outcome, currentRevision, currentSoulId) => {
    const store = createStore()
    let resolveLive!: (value: unknown) => void
    let rejectLive!: (error: Error) => void
    apiMock.getFreshAgentThreadSnapshot.mockReturnValueOnce(new Promise((resolve, reject) => { resolveLive = resolve; rejectLive = reject }))
    const native = FreshAgentSnapshotSchema.parse(savedCodexNativeHistory)
    const content = { kind: 'fresh-agent' as const, sessionType: 'freshcodex' as const, provider: 'codex' as const,
      sessionId: native.threadId, createRequestId: 'live-to-native-race', status: 'idle' as const,
      soulId: 'race-soul', soulIntentRevision: 5 }
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content }))
    render(<Provider store={store}><StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" /></Provider>)
    await waitFor(() => expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(1))
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue(native)
    const blocked = { ...content, soulId: currentSoulId, soulIntentRevision: currentRevision,
      recoverySummary: { desiredState: 'running' as const, recoveryState: 'blocked' as const,
        durabilityState: 'resume_captured' as const, allocationState: 'verified_durable' as const } }
    act(() => store.dispatch(updatePaneContent({ tabId: 'tab-1', paneId: 'pane-1', content: blocked })))
    expect(await screen.findByText('Saved native Codex answer')).toBeInTheDocument()
    const identity = getFreshAgentPaneContent(store)
    wsMock.send.mockClear()
    await act(async () => {
      if (outcome === 'failure') rejectLive(new ApiError(404, 'Old ordinary snapshot failed', { code: 'FRESH_AGENT_LOST_SESSION' }))
      else resolveLive({ ...native, revision: 999, extensions: { codex: { statusFromLiveState: true } },
        turns: [{ id: 'old-live', turnId: 'old-live', role: 'assistant', summary: '', items: [{ id: 'old-live-text', kind: 'text', text: 'Old ordinary snapshot answer' }] }] })
    })
    expect(screen.getByText('Saved native Codex answer')).toBeInTheDocument()
    expect(screen.queryByText('Old ordinary snapshot answer')).not.toBeInTheDocument()
    expect(screen.queryByText(/Old ordinary snapshot failed/)).not.toBeInTheDocument()
    expect(getFreshAgentPaneContent(store)).toEqual(identity)
    expect(wsMock.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: expect.stringMatching(/^freshAgent\.|^pane\.reconcile/) }))
  })

  it.each(['success', 'failure'] as const)('keeps an ordinary snapshot %s fenced after Retry while both current reads are pending', async (outcome) => {
    const store = createStore()
    let resolveOld!: (value: unknown) => void
    let rejectOld!: (error: Error) => void
    let resolveNative!: (value: unknown) => void
    apiMock.getFreshAgentThreadSnapshot.mockReturnValueOnce(new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject }))
    const native = FreshAgentSnapshotSchema.parse(savedCodexNativeHistory)
    const content = { kind: 'fresh-agent' as const, sessionType: 'freshcodex' as const, provider: 'codex' as const,
      sessionId: native.threadId, createRequestId: 'retry-with-old-live-read', status: 'idle' as const,
      soulId: 'retry-read-soul', soulIntentRevision: 5 }
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content }))
    render(<Provider store={store}><StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" /></Provider>)
    await waitFor(() => expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(1))
    apiMock.getFreshAgentThreadSnapshot.mockReturnValueOnce(new Promise((resolve) => { resolveNative = resolve }))
    const blocked = { ...content, recoverySummary: { desiredState: 'running' as const, recoveryState: 'blocked' as const,
      durabilityState: 'resume_captured' as const, allocationState: 'verified_durable' as const } }
    act(() => store.dispatch(updatePaneContent({ tabId: 'tab-1', paneId: 'pane-1', content: blocked })))
    await waitFor(() => expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(2))
    apiMock.getFreshAgentThreadSnapshot.mockReturnValue(new Promise(() => {}))
    apiMock.retryManagedRuntimeSoul.mockImplementation(async () => {
      store.dispatch(updatePaneContent({ tabId: 'tab-1', paneId: 'pane-1', content: { ...blocked,
        recoverySummary: { ...blocked.recoverySummary, recoveryState: 'recovering' } } }))
    })
    fireEvent.click(screen.getByRole('button', { name: 'Retry recovery' }))
    await waitFor(() => expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(3))
    const current = getFreshAgentPaneContent(store)
    wsMock.send.mockClear()
    await act(async () => {
      if (outcome === 'failure') rejectOld(new ApiError(404, 'Before-Retry ordinary read failed', { code: 'FRESH_AGENT_LOST_SESSION' }))
      else resolveOld({ ...native, revision: 999, extensions: { codex: { statusFromLiveState: true } },
        turns: [{ id: 'pre-retry', turnId: 'pre-retry', role: 'assistant', summary: '', items: [{ id: 'pre-retry-text', kind: 'text', text: 'Before-Retry ordinary answer' }] }] })
    })
    expect(screen.queryByText('Before-Retry ordinary answer')).not.toBeInTheDocument()
    expect(screen.queryByText(/Before-Retry ordinary read failed/)).not.toBeInTheDocument()
    expect(getFreshAgentPaneContent(store)).toEqual(current)
    expect(wsMock.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: expect.stringMatching(/^freshAgent\.|^pane\.reconcile/) }))
    // The initial saved-history read is still useful and has no live actor authority.
    await act(async () => resolveNative(native))
    expect(await screen.findByText('Saved native Codex answer')).toBeInTheDocument()
    expect(getFreshAgentPaneContent(store)).toEqual(current)
  })

  it('keeps saved native history through a vacant resumed read and accepts an authoritative live empty update', async () => {
    const store = createStore()
    const native = FreshAgentSnapshotSchema.parse(savedOpenCodeNativeHistory)
    native.revision = 1000
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue(native)
    const content = { kind: 'fresh-agent' as const, sessionType: 'freshopencode' as const, provider: 'opencode' as const,
      sessionId: native.threadId, sessionRef: { provider: 'opencode' as const, sessionId: native.threadId }, resumeSessionId: native.threadId,
      createRequestId: 'native-to-vacant-read', status: 'idle' as const, soulId: 'native-vacant-soul', soulIntentRevision: 5,
      recoverySummary: { desiredState: 'running' as const, recoveryState: 'blocked' as const,
        durabilityState: 'resume_captured' as const, allocationState: 'verified_durable' as const } }
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content }))
    render(<Provider store={store}><StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" /></Provider>)
    expect(await screen.findByText('Saved native OpenCode answer')).toBeInTheDocument()
    const empty = { ...native, revision: 0, latestTurnId: null, turns: [],
      extensions: { opencode: { ownerKind: 'vacant', ownerEpoch: 1, ownerGeneration: 2 } } }
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue(empty)
    const recovering = { ...content, recoverySummary: { ...content.recoverySummary, recoveryState: 'recovering' as const } }
    act(() => store.dispatch(updatePaneContent({ tabId: 'tab-1', paneId: 'pane-1', content: recovering })))
    await waitFor(() => expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(2))
    await act(async () => {})
    expect(screen.getByText('Saved native OpenCode answer')).toBeInTheDocument()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({ ...empty,
      extensions: { opencode: { statusFromLiveState: true } } })
    act(() => store.dispatch(updatePaneContent({ tabId: 'tab-1', paneId: 'pane-1', content: { ...recovering, soulIntentRevision: 6 } })))
    await waitFor(() => expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(screen.queryByText('Saved native OpenCode answer')).not.toBeInTheDocument())
    expect(getFreshAgentPaneContent(store).sessionId).toBe(native.threadId)
  })

  it('ignores initial native history after a newer resumed live snapshot has rendered', async () => {
    const store = createStore()
    let resolveNative!: (value: unknown) => void
    apiMock.getFreshAgentThreadSnapshot.mockReturnValueOnce(new Promise((resolve) => { resolveNative = resolve }))
    const native = FreshAgentSnapshotSchema.parse(savedCodexNativeHistory)
    const content = { kind: 'fresh-agent' as const, sessionType: 'freshcodex' as const, provider: 'codex' as const,
      sessionId: native.threadId, createRequestId: 'native-to-live-race', status: 'idle' as const,
      soulId: 'native-to-live-soul', soulIntentRevision: 5,
      recoverySummary: { desiredState: 'running' as const, recoveryState: 'blocked' as const,
        durabilityState: 'resume_captured' as const, allocationState: 'verified_durable' as const } }
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content }))
    render(<Provider store={store}><StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" /></Provider>)
    await waitFor(() => expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(1))
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({ ...native, revision: 101, extensions: { codex: { statusFromLiveState: true } },
      turns: [{ id: 'new-live', turnId: 'new-live', role: 'assistant', summary: '', items: [{ id: 'new-live-text', kind: 'text', text: 'New resumed live answer' }] }] })
    act(() => store.dispatch(updatePaneContent({ tabId: 'tab-1', paneId: 'pane-1', content: { ...content,
      recoverySummary: { ...content.recoverySummary, recoveryState: 'healthy' } } })))
    expect(await screen.findByText('New resumed live answer')).toBeInTheDocument()
    await act(async () => resolveNative(native))
    expect(screen.getByText('New resumed live answer')).toBeInTheDocument()
    expect(screen.queryByText('Saved native Codex answer')).not.toBeInTheDocument()
  })

  it('keeps an initial history read read-only when Retry recovery clears intervention', async () => {
    const store = createStore()
    let resolveHistory!: (result: unknown) => void
    apiMock.getFreshAgentThreadSnapshot.mockReturnValueOnce(new Promise((resolve) => { resolveHistory = resolve }))
    // Hold the resumed runtime's ordinary snapshot independently of the cold history read.
    apiMock.getFreshAgentThreadSnapshot.mockReturnValue(new Promise(() => {}))
    const content = { kind: 'fresh-agent' as const, sessionType: 'freshcodex' as const, provider: 'codex' as const,
      sessionId: savedCodexNativeHistory.threadId, createRequestId: 'retry-history-request', status: 'error' as const,
      soulId: 'retry-history-soul', soulIntentRevision: 1,
      recoverySummary: { desiredState: 'running' as const, recoveryState: 'blocked' as const,
        durabilityState: 'resume_captured' as const, allocationState: 'verified_durable' as const } }
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content }))
    apiMock.retryManagedRuntimeSoul.mockImplementation(async () => {
      store.dispatch(updatePaneContent({ tabId: 'tab-1', paneId: 'pane-1', content: { ...content,
        status: 'starting', recoverySummary: { ...content.recoverySummary, recoveryState: 'recovering' } } }))
    })
    render(<Provider store={store}><StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" /></Provider>)
    await waitFor(() => expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Retry recovery' }))
    await waitFor(() => expect(getFreshAgentPaneContent(store).status).toBe('starting'))
    await act(async () => resolveHistory(savedCodexNativeHistory))
    expect(await screen.findByText('Saved native Codex answer')).toBeInTheDocument()
    expect(getFreshAgentPaneContent(store).status).toBe('starting')
    expect(getFreshAgentPaneContent(store).resumeSessionId).toBeUndefined()
  })

  it('fences initial history against a newer same-soul intent revision', async () => {
    const store = createStore()
    let resolveOld!: (result: unknown) => void
    apiMock.getFreshAgentThreadSnapshot.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve }))
    const content = { kind: 'fresh-agent' as const, sessionType: 'freshcodex' as const, provider: 'codex' as const,
      sessionId: savedCodexNativeHistory.threadId, createRequestId: 'revision-history-request', status: 'error' as const,
      soulId: 'same-soul', soulIntentRevision: 1,
      recoverySummary: { desiredState: 'stopped' as const, recoveryState: 'lost' as const,
        durabilityState: 'resume_captured' as const, allocationState: 'verified_durable' as const } }
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content }))
    render(<Provider store={store}><StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" /></Provider>)
    await waitFor(() => expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(1))
    const next = FreshAgentSnapshotSchema.parse(savedCodexNativeHistory)
    next.turns[1].items[0] = { id: 'revision-answer', kind: 'text', text: 'Current revision history' }
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue(next)
    act(() => store.dispatch(updatePaneContent({ tabId: 'tab-1', paneId: 'pane-1', content: { ...content, soulIntentRevision: 2 } })))
    expect(await screen.findByText('Current revision history')).toBeInTheDocument()
    await act(async () => resolveOld(savedCodexNativeHistory))
    expect(screen.getByText('Current revision history')).toBeInTheDocument()
    expect(screen.queryByText('Saved native Codex answer')).not.toBeInTheDocument()
  })

  it('does not apply late history from a replaced soul with otherwise identical pane identity', async () => {
    const store = createStore()
    let resolveOld!: (result: unknown) => void
    apiMock.getFreshAgentThreadSnapshot.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve }))
    const content = { kind: 'fresh-agent' as const, sessionType: 'freshcodex' as const, provider: 'codex' as const,
      sessionId: savedCodexNativeHistory.threadId, createRequestId: 'shared-presentation', status: 'error' as const,
      soulId: 'old-soul', soulIntentRevision: 1,
      recoverySummary: { desiredState: 'stopped' as const, recoveryState: 'lost' as const,
        durabilityState: 'resume_captured' as const, allocationState: 'verified_durable' as const } }
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content }))
    render(<Provider store={store}><StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" /></Provider>)
    await waitFor(() => expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(1))
    const next = FreshAgentSnapshotSchema.parse(savedCodexNativeHistory)
    next.turns[1].items[0] = { id: 'next-answer', kind: 'text', text: 'Current soul answer' }
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue(next)
    act(() => store.dispatch(updatePaneContent({ tabId: 'tab-1', paneId: 'pane-1', content: { ...content, soulId: 'new-soul' } })))
    expect(await screen.findByText('Current soul answer')).toBeInTheDocument()
    await act(async () => resolveOld(savedCodexNativeHistory))
    expect(screen.getByText('Current soul answer')).toBeInTheDocument()
    expect(screen.queryByText('Saved native Codex answer')).not.toBeInTheDocument()
  })

  it.each(['success', 'failure'] as const)('ignores delayed managed native history %s after explicit replacement', async (outcome) => {
    const store = createStore()
    let resolveHistory!: (result: unknown) => void
    let rejectHistory!: (error: Error) => void
    apiMock.getFreshAgentThreadSnapshot.mockReturnValueOnce(new Promise((resolve, reject) => { resolveHistory = resolve; rejectHistory = reject }))
    apiMock.stopManagedRuntimeSoul.mockResolvedValue({ outcome: 'verified_empty', soul: { soulId: 'old-native-soul', intentRevision: 4 } })
    const content = { kind: 'fresh-agent' as const, sessionType: 'freshcodex' as const, provider: 'codex' as const,
      sessionId: savedCodexNativeHistory.threadId, createRequestId: 'old-native-request', status: 'error' as const,
      soulId: 'old-native-soul', soulIntentRevision: 4,
      recoverySummary: { desiredState: 'stopped' as const, recoveryState: 'lost' as const,
        durabilityState: 'resume_captured' as const, allocationState: 'verified_durable' as const } }
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content }))
    render(<Provider store={store}><StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" /></Provider>)
    await waitFor(() => expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledWith('freshcodex', 'codex', content.sessionId, expect.objectContaining({ soulId: content.soulId })))
    fireEvent.click(screen.getByRole('button', { name: 'Start new conversation' }))
    await waitFor(() => expect(getFreshAgentPaneContent(store).createRequestId).not.toBe(content.createRequestId))
    await act(async () => {
      if (outcome === 'success') resolveHistory(savedCodexNativeHistory)
      else rejectHistory(new Error('Old native helper failure'))
    })
    expect(screen.queryByText('Saved native Codex answer')).not.toBeInTheDocument()
    expect(screen.queryByText('Old native helper failure')).not.toBeInTheDocument()
    expect(getFreshAgentPaneContent(store).soulId).toBeUndefined()
    expect(getFreshAgentPaneContent(store).sessionId).toBeUndefined()
  })

  it.each([
    ['freshcodex', 'codex', 'blocked'], ['freshcodex', 'codex', 'lost'],
    ['freshopencode', 'opencode', 'blocked'], ['freshopencode', 'opencode', 'lost'],
  ] as const)('keeps loaded %s/%s turns when %s history GET returns a cold empty snapshot', async (sessionType, provider, recoveryState) => {
    const store = createStore()
    const sessionId = 'loaded-history-thread'
    // Native cold GETs stamp a vacant owner and idle/empty transcript, even
    // when the durable conversation still exists. Neither provider resumes.
    const cold = FreshAgentSnapshotSchema.parse({
      sessionType, provider, threadId: sessionId,
      ...(provider === 'opencode' ? { sessionId, latestTurnId: null } : { summary: '' }),
      revision: 0, status: 'idle',
      capabilities: { send: true, interrupt: provider === 'opencode', approvals: false, questions: false,
        fork: true, worktrees: false, diffs: provider === 'opencode', childThreads: false,
        undo: provider === 'opencode', redo: provider === 'opencode' },
      tokenUsage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0 },
      pendingApprovals: [], pendingQuestions: [], worktrees: [], diffs: [], childThreads: [], turns: [],
      extensions: { [provider]: { ownerKind: 'vacant', ownerEpoch: 1, ownerGeneration: 2 } },
    })
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({ ...cold,
      extensions: { [provider]: { statusFromLiveState: true } },
      turns: [{ id: 'loaded-turn', turnId: 'loaded-turn', source: 'durable', role: 'assistant', summary: '',
        items: [{ id: 'loaded-text', kind: 'text', text: 'Already loaded durable conversation' }] }],
    })
    const content = {
      kind: 'fresh-agent' as const, sessionType, provider, sessionId,
      sessionRef: { provider, sessionId }, resumeSessionId: sessionId, createRequestId: 'loaded-history-request',
      status: 'idle' as const, soulId: 'loaded-history-soul', soulIntentRevision: 12,
    }
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content }))
    render(<Provider store={store}><StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" /></Provider>)
    expect(await screen.findByText('Already loaded durable conversation')).toBeInTheDocument()
    let resolveCold!: (snapshot: typeof cold) => void
    apiMock.getFreshAgentThreadSnapshot.mockReturnValue(new Promise((resolve) => { resolveCold = resolve }))
    wsMock.send.mockClear()
    act(() => store.dispatch(updatePaneContent({ tabId: 'tab-1', paneId: 'pane-1', content: {
      ...content, recoverySummary: { desiredState: 'running', recoveryState, reason: 'provider_unavailable',
        durabilityState: 'resume_captured', allocationState: 'verified_durable' },
    } })))
    await waitFor(() => expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(2))
    await act(async () => resolveCold(cold))
    expect(screen.getByText('Already loaded durable conversation')).toBeInTheDocument()
    expect(screen.getByTestId('managed-runtime-recovery-card')).toBeInTheDocument()
    expect(wsMock.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: expect.stringMatching(/^freshAgent\.|^pane\.reconcile/) }))

    // A real authoritative empty update still replaces the transcript, even
    // while intervention is visible; only the cold unavailable read is kept.
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({ ...cold, revision: 1,
      extensions: { [provider]: { statusFromLiveState: true } },
    })
    act(() => store.dispatch(markSessionLost({ sessionType, provider, sessionId })))
    await waitFor(() => expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(screen.queryByText('Already loaded durable conversation')).not.toBeInTheDocument())
    expect(wsMock.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: expect.stringMatching(/^freshAgent\.|^pane\.reconcile/) }))
  })

  it('shows a lost Claude history refusal without claiming that runtime restoration is pending', async () => {
    const store = createStore()
    const locator = { sessionType: 'freshclaude' as const, provider: 'claude' as const, sessionId: CLAUDE_THREAD_ID }
    store.dispatch(sessionInit(locator))
    store.dispatch(markSessionLost(locator))
    apiMock.getFreshAgentThreadSnapshot.mockRejectedValue(new ApiError(404, 'Saved Claude transcript could not be read', {
      code: 'FRESH_AGENT_LOST_SESSION',
    }))
    const content = {
      kind: 'fresh-agent' as const, ...locator, sessionRef: { provider: locator.provider, sessionId: locator.sessionId },
      resumeSessionId: locator.sessionId, createRequestId: 'claude-history-refused', status: 'idle' as const,
      soulId: 'claude-history-soul', soulIntentRevision: 12,
      recoverySummary: { desiredState: 'stopped' as const, recoveryState: 'lost' as const, reason: 'provider_unavailable',
        durabilityState: 'resume_captured' as const, allocationState: 'verified_durable' as const },
    }
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content }))
    render(<Provider store={store}><StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" /></Provider>)
    expect(await screen.findByText(/Saved Claude transcript could not be read/)).toBeInTheDocument()
    expect(screen.queryByText('Restoring session...')).not.toBeInTheDocument()
    expect(screen.getByTestId('managed-runtime-recovery-card')).toBeInTheDocument()
    const layout = store.getState().panes.layouts['tab-1']
    expect(layout?.type === 'leaf' && layout.content).toEqual(content)
    expect(wsMock.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: expect.stringMatching(/^freshAgent\.|^pane\.reconcile/) }))
  })

  it.each(['blocked', 'lost'] as const)('keeps %s history snapshot refusal read-only', async (recoveryState) => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockRejectedValue(new ApiError(409, 'Saved history is temporarily unavailable', {
      code: 'RESTORE_UNAVAILABLE', ownerGeneration: 8, ownerKind: 'fresh-agent',
    }))
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: {
      kind: 'fresh-agent', sessionType: 'freshopencode', provider: 'opencode',
      sessionId: 'saved-refused-thread', sessionRef: { provider: 'opencode', sessionId: 'saved-refused-thread' },
      createRequestId: 'saved-refused-request', status: 'idle', soulId: 'saved-refused-soul', soulIntentRevision: 12,
      recoverySummary: { desiredState: 'running', recoveryState, reason: 'provider_unavailable', durabilityState: 'resume_captured', allocationState: 'verified_durable' },
    } }))
    render(<Provider store={store}><StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" /></Provider>)
    expect(await screen.findByText(/Saved history is temporarily unavailable/)).toBeInTheDocument()
    expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(1)
    expect(wsMock.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: expect.stringMatching(/^freshAgent\.|^pane\.reconcile/) }))
    const layout = store.getState().panes.layouts['tab-1']
    expect(layout?.type === 'leaf' && layout.content).toMatchObject({ sessionId: 'saved-refused-thread', createRequestId: 'saved-refused-request', soulIntentRevision: 12 })
  })

  it.each(['blocked', 'lost'] as const)(
    'does not re-drive a managed %s projection from the Fresh Agent .lost recovery effect',
    async (recoveryState) => {
      vi.useFakeTimers()
      try {
        const store = createStore()
        const locator = {
          sessionId: 'managed-recovery-thread',
          sessionType: 'freshcodex' as const,
          provider: 'codex' as const,
        }
        store.dispatch(sessionInit(locator))
        store.dispatch(sessionSnapshotReceived({
          ...locator,
          latestTurnId: 'turn-before-loss',
          status: 'idle',
        }))
        store.dispatch(historyPageReceived({
          ...locator,
          turns: [],
        }))
        store.dispatch(initLayout({
          tabId: 'tab-1',
          paneId: 'pane-1',
          content: {
            kind: 'fresh-agent',
            sessionType: 'freshcodex',
            provider: 'codex',
            createRequestId: 'managed-recovery-create',
            sessionId: locator.sessionId,
            sessionRef: { provider: 'codex', sessionId: locator.sessionId },
            status: 'idle',
            soulId: 'managed-soul',
            soulIntentRevision: 12,
            recoverySummary: {
              desiredState: 'running',
              recoveryState,
              reason: 'provider_unavailable',
              durabilityState: 'resume_captured',
              allocationState: 'verified_durable',
            },
          },
        }))

        render(
          <Provider store={store}>
            <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
          </Provider>,
        )

        expect(screen.getByTestId('managed-runtime-recovery-card')).toBeInTheDocument()
        wsMock.send.mockClear()

        act(() => store.dispatch(markSessionLost(locator)))
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0)
        })

        expect(sentFreshAgentMessages('freshAgent.create').filter((message) => (
          !message.sessionRef && !message.resumeSessionId
        ))).toHaveLength(0)
        expect(wsMock.send.mock.calls.some(([message]) => (
          message?.type === 'pane.reconcile.request'
        ))).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it('does not re-drive a deferred .lost callback after a managed projection arrives', async () => {
    vi.useFakeTimers()
    // Keep the callback alive through the projection update so this test
    // exercises the callback's own managed-runtime guard, not only the effect
    // guard. The callback is still driven by the real fake-timer queue below.
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {})
    try {
      const store = createStore()
      const locator = {
        sessionId: 'managed-deferred-recovery-thread',
        sessionType: 'freshcodex' as const,
        provider: 'codex' as const,
      }
      store.dispatch(sessionInit(locator))
      store.dispatch(sessionSnapshotReceived({
        ...locator,
        latestTurnId: 'turn-before-loss',
        status: 'idle',
      }))
      store.dispatch(historyPageReceived({ ...locator, turns: [] }))
      store.dispatch(initLayout({
        tabId: 'tab-1',
        paneId: 'pane-1',
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshcodex',
          provider: 'codex',
          createRequestId: 'managed-deferred-recovery-create',
          sessionId: locator.sessionId,
          sessionRef: { provider: 'codex', sessionId: locator.sessionId },
          status: 'idle',
        },
      }))

      render(
        <Provider store={store}>
          <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
        </Provider>,
      )
      wsMock.send.mockClear()

      act(() => store.dispatch(markSessionLost(locator)))
      const current = getFreshAgentPaneContent(store)
      act(() => store.dispatch(updatePaneContent({
        tabId: 'tab-1',
        paneId: 'pane-1',
        content: {
          ...current,
          soulId: 'managed-deferred-soul',
          soulIntentRevision: 13,
          recoverySummary: {
            desiredState: 'running',
            recoveryState: 'lost',
            reason: 'provider_unavailable',
            durabilityState: 'resume_captured',
            allocationState: 'verified_durable',
          },
        },
      })))

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      expect(sentFreshAgentMessages('freshAgent.create').filter((message) => (
        !message.sessionRef && !message.resumeSessionId
      ))).toHaveLength(0)
      expect(wsMock.send.mock.calls.some(([message]) => (
        message?.type === 'pane.reconcile.request'
      ))).toBe(false)
    } finally {
      clearTimeoutSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('retries a blocked managed Fresh Agent with its current soul revision and refreshes inventory', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'managed-retry-create',
        sessionId: 'managed-retry-thread',
        sessionRef: { provider: 'codex', sessionId: 'managed-retry-thread' },
        status: 'error',
        soulId: 'managed-retry-soul',
        soulIntentRevision: 19,
        recoverySummary: {
          desiredState: 'running',
          recoveryState: 'blocked',
          reason: 'provider_unavailable',
          durabilityState: 'resume_captured',
          allocationState: 'verified_durable',
        },
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Retry recovery' }))

    await waitFor(() => {
      expect(apiMock.retryManagedRuntimeSoul).toHaveBeenCalledWith('managed-retry-soul', 19)
      expect(apiMock.getManagedRuntimeInventory).toHaveBeenCalledTimes(1)
    })
  })

  it('clears prior managed retry feedback when a different Fresh Agent conversation occupies the pane', async () => {
    apiMock.retryManagedRuntimeSoul.mockRejectedValueOnce(new Error('Old conversation repair failed'))
    const store = createStore()
    const content = { kind: 'fresh-agent' as const, sessionType: 'freshcodex' as const, provider: 'codex',
      createRequestId: 'old-retry-create', status: 'error' as const, soulId: 'old-retry-soul', soulIntentRevision: 19,
      recoverySummary: { desiredState: 'running' as const, recoveryState: 'blocked' as const, reason: 'STORE_UNREADABLE',
        durabilityState: 'resume_captured' as const, allocationState: 'verified_durable' as const } }
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content }))
    render(<Provider store={store}><StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" /></Provider>)
    fireEvent.click(screen.getByRole('button', { name: 'Retry recovery' }))
    expect(await within(screen.getByTestId('managed-runtime-recovery-card')).findByRole('status')).toHaveTextContent('Old conversation repair failed')
    act(() => store.dispatch(updatePaneContent({ tabId: 'tab-1', paneId: 'pane-1', content: {
      ...content, createRequestId: 'new-retry-create', soulId: 'new-retry-soul',
    } })))
    expect(within(screen.getByTestId('managed-runtime-recovery-card')).queryByRole('status')).toBeNull()
  })

  it.each(['repair', 'reason', 'stale_result', 'stale_error', 'different_create', 'different_soul'] as const)('handles a managed Fresh Agent retry: %s', async (scenario) => {
    let resolve!: (value: unknown) => void
    let reject!: (error: Error) => void
    apiMock.retryManagedRuntimeSoul.mockReturnValueOnce(new Promise((res, rej) => { resolve = res; reject = rej }))
    const store = createStore()
    const content = { kind: 'fresh-agent' as const, sessionType: 'freshcodex' as const, provider: 'codex',
      createRequestId: 'retry-create', status: 'error' as const, soulId: 'retry-soul', soulIntentRevision: 19,
      recoverySummary: { desiredState: 'running' as const, recoveryState: 'blocked' as const, reason: 'STORE_UNREADABLE',
        durabilityState: 'resume_captured' as const, allocationState: 'verified_durable' as const } }
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content }))
    render(<Provider store={store}><StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" /></Provider>)
    const card = screen.getByTestId('managed-runtime-recovery-card')
    fireEvent.click(within(card).getByRole('button', { name: 'Retry recovery' }))
    expect(apiMock.retryManagedRuntimeSoul).toHaveBeenCalledWith('retry-soul', 19)
    const stale = scenario.startsWith('stale') || scenario.startsWith('different')
    if (stale) act(() => store.dispatch(updatePaneContent({ tabId: 'tab-1', paneId: 'pane-1', content: { ...content,
      ...(scenario === 'different_create' ? { createRequestId: 'another-create' }
        : scenario === 'different_soul' ? { soulId: 'another-soul' } : { soulIntentRevision: 20 }),
    } })))
    await act(async () => {
      if (scenario === 'stale_error') reject(new Error('Obsolete retry failure'))
      else resolve({ outcome: 'blocked', view: { soulId: 'retry-soul', intentRevision: 19, recoveryReason: 'OLD_RUNTIME_NOT_EMPTY' },
        probe: { kind: 'blocked', data: { reason: 'OLD_RUNTIME_NOT_EMPTY', retry_hint: { manualRetry: true,
          ...(scenario === 'reason' ? {} : { repair: 'Confirm the old process has stopped, then retry.' }) } } } })
    })
    if (stale) expect(within(card).queryByRole('status')).toBeNull()
    else expect(await within(card).findByRole('status')).toHaveTextContent(scenario === 'repair'
      ? 'Confirm the old process has stopped, then retry.' : 'The previous agent process could not be confirmed stopped. Check it before retrying recovery.')
  })

  const retainedBeforeStartNewSnapshot = { status: 'idle', turns: [
    { id: 'retained-turn', role: 'assistant', items: [{ id: 'retained-text', kind: 'text', text: 'Conversation retained before starting new' }] },
  ] }

  it.each([
    ['freshclaude', 'claude'], ['kilroy', 'claude'], ['freshcodex', 'codex'], ['freshopencode', 'opencode'],
  ] as const)('clears a failed close only after stopping the persisted managed soul and replacing a restored %s conversation', async (sessionType, provider) => {
    const store = createStore()
    let resolveStop!: (result: unknown) => void
    apiMock.stopManagedRuntimeSoul.mockReturnValueOnce(new Promise((resolve) => { resolveStop = resolve }))
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue(retainedBeforeStartNewSnapshot)
    const content = {
      kind: 'fresh-agent' as const, sessionType, provider, createRequestId: 'lost-restored-create',
      sessionRef: { provider, sessionId: CLAUDE_RESTORE_THREAD_ID }, status: 'error' as const,
      soulId: 'persisted-lost-soul', soulIntentRevision: 17,
      closeError: 'Previous close was not confirmed',
      recoverySummary: { desiredState: 'stopped' as const, recoveryState: 'lost' as const,
        durabilityState: 'resume_captured' as const, allocationState: 'verified_durable' as const },
    }
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content }))
    render(<Provider store={store}><StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" /></Provider>)
    expect(await screen.findByText('Conversation retained before starting new')).toBeInTheDocument()
    expect(screen.getByText('Close failed: Previous close was not confirmed')).toBeInTheDocument()
    wsMock.send.mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Start new conversation' }))
    await waitFor(() => expect(apiMock.stopManagedRuntimeSoul).toHaveBeenCalledWith('persisted-lost-soul', 17))
    expect(getFreshAgentPaneContent(store)).toMatchObject(content)
    expect(screen.getByText('Close failed: Previous close was not confirmed')).toBeInTheDocument()
    expect(screen.getByText('Conversation retained before starting new')).toBeInTheDocument()
    expect(sentFreshAgentMessages('freshAgent.kill')).toHaveLength(0)
    expect(sentFreshAgentMessages('freshAgent.create')).toHaveLength(0)
    await act(async () => resolveStop({ outcome: 'verified_empty', soul: { soulId: 'persisted-lost-soul', intentRevision: 17 } }))
    await waitFor(() => expect(getFreshAgentPaneContent(store).createRequestId).not.toBe(content.createRequestId))
    expect(getFreshAgentPaneContent(store).soulId).toBeUndefined()
    expect(getFreshAgentPaneContent(store).sessionRef).toBeUndefined()
    expect(getFreshAgentPaneContent(store).closeError).toBeUndefined()
    expect(screen.queryByText('Close failed: Previous close was not confirmed')).toBeNull()
  })

  it.each(['termination_unconfirmed', 'blocked_ownership', 'backend_unavailable', 'http_failure', 'missing_revision', 'missing_soul'])(
    'retains a lost managed Fresh Agent and reports %s cleanup inline', async (outcome) => {
      const store = createStore()
      apiMock.getFreshAgentThreadSnapshot.mockResolvedValue(retainedBeforeStartNewSnapshot)
      if (outcome === 'http_failure') apiMock.stopManagedRuntimeSoul.mockRejectedValueOnce(new Error('Server is unavailable'))
      else apiMock.stopManagedRuntimeSoul.mockResolvedValueOnce({ outcome, soul: { soulId: 'lost-soul', intentRevision: 9 } })
      const content = {
        kind: 'fresh-agent' as const, sessionType: 'freshcodex' as const, provider: 'codex' as const,
        createRequestId: 'lost-create', sessionId: 'lost-thread',
        sessionRef: { provider: 'codex' as const, sessionId: 'lost-thread' }, status: 'error' as const,
        soulId: outcome === 'missing_soul' ? undefined : 'lost-soul',
        soulIntentRevision: outcome === 'missing_revision' ? undefined : 9,
        closeError: 'Previous close was not confirmed',
        recoverySummary: { desiredState: 'stopped' as const, recoveryState: 'lost' as const,
          durabilityState: 'resume_captured' as const, allocationState: 'verified_durable' as const },
      }
      // Without a soul there is no native-history route. Load the existing
      // conversation before its managed projection loses that identity.
      store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: {
        ...content, ...(outcome === 'missing_soul' ? { recoverySummary: undefined } : {}),
      } }))
      render(<Provider store={store}><StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" /></Provider>)
      expect(await screen.findByText('Conversation retained before starting new')).toBeInTheDocument()
      if (outcome === 'missing_soul') act(() => store.dispatch(updatePaneContent({ tabId: 'tab-1', paneId: 'pane-1', content })))
      expect(screen.getByText('Close failed: Previous close was not confirmed')).toBeInTheDocument()
      const retained = getFreshAgentPaneContent(store)
      wsMock.send.mockClear()
      fireEvent.click(screen.getByRole('button', { name: 'Start new conversation' }))
      expect(await screen.findByRole('status')).toHaveTextContent(outcome === 'http_failure' ? 'Server is unavailable' : 'Your conversation has been kept')
      expect(getFreshAgentPaneContent(store)).toMatchObject(retained)
      expect(screen.getByText('Close failed: Previous close was not confirmed')).toBeInTheDocument()
      expect(screen.getByText('Conversation retained before starting new')).toBeInTheDocument()
      expect(sentFreshAgentMessages('freshAgent.kill')).toHaveLength(0)
      expect(sentFreshAgentMessages('freshAgent.create')).toHaveLength(0)
    },
  )

  it.each(['verified_empty', 'termination_unconfirmed', 'http_failure'])('does not alter a different Fresh Agent pane after a late %s stop result', async (outcome) => {
    const store = createStore()
    let resolveStop!: (result: unknown) => void
    let rejectStop!: (error: Error) => void
    apiMock.stopManagedRuntimeSoul.mockReturnValueOnce(new Promise((resolve, reject) => { resolveStop = resolve; rejectStop = reject }))
    const content = {
      kind: 'fresh-agent' as const, sessionType: 'freshcodex' as const, provider: 'codex' as const,
      createRequestId: 'old-lost-create', sessionRef: { provider: 'codex' as const, sessionId: 'old-thread' },
      status: 'error' as const, soulId: 'old-soul', soulIntentRevision: 11,
      recoverySummary: { desiredState: 'stopped' as const, recoveryState: 'lost' as const,
        durabilityState: 'resume_captured' as const, allocationState: 'verified_durable' as const },
    }
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content }))
    render(<Provider store={store}><StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" /></Provider>)
    fireEvent.click(screen.getByRole('button', { name: 'Start new conversation' }))
    await waitFor(() => expect(apiMock.stopManagedRuntimeSoul).toHaveBeenCalledWith('old-soul', 11))
    const replacement = { ...content, createRequestId: 'different-create', soulId: 'different-soul',
      sessionRef: { provider: 'codex' as const, sessionId: 'different-thread' } }
    act(() => store.dispatch(updatePaneContent({ tabId: 'tab-1', paneId: 'pane-1', content: replacement })))
    await act(async () => {
      if (outcome === 'http_failure') rejectStop(new Error('Stale request failed'))
      else resolveStop({ outcome, soul: { soulId: 'old-soul', intentRevision: 12 } })
    })
    expect(getFreshAgentPaneContent(store)).toMatchObject(replacement)
    expect(within(screen.getByTestId('managed-runtime-recovery-card')).queryByRole('status')).toBeNull()
  })

  it.each(['newer_pane', 'older_result', 'wrong_soul'])('does not replace Fresh Agent authority after a %s stop response', async (scenario) => {
    const store = createStore()
    let resolveStop!: (value: unknown) => void
    apiMock.stopManagedRuntimeSoul.mockReturnValueOnce(new Promise((resolve) => { resolveStop = resolve }))
    const content = {
      kind: 'fresh-agent' as const, sessionType: 'freshcodex' as const, provider: 'codex' as const,
      createRequestId: 'same-create', status: 'error' as const, soulId: 'same-soul', soulIntentRevision: 21,
      sessionRef: { provider: 'codex' as const, sessionId: 'retained-thread' },
      recoverySummary: { desiredState: 'stopped' as const, recoveryState: 'lost' as const,
        durabilityState: 'resume_captured' as const, allocationState: 'verified_durable' as const },
    }
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content }))
    render(<Provider store={store}><StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" /></Provider>)
    fireEvent.click(screen.getByRole('button', { name: 'Start new conversation' }))
    if (scenario === 'newer_pane') act(() => store.dispatch(updatePaneContent({ tabId: 'tab-1', paneId: 'pane-1', content: { ...content, soulIntentRevision: 24 } })))
    await act(async () => resolveStop({ outcome: 'verified_empty', soul: {
      soulId: scenario === 'wrong_soul' ? 'different-soul' : 'same-soul', intentRevision: scenario === 'older_result' ? 20 : 22,
    } }))
    expect(getFreshAgentPaneContent(store)).toMatchObject({ ...content, soulIntentRevision: scenario === 'newer_pane' ? 24 : 21 })
    const card = screen.getByTestId('managed-runtime-recovery-card')
    if (scenario === 'newer_pane') expect(within(card).queryByRole('status')).toBeNull()
    else expect(await within(card).findByRole('status')).toHaveTextContent('Your conversation has been kept')
  })

  it('immediately retries a running managed Fresh Agent using the committed stop revision', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({ status: 'stuck', turns: [] })
    let serverRevision = 17
    let running = true
    apiMock.stopManagedRuntimeSoul.mockImplementation((_soulId: string, revision: number) => {
      if (revision !== serverRevision) return Promise.reject(new Error('Stale intent revision'))
      if (running) {
        running = false
        serverRevision += 1
        return Promise.resolve({ outcome: 'backend_unavailable', soul: { soulId: 'running-fresh-soul', intentRevision: serverRevision } })
      }
      return Promise.resolve({ outcome: 'verified_empty', soul: { soulId: 'running-fresh-soul', intentRevision: serverRevision } })
    })
    const content = {
      kind: 'fresh-agent' as const, sessionType: 'freshcodex' as const, provider: 'codex' as const,
      createRequestId: 'running-stuck-create', sessionRef: { provider: 'codex' as const, sessionId: 'retained-thread' },
      status: 'stuck' as const, soulId: 'running-fresh-soul', soulIntentRevision: 17,
    }
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content }))
    render(<Provider store={store}><StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" /></Provider>)
    fireEvent.click(screen.getByRole('button', { name: 'Start new conversation' }))
    expect(await screen.findByText(/Cleanup could not be confirmed/)).toBeInTheDocument()
    expect(getFreshAgentPaneContent(store)).toMatchObject({ ...content, soulIntentRevision: 18 })
    fireEvent.click(screen.getByRole('button', { name: 'Start new conversation' }))
    await waitFor(() => expect(apiMock.stopManagedRuntimeSoul).toHaveBeenNthCalledWith(2, 'running-fresh-soul', 18))
    await waitFor(() => expect(getFreshAgentPaneContent(store).createRequestId).not.toBe(content.createRequestId))
  })

  it('follows a managed same-soul fork even when another view issued the request', async () => {
    const store = createStore()
    let onMessage: ((message: Record<string, unknown>) => void) | undefined
    wsMock.onMessage.mockImplementation((handler) => { onMessage = handler; return () => {} })
    store.dispatch(initLayout({
      tabId: 'tab-1', paneId: 'pane-1', content: {
        kind: 'fresh-agent', sessionType: 'freshcodex', provider: 'codex',
        createRequestId: 'this-view-request', sessionId: 'thread-parent', status: 'idle',
      },
    }))
    render(<Provider store={store}><StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" /></Provider>)
    await waitFor(() => expect(onMessage).toBeTypeOf('function'))
    wsMock.send.mockClear()
    act(() => onMessage?.({
      type: 'freshAgent.forked', requestId: 'other-view-request',
      parentSessionId: 'thread-parent', sessionId: 'thread-child',
      sessionType: 'freshcodex', provider: 'codex', runtimeProvider: 'codex',
      parentRetiredByRuntime: true,
    }))
    await waitFor(() => {
      const layout = store.getState().panes.layouts['tab-1']
      if (layout?.type !== 'leaf' || layout.content.kind !== 'fresh-agent') throw new Error('expected fresh-agent pane')
      expect(layout.content.sessionId).toBe('thread-child')
    })
    expect(wsMock.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'freshAgent.kill' }))
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
      model: 'gpt-6-astra',
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

  it('resumes an exited Codex pane without closing its durable conversation', async () => {
    const store = createStore()
    store.dispatch(sessionInit({
      sessionId: 'codex-thread-exited',
      sessionType: 'freshcodex',
      provider: 'codex',
      model: 'gpt-6-astra',
    }))
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-codex-exited',
        sessionId: 'codex-thread-exited',
        sessionRef: { provider: 'codex', sessionId: 'codex-thread-exited' },
        status: 'idle',
      },
    }))
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )
    await waitFor(() => expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalled())
    act(() => {
      store.dispatch(sessionExited({
        sessionId: 'codex-thread-exited',
        sessionType: 'freshcodex',
        provider: 'codex',
      }))
    })

    expect(await screen.findByRole('button', { name: 'Start new session' })).toBeVisible()
    wsMock.send.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Resume session' }))

    await waitFor(() => {
      const pane = getFreshAgentPaneContent(store)
      expect(pane.status).toBe('creating')
      expect(pane.sessionId).toBeUndefined()
      expect(pane.sessionRef).toEqual({ provider: 'codex', sessionId: 'codex-thread-exited' })
      expect(pane.resumeSessionId).toBe('codex-thread-exited')
    })
    expect(wsMock.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'freshAgent.kill' }))
    expect(wsMock.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'freshAgent.recovery.stop' }))
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

    it('does NOT re-focus the composer after a remount that lacked focus ownership (agent split while user is in app chrome)', async () => {
      const store = createStore()
      const content = {
        kind: 'fresh-agent' as const,
        sessionType: 'freshcodex' as const,
        provider: 'codex' as const,
        createRequestId: 'req-remount-gate',
        sessionId: 'thread-remount-gate',
        status: 'idle' as const,
      }
      const first = render(
        <Provider store={store}>
          <FreshAgentView tabId="tab-1" paneId="pane-1" paneContent={content} />
        </Provider>,
      )
      const textbox = await screen.findByRole('textbox', { name: 'Chat message input' }) as HTMLTextAreaElement
      await waitFor(() => expect(textbox).not.toBeDisabled())
      act(() => {
        store.dispatch(setActivePane({ tabId: 'tab-1', paneId: 'pane-1' }))
      })
      await waitFor(() => expect(document.activeElement).toBe(textbox))
      // User moved into application chrome without changing activePane…
      const chrome = document.createElement('input')
      document.body.appendChild(chrome)
      chrome.focus()
      // …then a leaf→split remount destroys and recreates this subtree.
      first.unmount()
      render(
        <Provider store={store}>
          <FreshAgentView tabId="tab-1" paneId="pane-1" paneContent={content} />
        </Provider>,
      )
      const textbox2 = await screen.findByRole('textbox', { name: 'Chat message input' }) as HTMLTextAreaElement
      await waitFor(() => expect(textbox2).not.toBeDisabled())
      await flushFrames()
      expect(document.activeElement).toBe(chrome)
    })

    it('re-focuses the composer when the ALREADY-active pane is explicitly re-selected (same-target select / focus epoch bump)', async () => {
      const store = createStore()
      const content = {
        kind: 'fresh-agent' as const,
        sessionType: 'freshcodex' as const,
        provider: 'codex' as const,
        createRequestId: 'req-epoch-reselect',
        sessionId: 'thread-epoch-reselect',
        status: 'idle' as const,
      }
      const first = render(
        <Provider store={store}>
          <FreshAgentView tabId="tab-1" paneId="pane-1" paneContent={content} />
        </Provider>,
      )
      const textbox = await screen.findByRole('textbox', { name: 'Chat message input' }) as HTMLTextAreaElement
      await waitFor(() => expect(textbox).not.toBeDisabled())
      act(() => {
        store.dispatch(setActivePane({ tabId: 'tab-1', paneId: 'pane-1' }))
      })
      await waitFor(() => expect(document.activeElement).toBe(textbox))
      const chrome = document.createElement('input')
      document.body.appendChild(chrome)
      chrome.focus()
      first.unmount()
      const second = render(
        <Provider store={store}>
          <FreshAgentView tabId="tab-1" paneId="pane-1" paneContent={content} />
        </Provider>,
      )
      const textbox2 = await screen.findByRole('textbox', { name: 'Chat message input' }) as HTMLTextAreaElement
      await waitFor(() => expect(textbox2).not.toBeDisabled())
      await flushFrames()
      expect(document.activeElement).toBe(chrome) // denied adoption
      // Same-target select: no eligibility transition exists, so the focus
      // epoch bump is the only signal that can legitimately move DOM focus.
      // PaneContainer forwards the bumped epoch — simulate that hand-off via
      // the prop (the fold→epoch-bump wiring is covered in ui-commands and
      // panesSlice tests; e2e §6b covers the full path).
      second.rerender(
        <Provider store={store}>
          <FreshAgentView tabId="tab-1" paneId="pane-1" paneContent={content} focusEpoch={1} />
        </Provider>,
      )
      await flushFrames()
      await waitFor(() => expect(document.activeElement).toBe(textbox2))
    })
  })

  describe('click-to-defocus transcript focus (c1fa)', () => {
    async function setupActivePane() {
      const store = createStore()
      apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
        status: 'idle',
        capabilities: { send: true, interrupt: true, fork: false },
        turns: [
          { id: 'turn-c1fa-0', role: 'user', items: [{ id: 'item-c1fa-0', kind: 'text', text: 'User message c1fa' }] },
          { id: 'turn-c1fa-1', role: 'assistant', items: [{ id: 'item-c1fa-1', kind: 'text', text: 'Assistant reply c1fa' }] },
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
              createRequestId: 'req-c1fa',
              sessionId: 'thread-c1fa',
              status: 'idle',
            }}
          />
        </Provider>,
      )
      await waitFor(() => expect(screen.getByText('Assistant reply c1fa')).toBeInTheDocument())
      const root = document.querySelector('[data-context="fresh-agent"]') as HTMLElement
      const scroller = document.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
      const textbox = screen.getByRole('textbox', { name: 'Chat message input' }) as HTMLTextAreaElement
      // Activate the pane so the activation effect has fired and focused the composer.
      await act(async () => {
        store.dispatch(setActivePane({ tabId: 'tab-1', paneId: 'pane-1' }))
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      })
      await waitFor(() => expect(document.activeElement).toBe(textbox))
      Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 200 })
      Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 1000 })
      scroller.scrollTop = 500
      fireEvent.scroll(scroller)
      return { store, root, scroller, textbox }
    }

    it('makes the transcript scroll container click-focusable (tabindex="-1")', async () => {
      const { scroller } = await setupActivePane()
      expect(scroller.getAttribute('tabindex')).toBe('-1')
      scroller.focus()
      expect(document.activeElement).toBe(scroller)
    })

    it('does not force-focus the composer on pointer-up in the transcript region', async () => {
      const { root, textbox } = await setupActivePane()
      // Move focus to the pane root (already tabIndex={-1}) to simulate the user
      // having clicked a non-composer region.
      root.focus()
      expect(document.activeElement).toBe(root)
      const focusSpy = vi.spyOn(textbox, 'focus')
      fireEvent.pointerUp(root)
      // The removed handler deferred composerRef.focus() in a requestAnimationFrame;
      // flush the frame so a red run (handler still present) actually calls the
      // spy and fails, instead of passing vacuously before the rAF fires.
      await act(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      })
      expect(focusSpy).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(root)
    })

    it('lets nav keys scroll the transcript once the transcript holds focus', async () => {
      const { scroller } = await setupActivePane()
      scroller.focus()
      expect(document.activeElement).toBe(scroller)
      const event = createEvent.keyDown(scroller, { key: 'PageDown' })
      fireEvent(scroller, event)
      expect(event.defaultPrevented).toBe(true)
      expect(scroller.scrollTop).toBe(660)
    })

    it('still funnels plain-text keys to the composer and re-focuses it', async () => {
      const { scroller, textbox } = await setupActivePane()
      scroller.focus()
      expect(document.activeElement).toBe(scroller)
      fireEvent(scroller, createEvent.keyDown(scroller, { key: 'h' }))
      expect(textbox.value).toBe('h')
      // appendText schedules textareaRef.focus() on the next animation frame;
      // flush it and assert focus returns to the composer (the load-bearing
      // refocus, assumption L3), so a regression that broke refocus would fail.
      await act(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      })
      expect(document.activeElement).toBe(textbox)
    })

    it('still focuses the composer when the pane is (re)activated after a transcript click', async () => {
      const { store, scroller, textbox } = await setupActivePane()
      // Simulate the user clicking the transcript (focus moves off the composer).
      scroller.focus()
      expect(document.activeElement).toBe(scroller)
      const focusSpy = vi.spyOn(textbox, 'focus')
      // Switch away and back — pane (re)activation must refocus the composer.
      act(() => {
        store.dispatch(setActivePane({ tabId: 'tab-1', paneId: 'pane-other' }))
      })
      act(() => {
        store.dispatch(setActivePane({ tabId: 'tab-1', paneId: 'pane-1' }))
      })
      await act(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      })
      expect(focusSpy).toHaveBeenCalled()
      expect(document.activeElement).toBe(textbox)
    })
  })
})

describe('freshcodex wedged-sidecar notice', () => {
  // Same store-backed render shape as the 'composer focus on pane activation
  // (0bc6)' harness above: a mounted freshcodex pane whose live status flows
  // from the freshAgent slice (the stuck card reads the store status, not the
  // persisted pane content).
  function renderFocusPane(options?: { sessionId?: string; status?: string }) {
    const store = createStore()
    const sessionId = options && 'sessionId' in options ? options.sessionId : 'thread-stuck-1'
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

  function dispatchStuck(store: ReturnType<typeof createStore>) {
    act(() => {
      store.dispatch(setSessionStatus({
        sessionId: 'thread-stuck-1', sessionType: 'freshcodex', provider: 'codex', status: 'stuck',
      }))
    })
  }

  it('renders the stuck notice with restart and start-new actions', async () => {
    const { store } = renderFocusPane({ sessionId: 'thread-stuck-1', status: 'running' })
    dispatchStuck(store)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/appears stuck/i)
    expect(screen.getByRole('button', { name: /restart sidecar and resume session/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /start new conversation/i })).toBeInTheDocument()
  })

  it('Restart sidecar confirms the process stop before resuming the same durable thread', async () => {
    const handlers: Array<(message: Record<string, unknown>) => void> = []
    wsMock.onMessage.mockReset()
    wsMock.onMessage.mockImplementation((handler: (message: Record<string, unknown>) => void) => {
      handlers.push(handler)
      return () => {}
    })
    const { store } = renderFocusPane({ sessionId: 'thread-stuck-1', status: 'running' })
    // Install the spy BEFORE the stuck fold re-renders: the click closure
    // captures `dispatch` at render time (react-redux useDispatch), so a spy
    // installed after the last render would observe nothing.
    const dispatchSpy = vi.spyOn(store, 'dispatch')
    dispatchStuck(store)
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: /restart sidecar and resume session/i }))
    const sent = wsMock.send.mock.calls.find(([message]) => message.type === 'freshAgent.recovery.stop')?.[0]
    expect(sent).toMatchObject({
      sessionId: 'thread-stuck-1',
      sessionType: 'freshcodex',
      provider: 'codex',
    })
    const creatingActions = () => dispatchSpy.mock.calls
      .map(([action]) => action)
      .filter((action: any) => action?.type === 'panes/updatePaneContent'
        && action.payload?.content?.status === 'creating')
    expect(creatingActions()).toHaveLength(0)
    for (const handler of handlers) handler({
      type: 'freshAgent.recovery.stopped',
      requestId: sent.requestId,
      sessionId: 'thread-stuck-1',
      sessionType: 'freshcodex',
      provider: 'codex',
      success: true,
    })
    await waitFor(() => expect(creatingActions()).toHaveLength(1))
    const remints = creatingActions()
    expect(remints).toHaveLength(1)
    expect(remints[0].payload.content.resumeSessionId).toBe('thread-stuck-1')
    expect(remints[0].payload.content.sessionId).toBeUndefined()
    expect(remints[0].payload.content.createRequestId).not.toBe('req-focus-0bc6')
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
    // Wall-clock debounce plus waitFor's 1s deadline races CPU contention
    // under parallel suites (the 429 sibling's note): advance the actual
    // scheduler/React timers deterministically.
    vi.useFakeTimers()
    try {
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
      // Let the identity fetches (immediate + trailing coalesce for the
      // sibling) fully settle before measuring the burst.
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(screen.getAllByText('done').length).toBeGreaterThan(0)
      apiMock.getFreshAgentThreadSnapshot.mockClear()

      for (let i = 0; i < 10; i += 1) {
        broadcast(sessionChanged())
      }

      // Exactly one trailing GET shared by both panes, not one per event/pane.
      await act(async () => { await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS) })
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(1)
      // A further full window stays silent: the burst coalesced into that one
      // trailing GET.
      await act(async () => { await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS) })
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the last good snapshot visible and stops fetching during 429 backoff', async () => {
    // Wall-clock debounce plus waitFor's 1s deadline races CPU contention in
    // cloud shards. Advance the actual scheduler/React timers deterministically.
    vi.useFakeTimers()
    try {
      const store = createStore()
      const broadcast = captureWsBroadcast()
      apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce(freshopencodeSnapshot('hello world', 10))

      store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: schedulerPaneContent('req-sched-429') }))
      render(
        <Provider store={store}>
          <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
        </Provider>,
      )
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(screen.getByText('hello world')).toBeInTheDocument()
      apiMock.getFreshAgentThreadSnapshot.mockRejectedValue(new ApiError(429, 'Too many requests', undefined, 60_000))

      broadcast(sessionChanged())
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(SNAPSHOT_DEBOUNCE_MS) })
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(2)
      // Last good transcript stays visible; no load-error banner.
      expect(screen.getByText('hello world')).toBeInTheDocument()
      expect(screen.queryByText(/Too many requests/)).not.toBeInTheDocument()

      // Invalidations stay suppressed throughout Retry-After, then the view's
      // automatic retry refreshes the transcript once backoff has elapsed.
      broadcast(sessionChanged())
      await act(async () => { await vi.advanceTimersByTimeAsync(59_999) })
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(2)
      expect(screen.getByText('hello world')).toBeInTheDocument()
      apiMock.getFreshAgentThreadSnapshot.mockResolvedValue(freshopencodeSnapshot('recovered transcript', 11))
      await act(async () => { await vi.advanceTimersByTimeAsync(51) })
      expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(3)
      expect(screen.getByText('recovered transcript')).toBeInTheDocument()
    } finally {
      cleanup()
      resetSnapshotSchedulerForTests()
      vi.useRealTimers()
    }
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
        model: 'gpt-6-astra',
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

describe('/undo + /redo dispatch (kata 1wxv)', () => {
  function rollbackCapableSnapshot(overrides: Record<string, unknown> = {}) {
    return {
      status: 'idle',
      summary: 'rollback capable',
      capabilities: { send: true, interrupt: true, fork: true, undo: true, redo: true },
      rollback: { canRedo: true, undoneDepth: 1 },
      rolledBackTurns: [
        { id: 'u9', turnId: 'u9', role: 'user', summary: 'rolled prompt', items: [{ id: 'u9-i', kind: 'text', text: 'rolled prompt' }], rolledBack: true },
      ],
      turns: [
        { id: 'u1', turnId: 'u1', role: 'user', summary: 'first prompt', items: [{ id: 'u1-i', kind: 'text', text: 'first prompt' }] },
        { id: 'a1', turnId: 'a1', role: 'assistant', summary: 'first answer', items: [{ id: 'a1-i', kind: 'text', text: 'first answer' }] },
      ],
      ...overrides,
    }
  }

  function initOpencodePane(store: ReturnType<typeof createStore>, { sessionId = 'ses_rollback', status = 'idle' } = {}) {
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-rollback',
        sessionId,
        initialCwd: '/repo/route-aware',
        status,
      },
    }))
  }

  function getComposer() {
    return screen.getByRole('textbox', { name: 'Chat message input' }) as HTMLTextAreaElement
  }

  it('/undo sends the frozen freshAgent.undo frame when idle and capable', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue(rollbackCapableSnapshot())
    initOpencodePane(store)
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )
    await waitFor(() => expect(screen.getByText('first answer')).toBeInTheDocument())
    wsMock.send.mockClear()

    fireEvent.change(getComposer(), { target: { value: '/undo' } })
    fireEvent.keyDown(getComposer(), { key: 'Enter' })

    // The frame goes out; the model NEVER receives '/undo' as text.
    expect(sentFreshAgentMessages('freshAgent.send')).toEqual([])
    const frame = sentFreshAgentMessages('freshAgent.undo').at(-1)
    expect(frame).toMatchObject({
      type: 'freshAgent.undo',
      sessionId: 'ses_rollback',
      sessionType: 'freshopencode',
      provider: 'opencode',
      mode: 'step',
      cwd: '/repo/route-aware',
    })
    expect(frame?.requestId).toEqual(expect.any(String))
  })

  it('/undo mid-turn writes nothing and shows the direction-aware busy UNDO notice verbatim', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue(rollbackCapableSnapshot({ status: 'running' }))
    initOpencodePane(store, { status: 'running' })
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )
    await waitFor(() => expect(screen.getByText('first answer')).toBeInTheDocument())
    wsMock.send.mockClear()

    fireEvent.change(getComposer(), { target: { value: '/undo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(sentFreshAgentMessages('freshAgent.undo')).toEqual([])
    expect(screen.getByText(ROLLBACK_BUSY_UNDO_NOTICE)).toBeInTheDocument()
  })

  it('/redo mid-turn writes nothing and shows the direction-aware busy REDO notice verbatim', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue(rollbackCapableSnapshot({ status: 'running' }))
    initOpencodePane(store, { status: 'running' })
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )
    await waitFor(() => expect(screen.getByText('first answer')).toBeInTheDocument())
    wsMock.send.mockClear()

    fireEvent.change(getComposer(), { target: { value: '/redo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(sentFreshAgentMessages('freshAgent.redo')).toEqual([])
    expect(screen.getByText(ROLLBACK_BUSY_REDO_NOTICE)).toBeInTheDocument()
  })

  it('typed /undo on a capability-false pane rolls to the pinned unsupported notice and sends nothing', async () => {
    const store = createStore()
    // No undo/redo stamps: a legacy server (or capability-false provider) surface.
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({
      status: 'idle',
      summary: 'legacy caps',
      capabilities: { send: true, interrupt: true, fork: true },
      turns: [
        { id: 'u1', turnId: 'u1', role: 'user', summary: 'first prompt', items: [{ id: 'u1-i', kind: 'text', text: 'first prompt' }] },
        { id: 'a1', turnId: 'a1', role: 'assistant', summary: 'first answer', items: [{ id: 'a1-i', kind: 'text', text: 'first answer' }] },
      ],
    })
    initOpencodePane(store)
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )
    await waitFor(() => expect(screen.getByText('first answer')).toBeInTheDocument())
    wsMock.send.mockClear()

    fireEvent.change(getComposer(), { target: { value: '/undo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(sentFreshAgentMessages('freshAgent.undo')).toEqual([])
    expect(screen.getByText(rollbackUnsupportedNotice('Freshopencode'))).toBeInTheDocument()
  })

  it('the freshcodex slash menu offers /undo but NEVER a /redo entry (codex is undo-only)', async () => {
    const store = createStore()
    // The freshcodex server shape: undo stamped (paginated thread), redo never.
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({
      status: 'idle',
      summary: 'Codex summary',
      capabilities: { send: true, interrupt: true, fork: true, undo: true, redo: false },
      turns: [{ id: 'turn-1', role: 'assistant', items: [{ id: 'item-1', kind: 'text', text: 'Codex turn' }] }],
    })
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-rb-codex-menu',
        sessionId: 'thread-rb-codex-menu',
        status: 'idle',
      },
    }))
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )
    await waitFor(() => expect(screen.getByText('Codex turn')).toBeInTheDocument())
    // The snapshot's turn text rendering IS the proof the capability stamps landed
    // (the transcript reads the committed snapshot state), so the menu consult is
    // deterministic without retries.
    fireEvent.click(screen.getByRole('button', { name: 'Slash commands' }))

    expect(screen.getByRole('menuitem', { name: /\/undo/ })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /\/redo/ })).not.toBeInTheDocument()
  })

  it('delta-r1 F7: the slash menu hides /undo and /redo on a capability-false (legacy) snapshot, keeping only capability-free rows', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({
      status: 'idle',
      summary: 'legacy caps',
      capabilities: { send: true, interrupt: true, fork: true },
      turns: [{ id: 'u1', turnId: 'u1', role: 'user', summary: 'first prompt', items: [{ id: 'u1-i', kind: 'text', text: 'first prompt' }] }],
    })
    initOpencodePane(store)
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )
    await waitFor(() => expect(screen.getByText('first prompt')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Slash commands' }))

    expect(screen.queryByRole('menuitem', { name: /\/undo/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /\/redo/ })).not.toBeInTheDocument()
    // Capability-free rows stay (the menu itself is alive).
    expect(screen.getByRole('menuitem', { name: /\/compact/ })).toBeInTheDocument()
  })

  it('delta-r1 F7: before capability discovery (no snapshot yet), the slash menu offers neither /undo nor /redo', async () => {
    const store = createStore()
    // The snapshot promise never resolves during this check — the pre-discovery state.
    let resolveSnapshot: ((value: unknown) => void) | undefined
    apiMock.getFreshAgentThreadSnapshot.mockImplementation(() => new Promise((resolve) => { resolveSnapshot = resolve }))
    initOpencodePane(store)
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Chat message input' })).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Slash commands' }))

    expect(screen.queryByRole('menuitem', { name: /\/undo/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /\/redo/ })).not.toBeInTheDocument()
    resolveSnapshot?.(rollbackCapableSnapshot())
  })

  it('delta-r1 F6: the view passes the snapshot redoableTurnIds through to the marker section (frozen markers hidden, current-epoch marker enabled)', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue(rollbackCapableSnapshot({
      rolledBackTurns: [
        { id: 'u8', turnId: 'u8', role: 'user', summary: 'frozen marker', items: [{ id: 'u8-i', kind: 'text', text: 'frozen marker' }], rolledBack: true },
        { id: 'a8', turnId: 'a8', role: 'assistant', summary: 'frozen answer', items: [{ id: 'a8-i', kind: 'text', text: 'frozen answer' }], rolledBack: true },
        { id: 'u9', turnId: 'u9', role: 'user', summary: 'current marker', items: [{ id: 'u9-i', kind: 'text', text: 'current marker' }], rolledBack: true, restorable: true },
      ],
      rollback: { canRedo: true, undoneDepth: 2, redoableTurnIds: ['u9'] },
    }))
    initOpencodePane(store)
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )
    await waitFor(() => expect(screen.getByText('current marker')).toBeInTheDocument())

    const section = screen.getByRole('region', { name: 'Rolled back turns' })
    const buttons = Array.from(section.querySelectorAll('button[aria-label="Redo to here"]'))
    expect(buttons).toHaveLength(1)
    expect(buttons[0].closest('div.flex.items-start')?.textContent).toContain('current marker')
    // The frozen pair is historical: the quiet line counts its ONE user step…
    const historyLine = within(section).getByRole('button', { name: /Toggle rolled-back history/ })
    expect(historyLine).toHaveTextContent('Rolled back (1) — kept in history')
    expect(within(section).queryByText('frozen marker')).toBeNull()
    // …and reveals the frozen rows (with no redo button) on demand.
    fireEvent.click(historyLine)
    const frozenRow = screen.getByText('frozen marker').closest('div.flex.items-start')
    expect(frozenRow).not.toBeNull()
    expect(frozenRow?.querySelector('button[aria-label="Redo to here"]')).toBeNull()
  })

  it('delta-r1 F6 legacy: a rollback block WITHOUT redoableTurnIds offers no per-marker redo', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue(rollbackCapableSnapshot({
      rollback: { canRedo: true, undoneDepth: 1 },
    }))
    initOpencodePane(store)
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )
    // Legacy shape: no restorable stamps ⇒ the marker is born behind the line.
    await waitFor(() => expect(screen.getByRole('button', { name: /Toggle rolled-back history/ })).toBeInTheDocument())

    const section = screen.getByRole('region', { name: 'Rolled back turns' })
    expect(section.querySelectorAll('button[aria-label="Redo to here"]')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: /Toggle rolled-back history/ }))
    expect(screen.getByText('rolled prompt')).toBeInTheDocument()
    expect(section.querySelectorAll('button[aria-label="Redo to here"]')).toHaveLength(0)
  })

  it('a freshcodex pane renders its markers collapsed from birth (undo-only provider)', async () => {
    // codex is undo-only: the server stamps restorable:false from the moment of
    // its undo, so the marker section is born collapsed behind the history line.
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({
      status: 'idle',
      summary: 'Codex rolled marker',
      capabilities: { send: true, interrupt: true, fork: true, undo: true, redo: false },
      rollback: { canRedo: false, undoneDepth: 1 },
      rolledBackTurns: [
        { id: 'u9', turnId: 'u9', role: 'user', summary: 'codex rolled prompt', items: [{ id: 'u9-i', kind: 'text', text: 'codex rolled prompt' }], rolledBack: true, restorable: false },
      ],
      turns: [],
    })
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-collapsed-codex',
        sessionId: 'thread-collapsed-codex',
        status: 'idle',
      },
    }))
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: /Toggle rolled-back history/ })).toBeInTheDocument())

    const section = screen.getByRole('region', { name: 'Rolled back turns' })
    const historyLine = within(section).getByRole('button', { name: /Toggle rolled-back history/ })
    expect(historyLine).toHaveTextContent('Rolled back (1) — kept in history')
    expect(historyLine).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'Redo to here' })).toBeNull()

    fireEvent.click(historyLine)
    expect(screen.getByText('codex rolled prompt')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Redo to here' })).toBeNull()
  })

  it('a freshcodex pane re-collapses the disclosure across conversation switches (threadId-keyed: codex snapshots carry no sessionId)', async () => {
    // The delta-review hazard: the Rust codex snapshot builder stamps threadId
    // but NEVER sessionId (codex.rs build_codex_snapshot_json), so the view
    // must fall back to threadId for the disclosure's conversation keying —
    // otherwise a second codex conversation in the same pane inherits the
    // first one's expanded history line instead of collapsing from birth.
    const codexSnapshotWith = (threadId: string, prompt: string) => ({
      status: 'idle' as const,
      summary: prompt,
      threadId,
      capabilities: { send: true, interrupt: true, fork: true, undo: true, redo: false },
      rollback: { canRedo: false, undoneDepth: 1 },
      rolledBackTurns: [
        { id: `${threadId}-u`, turnId: `${threadId}-u`, role: 'user', summary: prompt, items: [{ id: `${threadId}-u-i`, kind: 'text' as const, text: prompt }], rolledBack: true, restorable: false },
      ],
      turns: [],
    })
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue(codexSnapshotWith('thread-a', 'codex prompt one'))
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-codex-switch',
        sessionId: 'thread-a',
        status: 'idle',
      },
    }))
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )
    await waitFor(() => expect(screen.getByRole('button', { name: /Toggle rolled-back history/ })).toBeInTheDocument())

    // Expand conversation A's history line.
    fireEvent.click(screen.getByRole('button', { name: /Toggle rolled-back history/ }))
    expect(screen.getByText('codex prompt one')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Toggle rolled-back history/ })).toHaveAttribute('aria-expanded', 'true')

    // Start a NEW conversation in the SAME pane: the pane content re-keys to
    // thread-b and the (mocked) snapshot now describes conversation B.
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue(codexSnapshotWith('thread-b', 'codex prompt two'))
    act(() => {
      store.dispatch(updatePaneContent({
        tabId: 'tab-1',
        paneId: 'pane-1',
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshcodex',
          provider: 'codex',
          createRequestId: 'req-codex-switch',
          sessionId: 'thread-b',
          status: 'idle',
        },
      }))
    })

    // The disclosure re-collapses for the new conversation — codex markers are
    // collapsed from birth, and an expanded toggle never leaks across the
    // conversation switch (against the pre-fix code the key stays null and
    // aria-expanded would never return to 'false').
    await waitFor(() => expect(screen.getByRole('button', { name: /Toggle rolled-back history/ })).toHaveAttribute('aria-expanded', 'false'))
    expect(screen.queryByText('codex prompt one')).toBeNull()
    expect(screen.queryByText('codex prompt two')).toBeNull()
    // Expanding reveals conversation B's own row.
    fireEvent.click(screen.getByRole('button', { name: /Toggle rolled-back history/ }))
    expect(screen.getByText('codex prompt two')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Toggle rolled-back history/ })).toHaveAttribute('aria-expanded', 'true')
  })

  it('typed /redo on a freshcodex pane hits the composer RESERVED seam: pinned codex notice, NEVER a send (r3 correction 8)', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-rb-codex',
        sessionId: 'thread-rb-codex',
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

    fireEvent.change(getComposer(), { target: { value: '/redo' } })
    fireEvent.keyDown(getComposer(), { key: 'Enter' })

    // The composer's pre-catalog-resolution seam intercepts the reserved name: the
    // pinned codex notice shows, and the text NEVER reaches the model or the wire.
    expect(screen.getByText(REDO_CODEX_UNSUPPORTED_NOTICE)).toBeInTheDocument()
    expect(sentFreshAgentMessages('freshAgent.redo')).toEqual([])
    expect(sentFreshAgentMessages('freshAgent.send')).toEqual([])
    expect(getComposer().value).toBe('')
    // …but the typed text is pushed to prompt history exactly like a resolved command.
    expect(JSON.parse(window.localStorage.getItem('fresh-agent-prompt-history:freshcodex') ?? '[]')).toContain('/redo')
  })

  it('a rolledBack ack refills the composer with the removed prompt (overwrite, never append) + refill notice', async () => {
    const store = createStore()
    let onMessage: ((message: Record<string, unknown>) => void) | undefined
    wsMock.onMessage.mockImplementation((handler: (message: Record<string, unknown>) => void) => {
      onMessage = handler
      return () => {}
    })
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue(rollbackCapableSnapshot())
    initOpencodePane(store)
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )
    await waitFor(() => expect(screen.getByText('first answer')).toBeInTheDocument())
    expect(onMessage).toBeTypeOf('function')
    wsMock.send.mockClear()

    fireEvent.change(getComposer(), { target: { value: '/undo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    const frame = sentFreshAgentMessages('freshAgent.undo').at(-1)
    expect(frame?.requestId).toEqual(expect.any(String))

    // The user keeps typing while the rollback is in flight — the refill OVERWRITES.
    fireEvent.change(getComposer(), { target: { value: 'stale draft' } })
    act(() => {
      onMessage?.({
        type: 'freshAgent.event',
        sessionId: 'ses_rollback',
        sessionType: 'freshopencode',
        provider: 'opencode',
        event: {
          type: 'freshAgent.rolledBack',
          requestId: String(frame?.requestId),
          sessionId: 'ses_rollback',
          direction: 'undo',
          mode: 'step',
          removedPromptText: 'the removed prompt',
          removedTurnIds: ['u1', 'a1'],
          canRedo: true,
        },
      })
    })

    await waitFor(() => expect(getComposer().value).toBe('the removed prompt'))
    expect(screen.getByText(UNDO_REFILL_NOTICE)).toBeInTheDocument()
    // a11y: the refilled composer regains focus for immediate editing.
    await waitFor(() => expect(document.activeElement).toBe(getComposer()))
  })

  it('a redone ack leaves the composer contents alone (the server kept prompt truth)', async () => {
    const store = createStore()
    let onMessage: ((message: Record<string, unknown>) => void) | undefined
    wsMock.onMessage.mockImplementation((handler: (message: Record<string, unknown>) => void) => {
      onMessage = handler
      return () => {}
    })
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue(rollbackCapableSnapshot())
    initOpencodePane(store)
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )
    await waitFor(() => expect(screen.getByText('first answer')).toBeInTheDocument())
    wsMock.send.mockClear()

    fireEvent.change(getComposer(), { target: { value: '/redo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    const frame = sentFreshAgentMessages('freshAgent.redo').at(-1)
    expect(frame?.requestId).toEqual(expect.any(String))

    fireEvent.change(getComposer(), { target: { value: 'keep this draft' } })
    act(() => {
      onMessage?.({
        type: 'freshAgent.event',
        sessionId: 'ses_rollback',
        sessionType: 'freshopencode',
        provider: 'opencode',
        event: {
          type: 'freshAgent.redone',
          requestId: String(frame?.requestId),
          sessionId: 'ses_rollback',
          direction: 'redo',
          restoredThroughTurnId: 'u9',
          canRedo: false,
        },
      })
    })

    // No refill, no refill notice — a redo restores turns, not composer text.
    await waitFor(() => expect(getComposer().value).toBe('keep this draft'))
    expect(screen.queryByText(UNDO_REFILL_NOTICE)).not.toBeInTheDocument()
  })

  it('a rollback-flagged error renders the server-supplied message VERBATIM on the notice banner', async () => {
    const store = createStore()
    let onMessage: ((message: Record<string, unknown>) => void) | undefined
    wsMock.onMessage.mockImplementation((handler: (message: Record<string, unknown>) => void) => {
      onMessage = handler
      return () => {}
    })
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue(rollbackCapableSnapshot())
    initOpencodePane(store)
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )
    await waitFor(() => expect(screen.getByText('first answer')).toBeInTheDocument())
    wsMock.send.mockClear()

    fireEvent.change(getComposer(), { target: { value: '/undo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    const frame = sentFreshAgentMessages('freshAgent.undo').at(-1)
    expect(frame?.requestId).toEqual(expect.any(String))

    // The server-pinned copy (e.g. the claude moved-tip refusal) renders VERBATIM —
    // the client NEVER substitutes its own guess copy for a supplied message.
    const serverCopy = 'Redo is no longer available — the original conversation’s history changed since the undo.'
    act(() => {
      onMessage?.({
        type: 'freshAgent.event',
        sessionId: 'ses_rollback',
        sessionType: 'freshopencode',
        provider: 'opencode',
        event: {
          type: 'freshAgent.error',
          sessionId: 'ses_rollback',
          code: 'REDO_UNAVAILABLE',
          rollback: true,
          requestId: String(frame?.requestId),
          message: serverCopy,
        },
      })
    })

    expect(screen.getByText(serverCopy)).toBeInTheDocument()
  })

  it('a re-delivered rolledBack ack with the SAME requestId NEVER re-refills the composer (consume-once per requestId)', async () => {
    const store = createStore()
    let onMessage: ((message: Record<string, unknown>) => void) | undefined
    wsMock.onMessage.mockImplementation((handler: (message: Record<string, unknown>) => void) => {
      onMessage = handler
      return () => {}
    })
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue(rollbackCapableSnapshot())
    initOpencodePane(store)
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )
    await waitFor(() => expect(screen.getByText('first answer')).toBeInTheDocument())
    wsMock.send.mockClear()

    fireEvent.change(getComposer(), { target: { value: '/undo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    const frame = sentFreshAgentMessages('freshAgent.undo').at(-1)
    expect(frame?.requestId).toEqual(expect.any(String))

    // The SAME ack frame delivered twice (ws redundancy / reconnect replays can
    // re-deliver); the pending-rollback dedupe list consumes exactly once per
    // requestId, so the refill effect fires exactly once.
    const ackFrame = {
      type: 'freshAgent.event',
      sessionId: 'ses_rollback',
      sessionType: 'freshopencode',
      provider: 'opencode',
      event: {
        type: 'freshAgent.rolledBack',
        requestId: String(frame?.requestId),
        sessionId: 'ses_rollback',
        direction: 'undo',
        mode: 'step',
        removedPromptText: 'the removed prompt',
        removedTurnIds: ['u1', 'a1'],
        canRedo: true,
      },
    }
    act(() => {
      onMessage?.(ackFrame)
    })
    await waitFor(() => expect(getComposer().value).toBe('the removed prompt'))

    // A user edit after the refill must survive the replayed ack — a second
    // refill would clobber it with 'the removed prompt' again.
    fireEvent.change(getComposer(), { target: { value: 'post-refill edit' } })
    act(() => {
      onMessage?.(ackFrame)
    })

    expect(getComposer().value).toBe('post-refill edit')
  })

  it('a freshcodex pane stamps undo-only rollback capabilities on the pane-action registry (NEVER redo)', async () => {
    // The server stamps undo:true / redo:false for freshcodex — the registry must
    // never carry a redo capability for the context menu to offer.
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({
      status: 'idle',
      summary: 'Codex rollback caps',
      capabilities: { send: true, interrupt: true, fork: true, undo: true, redo: false },
      rollback: { canRedo: false, undoneDepth: 0 },
      turns: [],
    })
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-caps-codex',
        sessionId: 'thread-caps-codex',
        status: 'idle',
      },
    }))
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )
    await waitFor(() => {
      const actions = getFreshAgentPaneActions('pane-1')
      expect(actions?.undoSupported).toBe(true)
      expect(actions?.redoSupported).toBe(false)
      expect(actions?.canUndo).toBe(true)
    })
  })

  it('a freshclaude pane with canRedo stamps both rollback capabilities on the pane-action registry (the menu row is offered, enabled)', async () => {
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({
      status: 'idle',
      summary: 'Claude rollback caps',
      capabilities: { send: true, interrupt: true, approvals: true, questions: true, fork: true, undo: true, redo: true },
      rollback: { canRedo: true, undoneDepth: 1 },
      rolledBackTurns: [],
      turns: [],
    })
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-caps-claude',
        sessionId: CLAUDE_THREAD_ID,
        status: 'connected',
      },
    }))
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )
    await waitFor(() => {
      const actions = getFreshAgentPaneActions('pane-1')
      expect(actions?.undoSupported).toBe(true)
      expect(actions?.redoSupported).toBe(true)
      expect(actions?.canRedo).toBe(true)
    })
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

  it('the chip follows the model a fresh session.metadata frame states, over a stale REST snapshot', async () => {
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
    // The REST snapshot still reports the PRE-change model: the chip must not
    // be trapped on it once the server has stated the live pair via metadata.
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({
      status: 'idle',
      summary: 'summary',
      capabilities: { send: true, interrupt: true, fork: true },
      turns: [],
      settings: { model: 'claude-live-99', effort: 'low' },
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
            createRequestId: 'req-strip-metadata-model',
            sessionId: CLAUDE_THREAD_ID,
            status: 'connected',
            model: 'opus[1m]',
            effort: 'high',
          }}
        />
      </Provider>,
    )

    // The chip starts on the live (init) model.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Model: Live Ninety Nine — change model' })).toBeInTheDocument()
    })

    // The live pair changed server-side (a configure or a settings-carrying
    // send applied it) and the metadata broadcast states the new truth: the
    // chip flips IMMEDIATELY — the stale snapshot term never masks it.
    store.dispatch(sessionMetadataReceived({
      sessionId: CLAUDE_THREAD_ID,
      sessionType: 'freshclaude',
      provider: 'claude',
      model: 'opus[1m]',
      effort: 'high',
    }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Model: Claude Opus 5 (1M context) — change model' })).toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: 'Model: Live Ninety Nine — change model' })).toBeNull()
    // The tooltip effort follows the metadata fold (not the snapshot's stale
    // 'low').
    expect(screen.getByRole('button', { name: 'Model: Claude Opus 5 (1M context) — change model' }))
      .toHaveAttribute('title', 'opus[1m] · effort high')
  })

  it('an explicit-null metadata effort clears the chip tooltip back to Default', async () => {
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
        source: { id: 'opencode-go', displayName: 'OpenCode Go' },
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high'],
        supportsAdaptiveThinking: true,
      }],
    })
    const store = createStore()
    store.dispatch(sessionInit({
      sessionId: 'ses_metadata_null',
      sessionType: 'freshopencode',
      provider: 'opencode',
      model: 'opencode-go/glm-5.2',
      effort: 'high',
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
            createRequestId: 'req-strip-metadata-null',
            sessionId: 'ses_metadata_null',
            status: 'connected',
            model: 'opencode-go/glm-5.2',
            effort: 'high',
          }}
        />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Model: GLM 5.2 — change model' })).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Model: GLM 5.2 — change model' }))
      .toHaveAttribute('title', 'opencode-go/glm-5.2 · effort high')

    // The Default-row commit clears the variant: metadata states effort null
    // and the tooltip words the SESSION's cleared effort, not a stale 'high'.
    store.dispatch(sessionMetadataReceived({
      sessionId: 'ses_metadata_null',
      sessionType: 'freshopencode',
      provider: 'opencode',
      model: 'opencode-go/glm-5.2',
      effort: null,
    }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Model: GLM 5.2 — change model' }))
        .toHaveAttribute('title', 'opencode-go/glm-5.2 · effort Default')
    })
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

// ── kata b8ke Task 9: opened-as-CLI-elsewhere divergence card + the typed
// handoff-failure banner with Retry ──
describe('fresh-agent runtime-owner divergence recovery (kata b8ke)', () => {
  const DIV_SESSION_ID = 'ses_divergence_1'

  beforeEach(() => {
    apiMock.requestSessionHandoff.mockClear()
    apiMock.requestSessionHandoff.mockResolvedValue({
      ok: true,
      operationId: 'handoff-default',
      generation: 1,
      owner: { kind: 'terminal', terminalId: 't-default', mode: 'codex' },
    })
  })

  function divergencePaneContent(overrides: Record<string, unknown> = {}) {
    return {
      kind: 'fresh-agent',
      sessionType: 'freshcodex',
      provider: 'codex',
      createRequestId: 'req-divergence',
      sessionId: DIV_SESSION_ID,
      sessionRef: { provider: 'codex', sessionId: DIV_SESSION_ID },
      status: 'idle',
      ...overrides,
    } as const
  }

  function terminalOwnerFrame(overrides: Record<string, unknown> = {}) {
    return {
      type: 'session.runtimeOwner',
      provider: 'codex',
      sessionId: DIV_SESSION_ID,
      epoch: 1,
      generation: 2,
      ownerKind: 'terminal',
      terminalId: 't-5',
      operationId: 'handoff-div',
      transition: 'handoff-committed',
      ...overrides,
    }
  }

  it('divergent pane renders the opened-as-CLI-elsewhere card with a direct attach action', async () => {
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: divergencePaneContent() }))
    // Prop-rendered (the wedged-sidecar harness shape): the attach action
    // swaps the pane to a TERMINAL pane in the store — a store-backed
    // wrapper would throw on the kind change mid-assertion.
    render(
      <Provider store={store}>
        <FreshAgentView tabId="tab-1" paneId="pane-1" paneContent={divergencePaneContent()} />
      </Provider>,
    )

    // Install the spy BEFORE the divergence fold re-renders: the click
    // closure captures `dispatch` at render time (react-redux).
    const dispatchSpy = vi.spyOn(store, 'dispatch')

    act(() => store.dispatch(applyRuntimeOwner(terminalOwnerFrame())))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/open as a terminal on another device/i)
    const attach = within(alert).getByRole('button', { name: /attach the terminal here/i })

    // The attach action swaps THIS pane to a terminal pane bound to the
    // owner's terminal id, keeping the same sessionRef.
    fireEvent.click(attach)
    const swap = dispatchSpy.mock.calls
      .map(([action]) => action as { type?: string; payload?: { tabId?: string; paneId?: string; content?: { kind?: string } } })
      .find((action) => action?.type === 'panes/updatePaneContent' && action.payload?.content?.kind === 'terminal')
    expect(swap?.payload).toMatchObject({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'terminal',
        mode: 'codex',
        terminalId: 't-5',
        status: 'running',
        sessionRef: { provider: 'codex', sessionId: DIV_SESSION_ID },
      },
    })
  })

  it('handoff-started is not a live target: the card renders waiting copy with NO attach action', async () => {
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: divergencePaneContent() }))
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    act(() => store.dispatch(applyRuntimeOwner(terminalOwnerFrame({
      transition: 'handoff-started',
      terminalId: undefined,
      generation: 3,
    }))))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/being reopened/i)
    // Round-3 F15: no Attach action until the committed owner event.
    expect(within(alert).queryByRole('button')).toBeNull()
  })

  it('same-session authoritative attach recovery sends the new round fence', async () => {
    const store = createStore()
    const sid = 'thread-attach-recovery'
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: divergencePaneContent({
        sessionId: sid,
        sessionRef: { provider: 'codex', sessionId: sid },
      }),
    }))
    store.dispatch(applyRuntimeOwner(terminalOwnerFrame({
      sessionId: sid,
      ownerKind: 'fresh-agent',
      terminalId: undefined,
      epoch: 1,
      generation: 5,
    })))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    await waitFor(() => expect(sentFreshAgentMessages('freshAgent.attach')).toHaveLength(1))
    expect(sentFreshAgentMessages('freshAgent.attach')[0]).toMatchObject({
      sessionId: sid,
      observedEpoch: 1,
      observedGeneration: 5,
    })

    act(() => {
      store.dispatch(applyRuntimeOwner(terminalOwnerFrame({
        sessionId: sid,
        ownerKind: 'fresh-agent',
        terminalId: undefined,
        epoch: 1,
        generation: 9,
      })))
      store.dispatch(applyFreshAgentReconcileAttach({
        tabId: 'tab-1',
        paneId: 'pane-1',
        sessionRef: { provider: 'codex', sessionId: sid },
        serverInstanceId: 'same-server',
      }))
    })

    await waitFor(() => expect(sentFreshAgentMessages('freshAgent.attach')).toHaveLength(2))
    expect(sentFreshAgentMessages('freshAgent.attach')[1]).toMatchObject({
      sessionId: sid,
      observedEpoch: 1,
      observedGeneration: 9,
    })
  })

  // b8ke ext r34 F2: the attach-here path CANONICALIZES at the write — a
  // cross-device pane holding a PRE-REKEY provisional id discovers the
  // terminal owner through the alias chain, and the pane write must anchor
  // to the CANONICAL session ref (the reverse terminal→fresh-agent action
  // has the same discipline at TerminalView). Pre-r34 the write kept the
  // pane's raw superseded sessionRef: the attach worked for the current
  // process but the pane stayed durably anchored to the retired id, which
  // later restoration/lifecycle recovery could no longer identify once
  // the alias records reset on reconnect and the registry reconstitutes
  // in memory at server start.
  it('the attach-here action writes the CANONICAL session ref for an aliased provisional id', async () => {
    const OLD_ID = 'old-thread-r34'
    const CANONICAL_ID = 'ses-canonical-r34'
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: divergencePaneContent({
      sessionRef: { provider: 'codex', sessionId: OLD_ID },
      sessionId: OLD_ID,
    }) }))
    // Prop-rendered (the wedged-sidecar harness shape): the attach action
    // swaps the pane to a TERMINAL pane in the store — a store-backed
    // wrapper would throw on the kind change mid-assertion.
    render(
      <Provider store={store}>
        <FreshAgentView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={divergencePaneContent({
            sessionRef: { provider: 'codex', sessionId: OLD_ID },
            sessionId: OLD_ID,
          })}
        />
      </Provider>,
    )

    const dispatchSpy = vi.spyOn(store, 'dispatch')

    // The alias chain: the OLD (pre-rebind) id's runtime-owner record
    // carries aliasOf naming the canonical thread id (the r31-F2 rebind
    // old-key frame shape), and the CANONICAL record names the committed
    // terminal owner.
    act(() => store.dispatch(applyRuntimeOwner(terminalOwnerFrame({
      sessionId: OLD_ID,
      aliasOf: CANONICAL_ID,
      transition: 'released',
      generation: 4,
      terminalId: 't-r34-alias',
    }))))
    act(() => store.dispatch(applyRuntimeOwner(terminalOwnerFrame({
      sessionId: CANONICAL_ID,
      transition: 'handoff-committed',
      generation: 5,
      terminalId: 't-r34-alias',
    }))))

    // The divergence card renders through the alias chain (the pane's
    // canonical session resolves OLD → CANONICAL → the terminal owner).
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/open as a terminal on another device/i)
    const attach = within(alert).getByRole('button', { name: /attach the terminal here/i })
    fireEvent.click(attach)

    // THE PANE WRITE IS CANONICAL: the swap's sessionRef is the canonical
    // thread id, never the pane's retired provisional one (pre-r34 this
    // payload kept OLD_ID).
    const swap = dispatchSpy.mock.calls
      .map(([action]) => action as { type?: string; payload?: { tabId?: string; paneId?: string; content?: { kind?: string; sessionRef?: { sessionId?: string } } } })
      .find((action) => action?.type === 'panes/updatePaneContent' && action.payload?.content?.kind === 'terminal')
    expect(swap?.payload).toMatchObject({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'terminal',
        mode: 'codex',
        terminalId: 't-r34-alias',
        sessionRef: { provider: 'codex', sessionId: CANONICAL_ID },
      },
    })
    expect(swap?.payload?.content?.sessionRef?.sessionId).not.toBe(OLD_ID)
  })

  // b8ke focused round-5 R5-3: a SAME-KIND in-progress lifecycle transition
  // (the ready-replay fold of starting/handoff/stopping naming THIS pane's
  // kind) is transition-blocked: the pane shows the transition card (never
  // a silent same-kind "all clear") and offers no actions.
  it('a same-kind in-progress owner record renders the transition card with no actions', async () => {
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: divergencePaneContent() }))
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    // SAME-KIND: the pane is fresh-agent (freshcodex) and the record's
    // ownerKind is fresh-agent with an in-progress transition — pre-fix
    // this folded as no divergence at all (polling resumed mid-lifecycle).
    act(() => store.dispatch(applyRuntimeOwner(terminalOwnerFrame({
      ownerKind: 'fresh-agent',
      transition: 'handoff-started',
      terminalId: undefined,
      generation: 4,
    }))))

    const card = await screen.findByTestId('fresh-agent-owner-transition-card')
    expect(card).toHaveTextContent(/being reopened/i)
    expect(within(card).queryByRole('button')).toBeNull()
    // Not the cross-kind divergence card, not the fenced recovery card.
    expect(screen.queryByTestId('session-handoff-error-banner')).toBeNull()
  })

  // b8ke ext r32 F3: a DIVERGED pane is a PURE OBSERVER while it still
  // renders the fresh-agent view — the composer is disabled (no submit,
  // no local echo, no old-kind send the server's generation fence would
  // refuse as a misleading failed interaction), the interrupt affordance
  // is gone (the runtime-owner state owns the writer), and a message
  // queued BEFORE the divergence is HELD (never flushed) until the pane
  // is no longer diverged. Pre-r32 all three affordances stayed live on
  // the diverged pane.
  // b8ke ext r35 F2: an AUTOMATIC re-drive of the same create request
  // carries the request's ORIGINAL observed pair — never a refreshed one.
  // Pre-r35 the retryable SESSION_RESERVED answer re-armed the create
  // effect, which re-captured the LATEST record: a queued create whose
  // original (1,5) observation was superseded by another device's
  // start/stop cycle (the record left Vacant at gen 9) was resent with
  // the refreshed (1,9) pair — presented as current, the runtime could
  // resume without a new user lifecycle decision, defeating the
  // server-side stale-generation safety net. The honest automatic
  // contract: the ORIGINAL pair flows to the server, which refuses it
  // typed (option (a) of the class contract — the safety net working).
  it('the SESSION_RESERVED create redrive carries the ORIGINAL observed pair — never a refreshed one', async () => {
    const listeners: Array<(message: any) => void> = []
    wsMock.onMessage.mockImplementation((listener) => {
      listeners.push(listener)
      return () => {}
    })
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: divergencePaneContent({
        status: 'creating',
        // sessionRef WITHOUT sessionId — the durable-restored create shape
        // (a pane WITH sessionId attaches instead of creating).
        sessionId: undefined,
        sessionRef: { provider: 'codex', sessionId: 'ses-r35-redrive' },
        createRequestId: 'req-r35-redrive',
      }),
    }))
    // The ORIGINAL ownership observation: a fresh-agent owner at (1, 5).
    act(() => store.dispatch(applyRuntimeOwner({
      type: 'session.runtimeOwner',
      provider: 'codex',
      sessionId: 'ses-r35-redrive',
      epoch: 1,
      generation: 5,
      ownerKind: 'fresh-agent',
      transition: 'handoff-committed',
      operationId: 'op-r35-orig',
    })))
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    // The mount create carried the ORIGINAL pair (1, 5).
    await waitFor(() => {
      const creates = sentFreshAgentMessages('freshAgent.create')
      expect(creates).toHaveLength(1)
      expect(creates[0]).toMatchObject({
        requestId: 'req-r35-redrive',
        observedEpoch: 1,
        observedGeneration: 5,
      })
    })

    // The retryable SESSION_RESERVED answer re-drives the SAME create.
    act(() => {
      for (const listener of listeners) {
        listener({
          type: 'freshAgent.create.failed',
          requestId: 'req-r35-redrive',
          code: 'SESSION_RESERVED',
          retryable: true,
        })
      }
    })
    // Meanwhile another device's start/stop cycle leaves the record
    // VACANT at generation 9 — the original observation is now stale.
    act(() => store.dispatch(applyRuntimeOwner({
      type: 'session.runtimeOwner',
      provider: 'codex',
      sessionId: 'ses-r35-redrive',
      epoch: 1,
      generation: 9,
      ownerKind: 'vacant',
      transition: 'released',
      operationId: 'op-r35-cycle',
    })))

    // After the 1s floor the redrive fires: the resent create carries the
    // ORIGINAL (1, 5) pair — the server's stale-generation fence refuses
    // it typed; NEVER the refreshed (1, 9) pair presenting the old
    // request as current (pre-r35 the resent frame carried gen 9).
    await waitFor(() => {
      expect(sentFreshAgentMessages('freshAgent.create')).toHaveLength(2)
    }, { timeout: 5_000 })
    const redriven = sentFreshAgentMessages('freshAgent.create')[1]
    expect(redriven).toMatchObject({
      requestId: 'req-r35-redrive',
      observedEpoch: 1,
      observedGeneration: 5,
    })
    expect(redriven.observedGeneration).not.toBe(9)
  })

  // b8ke ext r37 F1: a NEW authoritative recovery round captures the
  // CURRENT fence. The create-fence cache is keyed by
  // (createRequestId, reconcileEpoch) — the terminal cache's key shape —
  // because a pane-reconcile respawn/fresh verdict PRESERVES the
  // createRequestId and bumps the epoch as its ONLY re-fire signal: that
  // is a NEW recovery decision (server restart, crash recovery, another
  // device's transition), not an automatic retry, and it may observe
  // fresh. Pre-r37 the epoch-bumped re-arm reused the OLD N fence: the
  // server refused SESSION_RESERVED, the client retried the stale pair,
  // the bounded re-reconcile drained the respawn cap, and a recoverable
  // durable session was falsely classified dead. Within-round automatic
  // retries keep the round-35 contract: the ROUND's original pair.
  it('a new authoritative recovery round captures the CURRENT fence; within-round retries keep the round pair', async () => {
    const listeners: Array<(message: any) => void> = []
    wsMock.onMessage.mockImplementation((listener) => {
      listeners.push(listener)
      return () => {}
    })
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: divergencePaneContent({
        status: 'creating',
        sessionId: undefined,
        sessionRef: { provider: 'codex', sessionId: 'ses-r37-recovery' },
        createRequestId: 'req-r37-recovery',
      }),
    }))
    // The round-1 world: a fresh-agent owner at (1, 5).
    act(() => store.dispatch(applyRuntimeOwner({
      type: 'session.runtimeOwner',
      provider: 'codex',
      sessionId: 'ses-r37-recovery',
      epoch: 1,
      generation: 5,
      ownerKind: 'fresh-agent',
      transition: 'handoff-committed',
      operationId: 'op-r37-orig',
    })))
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    // Round 1's create carried the observed pair (1, 5).
    await waitFor(() => {
      const creates = sentFreshAgentMessages('freshAgent.create')
      expect(creates).toHaveLength(1)
      expect(creates[0]).toMatchObject({
        requestId: 'req-r37-recovery',
        observedEpoch: 1,
        observedGeneration: 5,
      })
    })

    // Ownership advances on another device (generation 9) and the
    // authoritative recovery round begins: the respawn verdict PRESERVES
    // the createRequestId and bumps the reconcileEpoch.
    act(() => store.dispatch(applyRuntimeOwner({
      type: 'session.runtimeOwner',
      provider: 'codex',
      sessionId: 'ses-r37-recovery',
      epoch: 1,
      generation: 9,
      ownerKind: 'vacant',
      transition: 'released',
      operationId: 'op-r37-advance',
    })))
    act(() => store.dispatch(resetFreshAgentPaneForReconcileCreate({
      tabId: 'tab-1',
      paneId: 'pane-1',
      intent: 'respawn',
      sessionRef: { provider: 'codex', sessionId: 'ses-r37-recovery' },
    })))

    // THE NEW ROUND CAPTURES THE CURRENT FENCE: the re-armed create
    // carries (1, 9) — the recovery round proceeds (pre-r37 the OLD
    // (1, 5) pair was reused, refused SESSION_RESERVED, and the cycle
    // drained the respawn cap against a recoverable session).
    await waitFor(() => {
      expect(sentFreshAgentMessages('freshAgent.create')).toHaveLength(2)
    }, { timeout: 5_000 })
    const recoveryRound = sentFreshAgentMessages('freshAgent.create')[1]
    expect(recoveryRound).toMatchObject({
      requestId: 'req-r37-recovery',
      observedEpoch: 1,
      observedGeneration: 9,
    })
    expect(recoveryRound.observedGeneration).not.toBe(5)

    // WITHIN-ROUND: a retryable SESSION_RESERVED on the recovery round's
    // create retries with the ROUND's ORIGINAL pair (1, 9) — never a
    // refresh (the round-35 contract holds inside the new round).
    act(() => {
      for (const listener of listeners) {
        listener({
          type: 'freshAgent.create.failed',
          requestId: 'req-r37-recovery',
          code: 'SESSION_RESERVED',
          retryable: true,
        })
      }
    })
    // Ownership advances AGAIN mid-window — the within-round retry must
    // STILL carry the round's (1, 9) pair, never the newer (1, 11).
    act(() => store.dispatch(applyRuntimeOwner({
      type: 'session.runtimeOwner',
      provider: 'codex',
      sessionId: 'ses-r37-recovery',
      epoch: 1,
      generation: 11,
      ownerKind: 'vacant',
      transition: 'released',
      operationId: 'op-r37-advance-2',
    })))
    await waitFor(() => {
      expect(sentFreshAgentMessages('freshAgent.create')).toHaveLength(3)
    }, { timeout: 5_000 })
    const withinRoundRetry = sentFreshAgentMessages('freshAgent.create')[2]
    expect(withinRoundRetry).toMatchObject({
      requestId: 'req-r37-recovery',
      observedEpoch: 1,
      observedGeneration: 9,
    })
    expect(withinRoundRetry.observedGeneration).not.toBe(11)
  })

  it('a diverged pane is a pure observer: composer disabled, queued text held, no interrupt affordance', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({
      status: 'running',
      capabilities: { send: true, interrupt: true, fork: false },
      turns: [],
    })
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: divergencePaneContent({ status: 'running' }),
    }))
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    // PRE-DIVERGENCE: busy + interruptible — the stop affordance renders
    // and the composer accepts typing.
    expect(await screen.findByRole('button', { name: 'Stop' })).toBeEnabled()
    expect(screen.getByRole('textbox', { name: 'Chat message input' })).toBeEnabled()

    // Queue a follow-up while busy (one active turn — the queue holds it).
    fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), { target: { value: 'Held follow-up' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(screen.getByRole('status', { name: 'Queued messages' })).toHaveTextContent('1 queued')
    expect(sentFreshAgentMessages('freshAgent.send')).toHaveLength(0)

    // THE DIVERGENCE: the session is handed to a terminal runtime while
    // the pane is busy with a queued message.
    act(() => store.dispatch(applyRuntimeOwner(terminalOwnerFrame())))
    await screen.findByRole('alert')

    // The composer is DISABLED — a pure observer with the attach action.
    expect(screen.getByRole('textbox', { name: 'Chat message input' })).toBeDisabled()
    // The interrupt affordance is GONE while diverged (pre-r32 the busy
    // pane kept its Stop button over a writer it no longer owns).
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()

    // The session goes idle while STILL diverged: the queued message must
    // NOT flush (pre-r32 the freed composer flushed the queue and issued
    // an old-kind send the fence refused).
    act(() => store.dispatch(setSessionStatus({
      sessionId: DIV_SESSION_ID,
      sessionType: 'freshcodex',
      provider: 'codex',
      status: 'idle',
    })))
    await act(async () => { await Promise.resolve() })
    expect(sentFreshAgentMessages('freshAgent.send')).toHaveLength(0)
    expect(screen.getByRole('status', { name: 'Queued messages' })).toHaveTextContent('1 queued')
  })

  it('handoff-failure banner renders the typed code with a Retry that re-invokes the same handoff identity', async () => {
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: divergencePaneContent() }))
    store.dispatch(setPaneHandoffError({
      tabId: 'tab-1',
      paneId: 'pane-1',
      error: {
        code: 'TARGET_SPAWN_FAILED',
        message: 'the target runtime failed to start',
        retryable: true,
        generation: 4,
      },
    }))
    // The retry's handoff FAILS again (retryable) — the pane must STAY a
    // fresh-agent pane wearing the banner; only the invocation is asserted.
    apiMock.requestSessionHandoff.mockResolvedValue({
      ok: false,
      error: { code: 'TARGET_SPAWN_FAILED', message: 'still failing', retryable: true, ownerGeneration: 5 },
    })
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent(/target runtime failed to start/i)
    const retry = within(banner).getByRole('button', { name: /retry reopening/i })

    fireEvent.click(retry)
    // Retry is scheduled after a short backoff — never an immediate
    // tight loop.
    expect(apiMock.requestSessionHandoff).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(apiMock.requestSessionHandoff).toHaveBeenCalledTimes(1)
    }, { timeout: 5_000 })

    expect(apiMock.requestSessionHandoff).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'codex',
      sessionId: DIV_SESSION_ID,
      targetKind: 'terminal',
      mode: 'codex',
    }))
  })

  // b8ke ext r34 F1: `retryable: true` below is the SERVER's REAL shape —
  // the handler emits it (pinned server-side in
  // session_handoff::tests::a_stale_generation_answer_is_retryable_from_the_handler_output);
  // pre-r34 the server emitted false while client tests fabricated true,
  // so the banner's Retry action never rendered for a real server answer.
  it('STALE_GENERATION retry refreshes the observed (epoch, generation) pair from the runtime-owner record', async () => {
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: divergencePaneContent() }))
    store.dispatch(setPaneHandoffError({
      tabId: 'tab-1',
      paneId: 'pane-1',
      error: {
        code: 'STALE_GENERATION',
        message: 'observed ownership fence is stale; refresh and retry',
        retryable: true,
        generation: 3,
      },
    }))
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    const banner = await screen.findByRole('alert')
    const retry = within(banner).getByRole('button', { name: /retry reopening/i })

    // The retry's handoff fails again — the pane stays; only the body is
    // asserted (the REFRESHED fence pair).
    apiMock.requestSessionHandoff.mockResolvedValue({
      ok: false,
      error: { code: 'STALE_GENERATION', message: 'still stale', retryable: true, ownerGeneration: 9 },
    })

    // The owner record has since moved to (epoch 2, generation 9) — the
    // retry must carry the REFRESHED pair, never the stale one (round-2).
    act(() => store.dispatch(applyRuntimeOwner(terminalOwnerFrame({
      epoch: 2,
      generation: 9,
      ownerKind: 'vacant',
      terminalId: undefined,
      transition: 'released',
    }))))

    fireEvent.click(retry)
    await waitFor(() => {
      expect(apiMock.requestSessionHandoff).toHaveBeenCalledTimes(1)
    }, { timeout: 5_000 })

    expect(apiMock.requestSessionHandoff).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'codex',
      sessionId: DIV_SESSION_ID,
      observedEpoch: 2,
      observedGeneration: 9,
    }))
  })

  it('HANDOFF_IN_PROGRESS retry waits out the backoff before re-invoking (never an immediate tight loop)', async () => {
    // A wall-clock mid-window sleep (350ms < the 750ms backoff) races CPU
    // contention under parallel suites — the act()-queueing gap before the
    // sleep started could itself exceed the backoff, so the check landed
    // after the timer legitimately fired (the snapshot-debounce sibling's
    // note fixed the same class of flake). Advance the real timer clock
    // deterministically instead: nothing wall-clock remains.
    vi.useFakeTimers()
    try {
      const store = createStore()
      store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: divergencePaneContent() }))
      store.dispatch(setPaneHandoffError({
        tabId: 'tab-1',
        paneId: 'pane-1',
        error: {
          code: 'HANDOFF_IN_PROGRESS',
          message: 'a lifecycle operation is in flight; retry after it settles',
          retryable: true,
          generation: 2,
        },
      }))
      // The retry's handoff fails again — the pane stays; only the timing of
      // the single re-invocation is asserted.
      apiMock.requestSessionHandoff.mockResolvedValue({
        ok: false,
        error: { code: 'HANDOFF_IN_PROGRESS', message: 'still in flight', retryable: true, ownerGeneration: 2 },
      })
      render(
        <Provider store={store}>
          <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
        </Provider>,
      )
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })

      const banner = screen.getByRole('alert')
      const retry = within(banner).getByRole('button', { name: /retry reopening/i })
      fireEvent.click(retry)

      // Synchronous: nothing sent on click itself (never a tight loop).
      expect(apiMock.requestSessionHandoff).not.toHaveBeenCalled()

      // Mid-backoff: one tick before the deadline the timer cannot have fired.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SESSION_HANDOFF_RETRY_BACKOFF_MS - 1)
      })
      expect(apiMock.requestSessionHandoff).not.toHaveBeenCalled()

      // At the full backoff exactly one re-invocation leaves...
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1)
      })
      expect(apiMock.requestSessionHandoff).toHaveBeenCalledTimes(1)
      // ...and no stacked timer follows it: a full further window stays
      // silent.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SESSION_HANDOFF_RETRY_BACKOFF_MS)
      })
      expect(apiMock.requestSessionHandoff).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('every typed handoff-failure code composes: the banner renders the typed message with a Retry that re-invokes the same identity', async () => {
    // Task-009 review Minor 1: the per-code fold matrix lives in the
    // ContextMenu suite; this loop gives EVERY typed code — including
    // REAP_TIMEOUT — the composed banner-render + Retry assertion.
    // b8ke ext r34 F1: `retryable: true` is the SERVER's REAL shape for
    // STALE_GENERATION (pinned server-side); the matrix keeps the
    // banner-render assertion per code honest against it.
    const typedFailures: Array<{ code: string; message: string }> = [
      { code: 'REAP_TIMEOUT', message: 'the prior runtime did not confirm its exit in time' },
      { code: 'TARGET_SPAWN_FAILED', message: 'the target runtime failed to start' },
      { code: 'STALE_GENERATION', message: 'observed ownership fence is stale; refresh and retry' },
      { code: 'HANDOFF_IN_PROGRESS', message: 'a lifecycle operation is in flight; retry after it settles' },
    ]

    for (const failure of typedFailures) {
      apiMock.requestSessionHandoff.mockClear()
      const store = createStore()
      store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: divergencePaneContent() }))
      store.dispatch(setPaneHandoffError({
        tabId: 'tab-1',
        paneId: 'pane-1',
        error: {
          code: failure.code,
          message: failure.message,
          retryable: true,
          generation: 4,
        },
      }))
      // The retry's handoff fails again (retryable) — the pane must STAY a
      // fresh-agent pane wearing the banner; only the invocation is asserted.
      apiMock.requestSessionHandoff.mockResolvedValue({
        ok: false,
        error: { code: failure.code, message: 'still failing', retryable: true, ownerGeneration: 5 },
      })
      render(
        <Provider store={store}>
          <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
        </Provider>,
      )

      const banner = await screen.findByRole('alert')
      expect(banner).toHaveTextContent(new RegExp(failure.message, 'i'))
      const retry = within(banner).getByRole('button', { name: /retry reopening/i })

      fireEvent.click(retry)
      await waitFor(() => {
        expect(apiMock.requestSessionHandoff).toHaveBeenCalledTimes(1)
      }, { timeout: 5_000 })

      expect(apiMock.requestSessionHandoff).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'codex',
        sessionId: DIV_SESSION_ID,
        targetKind: 'terminal',
        mode: 'codex',
      }))
      cleanup()
    }
  })
})

describe('b8ke ext F2: sessionRef-only panes kill the old runtime on replacement/restart', () => {
  // The restored-pane shape: persistence strips content.sessionId, leaving
  // ONLY the durable sessionRef — BOTH kill paths must use
  // sessionRef.sessionId (pre-ext the `content.sessionId` gate skipped the
  // awaited kill entirely, clearing the durable reference and starting a
  // blank conversation while the prior runtime stayed live and
  // unrepresented).

  it('startNewConversation kills the sessionRef session before starting the new one', async () => {
    const handlers: Array<(msg: Record<string, unknown>) => void> = []
    wsMock.onMessage.mockReset()
    wsMock.onMessage.mockImplementation((listener: (msg: Record<string, unknown>) => void) => {
      handlers.push(listener)
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
        createRequestId: 'req-ref-only-new',
        sessionRef: { provider: 'codex', sessionId: 'thread-ref-only' },
        status: 'stuck',
      },
    }))

    render(
      <Provider store={store}>
        <FreshAgentView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={{
            kind: 'fresh-agent',
            sessionType: 'freshcodex',
            provider: 'codex',
            createRequestId: 'req-ref-only-new',
            sessionRef: { provider: 'codex', sessionId: 'thread-ref-only' },
            status: 'stuck',
          }}
        />
      </Provider>,
    )

    await screen.findByRole('alert')
    wsMock.send.mockClear()

    // The stuck card's Start-new action (the same startNewConversation
    // callback the /new command and the context menu drive).
    fireEvent.click(screen.getByRole('button', { name: 'Start new conversation' }))

    // THE F2 CONTRACT: the awaited kill targets the durable sessionRef
    // session — pre-ext a sessionRef-only pane sent NO kill at all and the
    // pane swapped straight to a blank conversation over the live runtime.
    expect(wsMock.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'freshAgent.kill',
      sessionId: 'thread-ref-only',
      sessionType: 'freshcodex',
      provider: 'codex',
    }))
    // Ungated before the ack: the pane keeps its durable reference.
    const before = store.getState().panes.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
    expect(before.content).toMatchObject({ status: 'idle' })

    for (const handler of handlers) {
      handler({
        type: 'freshAgent.killed',
        sessionId: 'thread-ref-only',
        sessionType: 'freshcodex',
        provider: 'codex',
        success: true,
      })
    }
    await waitFor(() => {
      const after = store.getState().panes.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
      expect(after.content).toMatchObject({ status: 'creating' })
      expect((after.content as { sessionId?: string }).sessionId).toBeUndefined()
      expect((after.content as { sessionRef?: { sessionId: string } }).sessionRef).toBeUndefined()
    })
  })

  it('restartStuckSidecar kills the sessionRef session before re-driving creation', async () => {
    const handlers: Array<(msg: Record<string, unknown>) => void> = []
    wsMock.onMessage.mockReset()
    wsMock.onMessage.mockImplementation((listener: (msg: Record<string, unknown>) => void) => {
      handlers.push(listener)
      return () => {}
    })
    const store = createStore()
    const dispatchSpy = vi.spyOn(store, 'dispatch')

    render(
      <Provider store={store}>
        <FreshAgentView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={{
            kind: 'fresh-agent',
            sessionType: 'freshcodex',
            provider: 'codex',
            createRequestId: 'req-ref-stuck',
            sessionRef: { provider: 'codex', sessionId: 'thread-ref-stuck' },
            status: 'stuck',
          }}
        />
      </Provider>,
    )

    await screen.findByRole('alert')
    wsMock.send.mockClear()
    fireEvent.click(screen.getByRole('button', { name: /restart sidecar and resume session/i }))

    // The recovery stop targets the durable sessionRef and waits for a
    // correlated confirmation before any new runtime starts.
    const sent = wsMock.send.mock.calls.find(([message]) => message.type === 'freshAgent.recovery.stop')?.[0]
    expect(sent).toMatchObject({
      sessionId: 'thread-ref-stuck',
      sessionType: 'freshcodex',
      provider: 'codex',
    })
    const remintsBeforeAck = dispatchSpy.mock.calls
      .map(([action]) => action)
      .filter((action: any) => action?.type === 'panes/updatePaneContent'
        && action.payload?.content?.status === 'creating')
    expect(remintsBeforeAck).toHaveLength(0)
    for (const handler of handlers) {
      handler({
        type: 'freshAgent.recovery.stopped',
        requestId: sent.requestId,
        sessionId: 'thread-ref-stuck',
        sessionType: 'freshcodex',
        provider: 'codex',
        success: true,
      })
    }
    await waitFor(() => {
      const remints = dispatchSpy.mock.calls
        .map(([action]) => action)
        .filter((action: any) => action?.type === 'panes/updatePaneContent'
          && action.payload?.content?.status === 'creating')
      expect(remints).toHaveLength(1)
    })
  })

  it('does not resume a wedged Codex session after a refused recovery stop', async () => {
    const handlers: Array<(msg: Record<string, unknown>) => void> = []
    wsMock.onMessage.mockReset()
    wsMock.onMessage.mockImplementation((listener: (msg: Record<string, unknown>) => void) => {
      handlers.push(listener)
      return () => {}
    })
    const store = createStore()
    const dispatchSpy = vi.spyOn(store, 'dispatch')
    render(
      <Provider store={store}>
        <FreshAgentView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={{
            kind: 'fresh-agent',
            sessionType: 'freshcodex',
            provider: 'codex',
            createRequestId: 'req-ref-stuck-failed',
            sessionRef: { provider: 'codex', sessionId: 'thread-ref-stuck-failed' },
            status: 'stuck',
          }}
        />
      </Provider>,
    )
    await screen.findByRole('alert')
    wsMock.send.mockClear()
    fireEvent.click(screen.getByRole('button', { name: /restart sidecar and resume session/i }))
    const sent = wsMock.send.mock.calls.find(([message]) => message.type === 'freshAgent.recovery.stop')?.[0]
    expect(sent?.requestId).toEqual(expect.any(String))
    for (const handler of handlers) {
      handler({
        type: 'freshAgent.recovery.stopped',
        requestId: sent.requestId,
        sessionId: 'thread-ref-stuck-failed',
        sessionType: 'freshcodex',
        provider: 'codex',
        success: false,
        code: 'TEARDOWN_NOT_CONFIRMED',
      })
    }
    await waitFor(() => expect(store.getState().freshAgent.sessions['freshcodex:codex:thread-ref-stuck-failed']?.lastErrorCode).toBe('TEARDOWN_NOT_CONFIRMED'))
    const remints = dispatchSpy.mock.calls
      .map(([action]) => action)
      .filter((action: any) => action?.type === 'panes/updatePaneContent'
        && action.payload?.content?.status === 'creating')
    expect(remints).toHaveLength(0)
  })
})

describe('b8ke ext F1: locatorMatchesPane accepts canonical-session events for an old-key pane', () => {
  // The rekey mirror pair: the old key's record carries aliasOf naming the
  // canonical id. A pane holding the pre-rekey sessionRef must accept
  // CANONICAL-session events (its resolved key) — pre-ext the locator's
  // valid-id set only held the pane's raw ids, so canonical-session events
  // were rejected and the old-key pane never converged.
  const OLD_SESSION_ID = '11111111-2222-4333-8444-555555555555'
  const NEW_SESSION_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa'
  const runtimeOwners = {
    [`claude:${OLD_SESSION_ID}`]: {
      provider: 'claude',
      sessionId: OLD_SESSION_ID,
      epoch: 3,
      generation: 2,
      ownerKind: 'fresh-agent',
      operationId: 'rekey-1',
      transition: 'handoff-committed',
      aliasOf: NEW_SESSION_ID,
      updatedAt: 1,
    },
  } as Record<string, import('@/store/freshAgentTypes').RuntimeOwnerRecord>
  const oldKeyPaneContent = {
    kind: 'fresh-agent',
    sessionType: 'freshclaude',
    provider: 'claude',
    createRequestId: 'req-locator',
    sessionRef: { provider: 'claude', sessionId: OLD_SESSION_ID },
    status: 'idle',
  } as Parameters<typeof locatorMatchesPane>[1]

  it('accepts the canonical session id for a pane holding the pre-rekey id', () => {
    expect(locatorMatchesPane(
      { sessionId: NEW_SESSION_ID, provider: 'claude' },
      oldKeyPaneContent,
      undefined,
      runtimeOwners,
    )).toBe(true)
    // The pane's own (old) id still matches, and unrelated ids still do not.
    expect(locatorMatchesPane(
      { sessionId: OLD_SESSION_ID, provider: 'claude' },
      oldKeyPaneContent,
      undefined,
      runtimeOwners,
    )).toBe(true)
    expect(locatorMatchesPane(
      { sessionId: 'unrelated-session', provider: 'claude' },
      oldKeyPaneContent,
      undefined,
      runtimeOwners,
    )).toBe(false)
  })

  it('a foreign provider is never a valid canonical target (the chain is per-provider)', () => {
    expect(locatorMatchesPane(
      { sessionId: NEW_SESSION_ID, provider: 'codex' },
      oldKeyPaneContent,
      undefined,
      runtimeOwners,
    )).toBe(false)
  })
})

// ── b8ke ext r21 F2: the compact/undo/fork frames carry the observed fence ──

describe('b8ke ext r21 F2: the compact/undo/fork senders carry the observed fence', () => {
  function seedOwnerRecord(
    store: ReturnType<typeof createStore>,
    sessionId: string,
    epoch: number,
    generation: number,
  ) {
    store.dispatch(applyRuntimeOwner({
      type: 'session.runtimeOwner',
      provider: 'opencode',
      sessionId,
      epoch,
      generation,
      ownerKind: 'fresh-agent',
      operationId: `handoff-r21-${sessionId}`,
      transition: 'handoff-committed',
    }))
  }

  function getComposer() {
    return screen.getByRole('textbox', { name: 'Chat message input' }) as HTMLTextAreaElement
  }

  it('/compact carries the session-owner fence on the wire', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({
      status: 'idle',
      summary: 'r21 compact',
      capabilities: { send: true, interrupt: true, fork: true },
      turns: [],
    })
    // The pane's session carries an owner record: (epoch 12, generation 34).
    seedOwnerRecord(store, 'ses-r21-compact', 12, 34)
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-r21-compact',
        sessionId: 'ses-r21-compact',
        initialCwd: '/repo/r21',
        status: 'idle',
      },
    }))
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )
    await waitFor(() => expect(getComposer()).not.toBeDisabled())
    wsMock.send.mockClear()

    fireEvent.change(getComposer(), { target: { value: '/compact' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    // The queued frame carries the observed pair — the server's stale-pair
    // rejection can refuse a reconnect-replayed stale compact, never an
    // unfenced recreation.
    expect(wsMock.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'freshAgent.compact',
      requestId: expect.any(String),
      sessionId: 'ses-r21-compact',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/r21',
      observedEpoch: 12,
      observedGeneration: 34,
    }))
  })

  it('/compact with NO owner record sends no pair (the legacy-unfenced shape)', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({
      status: 'idle',
      summary: 'r21 no-fence',
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
        createRequestId: 'req-r21-nofence',
        sessionId: 'ses-r21-nofence',
        initialCwd: '/repo/r21',
        status: 'idle',
      },
    }))
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )
    await waitFor(() => expect(getComposer()).not.toBeDisabled())
    wsMock.send.mockClear()

    fireEvent.change(getComposer(), { target: { value: '/compact' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    const frame = sentFreshAgentMessages('freshAgent.compact').at(-1)
    expect(frame).toMatchObject({ type: 'freshAgent.compact', sessionId: 'ses-r21-nofence' })
    expect(frame).not.toHaveProperty('observedEpoch')
    expect(frame).not.toHaveProperty('observedGeneration')
  })

  it('/undo carries the session-owner fence on the wire', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({
      status: 'idle',
      summary: 'r21 undo',
      capabilities: { send: true, interrupt: true, fork: true, undo: true, redo: true },
      rollback: { canRedo: true, undoneDepth: 1 },
      rolledBackTurns: [
        { id: 'u9', turnId: 'u9', role: 'user', summary: 'rolled prompt', items: [{ id: 'u9-i', kind: 'text', text: 'rolled prompt' }], rolledBack: true },
      ],
      turns: [
        { id: 'u1', turnId: 'u1', role: 'user', summary: 'first prompt', items: [{ id: 'u1-i', kind: 'text', text: 'first prompt' }] },
      ],
    })
    seedOwnerRecord(store, 'ses-r21-undo', 5, 9)
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-r21-undo',
        sessionId: 'ses-r21-undo',
        initialCwd: '/repo/r21',
        status: 'idle',
      },
    }))
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )
    await waitFor(() => expect(screen.getByText('first prompt')).toBeInTheDocument())
    wsMock.send.mockClear()

    fireEvent.change(getComposer(), { target: { value: '/undo' } })
    fireEvent.keyDown(getComposer(), { key: 'Enter' })

    const frame = sentFreshAgentMessages('freshAgent.undo').at(-1)
    expect(frame).toMatchObject({
      type: 'freshAgent.undo',
      sessionId: 'ses-r21-undo',
      sessionType: 'freshopencode',
      provider: 'opencode',
      mode: 'step',
      observedEpoch: 5,
      observedGeneration: 9,
    })
  })

  it('the Fork button carries the session-owner fence on the wire', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
      status: 'idle',
      summary: 'r21 fork',
      capabilities: { send: true, interrupt: true, fork: true },
      turns: [
        {
          id: 'turn-r21-fork',
          turnId: 'turn-r21-fork',
          role: 'assistant',
          summary: 'Ready to fork',
          items: [{ id: 'item-r21-fork', kind: 'text', text: 'Ready to fork' }],
        },
      ],
    })
    seedOwnerRecord(store, 'ses-r21-fork', 8, 21)
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-r21-fork',
        sessionId: 'ses-r21-fork',
        initialCwd: '/repo/r21',
        status: 'idle',
      },
    }))
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Fork conversation from here' }))

    // The fork frame carries the observed pair of the PARENT's session.
    expect(wsMock.send).toHaveBeenCalledWith({
      type: 'freshAgent.fork',
      requestId: 'req-r21-fork',
      sessionId: 'ses-r21-fork',
      sessionType: 'freshopencode',
      provider: 'opencode',
      tabId: 'tab-1',
      cwd: '/repo/r21',
      input: { atTurnId: 'turn-r21-fork' },
      observedEpoch: 8,
      observedGeneration: 21,
    })
  })
})


describe('!command shell escape (exec route)', () => {
  function renderShellEscapePane(store: ReturnType<typeof createStore>) {
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-shell-escape',
        sessionId: 'thread-shell-escape',
        status: 'idle',
      },
    }))
    return render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )
  }

  it('runs in the live session cwd when the pane has no initial cwd', async () => {
    const store = createStore()
    store.dispatch(sessionInit({
      sessionId: 'thread-shell-escape',
      sessionType: 'freshcodex',
      provider: 'codex',
      cwd: '/live/session/cwd',
    }))
    apiMock.post.mockImplementation((url: string) =>
      url === '/api/fresh-agent/exec'
        ? Promise.resolve({ output: '', exitCode: 0, truncated: false })
        : Promise.resolve({ title: null, source: 'none' }))
    renderShellEscapePane(store)

    const textbox = await screen.findByRole('textbox', { name: 'Chat message input' }) as HTMLTextAreaElement
    await waitFor(() => expect(textbox).not.toBeDisabled())
    fireEvent.change(textbox, { target: { value: '!pwd' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => {
      expect(apiMock.post).toHaveBeenCalledWith('/api/fresh-agent/exec', { command: 'pwd', cwd: '/live/session/cwd' })
    })
  })

  it('a shell command finishing after the conversation was replaced never lands in the new queue', async () => {
    let resolveExec!: (value: { output: string; exitCode: number; truncated: boolean }) => void
    apiMock.post.mockImplementation((url: string) => {
      if (url !== '/api/fresh-agent/exec') return Promise.resolve({ title: null, source: 'none' })
      return new Promise((resolve) => {
        resolveExec = resolve
      })
    })
    const store = createStore()
    renderShellEscapePane(store)

    const textbox = await screen.findByRole('textbox', { name: 'Chat message input' }) as HTMLTextAreaElement
    await waitFor(() => expect(textbox).not.toBeDisabled())
    fireEvent.change(textbox, { target: { value: '!echo stale' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith('/api/fresh-agent/exec', expect.objectContaining({ command: 'echo stale' })))

    // The /new equivalent: the pane's session identity is replaced while
    // the (up to 30 s) exec is still in flight.
    act(() => {
      store.dispatch(updatePaneContent({
        tabId: 'tab-1',
        paneId: 'pane-1',
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshcodex',
          provider: 'codex',
          createRequestId: 'req-shell-escape-2',
          sessionId: 'thread-shell-escape-new',
          status: 'idle',
        },
      }))
    })

    act(() => {
      resolveExec({ output: 'stale output', exitCode: 0, truncated: false })
    })

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/was not sent/)
    })
    expect(screen.queryByRole('status', { name: 'Queued messages' })).toBeNull()
  })
})

describe('diff panel view wiring (ekc6)', () => {
  it('expands a diff using the live session cwd when the pane has no initial cwd', async () => {
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({
      status: 'idle',
      summary: 'Codex summary',
      capabilities: { send: true, interrupt: true, fork: true },
      diffs: [{ id: 'diff-1', title: 'README.md', path: 'README.md' }],
      turns: [],
    })
    const store = createStore()
    store.dispatch(sessionInit({
      sessionId: 'thread-diff-cwd',
      sessionType: 'freshcodex',
      provider: 'codex',
      cwd: '/live/session/cwd',
    }))
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-diff-cwd',
        sessionId: 'thread-diff-cwd',
        status: 'idle',
      },
    }))
    render(
      <Provider store={store}>
        <StoreBackedFreshAgentView tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    // The pane carries NO initialCwd but a live session cwd; the snapshot
    // carries a path-bearing diff. Expanding it must FETCH with the live
    // session cwd —
    // not show the missing-prerequisite "Diff unavailable" copy the
    // initialCwd-only wiring produced for resumed/API-created panes.
    const trigger = await screen.findByRole('button', { name: 'Diff: README.md' })
    fireEvent.click(trigger)
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'true'))
    expect(screen.queryByText('Diff unavailable for this file.')).toBeNull()
  })
})

describe('task delegation open-session link (freshopencode tui parity)', () => {
  // Renders a freshopencode pane whose snapshot carries the given turns,
  // following the file's direct-render harness (mocked snapshot fetch +
  // FreshAgentView with a concrete paneContent). The store records every
  // dispatched action via an injected middleware — a store.dispatch property
  // spy CANNOT observe a createAsyncThunk's pending/fulfilled frames because
  // the thunk middleware dispatches them through the composed closure captured
  // at store creation, never through the property.
  function renderFreshOpencodeViewWithSnapshot(options: {
    sessionId: string
    turns: Array<Record<string, unknown>>
  }) {
    const actions: Array<{ type?: string; meta?: { arg?: Record<string, unknown> } }> = []
    const recordActions: Middleware = () => (next) => (action) => {
      actions.push(action as { type?: string; meta?: { arg?: Record<string, unknown> } })
      return next(action)
    }
    const store = createStore(false, [recordActions])
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
      status: 'idle',
      summary: 'OpenCode summary',
      capabilities: { send: true, interrupt: true, fork: true },
      turns: options.turns,
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
            createRequestId: 'req-delegation-open',
            sessionId: options.sessionId,
            initialCwd: '/repo/parent',
            status: 'idle',
          }}
        />
      </Provider>,
    )
    return { store, actions }
  }

  it('dispatches openSessionTab with the child session when the delegation Open session button is clicked', async () => {
    const { actions } = renderFreshOpencodeViewWithSnapshot({
      sessionId: 'ses_parent',
      turns: [{
        id: 't1', turnId: 't1', role: 'assistant', summary: '',
        items: [{
          id: 'task1', kind: 'task_delegation', status: 'completed',
          title: 'General Task — Fix the flaky harness', description: 'Fix the flaky harness',
          childSessionId: 'ses_child_1',
        }],
      }],
    })
    // The delegation block (and its Open session button) render only inside
    // the EXPANDED activity strip — expand FIRST (plan-review round 2,
    // Finding 14), like the transcript tests do.
    fireEvent.click(await screen.findByRole('button', { name: 'Toggle activity details' }))
    fireEvent.click(screen.getByRole('button', { name: /open session/i }))
    const pending = actions.find((action) => action.type === 'tabs/openSessionTab/pending')
    expect(pending).toBeDefined()
    expect(pending?.meta?.arg).toMatchObject({
      sessionId: 'ses_child_1',
      title: 'Fix the flaky harness',
      cwd: '/repo/parent',
      provider: 'opencode',
      sessionType: 'freshopencode',
      isSubagent: true,
    })
  })
})
