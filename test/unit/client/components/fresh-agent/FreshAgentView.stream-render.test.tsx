import { Profiler, type ProfilerOnRenderCallback } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
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

// Transcript-live plan D5 (acceptance 10): a token re-renders only the live
// tail. The pane's view — header, status strip, composer, transcript — does
// not commit per delta. The tail itself is replaced by a stub that subscribes
// to nothing, so every commit the profiler sees belongs to the view.

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

const tailMock = vi.hoisted(() => ({ sessionKeys: [] as string[] }))

vi.mock('@/components/fresh-agent/FreshAgentLiveTail', async () => {
  const actual = await vi.importActual<typeof import('@/components/fresh-agent/FreshAgentLiveTail')>('@/components/fresh-agent/FreshAgentLiveTail')
  return {
    ...actual,
    FreshAgentLiveTail: ({ sessionKey }: { sessionKey: string }) => {
      tailMock.sessionKeys.push(sessionKey)
      return <div data-testid="live-tail-stub" />
    },
  }
})

vi.mock('@/components/markdown/LazyMarkdown', async () => {
  const { MarkdownRenderer } = await import('@/components/markdown/MarkdownRenderer')
  return {
    LazyMarkdown: ({ content }: { content: string }) => <MarkdownRenderer content={content} />,
  }
})

const SESSION_ID = '550e8400-e29b-41d4-a716-44665544d0a5'
const locator = { sessionId: SESSION_ID, sessionType: 'freshclaude' as const, provider: 'claude' as const }
const KEY = `freshclaude:claude:${SESSION_ID}`

function claudeSnapshot() {
  return {
    sessionType: 'freshclaude',
    provider: 'claude',
    threadId: SESSION_ID,
    sessionId: SESSION_ID,
    revision: 1,
    latestTurnId: 'u-user',
    status: 'idle',
    summary: '',
    capabilities: { send: true, interrupt: true, approvals: false, questions: false, fork: false },
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    pendingApprovals: [],
    pendingQuestions: [],
    worktrees: [],
    diffs: [],
    childThreads: [],
    turns: [{ id: 'u-user', turnId: 'u-user', role: 'user', summary: 'go', items: [{ id: 'u-user-text', kind: 'text', text: 'go' }] }],
    extensions: { claude: { transcriptLineUuids: ['u-user'] } },
  }
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
    content: { kind: 'fresh-agent', ...locator, createRequestId: 'req-stream-render', status: 'idle' },
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

function deliver(store: Store, event: Record<string, unknown>) {
  const message = { type: 'freshAgent.event', ...locator, event: { sessionId: SESSION_ID, ...event } }
  act(() => {
    handleFreshAgentMessage(store.dispatch, message)
    for (const handler of [...wsMock.handlers]) handler(message)
  })
}

const stream = (event: Record<string, unknown>) => ({
  type: 'freshAgent.stream', messageId: 'msg_profiled', parentToolUseId: null, event,
})

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  resetSnapshotSchedulerForTests()
  wsMock.handlers.clear()
  wsMock.send.mockReset()
  tailMock.sessionKeys = []
  apiMock.getFreshAgentThreadSnapshot.mockReset()
  apiMock.getFreshAgentThreadSnapshot.mockImplementation(async () => claudeSnapshot())
})

afterEach(() => {
  cleanup()
  resetSnapshotSchedulerForTests()
  vi.useRealTimers()
})

describe('FreshAgentView under a token stream (transcript-live D5)', () => {
  it('does not commit once per delta; only the live tail follows the stream', async () => {
    const store = createStore()
    let commits = 0
    const onRender: ProfilerOnRenderCallback = () => { commits += 1 }
    render(
      <Provider store={store}>
        <Profiler id="FreshAgentView" onRender={onRender}>
          <StoreBackedView />
        </Profiler>
      </Provider>,
    )
    await advance(0)
    await advance(SNAPSHOT_DEBOUNCE_MS)
    expect(tailMock.sessionKeys).toContain(KEY)

    deliver(store, { type: 'freshAgent.status', status: 'running' })
    deliver(store, stream({ type: 'message_start', message: { id: 'msg_profiled' } }))
    deliver(store, stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    deliver(store, stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'first ' } }))
    // The tail starts showing content: the transcript's own live strip yields
    // to it (one commit per turn, not per token).
    await advance(LIVE_STREAM_FLUSH_MS)
    await advance(500)
    commits = 0
    const fetchesBefore = apiMock.getFreshAgentThreadSnapshot.mock.calls.length

    // 200 tokens in five flush windows: well inside the 3 s busy poll, so no
    // snapshot read lands in the window and every commit would be the stream's.
    for (let i = 0; i < 200; i += 1) {
      deliver(store, stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `t${i} ` } }))
      if (i % 40 === 39) await advance(LIVE_STREAM_FLUSH_MS)
    }

    expect(apiMock.getFreshAgentThreadSnapshot.mock.calls.length).toBe(fetchesBefore)
    expect(store.getState().freshAgentLive.bySession[KEY].blocks[0].text).toContain('t199')
    expect(commits).toBe(0)
  })
})
