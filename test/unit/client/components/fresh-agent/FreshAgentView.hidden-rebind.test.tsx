import { act, cleanup, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import panesReducer, { initLayout } from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
import freshAgentReducer from '@/store/freshAgentSlice'
import tabsReducer from '@/store/tabsSlice'
import connectionReducer from '@/store/connectionSlice'
import { FreshAgentView } from '@/components/fresh-agent/FreshAgentView'
import { getRebindQueue, resetRebindQueueForTests } from '@/lib/rebind-queue'
import { resetSnapshotSchedulerForTests } from '@/lib/fresh-agent-snapshot-scheduler'
import type { FreshAgentPaneContent } from '@/store/paneTypes'

// Claude snapshot hydration is keyed by Claude's durable UUID
// (getFreshAgentSnapshotThreadId -> getCanonicalPaneResumeSessionId gates on
// isValidClaudeSessionId), so the fixtures use UUID-format session ids.
const SESS_1 = '550e8400-e29b-41d4-a716-446655440101'
const SESS_2 = '550e8400-e29b-41d4-a716-446655440102'
const SESS_3 = '550e8400-e29b-41d4-a716-446655440103'
const SESS_4 = '550e8400-e29b-41d4-a716-446655440104'

const wsMock = vi.hoisted(() => ({
  send: vi.fn(),
  onMessage: vi.fn(() => () => {}),
  onReconnect: vi.fn(() => () => {}),
}))

let wsMessageHandlers: Array<(message: Record<string, unknown>) => void> = []

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

function createStore() {
  return configureStore({
    reducer: {
      panes: panesReducer,
      settings: settingsReducer,
      freshAgent: freshAgentReducer,
      tabs: tabsReducer,
      // FreshAgentView reads connection.status to gate the .lost recovery
      // driver; preload ready so tests keep the pre-gate behavior.
      connection: connectionReducer,
    },
    preloadedState: {
      connection: {
        status: 'ready' as const,
        platform: null,
        availableClis: {},
        featureFlags: {},
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
          title: 'Tab 1',
          titleSetByUser: false,
          status: 'running' as const,
          mode: 'shell' as const,
          shell: 'system' as const,
          createdAt: Date.now(),
        }],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
        tombstones: [],
      },
    },
  })
}

const basePaneContent: FreshAgentPaneContent = {
  kind: 'fresh-agent',
  sessionType: 'freshclaude',
  provider: 'claude',
  createRequestId: 'req-hidden-rebind',
  status: 'idle',
}

let currentStore: ReturnType<typeof createStore>

function renderView({ paneContent, hidden, paneId = 'pane-1' }: {
  paneContent: FreshAgentPaneContent
  hidden: boolean
  paneId?: string
}) {
  currentStore = createStore()
  currentStore.dispatch(initLayout({ tabId: 'tab-1', paneId, content: paneContent }))
  return render(
    <Provider store={currentStore}>
      <FreshAgentView tabId="tab-1" paneId={paneId} paneContent={paneContent} hidden={hidden} />
    </Provider>,
  )
}

function rerenderView(
  rerender: ReturnType<typeof render>['rerender'],
  { paneContent, hidden }: { paneContent: FreshAgentPaneContent; hidden: boolean },
) {
  rerender(
    <Provider store={currentStore}>
      <FreshAgentView tabId="tab-1" paneId="pane-1" paneContent={paneContent} hidden={hidden} />
    </Provider>,
  )
}

function attachFramesSent() {
  return wsMock.send.mock.calls
    .map(([frame]: [{ type?: string }]) => frame)
    .filter((frame: { type?: string }) => frame?.type === 'freshAgent.attach')
}

function fireReconnect() {
  // Every registered onReconnect callback, newest-first registration order.
  for (const call of wsMock.onReconnect.mock.calls) {
    act(() => { call[0]() })
  }
}

function emitWsMessage(message: Record<string, unknown>) {
  act(() => {
    for (const handler of wsMessageHandlers) handler(message)
  })
}

function snapshotWithText(text: string, revision?: number) {
  return {
    ...(revision === undefined ? {} : { revision }),
    status: 'idle',
    summary: text,
    capabilities: { send: true, interrupt: true, fork: true },
    diffs: [],
    worktrees: [],
    turns: text
      ? [{ id: `turn-${text}`, role: 'assistant', items: [{ id: `item-${text}`, kind: 'text', text }] }]
      : [],
  }
}

describe('FreshAgentView hidden-pane rebind (F8)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetRebindQueueForTests()
    resetSnapshotSchedulerForTests()
    wsMock.send.mockClear()
    wsMock.onReconnect.mockClear()
    wsMock.onMessage.mockClear()
    wsMessageHandlers = []
    wsMock.onMessage.mockImplementation((handler) => {
      wsMessageHandlers.push(handler as (message: Record<string, unknown>) => void)
      return () => {}
    })
    wsMock.onReconnect.mockImplementation(() => () => {})
    apiMock.getFreshAgentThreadSnapshot.mockReset()
    apiMock.getFreshAgentModelCapabilities.mockReset()
    apiMock.post.mockReset()
    apiMock.setSessionMetadata.mockReset()
    apiMock.post.mockResolvedValue({ title: null, source: 'none' })
    apiMock.setSessionMetadata.mockResolvedValue(undefined)
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValue({
      status: 'idle',
      summary: 'Claude summary',
      capabilities: { send: true, interrupt: true, fork: true },
      diffs: [],
      worktrees: [],
      turns: [],
    })
    apiMock.getFreshAgentModelCapabilities.mockResolvedValue({
      ok: true,
      sessionType: 'freshclaude',
      runtimeProvider: 'claude',
      status: 'fresh',
      fetchedAt: 1_000,
      models: [],
    })
  })
  afterEach(async () => {
    // Drain pending timers + promise continuations (mocked snapshot fetches,
    // queue release timers) inside act BEFORE restoring real timers, so no
    // React work leaks past environment teardown.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    cleanup()
    vi.useRealTimers()
  })

  it('a HIDDEN pane with a sessionId subscribes to reconnect and re-attaches', () => {
    const paneContent = { ...basePaneContent, sessionId: SESS_1, status: 'idle' as const }
    renderView({ paneContent, hidden: true })
    // Rebind subscription must exist even while hidden:
    expect(wsMock.onReconnect).toHaveBeenCalled()
    wsMock.send.mockClear()
    fireReconnect()
    act(() => { vi.advanceTimersByTime(500) }) // drain the rebind queue spacing
    const attaches = attachFramesSent()
    expect(attaches.length).toBeGreaterThanOrEqual(1)
    expect(attaches[0]).toMatchObject({ type: 'freshAgent.attach', sessionId: SESS_1 })
  })

  it('a HIDDEN pane attaches on mount (session rebind is visibility-independent)', () => {
    const paneContent = { ...basePaneContent, sessionId: SESS_2, status: 'idle' as const }
    renderView({ paneContent, hidden: true })
    act(() => { vi.advanceTimersByTime(500) })
    expect(attachFramesSent().length).toBeGreaterThanOrEqual(1)
  })

  it('reveal after a hidden reconnect performs only surface hydration (no duplicate attach)', () => {
    const paneContent = { ...basePaneContent, sessionId: SESS_3, status: 'idle' as const }
    const { rerender } = renderView({ paneContent, hidden: true })
    act(() => { vi.advanceTimersByTime(500) })
    fireReconnect()
    act(() => { vi.advanceTimersByTime(500) })
    const attachCountWhileHidden = attachFramesSent().length
    expect(attachCountWhileHidden).toBeGreaterThanOrEqual(1)
    // Reveal:
    rerenderView(rerender, { paneContent, hidden: false })
    act(() => { vi.advanceTimersByTime(500) })
    // No NEW attach frame on reveal -- the session was already rebound.
    expect(attachFramesSent().length).toBe(attachCountWhileHidden)
  })

  it('reconnect while hidden defers snapshot refresh to reveal', async () => {
    // getFreshAgentThreadSnapshot is mocked in the donor preamble; capture its
    // call count. The initial mount fetch may run -- measure the DELTA around
    // the reconnect edge.
    const paneContent = { ...basePaneContent, sessionId: SESS_4, status: 'idle' as const }
    const { rerender } = renderView({ paneContent, hidden: true })
    // Async timer advance: the snapshot scheduler is single-flight per key, so
    // the mount identity fetch must fully settle (promise continuations AND
    // debounce timers) or the reveal refresh would fold into a trailing run
    // that a sync advance can never fire.
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    const callsBeforeReconnect = apiMock.getFreshAgentThreadSnapshot.mock.calls.length
    fireReconnect()
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(apiMock.getFreshAgentThreadSnapshot.mock.calls.length).toBe(callsBeforeReconnect)
    rerenderView(rerender, { paneContent, hidden: false })
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(apiMock.getFreshAgentThreadSnapshot.mock.calls.length).toBeGreaterThan(callsBeforeReconnect)
  })

  it('defers a hidden transcript change and blocks the old transcript until reveal hydration finishes', async () => {
    apiMock.getFreshAgentThreadSnapshot
      .mockResolvedValueOnce(snapshotWithText('old transcript'))
      .mockResolvedValueOnce(snapshotWithText('new transcript'))
    const paneContent = { ...basePaneContent, sessionId: SESS_1, status: 'idle' as const }
    const { rerender } = renderView({ paneContent, hidden: true })

    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    const callsBeforeChange = apiMock.getFreshAgentThreadSnapshot.mock.calls.length
    expect(screen.getByText('old transcript')).toBeInTheDocument()

    emitWsMessage({
      type: 'freshAgent.event',
      sessionId: SESS_1,
      sessionType: 'freshclaude',
      provider: 'claude',
      event: { type: 'freshAgent.session.changed', sessionId: SESS_1 },
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(apiMock.getFreshAgentThreadSnapshot.mock.calls.length).toBe(callsBeforeChange)

    rerenderView(rerender, { paneContent, hidden: false })
    expect(screen.getByRole('status', { name: 'Refreshing conversation' })).toBeInTheDocument()
    expect(screen.getByTestId('fresh-agent-stale-transcript')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByText('old transcript')).toBeInTheDocument()

    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(screen.getByText('new transcript')).toBeInTheDocument()
    expect(screen.queryByTestId('fresh-agent-stale-transcript')).not.toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Refreshing conversation' })).not.toBeInTheDocument()
  })

  it('does not mark a hidden pane stale for a status-only snapshot event', async () => {
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce(snapshotWithText('current transcript'))
    const paneContent = { ...basePaneContent, sessionId: SESS_2, status: 'idle' as const }
    const { rerender } = renderView({ paneContent, hidden: true })

    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    const callsBeforeStatus = apiMock.getFreshAgentThreadSnapshot.mock.calls.length
    emitWsMessage({
      type: 'freshAgent.event',
      sessionId: SESS_2,
      sessionType: 'freshclaude',
      provider: 'claude',
      event: { type: 'freshAgent.session.snapshot', sessionId: SESS_2, status: 'idle' },
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    rerenderView(rerender, { paneContent, hidden: false })

    expect(apiMock.getFreshAgentThreadSnapshot.mock.calls.length).toBe(callsBeforeStatus)
    expect(screen.getByText('current transcript')).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Refreshing conversation' })).not.toBeInTheDocument()
  })

  it('keeps stale content concealed and offers retry when reveal hydration fails', async () => {
    apiMock.getFreshAgentThreadSnapshot
      .mockResolvedValueOnce(snapshotWithText('old transcript'))
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(snapshotWithText('recovered transcript'))
    const paneContent = { ...basePaneContent, sessionId: SESS_3, status: 'idle' as const }
    const { rerender } = renderView({ paneContent, hidden: true })

    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    emitWsMessage({
      type: 'freshAgent.event',
      sessionId: SESS_3,
      sessionType: 'freshclaude',
      provider: 'claude',
      event: { type: 'freshAgent.result', sessionId: SESS_3 },
    })
    rerenderView(rerender, { paneContent, hidden: false })
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })

    expect(screen.getByRole('alert', { name: 'The conversation could not be refreshed.' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.getByTestId('fresh-agent-stale-transcript')).toHaveAttribute('aria-hidden', 'true')

    act(() => { screen.getByRole('button', { name: 'Retry' }).click() })
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(screen.getByText('recovered transcript')).toBeInTheDocument()
    expect(screen.queryByTestId('fresh-agent-stale-transcript')).not.toBeInTheDocument()
  })

  it('keeps the spinner up when the first reveal snapshot has not caught up yet', async () => {
    apiMock.getFreshAgentThreadSnapshot
      .mockResolvedValueOnce(snapshotWithText('old transcript', 10))
      .mockResolvedValueOnce(snapshotWithText('still old on disk', 10))
      .mockResolvedValueOnce(snapshotWithText('caught up transcript', 11))
    const paneContent = { ...basePaneContent, sessionId: SESS_4, status: 'idle' as const }
    const { rerender } = renderView({ paneContent, hidden: true })

    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    emitWsMessage({
      type: 'freshAgent.event',
      sessionId: SESS_4,
      sessionType: 'freshclaude',
      provider: 'claude',
      event: { type: 'freshAgent.session.changed', sessionId: SESS_4 },
    })
    rerenderView(rerender, { paneContent, hidden: false })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
      for (let i = 0; i < 5; i++) await Promise.resolve()
    })
    expect(screen.getByRole('status', { name: 'Refreshing conversation' })).toBeInTheDocument()
    expect(screen.getByText('still old on disk')).toBeInTheDocument()
    expect(screen.getByTestId('fresh-agent-stale-transcript')).toHaveAttribute('aria-hidden', 'true')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
      for (let i = 0; i < 5; i++) await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
      for (let i = 0; i < 5; i++) await Promise.resolve()
    })
    expect(apiMock.getFreshAgentThreadSnapshot.mock.calls.length).toBe(3)
    expect(screen.getByText('caught up transcript')).toBeInTheDocument()
    expect(screen.queryByTestId('fresh-agent-stale-transcript')).not.toBeInTheDocument()
  })
})

describe('FreshAgentView hidden-pane create rebind (F8)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetRebindQueueForTests()
    wsMock.send.mockClear()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  function createFramesSent() {
    return wsMock.send.mock.calls
      .map(([frame]: [{ type?: string }]) => frame)
      .filter((frame: { type?: string }) => frame?.type === 'freshAgent.create')
  }

  it('a HIDDEN pane in status creating sends freshAgent.create (restart recovery)', () => {
    const paneContent: FreshAgentPaneContent = {
      ...basePaneContent,
      sessionId: undefined,
      status: 'creating',
      createRequestId: 'req-hidden-1',
    }
    renderView({ paneContent, hidden: true })
    act(() => { vi.advanceTimersByTime(500) })
    const creates = createFramesSent()
    expect(creates.length).toBe(1)
    expect(creates[0]).toMatchObject({ type: 'freshAgent.create', requestId: 'req-hidden-1' })
  })

  it('hidden creates are paced: N panes never exceed 4 un-acked in-flight creates', () => {
    // Render 6 hidden panes sharing the mocked ws. None receives a
    // freshAgent.created ack, so the queue must hold creates 5 and 6 back
    // until the 10s auto-release backstop.
    for (let i = 0; i < 6; i++) {
      renderView({
        paneContent: {
          ...basePaneContent,
          sessionId: undefined,
          status: 'creating',
          createRequestId: `req-storm-${i}`,
        },
        paneId: `pane-storm-${i}`,
        hidden: true,
      })
    }
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(createFramesSent().length).toBe(4)
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(createFramesSent().length).toBe(6)
  })

  it('a hidden create queued behind a full queue does not send after unmount', () => {
    // Fill all 4 slots with blocker jobs that never release (freed only by
    // the 10s auto-release backstop).
    const queue = getRebindQueue()
    for (let i = 0; i < 4; i++) {
      queue.enqueue({ key: `blocker-${i}`, run: () => {} })
    }
    act(() => { vi.advanceTimersByTime(500) })
    const { unmount } = renderView({
      paneContent: {
        ...basePaneContent,
        sessionId: undefined,
        status: 'creating',
        createRequestId: 'req-unmounted',
      },
      hidden: true,
    })
    act(() => { vi.advanceTimersByTime(100) })
    // The create job is QUEUED behind the blockers -- nothing sent yet.
    expect(createFramesSent().length).toBe(0)
    unmount()
    // Blockers auto-release at 10s; the queued create job then gets its turn.
    act(() => { vi.advanceTimersByTime(11_000) })
    const framesForUnmountedPane = createFramesSent()
      .filter((frame: { requestId?: string }) => frame.requestId === 'req-unmounted')
    expect(framesForUnmountedPane.length).toBe(0)
  })

  it('the freshAgent.create.failed ack releases the queue slot', () => {
    for (let i = 0; i < 5; i++) {
      renderView({
        paneContent: {
          ...basePaneContent,
          sessionId: undefined,
          status: 'creating',
          createRequestId: `req-fail-${i}`,
        },
        paneId: `pane-fail-${i}`,
        hidden: true,
      })
    }
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(createFramesSent().length).toBe(4)
    // Deliver the create-failed ack for the first pane through every
    // registered onMessage handler (mirror the created-ack test above).
    act(() => {
      for (const call of wsMock.onMessage.mock.calls) {
        call[0]({
          type: 'freshAgent.create.failed',
          requestId: 'req-fail-0',
          code: 'SPAWN_FAILED',
          message: 'boom',
          retryable: false,
        })
      }
    })
    act(() => { vi.advanceTimersByTime(1_000) })
    // Slot released well before the 10s backstop -- the 5th create goes out.
    expect(createFramesSent().length).toBe(5)
  })

  it('the freshAgent.created ack releases the queue slot', () => {
    for (let i = 0; i < 5; i++) {
      renderView({
        paneContent: {
          ...basePaneContent,
          sessionId: undefined,
          status: 'creating',
          createRequestId: `req-ack-${i}`,
        },
        paneId: `pane-ack-${i}`,
        hidden: true,
      })
    }
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(createFramesSent().length).toBe(4)
    // Deliver the created ack for the first pane through every registered
    // onMessage handler (mirror the freshAgent.created frame shape used by
    // the donor FreshAgentView.test.tsx created-frame fixture).
    act(() => {
      for (const call of wsMock.onMessage.mock.calls) {
        call[0]({ type: 'freshAgent.created', requestId: 'req-ack-0', sessionId: 'sess-ack-0' })
      }
    })
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(createFramesSent().length).toBe(5)
  })
})
