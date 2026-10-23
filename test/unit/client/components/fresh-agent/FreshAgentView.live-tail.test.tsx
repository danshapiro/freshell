import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { appReducers } from '@/store/appReducers'
import { initLayout, mergePaneContent } from '@/store/panesSlice'
import { setStatus } from '@/store/connectionSlice'
import { useAppSelector } from '@/store/hooks'
import { FreshAgentView } from '@/components/fresh-agent/FreshAgentView'
import { LANDING_RECHECK_MAX } from '@/components/fresh-agent/useTranscriptLandings'
import { handleFreshAgentMessage } from '@/lib/fresh-agent-ws'
import { resetSnapshotSchedulerForTests, SNAPSHOT_DEBOUNCE_MS } from '@/lib/fresh-agent-snapshot-scheduler'
import { LIVE_STREAM_FLUSH_MS } from '@/lib/fresh-agent-stream-batcher'

// Transcript-live plan D5: a claude pane follows its transcript per message,
// re-polls (boundedly) for announced lines the CLI has not written yet, and
// drops its live tail once the turn's lines landed and the turn ended.

const wsMock = vi.hoisted(() => ({
  handlers: new Set<(message: unknown) => void>(),
  send: vi.fn(),
}))

const apiMock = vi.hoisted(() => ({
  getFreshAgentThreadSnapshot: vi.fn(),
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsMock.send,
    onMessage: (handler: (message: unknown) => void) => {
      wsMock.handlers.add(handler)
      return () => { wsMock.handlers.delete(handler) }
    },
    onReconnect: () => () => {},
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn().mockRejectedValue(new Error('no server in tests')),
      post: vi.fn().mockRejectedValue(new Error('no server in tests')),
    },
    getFreshAgentThreadSnapshot: apiMock.getFreshAgentThreadSnapshot,
    getFreshAgentCheckpointOutcomePage: vi.fn().mockResolvedValue({ outcomes: [], nextCursor: null }),
    getFreshAgentModelCapabilities: vi.fn().mockRejectedValue(new Error('no server in tests')),
    setSessionMetadata: vi.fn().mockResolvedValue(undefined),
  }
})

vi.mock('@/store/settingsThunks', () => ({
  saveServerSettingsPatch: (patch: unknown) => ({ type: 'settings/saveServerSettingsPatch', payload: patch }),
}))

vi.mock('@/components/markdown/LazyMarkdown', async () => {
  const { MarkdownRenderer } = await import('@/components/markdown/MarkdownRenderer')
  return {
    LazyMarkdown: ({ content }: { content: string }) => <MarkdownRenderer content={content} />,
  }
})

const SESSION_ID = '550e8400-e29b-41d4-a716-44665544d005'
const locator = { sessionId: SESSION_ID, sessionType: 'freshclaude' as const, provider: 'claude' as const }
const KEY = `freshclaude:claude:${SESSION_ID}`

type Turn = { id: string; turnId: string; role: 'user' | 'assistant'; summary: string; items: unknown[] }

function userTurn(id: string, text: string): Turn {
  return { id, turnId: id, role: 'user', summary: text, items: [{ id: `${id}-text`, kind: 'text', text }] }
}

function assistantText(id: string, text: string): Turn {
  return { id, turnId: id, role: 'assistant', summary: text, items: [{ id: `${id}-text`, kind: 'text', text }] }
}

function assistantTool(id: string, name: string): Turn {
  return {
    id,
    turnId: id,
    role: 'assistant',
    summary: '',
    items: [{ id: `${id}-tool`, kind: 'tool_use', toolUseId: `toolu_${id}`, name, input: { command: 'ls' } }],
  }
}

function claudeSnapshot(turns: Turn[], lineUuids: string[] = turns.map((turn) => turn.turnId), revision = 1) {
  return {
    sessionType: 'freshclaude',
    provider: 'claude',
    threadId: SESSION_ID,
    sessionId: SESSION_ID,
    revision,
    latestTurnId: turns.at(-1)?.turnId ?? null,
    status: 'idle',
    summary: '',
    capabilities: { send: true, interrupt: true, approvals: false, questions: false, fork: false },
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    pendingApprovals: [],
    pendingQuestions: [],
    worktrees: [],
    diffs: [],
    childThreads: [],
    turns,
    extensions: { claude: { transcriptLineUuids: lineUuids } },
  }
}

/** Every read parses fresh JSON in production: hand out a new object per call. */
function serve(...snapshots: Array<() => ReturnType<typeof claudeSnapshot>>) {
  const queue = [...snapshots]
  apiMock.getFreshAgentThreadSnapshot.mockImplementation(async () => (queue.length > 1 ? queue.shift()! : queue[0])())
}

function createStore() {
  const store = configureStore({
    reducer: appReducers,
    middleware: (getDefault) => getDefault({ serializableCheck: false, immutableCheck: false }),
  })
  store.dispatch(setStatus('ready'))
  store.dispatch(initLayout({
    tabId: 'tab-1',
    paneId: 'pane-1',
    content: {
      kind: 'fresh-agent',
      ...locator,
      createRequestId: 'req-live-tail',
      status: 'idle',
    },
  }))
  return store
}

type Store = ReturnType<typeof createStore>

function StoreBackedView({ hidden = false }: { hidden?: boolean }) {
  const content = useAppSelector((state) => {
    const layout = state.panes.layouts['tab-1']
    if (!layout || layout.type !== 'leaf' || layout.content.kind !== 'fresh-agent') throw new Error('missing pane')
    return layout.content
  })
  return <FreshAgentView tabId="tab-1" paneId="pane-1" paneContent={content} hidden={hidden} />
}

/** What App and the mounted view both receive for one server frame. */
function deliver(store: Store, event: Record<string, unknown>) {
  const message = { type: 'freshAgent.event', ...locator, event: { sessionId: SESSION_ID, ...event } }
  act(() => {
    handleFreshAgentMessage(store.dispatch, message)
    for (const handler of [...wsMock.handlers]) handler(message)
  })
}

const stream = (event: Record<string, unknown>) => ({
  type: 'freshAgent.stream', messageId: 'msg_live', parentToolUseId: null, event,
})

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/**
 * Lets `rounds` debounced refetches run to completion, one act scope each: a
 * committed snapshot's effects (and the re-poll they ask for) run when its
 * act scope ends.
 */
async function settleRefetches(rounds: number) {
  for (let i = 0; i < rounds; i += 1) await advance(SNAPSHOT_DEBOUNCE_MS)
}

async function mount(store: Store) {
  render(<Provider store={store}><StoreBackedView /></Provider>)
  await advance(0)
  await advance(SNAPSHOT_DEBOUNCE_MS)
}

const fetchCount = () => apiMock.getFreshAgentThreadSnapshot.mock.calls.length

beforeEach(() => {
  vi.useFakeTimers()
  resetSnapshotSchedulerForTests()
  wsMock.handlers.clear()
  wsMock.send.mockReset()
  apiMock.getFreshAgentThreadSnapshot.mockReset()
})

afterEach(() => {
  cleanup()
  resetSnapshotSchedulerForTests()
  vi.useRealTimers()
})

describe('FreshAgentView live transcript (transcript-live D5)', () => {
  it('refetches the snapshot within the debounce of a transcript announcement', async () => {
    serve(() => claudeSnapshot([userTurn('u-user', 'hi')]))
    const store = createStore()
    await mount(store)
    const before = fetchCount()
    expect(before).toBeGreaterThan(0)

    deliver(store, { type: 'freshAgent.session.changed', reason: 'transcript', uuid: 'u-user', parentToolUseId: null })
    await advance(SNAPSHOT_DEBOUNCE_MS - 1)
    expect(fetchCount()).toBe(before)
    await advance(1)
    expect(fetchCount()).toBe(before + 1)
  })

  it('re-polls for an announced line the snapshot lacks, at most LANDING_RECHECK_MAX times', async () => {
    serve(() => claudeSnapshot([userTurn('u-user', 'hi')]))
    const store = createStore()
    await mount(store)
    const before = fetchCount()

    deliver(store, { type: 'freshAgent.session.changed', reason: 'transcript', uuid: 'u-late', parentToolUseId: null })
    await settleRefetches(LANDING_RECHECK_MAX + 6)
    await advance(10_000)

    // The announcement's own refetch, then one re-poll per miss up to the bound.
    expect(fetchCount()).toBe(before + 1 + LANDING_RECHECK_MAX)
    expect(store.getState().freshAgentLive.bySession[KEY]?.expectedTurnIds ?? []).toEqual([])
  })

  it('stops re-polling as soon as the line lands (as a turn or a bookkeeping line)', async () => {
    serve(
      () => claudeSnapshot([userTurn('u-user', 'hi')]),
      () => claudeSnapshot([userTurn('u-user', 'hi')]),
      () => claudeSnapshot([userTurn('u-user', 'hi')], ['u-user', 'u-absorbed']),
    )
    const store = createStore()
    await mount(store)
    const before = fetchCount()

    deliver(store, { type: 'freshAgent.session.changed', reason: 'transcript', uuid: 'u-absorbed', parentToolUseId: null })
    await settleRefetches(10)

    expect(fetchCount()).toBe(before + 2)
    expect(store.getState().freshAgentLive.bySession[KEY].expectedTurnIds).toEqual([])
  })

  it('shows streamed text once while it streams and after its line lands, then drops the tail when the turn ends', async () => {
    serve(() => claudeSnapshot([userTurn('u-user', 'question')]))
    const store = createStore()
    await mount(store)

    deliver(store, { type: 'freshAgent.status', status: 'running' })
    deliver(store, stream({ type: 'message_start', message: { id: 'msg_live' } }))
    deliver(store, stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    deliver(store, stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The streamed answer' } }))
    await advance(LIVE_STREAM_FLUSH_MS)
    expect(screen.getAllByText('The streamed answer')).toHaveLength(1)
    expect(screen.getByRole('article', { name: /live response/ })).toHaveTextContent('The streamed answer')

    serve(() => claudeSnapshot([userTurn('u-user', 'question'), assistantText('u-answer', 'The streamed answer')]))
    deliver(store, {
      type: 'freshAgent.assistant', content: [{ type: 'text', text: 'The streamed answer' }], uuid: 'u-answer', messageId: 'msg_live', parentToolUseId: null,
    })
    deliver(store, { type: 'freshAgent.session.changed', reason: 'transcript', uuid: 'u-answer', parentToolUseId: null })
    // A second block of the same turn is still streaming.
    deliver(store, stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }))
    deliver(store, stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Still going' } }))
    await advance(SNAPSHOT_DEBOUNCE_MS + LIVE_STREAM_FLUSH_MS)

    expect(screen.getAllByText('The streamed answer')).toHaveLength(1)
    expect(screen.getByRole('article', { name: /live response/ })).not.toHaveTextContent('The streamed answer')
    // Busy: the unlanded block stays.
    expect(screen.getByRole('article', { name: /live response/ })).toHaveTextContent('Still going')
    expect(store.getState().freshAgentLive.bySession[KEY].blocks.map((block) => block.text)).toEqual(['Still going'])

    // The turn ends; its last line lands with the refetch the result triggers.
    serve(() => claudeSnapshot([
      userTurn('u-user', 'question'), assistantText('u-answer', 'The streamed answer'), assistantText('u-more', 'Still going'),
    ]))
    deliver(store, {
      type: 'freshAgent.assistant', content: [{ type: 'text', text: 'Still going' }], uuid: 'u-more', messageId: 'msg_live', parentToolUseId: null,
    })
    deliver(store, { type: 'freshAgent.session.changed', reason: 'transcript', uuid: 'u-more', parentToolUseId: null })
    deliver(store, { type: 'freshAgent.result', costUsd: 0.01 })
    await settleRefetches(4)

    expect(screen.queryByRole('article', { name: /live response/ })).not.toBeInTheDocument()
    expect(screen.getAllByText('Still going')).toHaveLength(1)
    expect(store.getState().freshAgentLive.bySession[KEY]).toMatchObject({ blocks: [], expectedTurnIds: [] })
  })

  it('keeps an unlanded block after the turn ends until its line lands', async () => {
    serve(() => claudeSnapshot([userTurn('u-user', 'question')]))
    const store = createStore()
    await mount(store)

    deliver(store, { type: 'freshAgent.status', status: 'running' })
    deliver(store, stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    deliver(store, stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Slow to land' } }))
    deliver(store, {
      type: 'freshAgent.assistant', content: [{ type: 'text', text: 'Slow to land' }], uuid: 'u-slow', messageId: 'msg_live', parentToolUseId: null,
    })
    deliver(store, { type: 'freshAgent.session.changed', reason: 'transcript', uuid: 'u-slow', parentToolUseId: null })
    deliver(store, { type: 'freshAgent.result', costUsd: 0.01 })
    // The first refetch after the result misses the line: the text stays on screen.
    await advance(SNAPSHOT_DEBOUNCE_MS)
    expect(screen.getByRole('article', { name: /live response/ })).toHaveTextContent('Slow to land')

    serve(() => claudeSnapshot([
      userTurn('u-user', 'question'), assistantText('u-slow', 'Slow to land'),
    ]))
    await settleRefetches(2)
    expect(screen.queryByRole('article', { name: /live response/ })).not.toBeInTheDocument()
    expect(screen.getAllByText('Slow to land')).toHaveLength(1)
  })

  it('renders the tail only while the pane is visible, and shows the whole tail on reveal', async () => {
    serve(() => claudeSnapshot([userTurn('u-user', 'question')]))
    const store = createStore()
    const view = render(<Provider store={store}><StoreBackedView hidden /></Provider>)
    await advance(0)
    await advance(SNAPSHOT_DEBOUNCE_MS)

    deliver(store, { type: 'freshAgent.status', status: 'running' })
    deliver(store, stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    deliver(store, stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Written while hidden' } }))
    await advance(LIVE_STREAM_FLUSH_MS)
    // A background pane keeps the tail in the store but renders none of it.
    expect(store.getState().freshAgentLive.bySession[KEY].blocks.map((block) => block.text)).toEqual(['Written while hidden'])
    expect(screen.queryByRole('article', { name: /live response/ })).not.toBeInTheDocument()

    // On reveal the pane refreshes its (now stale) transcript first, as for any
    // hidden pane, then shows the tail as it stands.
    serve(() => claudeSnapshot([userTurn('u-user', 'question')], ['u-user'], 2))
    view.rerender(<Provider store={store}><StoreBackedView /></Provider>)
    await settleRefetches(3)
    expect(screen.getByRole('article', { name: /live response/ })).toHaveTextContent('Written while hidden')
  })

  it('shows one live reel: the transcript\'s own live strip yields to the live tail', async () => {
    serve(() => claudeSnapshot([
      userTurn('u-user', 'question'), assistantTool('u-tool', 'Bash'),
    ]))
    const store = createStore()
    await mount(store)
    deliver(store, { type: 'freshAgent.status', status: 'running' })
    // Let every refresh the status change causes settle: the tail must take
    // over on its own, not ride on an unrelated re-render.
    await settleRefetches(3)
    // Busy with no live content: the last durable activity line is the live one.
    expect(screen.getAllByLabelText('running')).toHaveLength(1)

    // The block opens empty (nothing live to show yet); the session record's
    // streaming flag changes with it, so let that settle too.
    deliver(store, stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }))
    await settleRefetches(3)
    expect(screen.getAllByLabelText('running')).toHaveLength(1)
    expect(screen.queryByRole('article', { name: /live response/ })).not.toBeInTheDocument()

    // Its first text arrives: the tail takes over the live reel.
    deliver(store, stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'next step' } }))
    await advance(LIVE_STREAM_FLUSH_MS)

    const running = screen.getAllByLabelText('running')
    expect(running).toHaveLength(1)
    const liveArticle = screen.getByRole('article', { name: /live response/ })
    expect(within(liveArticle).getByLabelText('running')).toBe(running[0])
  })
})

describe('provider notices (transcript-live D6)', () => {
  it('shows a notice in the pane banner without ending the running turn', async () => {
    serve(() => claudeSnapshot([userTurn('u-user', 'question')]))
    const store = createStore()
    await mount(store)
    deliver(store, { type: 'freshAgent.status', status: 'running' })
    const sessionsBefore = store.getState().freshAgent.sessions

    deliver(store, {
      type: 'freshAgent.notice',
      level: 'error',
      code: 'COMPACTION_FAILED',
      message: 'Error during compaction: API Error: 400 prompt is too long',
    })

    expect(screen.getByRole('alert')).toHaveTextContent('Error during compaction: API Error: 400 prompt is too long')
    expect(store.getState().freshAgent.sessions).toBe(sessionsBefore)
    expect(store.getState().freshAgent.sessions[KEY].status).toBe('running')
    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument()
  })

  it('tells when a rate limit resets, in local time', async () => {
    serve(() => claudeSnapshot([userTurn('u-user', 'question')]))
    const store = createStore()
    await mount(store)
    const resetsAt = Math.floor(Date.now() / 1000) + 2 * 60 * 60
    const expectedTime = new Date(resetsAt * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

    deliver(store, {
      type: 'freshAgent.notice',
      level: 'error',
      code: 'RATE_LIMITED',
      message: 'You have reached your Claude usage limit.',
      rateLimit: { status: 'rejected', resetsAt, rateLimitType: 'five_hour' },
    })

    const banner = screen.getByRole('alert')
    expect(banner).toHaveTextContent('You have reached your Claude usage limit.')
    expect(banner).toHaveTextContent(expectedTime)
  })

  it('shows each notice once, even when the same text repeats', async () => {
    serve(() => claudeSnapshot([userTurn('u-user', 'question')]))
    const store = createStore()
    await mount(store)
    const notice = { type: 'freshAgent.notice', level: 'warning', code: 'INFORMATIONAL', message: 'Hook feedback: lint failed' }

    deliver(store, notice)
    expect(screen.getByRole('alert')).toHaveTextContent('Hook feedback: lint failed')
    await advance(10_000)
    expect(screen.queryByText('Hook feedback: lint failed')).not.toBeInTheDocument()

    deliver(store, notice)
    expect(screen.getByRole('alert')).toHaveTextContent('Hook feedback: lint failed')
  })
})

describe('the CLI\'s own permission mode (transcript-live D7)', () => {
  function setPanePermissionMode(store: Store, permissionMode: string) {
    store.dispatch(mergePaneContent({ tabId: 'tab-1', paneId: 'pane-1', updates: { permissionMode } }))
  }

  function paneContent(store: Store) {
    const layout = store.getState().panes.layouts['tab-1']
    if (!layout || layout.type !== 'leaf' || layout.content.kind !== 'fresh-agent') throw new Error('missing pane')
    return layout.content
  }

  function sends() {
    return wsMock.send.mock.calls.map(([message]) => message as Record<string, any>).filter((message) => message?.type === 'freshAgent.send')
  }

  it('adopts a mode change the CLI reports and keeps it on the next send', async () => {
    serve(() => claudeSnapshot([userTurn('u-user', 'plan it')]))
    const store = createStore()
    setPanePermissionMode(store, 'plan')
    await mount(store)

    // ExitPlanMode was approved: the CLI left plan mode on its own.
    deliver(store, { type: 'freshAgent.session.metadata', permissionMode: 'default' })
    await advance(0)
    expect(paneContent(store).permissionMode).toBe('default')

    const composer = screen.getByRole('textbox', { name: 'Chat message input' })
    act(() => {
      fireEvent.change(composer, { target: { value: 'now build it' } })
    })
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    })
    expect(sends().at(-1)?.settings?.permissionMode).toBe('default')
  })

  it('leaves the pane\'s own later choice alone when unrelated metadata repeats the session\'s mode', async () => {
    serve(() => claudeSnapshot([userTurn('u-user', 'hi')]))
    const store = createStore()
    setPanePermissionMode(store, 'plan')
    await mount(store)
    deliver(store, { type: 'freshAgent.session.metadata', permissionMode: 'default' })
    await advance(0)

    // The user picks a mode in the pane; a model-only statement must not undo it.
    act(() => setPanePermissionMode(store, 'acceptEdits'))
    deliver(store, { type: 'freshAgent.session.metadata', model: 'claude-sonnet-4-6', permissionMode: 'default' })
    deliver(store, { type: 'freshAgent.session.metadata', model: 'claude-opus-4-6' })
    await advance(0)
    expect(paneContent(store).permissionMode).toBe('acceptEdits')
  })

  it.each(['auto', 'dontAsk'])('lets go of its own mode when the CLI reports one the pane cannot show (%s), so the next send keeps the CLI\'s', async (cliMode) => {
    serve(() => claudeSnapshot([userTurn('u-user', 'plan it')]))
    const store = createStore()
    setPanePermissionMode(store, 'plan')
    await mount(store)

    // ExitPlanMode was approved: the CLI went back to the mode it had before plan mode.
    deliver(store, { type: 'freshAgent.session.metadata', permissionMode: cliMode })
    await advance(0)
    expect(paneContent(store).permissionMode).toBeUndefined()

    const composer = screen.getByRole('textbox', { name: 'Chat message input' })
    act(() => {
      fireEvent.change(composer, { target: { value: 'now build it' } })
    })
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    })
    expect(sends().at(-1)?.settings).toBeDefined()
    expect(sends().at(-1)?.settings).not.toHaveProperty('permissionMode')
  })
})
