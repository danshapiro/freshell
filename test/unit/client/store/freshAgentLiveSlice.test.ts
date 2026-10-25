import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import freshAgentReducer, {
  markSessionLost,
  materializeSession,
  removeSession,
  sessionError,
  sessionExited,
  setSessionStatus,
  turnResult,
} from '@/store/freshAgentSlice'
import freshAgentLiveReducer, {
  assistantBlockBound,
  liveRetrySet,
  liveTailCleared,
  liveTailViewerAdded,
  liveTailViewerRemoved,
  streamOpsApplied,
  transcriptAnnounced,
  transcriptExpectationsDropped,
  transcriptLanded,
  transcriptProjectionSnapshotReceived,
} from '@/store/freshAgentLiveSlice'
import { FreshAgentSnapshotSchema } from '@shared/fresh-agent-contract'
import { handleFreshAgentMessage } from '@/lib/fresh-agent-ws'
import { LIVE_STREAM_FLUSH_MS, streamBatcherFor } from '@/lib/fresh-agent-stream-batcher'
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
  const codexLocator = { sessionId: 'codex-reconnect', sessionType: 'freshcodex' as const, provider: 'codex' as const }
  const codexKey = 'freshcodex:codex:codex-reconnect'
  const codexSnapshot = (revision = 2) => FreshAgentSnapshotSchema.parse({ sessionType: 'freshcodex', provider: 'codex', threadId: codexLocator.sessionId, revision: 0, status: 'running', capabilities: { send: false, interrupt: true, approvals: false, questions: false, fork: false }, tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, turns: [{ id: 't', turnId: 't', role: 'assistant', summary: '', items: [{ id: 'a', kind: 'text', text: 'Hel' }] }], extensions: { codex: { projection: { id: 'p', historyGeneration: 0, eventRevision: revision, eventOwnedTurnIds: ['t'], nativePreviewTurnIds: [], nativeFinalTurnIds: [], turnRows: { t: ['t'] }, turnOutputStates: {} } } } })

  it('buffers a reconnect delta without adopting its source, then applies it to the captured event-owned prefix', () => {
    const store = createStore()
    handleFreshAgentMessage(store.dispatch, { type: 'freshAgent.event', ...codexLocator, event: { type: 'freshAgent.transcript.patch', sessionId: codexLocator.sessionId, projectionId: 'p', historyGeneration: 0, ops: [{ op: 'appendItem', nativeTurnId: 't', rowId: 't', itemId: 'a', field: 'text', text: 'lo', revision: 3 }] } })
    expect(tail(store, codexKey).projection).toBeUndefined()
    store.dispatch(transcriptProjectionSnapshotReceived({ ...codexLocator, snapshot: codexSnapshot() }))
    expect(tail(store, codexKey).projection?.turns[0].items).toEqual([{ id: 'a', kind: 'text', text: 'Hello' }])
  })

  it('flags a bounded reconnect-buffer gap until a current authoritative event prefix arrives', () => {
    const store = createStore()
    for (let revision = 3; revision < 100; revision++) handleFreshAgentMessage(store.dispatch, { type: 'freshAgent.event', ...codexLocator, event: { type: 'freshAgent.transcript.patch', sessionId: codexLocator.sessionId, projectionId: 'p', historyGeneration: 0, ops: [{ op: 'appendItem', nativeTurnId: 't', rowId: 't', itemId: 'a', field: 'text', text: 'x'.repeat(2048), revision }] } })
    store.dispatch(transcriptProjectionSnapshotReceived({ ...codexLocator, snapshot: codexSnapshot() }))
    expect(tail(store, codexKey).projection?.needsResnapshot).toBe(true)
    store.dispatch(transcriptProjectionSnapshotReceived({ ...codexLocator, snapshot: codexSnapshot(99) }))
    expect(tail(store, codexKey).projection?.needsResnapshot).not.toBe(true)
    expect(tail(store, codexKey).projection?.turns[0].items).toEqual([{ id: 'a', kind: 'text', text: 'Hel' }])
  })

  it('host loss preserves a prior failure and freezes completed output as unconfirmed rather than changing it to an interruption', () => {
    const store = createStore()
    const snapshot = codexSnapshot()
    snapshot.turns[0].error = { name: 'ProviderError', message: 'The native turn failed' }
    store.dispatch(transcriptProjectionSnapshotReceived({ ...codexLocator, snapshot }))
    handleFreshAgentMessage(store.dispatch, { type: 'freshAgent.event', ...codexLocator, event: { type: 'freshAgent.transcript.patch', sessionId: codexLocator.sessionId, projectionId: 'p', historyGeneration: 0, ops: [{ op: 'settleTurn', nativeTurnId: 't', status: 'failed', revision: 3 }] } })
    expect(tail(store, codexKey).projection?.turns[0].outputState?.diagnostic).not.toBe('interrupted')
    store.dispatch(markSessionLost(codexLocator))
    expect(tail(store, codexKey).projection?.turns[0]).toMatchObject({ error: { message: 'The native turn failed' }, outputState: { diagnostic: 'unsaved', refreshPending: false } })
  })
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

  it('lands a block it never learned the line of by its API message id and position', () => {
    const store = createStore()
    // The snapshot holding msg_1's lines outran the assistant frames that name them.
    streamTurn(store)
    apply(store, start('msg_2', 0, 'text'), delta('msg_2', 0, 'next message'))
    store.dispatch(transcriptLanded({
      sessionKey: KEY,
      present: ['line-a', 'line-b'],
      messageBlockKinds: { msg_1: ['thinking', 'text'] },
    }))
    // msg_1's thinking (0) and text (1) are on screen; its tool (2) and msg_2 are not.
    expect(tail(store).blocks.map((block) => `${block.messageId}:${block.index}`)).toEqual(['msg_1:2', 'msg_2:0'])
  })

  it('trusts a bound block\'s uuid over its position, and never lands a block of another kind', () => {
    const store = createStore()
    apply(store, start('msg_1', 0, 'text'), delta('msg_1', 0, 'bound'), start('msg_1', 1, 'thinking'), delta('msg_1', 1, 'mismatch'))
    store.dispatch(assistantBlockBound({ ...locator, uuid: 'u-text', messageId: 'msg_1', content: [{ type: 'text', text: 'bound' }] }))
    store.dispatch(transcriptLanded({
      sessionKey: KEY,
      present: ['some-other-line'],
      messageBlockKinds: { msg_1: ['text', 'text'] },
    }))
    expect(tail(store).blocks.map((block) => block.text)).toEqual(['bound', 'mismatch'])
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
    ['the pane clears it after the turn ended', (store: Store) => {
      store.dispatch(turnResult(locator))
      store.dispatch(liveTailCleared({ sessionKey: KEY }))
    }],
  ])('clears the tail when %s', (_label, end) => {
    const store = createStore()
    store.dispatch(liveTailViewerAdded({ sessionKey: KEY }))
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
    store.dispatch(liveTailViewerAdded({ sessionKey: KEY }))
    apply(store, start('msg_1', 0, 'text'), delta('msg_1', 0, 'kept'))
    event(store)
    expect(tail(store).blocks.map((block) => block.text)).toEqual(['kept'])
  })

  it('drops only the retry on a session error: the blocks and the lines the pane waits for stay until they land', () => {
    const store = createStore()
    store.dispatch(liveTailViewerAdded({ sessionKey: KEY }))
    apply(store, start('msg_1', 0, 'text'), delta('msg_1', 0, 'answer'))
    store.dispatch(assistantBlockBound({ ...locator, uuid: 'u-1', messageId: 'msg_1', content: [{ type: 'text', text: 'answer' }] }))
    store.dispatch(transcriptAnnounced({ ...locator, uuid: 'u-1' }))
    apply(store, start('msg_1', 1, 'text'), delta('msg_1', 1, 'still streaming'))
    store.dispatch(liveRetrySet({ ...locator, attempt: 3 }))

    // error_max_turns after its result, or a refused configure mid-turn.
    store.dispatch(sessionError({ ...locator, message: 'Claude reached its turn limit.' }))

    expect(tail(store).retry).toBeUndefined()
    expect(tail(store).blocks.map((block) => block.text)).toEqual(['answer', 'still streaming'])
    expect(tail(store).expectedTurnIds).toEqual(['u-1'])
    // The streaming block keeps growing.
    apply(store, delta('msg_1', 1, ' and more'))
    expect(tail(store).blocks[1].text).toBe('still streaming and more')
  })

  it('the pane\'s clear keeps the blocks of a turn still streaming and drops those of a turn that ended', () => {
    const store = createStore()
    store.dispatch(liveTailViewerAdded({ sessionKey: KEY }))
    apply(store, start('msg_1', 0, 'text'), delta('msg_1', 0, 'previous answer'))
    store.dispatch(turnResult(locator))
    apply(store, start('msg_2', 0, 'text'), delta('msg_2', 0, 'next answer'))
    store.dispatch(transcriptAnnounced({ ...locator, uuid: 'u-gone' }))

    // The pane believes the session idle (an error said so) while the CLI streams on.
    store.dispatch(liveTailCleared({ sessionKey: KEY }))

    expect(tail(store).blocks.map((block) => block.text)).toEqual(['next answer'])
    expect(tail(store).expectedTurnIds).toEqual([])
    apply(store, delta('msg_2', 0, ', continued'))
    expect(tail(store).blocks[0].text).toBe('next answer, continued')

    store.dispatch(turnResult(locator))
    store.dispatch(liveTailCleared({ sessionKey: KEY }))
    expect(tail(store).blocks).toEqual([])
  })

  it.each([
    ['its result arrives', (store: Store) => store.dispatch(turnResult(locator))],
    ['its status turns idle', (store: Store) => store.dispatch(setSessionStatus({ ...locator, status: 'idle' }))],
    ['an error ends it', (store: Store) => store.dispatch(sessionError({ ...locator, message: 'boom' }))],
  ])('drops the tail no visible pane settles when its turn ends (%s)', (_label, end) => {
    const store = createStore()
    apply(store, start('msg_1', 0, 'text'), delta('msg_1', 0, 'nobody here sees this'))
    store.dispatch(transcriptAnnounced({ ...locator, uuid: 'u-1' }))
    store.dispatch(liveRetrySet({ ...locator, attempt: 1 }))
    end(store)
    expect(tail(store)).toBeUndefined()
  })

  it('keeps a tail while any visible pane settles it, and drops it at the turn\'s end once the last one left', () => {
    const store = createStore()
    store.dispatch(liveTailViewerAdded({ sessionKey: KEY }))
    store.dispatch(liveTailViewerAdded({ sessionKey: KEY }))
    apply(store, start('msg_1', 0, 'text'), delta('msg_1', 0, 'first turn'))
    store.dispatch(liveTailViewerRemoved({ sessionKey: KEY }))
    store.dispatch(turnResult(locator))
    expect(tail(store).blocks.map((block) => block.text)).toEqual(['first turn'])

    // A pane leaving drops nothing by itself (a split remounts its panes).
    store.dispatch(liveTailViewerRemoved({ sessionKey: KEY }))
    expect(tail(store).blocks.map((block) => block.text)).toEqual(['first turn'])
    apply(store, start('msg_2', 0, 'text'), delta('msg_2', 0, 'second turn'))
    store.dispatch(turnResult(locator))
    expect(tail(store)).toBeUndefined()
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
  afterEach(() => {
    vi.useRealTimers()
  })

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

  it('applies a session\'s pending stream events before a stopped recovery removes it, leaving no tail behind', () => {
    vi.useFakeTimers()
    const store = createStore()
    handleFreshAgentMessage(store.dispatch, stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    handleFreshAgentMessage(store.dispatch, stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'pending' } }))
    handleFreshAgentMessage(store.dispatch, { type: 'freshAgent.recovery.stopped', ...locator, success: true })
    vi.advanceTimersByTime(LIVE_STREAM_FLUSH_MS)
    expect(tail(store)).toBeUndefined()
  })

  it('drops a retry frame without a positive attempt', () => {
    const store = createStore()
    handleFreshAgentMessage(store.dispatch, frame({ type: 'freshAgent.retry', attempt: 'soon' }))
    expect(tail(store)).toBeUndefined()
  })
})
