import { Profiler } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { appReducers } from '@/store/appReducers'
import { initLayout } from '@/store/panesSlice'
import { setStatus } from '@/store/connectionSlice'
import { useAppSelector } from '@/store/hooks'
import { FreshAgentView } from '@/components/fresh-agent/FreshAgentView'
import { handleFreshAgentMessage } from '@/lib/fresh-agent-ws'
import { resetSnapshotSchedulerForTests, SNAPSHOT_DEBOUNCE_MS } from '@/lib/fresh-agent-snapshot-scheduler'
import { LIVE_STREAM_FLUSH_MS } from '@/lib/fresh-agent-stream-batcher'

// Transcript-live plan D9: one freshclaude turn end to end in the DOM — the
// app's real store and reducers, the real websocket handler (with its stream
// batcher) and the real pane, with only the snapshot API mocked. Streamed
// text appears, the snapshot holding its line commits, the turn ends; across
// every React commit in between, the text is on screen exactly once: never
// twice (tail and transcript together) and never zero times (a gap between
// the tail letting go and the transcript taking over).

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

// Synchronous markdown (the transcript tests' established mock), so a frame
// never holds both the renderer's Suspense fallback and its content.
vi.mock('@/components/markdown/LazyMarkdown', async () => {
  const { MarkdownRenderer } = await import('@/components/markdown/MarkdownRenderer')
  return {
    LazyMarkdown: ({ content }: { content: string }) => <MarkdownRenderer content={content} />,
  }
})

const SESSION_ID = '550e8400-e29b-41d4-a716-44665544d009'
const locator = { sessionId: SESSION_ID, sessionType: 'freshclaude' as const, provider: 'claude' as const }
const ANSWER = 'Kittens are small cats that love yarn.'
const ANSWER_CHUNKS = ['Kittens are ', 'small cats ', 'that love ', 'yarn.']
const FOLLOW_UP = 'And what about puppies?'
const NEXT_ANSWER = 'Puppies are young dogs.'

type Turn = { id: string; turnId: string; messageId?: string; role: 'user' | 'assistant'; summary: string; items: unknown[] }

const question: Turn = { id: 'u-question', turnId: 'u-question', role: 'user', summary: 'Tell me about kittens', items: [{ id: 'q', kind: 'text', text: 'Tell me about kittens' }] }
// As the server projects it: keyed by its line uuid, carrying its API message id.
const answer: Turn = { id: 'u-answer', turnId: 'u-answer', messageId: 'msg_kittens', role: 'assistant', summary: ANSWER, items: [{ id: 'a', kind: 'text', text: ANSWER }] }

function claudeSnapshot(turns: Turn[]) {
  return {
    sessionType: 'freshclaude',
    provider: 'claude',
    threadId: SESSION_ID,
    sessionId: SESSION_ID,
    revision: 1,
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
    extensions: { claude: { transcriptLineUuids: turns.map((turn) => turn.turnId) } },
  }
}

/** The transcript as the server would serve it next; a new object per read, as parsed JSON is. */
let served: Turn[] = []

function createStore() {
  const store = configureStore({
    reducer: appReducers,
    middleware: (getDefault) => getDefault({ serializableCheck: false, immutableCheck: false }),
  })
  store.dispatch(setStatus('ready'))
  store.dispatch(initLayout({
    tabId: 'tab-1',
    paneId: 'pane-1',
    content: { kind: 'fresh-agent', ...locator, createRequestId: 'req-live-flow', status: 'idle' },
  }))
  return store
}

type Store = ReturnType<typeof createStore>

function StoreBackedView() {
  const content = useAppSelector((state) => {
    const layout = state.panes.layouts['tab-1']
    if (!layout || layout.type !== 'leaf' || layout.content.kind !== 'fresh-agent') throw new Error('missing pane')
    return layout.content
  })
  return <FreshAgentView tabId="tab-1" paneId="pane-1" paneContent={content} />
}

/** How many times the answer is on screen, counted after every React commit. */
function countOnScreen(text: string): number {
  return (document.body.textContent ?? '').split(text).length - 1
}

/** Whether `first` shows above `second` (both on screen once). */
function onScreenBefore(first: string, second: string): boolean {
  const text = document.body.textContent ?? ''
  const a = text.indexOf(first)
  const b = text.indexOf(second)
  return a >= 0 && b >= 0 && a < b
}

function renderFlow(store: Store) {
  const frames: number[] = []
  render(
    <Profiler id="freshclaude-flow" onRender={() => { frames.push(countOnScreen(ANSWER)) }}>
      <Provider store={store}>
        <StoreBackedView />
      </Provider>
    </Profiler>,
  )
  return frames
}

function deliver(store: Store, event: Record<string, unknown>) {
  const message = { type: 'freshAgent.event', ...locator, event: { sessionId: SESSION_ID, ...event } }
  act(() => {
    handleFreshAgentMessage(store.dispatch, message)
    for (const handler of [...wsMock.handlers]) handler(message)
  })
}

const stream = (event: Record<string, unknown>, messageId = 'msg_kittens') => ({
  type: 'freshAgent.stream', messageId, parentToolUseId: null, event,
})

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function settleRefetches(rounds: number) {
  for (let i = 0; i < rounds; i += 1) await advance(SNAPSHOT_DEBOUNCE_MS)
}

/** The model streams the answer, then the CLI sends the block's message and announces its line. */
async function streamAnswer(store: Store) {
  deliver(store, { type: 'freshAgent.status', status: 'running' })
  deliver(store, stream({ type: 'message_start', message: { id: 'msg_kittens' } }))
  deliver(store, stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  for (const chunk of ANSWER_CHUNKS) {
    deliver(store, stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } }))
    await advance(LIVE_STREAM_FLUSH_MS)
  }
  deliver(store, stream({ type: 'content_block_stop', index: 0 }))
  deliver(store, {
    type: 'freshAgent.assistant', content: [{ type: 'text', text: ANSWER }], uuid: 'u-answer', messageId: 'msg_kittens', parentToolUseId: null,
  })
  deliver(store, { type: 'freshAgent.session.changed', reason: 'transcript', uuid: 'u-answer', parentToolUseId: null })
}

/** Every frame from the first one showing the answer: the answer is there exactly once. */
function framesSinceFirstShown(frames: number[]): number[] {
  const first = frames.findIndex((count) => count > 0)
  expect(first).toBeGreaterThanOrEqual(0)
  return frames.slice(first)
}

beforeEach(() => {
  vi.useFakeTimers()
  resetSnapshotSchedulerForTests()
  wsMock.handlers.clear()
  wsMock.send.mockReset()
  served = [question]
  apiMock.getFreshAgentThreadSnapshot.mockReset()
  apiMock.getFreshAgentThreadSnapshot.mockImplementation(async () => claudeSnapshot(served))
})

afterEach(() => {
  cleanup()
  resetSnapshotSchedulerForTests()
  vi.useRealTimers()
})

describe('freshclaude live rendering flow (transcript-live D9)', () => {
  it('shows a streamed answer exactly once from its first token through the landed transcript and the turn\'s end', async () => {
    const store = createStore()
    const frames = renderFlow(store)
    await settleRefetches(2)
    expect(countOnScreen(ANSWER)).toBe(0)

    served = [question, answer]
    await streamAnswer(store)
    await settleRefetches(3)
    deliver(store, { type: 'freshAgent.result', costUsd: 0.01 })
    deliver(store, { type: 'freshAgent.turn.complete', at: Date.now() })
    await settleRefetches(4)

    expect(countOnScreen(ANSWER)).toBe(1)
    expect(document.querySelector('[data-turn-source="live"]')).toBeNull()
    const shown = framesSinceFirstShown(frames)
    expect(shown.length).toBeGreaterThan(3)
    expect(shown.filter((count) => count !== 1)).toEqual([])
  })

  it('keeps the answer on screen exactly once when its line lands only after the turn ended', async () => {
    const store = createStore()
    const frames = renderFlow(store)
    await settleRefetches(2)

    // The CLI is slow to write the line: the refetches around the result miss it.
    await streamAnswer(store)
    deliver(store, { type: 'freshAgent.result', costUsd: 0.01 })
    await settleRefetches(2)
    expect(countOnScreen(ANSWER)).toBe(1)
    expect(document.querySelector('[data-turn-source="live"]')).not.toBeNull()

    served = [question, answer]
    await settleRefetches(4)

    expect(countOnScreen(ANSWER)).toBe(1)
    expect(document.querySelector('[data-turn-source="live"]')).toBeNull()
    expect(framesSinceFirstShown(frames).filter((count) => count !== 1)).toEqual([])
  })

  // error_max_turns, error_during_execution and error_max_budget_usd: the CLI
  // sends the turn's result and then the error that explains it, before it
  // writes the turn's last line (about 100 ms later).
  async function failTurn(store: Store) {
    deliver(store, { type: 'freshAgent.result', costUsd: 0.01 })
    deliver(store, { type: 'freshAgent.error', message: 'Claude reached its turn limit. Send a message to continue.', turnFailure: true })
    deliver(store, { type: 'freshAgent.turn.complete', at: Date.now() })
  }

  it('keeps the answer of a failed turn on screen exactly once when its line lands after the error and its refetches', async () => {
    const store = createStore()
    const frames = renderFlow(store)
    await settleRefetches(2)

    await streamAnswer(store)
    await failTurn(store)
    await settleRefetches(2)
    expect(countOnScreen(ANSWER)).toBe(1)

    served = [question, answer]
    await settleRefetches(4)

    expect(countOnScreen(ANSWER)).toBe(1)
    expect(document.querySelector('[data-turn-source="live"]')).toBeNull()
    expect(framesSinceFirstShown(frames).filter((count) => count !== 1)).toEqual([])
  })

  it('never blinks out the answer of a failed turn whose line lands 100 ms after the error', async () => {
    const store = createStore()
    const frames = renderFlow(store)
    await settleRefetches(2)

    await streamAnswer(store)
    await failTurn(store)
    await advance(100)
    served = [question, answer]
    await settleRefetches(6)

    expect(countOnScreen(ANSWER)).toBe(1)
    expect(document.querySelector('[data-turn-source="live"]')).toBeNull()
    expect(framesSinceFirstShown(frames).filter((count) => count !== 1)).toEqual([])
  })

  it('keeps streaming a block through an error that does not end the turn (a refused configure)', async () => {
    const store = createStore()
    renderFlow(store)
    await settleRefetches(2)
    const textOnScreen = () => document.querySelector('[data-turn-source="live"]')?.textContent ?? ''

    deliver(store, { type: 'freshAgent.status', status: 'running' })
    deliver(store, stream({ type: 'message_start', message: { id: 'msg_kittens' } }))
    deliver(store, stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    deliver(store, stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Kittens are ' } }))
    await advance(LIVE_STREAM_FLUSH_MS)

    // The user changed the model mid-turn: the server refuses until the turn ends.
    deliver(store, { type: 'freshAgent.error', code: 'CLAUDE_SETTINGS_FAILED', message: 'Wait for the current turn to finish before changing agent settings.' })
    deliver(store, stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'small cats ' } }))
    await advance(LIVE_STREAM_FLUSH_MS)
    expect(textOnScreen()).toContain('Kittens are small cats')

    // The refreshes the error causes come and go; the CLI streams on.
    await settleRefetches(4)
    deliver(store, stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'that love ' } }))
    deliver(store, stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'yarn.' } }))
    await advance(LIVE_STREAM_FLUSH_MS)
    expect(textOnScreen()).toContain(ANSWER)

    // The block completes and lands as usual.
    deliver(store, stream({ type: 'content_block_stop', index: 0 }))
    deliver(store, {
      type: 'freshAgent.assistant', content: [{ type: 'text', text: ANSWER }], uuid: 'u-answer', messageId: 'msg_kittens', parentToolUseId: null,
    })
    deliver(store, { type: 'freshAgent.session.changed', reason: 'transcript', uuid: 'u-answer', parentToolUseId: null })
    deliver(store, { type: 'freshAgent.result', costUsd: 0.01 })
    served = [question, answer]
    await settleRefetches(4)
    expect(countOnScreen(ANSWER)).toBe(1)
    expect(document.querySelector('[data-turn-source="live"]')).toBeNull()
  })

  it('keeps a finished answer above the next prompt sent before the answer\'s line landed, and the next answer below it', async () => {
    const store = createStore()
    renderFlow(store)
    await settleRefetches(2)

    await streamAnswer(store)
    deliver(store, { type: 'freshAgent.result', costUsd: 0.01 })
    deliver(store, { type: 'freshAgent.turn.complete', at: Date.now() })
    await advance(0)

    // The user sends the next prompt at once; the CLI has not written the answer's line yet.
    const composer = screen.getByRole('textbox', { name: 'Chat message input' })
    act(() => {
      fireEvent.change(composer, { target: { value: FOLLOW_UP } })
    })
    act(() => {
      fireEvent.keyDown(composer, { key: 'Enter' })
    })
    await advance(0)
    expect(wsMock.send.mock.calls.some(([message]) => (message as { type?: string })?.type === 'freshAgent.send')).toBe(true)
    expect(countOnScreen(ANSWER)).toBe(1)
    expect(countOnScreen(FOLLOW_UP)).toBe(1)
    expect(onScreenBefore(ANSWER, FOLLOW_UP)).toBe(true)

    // The next turn streams: its text goes below the prompt it answers.
    deliver(store, { type: 'freshAgent.status', status: 'running' })
    deliver(store, stream({ type: 'message_start', message: { id: 'msg_next' } }, 'msg_next'))
    deliver(store, stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'msg_next'))
    deliver(store, stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: NEXT_ANSWER } }, 'msg_next'))
    await advance(LIVE_STREAM_FLUSH_MS)
    expect(onScreenBefore(ANSWER, FOLLOW_UP)).toBe(true)
    expect(onScreenBefore(FOLLOW_UP, NEXT_ANSWER)).toBe(true)

    // The first answer's line lands: it stays above the prompt, once.
    served = [question, answer]
    await settleRefetches(3)
    expect(countOnScreen(ANSWER)).toBe(1)
    expect(onScreenBefore(ANSWER, FOLLOW_UP)).toBe(true)
    expect(onScreenBefore(FOLLOW_UP, NEXT_ANSWER)).toBe(true)
  })
})
