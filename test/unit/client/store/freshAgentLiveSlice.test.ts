import { describe, expect, it } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import freshAgentReducer, {
  markSessionLost,
  materializeSession,
  removeSession,
  sessionError,
  sessionExited,
  setSessionStatus,
} from '@/store/freshAgentSlice'
import freshAgentLiveReducer, {
  assistantBlockBound,
  liveRetrySet,
  liveTailCleared,
  streamOpsApplied,
  transcriptAnnounced,
  transcriptExpectationsDropped,
  transcriptLanded,
} from '@/store/freshAgentLiveSlice'
import { handleFreshAgentMessage } from '@/lib/fresh-agent-ws'
import { streamBatcherFor } from '@/lib/fresh-agent-stream-batcher'
import type { LiveStreamOp } from '@/store/freshAgentLiveTypes'

const locator = { sessionId: 'live-1', sessionType: 'freshclaude' as const, provider: 'claude' as const }
const KEY = 'freshclaude:claude:live-1'

function createStore() {
  return configureStore({
    reducer: { freshAgent: freshAgentReducer, freshAgentLive: freshAgentLiveReducer },
  })
}

type Store = ReturnType<typeof createStore>

const start = (messageId: string, index: number, kind: 'text' | 'thinking' | 'tool_use', extra: Partial<LiveStreamOp> = {}): LiveStreamOp => (
  { op: 'start', messageId, index, kind, ...extra } as LiveStreamOp
)
const delta = (messageId: string, index: number, text: string): LiveStreamOp => ({ op: 'delta', messageId, index, text })

function apply(store: Store, ...ops: LiveStreamOp[]) {
  store.dispatch(streamOpsApplied({ ...locator, ops }))
}

function tail(store: Store, key = KEY) {
  return store.getState().freshAgentLive.bySession[key]
}

/** One assistant message per content block, all sharing the API message id (real-CLI fact F2). */
function streamTurn(store: Store) {
  apply(store,
    start('msg_1', 0, 'thinking'), delta('msg_1', 0, 'pondering'),
    start('msg_1', 1, 'text'), delta('msg_1', 1, 'Hello'),
    start('msg_1', 2, 'tool_use', { name: 'Read', toolUseId: 'toolu_1' } as Partial<LiveStreamOp>),
  )
}

describe('freshAgentLive slice (transcript-live D3)', () => {
  it('binds each assistant message to the first unbound streamed block of its message id and kind', () => {
    const store = createStore()
    streamTurn(store)
    store.dispatch(assistantBlockBound({ ...locator, uuid: 'u-text', messageId: 'msg_1', content: [{ type: 'text', text: 'Hello' }] }))
    store.dispatch(assistantBlockBound({ ...locator, uuid: 'u-think', messageId: 'msg_1', content: [{ type: 'thinking', thinking: 'pondering' }] }))
    store.dispatch(assistantBlockBound({
      ...locator,
      uuid: 'u-tool',
      messageId: 'msg_1',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/repo/a.ts' } }],
    }))

    expect(tail(store).blocks).toEqual([
      { messageId: 'msg_1', index: 0, kind: 'thinking', text: 'pondering', uuid: 'u-think' },
      { messageId: 'msg_1', index: 1, kind: 'text', text: 'Hello', uuid: 'u-text' },
      { messageId: 'msg_1', index: 2, kind: 'tool_use', text: '', name: 'Read', toolUseId: 'toolu_1', uuid: 'u-tool', input: { file_path: '/repo/a.ts' } },
    ])
  })

  it('binds a block of another message id to nothing and binds no block twice', () => {
    const store = createStore()
    apply(store, start('msg_1', 0, 'text'), delta('msg_1', 0, 'one'), start('msg_2', 0, 'text'), delta('msg_2', 0, 'two'))
    store.dispatch(assistantBlockBound({ ...locator, uuid: 'u-2', messageId: 'msg_2', content: [{ type: 'text', text: 'two' }] }))
    store.dispatch(assistantBlockBound({ ...locator, uuid: 'u-3', messageId: 'msg_2', content: [{ type: 'text', text: 'three' }] }))
    store.dispatch(assistantBlockBound({ ...locator, uuid: 'u-9', messageId: 'msg_9', content: [{ type: 'text', text: 'never streamed' }] }))

    expect(tail(store).blocks.map((block) => [block.messageId, block.text, block.uuid])).toEqual([
      ['msg_1', 'one', undefined],
      ['msg_2', 'two', 'u-2'],
    ])
  })

  it('takes the bound message\'s text when the stream missed part of it', () => {
    const store = createStore()
    apply(store, start('msg_1', 0, 'text'), delta('msg_1', 0, 'Hel'))
    store.dispatch(assistantBlockBound({ ...locator, uuid: 'u-1', messageId: 'msg_1', content: [{ type: 'text', text: 'Hello, world' }] }))
    expect(tail(store).blocks[0]).toMatchObject({ text: 'Hello, world', uuid: 'u-1' })
  })

  it('drops deltas for a block whose start it never saw', () => {
    const store = createStore()
    apply(store, delta('msg_1', 0, 'mid-stream'), start('msg_1', 1, 'text'), delta('msg_1', 1, 'seen'))
    expect(tail(store).blocks).toEqual([{ messageId: 'msg_1', index: 1, kind: 'text', text: 'seen' }])
  })

  it('removes the blocks and expectations a snapshot shows have landed', () => {
    const store = createStore()
    streamTurn(store)
    store.dispatch(assistantBlockBound({ ...locator, uuid: 'u-think', messageId: 'msg_1', content: [{ type: 'thinking', thinking: 'pondering' }] }))
    store.dispatch(assistantBlockBound({ ...locator, uuid: 'u-text', messageId: 'msg_1', content: [{ type: 'text', text: 'Hello' }] }))
    for (const uuid of ['u-think', 'u-text', 'u-result']) store.dispatch(transcriptAnnounced({ ...locator, uuid }))
    store.dispatch(transcriptAnnounced({ ...locator, uuid: 'u-text' }))
    expect(tail(store).expectedTurnIds).toEqual(['u-think', 'u-text', 'u-result'])

    store.dispatch(transcriptLanded({ sessionKey: KEY, present: ['u-think', 'u-result', 'older-line'] }))

    expect(tail(store).blocks.map((block) => block.uuid ?? block.kind)).toEqual(['u-text', 'tool_use'])
    expect(tail(store).expectedTurnIds).toEqual(['u-text'])

    store.dispatch(transcriptExpectationsDropped({ sessionKey: KEY, uuids: ['u-text'] }))
    expect(tail(store).expectedTurnIds).toEqual([])
    // Giving up on the re-poll keeps the block: it still shows until it lands or the tail clears.
    expect(tail(store).blocks.map((block) => block.uuid ?? block.kind)).toEqual(['u-text', 'tool_use'])
  })

  it('shows a retry until the next block starts', () => {
    const store = createStore()
    store.dispatch(liveRetrySet({ ...locator, attempt: 2, maxRetries: 10, delayMs: 1200, errorStatus: 529, error: 'overloaded' }))
    expect(tail(store).retry).toEqual({ attempt: 2, maxRetries: 10, delayMs: 1200, errorStatus: 529, error: 'overloaded' })
    apply(store, delta('msg_1', 0, 'not a start'))
    expect(tail(store).retry).toBeDefined()
    apply(store, start('msg_1', 0, 'text'))
    expect(tail(store).retry).toBeUndefined()
  })

  it('moves the tail to the new key when the session materializes', () => {
    const store = createStore()
    apply(store, start('msg_1', 0, 'text'), delta('msg_1', 0, 'carried'))
    store.dispatch(transcriptAnnounced({ ...locator, uuid: 'u-1' }))
    store.dispatch(materializeSession({ ...locator, previousSessionId: 'live-1', sessionId: 'live-real' }))

    expect(tail(store)).toBeUndefined()
    expect(tail(store, 'freshclaude:claude:live-real')).toMatchObject({
      blocks: [{ text: 'carried' }],
      expectedTurnIds: ['u-1'],
    })
  })

  it.each([
    ['the session exits', (store: Store) => store.dispatch(sessionExited(locator))],
    ['the session is lost', (store: Store) => {
      store.dispatch(setSessionStatus({ ...locator, status: 'running' }))
      store.dispatch(markSessionLost(locator))
    }],
    ['the session is killed', (store: Store) => store.dispatch(removeSession(locator))],
    ['the status turns exited', (store: Store) => store.dispatch(setSessionStatus({ ...locator, status: 'exited' }))],
    ['the status turns stuck', (store: Store) => store.dispatch(setSessionStatus({ ...locator, status: 'stuck' }))],
    ['a turn error ends it', (store: Store) => store.dispatch(sessionError({ ...locator, message: 'boom' }))],
    ['the pane clears it', (store: Store) => store.dispatch(liveTailCleared({ sessionKey: KEY }))],
  ])('clears the tail when %s', (_label, end) => {
    const store = createStore()
    apply(store, start('msg_1', 0, 'text'), delta('msg_1', 0, 'gone'))
    store.dispatch(liveRetrySet({ ...locator, attempt: 1 }))
    store.dispatch(transcriptAnnounced({ ...locator, uuid: 'u-1' }))
    end(store)
    expect(tail(store)?.blocks ?? []).toEqual([])
    expect(tail(store)?.retry).toBeUndefined()
    expect(tail(store)?.expectedTurnIds ?? []).toEqual([])
  })

  it.each([
    ['the status turns idle (the pane clears it once the turn has landed)', (store: Store) => store.dispatch(setSessionStatus({ ...locator, status: 'idle' }))],
    ['a restore failure is reported', (store: Store) => store.dispatch(sessionError({ ...locator, code: 'RESTORE_NOT_FOUND', message: 'gone' }))],
  ])('keeps the tail when %s', (_label, event) => {
    const store = createStore()
    apply(store, start('msg_1', 0, 'text'), delta('msg_1', 0, 'kept'))
    event(store)
    expect(tail(store).blocks.map((block) => block.text)).toEqual(['kept'])
  })

  it('never writes a session that has no tail', () => {
    const store = createStore()
    const before = store.getState().freshAgentLive
    store.dispatch(sessionExited(locator))
    store.dispatch(liveTailCleared({ sessionKey: KEY }))
    store.dispatch(transcriptLanded({ sessionKey: KEY, present: ['x'] }))
    expect(store.getState().freshAgentLive).toBe(before)
  })
})

describe('websocket routing into the live tail (transcript-live D3)', () => {
  const frame = (event: Record<string, unknown>) => ({ type: 'freshAgent.event', ...locator, event: { sessionId: locator.sessionId, ...event } })
  const stream = (event: Record<string, unknown>, extra: Record<string, unknown> = {}) => frame({
    type: 'freshAgent.stream', messageId: 'msg_1', parentToolUseId: null, event, ...extra,
  })

  it('binds top-level assistant messages, expects announced lines, and ignores a subagent\'s', () => {
    const store = createStore()
    handleFreshAgentMessage(store.dispatch, stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    handleFreshAgentMessage(store.dispatch, stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }))
    handleFreshAgentMessage(store.dispatch, frame({
      type: 'freshAgent.assistant', content: [{ type: 'text', text: 'Hi' }], uuid: 'u-main', messageId: 'msg_1', parentToolUseId: null,
    }))
    handleFreshAgentMessage(store.dispatch, frame({ type: 'freshAgent.session.changed', reason: 'transcript', uuid: 'u-main', parentToolUseId: null }))
    // A subagent's assistant message and its announcement belong to the delegation, not the tail.
    handleFreshAgentMessage(store.dispatch, frame({
      type: 'freshAgent.assistant', content: [{ type: 'text', text: 'sub' }], uuid: 'u-sub', messageId: 'msg_1', parentToolUseId: 'toolu_agent',
    }))
    handleFreshAgentMessage(store.dispatch, frame({ type: 'freshAgent.session.changed', reason: 'transcript', uuid: 'u-sub', parentToolUseId: 'toolu_agent' }))
    // Other session.changed reasons are not transcript lines.
    handleFreshAgentMessage(store.dispatch, frame({ type: 'freshAgent.session.changed', reason: 'session-commands' }))

    expect(tail(store).blocks).toEqual([{ messageId: 'msg_1', index: 0, kind: 'text', text: 'Hi', uuid: 'u-main' }])
    expect(tail(store).expectedTurnIds).toEqual(['u-main'])
  })

  it('shows an API retry and clears it when the retried request streams', () => {
    const store = createStore()
    handleFreshAgentMessage(store.dispatch, frame({ type: 'freshAgent.status', status: 'running' }))
    const sessionsBefore = store.getState().freshAgent.sessions
    handleFreshAgentMessage(store.dispatch, frame({
      type: 'freshAgent.retry', attempt: 1, maxRetries: 10, delayMs: 500, errorStatus: 529, error: 'overloaded',
    }))
    expect(tail(store).retry).toEqual({ attempt: 1, maxRetries: 10, delayMs: 500, errorStatus: 529, error: 'overloaded' })
    // A retry never ends the turn or touches the session (transcript-live P4).
    expect(store.getState().freshAgent.sessions).toBe(sessionsBefore)
    expect(store.getState().freshAgent.sessions[KEY].status).toBe('running')

    handleFreshAgentMessage(store.dispatch, stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    streamBatcherFor(store.dispatch).flush()
    expect(tail(store).retry).toBeUndefined()
  })

  it('numbers each notice and drops a malformed one', () => {
    const store = createStore()
    handleFreshAgentMessage(store.dispatch, frame({ type: 'freshAgent.status', status: 'running' }))
    const sessionsBefore = store.getState().freshAgent.sessions
    handleFreshAgentMessage(store.dispatch, frame({ type: 'freshAgent.notice', level: 'warning', code: 'INFORMATIONAL', message: ' heads up ' }))
    expect(tail(store).notice).toEqual({ seq: 1, level: 'warning', code: 'INFORMATIONAL', message: 'heads up' })
    handleFreshAgentMessage(store.dispatch, frame({
      type: 'freshAgent.notice', level: 'loud', code: 'RATE_LIMIT_WARNING', message: 'near', rateLimit: { status: 'allowed_warning', resetsAt: 1761300000, extra: 1 },
    }))
    expect(tail(store).notice).toEqual({
      seq: 2, level: 'info', code: 'RATE_LIMIT_WARNING', message: 'near', rateLimit: { status: 'allowed_warning', resetsAt: 1761300000 },
    })
    handleFreshAgentMessage(store.dispatch, frame({ type: 'freshAgent.notice', level: 'error', code: 'X' }))
    expect(tail(store).notice?.seq).toBe(2)
    // A notice never ends the turn or touches the session (P4).
    expect(store.getState().freshAgent.sessions).toBe(sessionsBefore)
  })

  it('drops a retry frame without a positive attempt', () => {
    const store = createStore()
    handleFreshAgentMessage(store.dispatch, frame({ type: 'freshAgent.retry', attempt: 'soon' }))
    expect(tail(store)).toBeUndefined()
  })
})
