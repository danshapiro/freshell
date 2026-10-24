import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import freshAgentReducer, { materializeSession, sessionCreated } from '@/store/freshAgentSlice'
import freshAgentLiveReducer, { liveTailViewerAdded } from '@/store/freshAgentLiveSlice'
import { LIVE_STREAM_FLUSH_MS } from '@/lib/fresh-agent-stream-batcher'
import panesReducer, { initLayout, materializeFreshAgentSession, type PanesState } from '@/store/panesSlice'
import turnCompletionReducer, { markPaneAttention, markTabAttention } from '@/store/turnCompletionSlice'
import {
  foldReadyRuntimeOwners,
  foldSessionRuntimeOwnerFrame,
  handleFreshAgentMessage,
  registerFreshAgentCreate,
} from '@/lib/fresh-agent-ws'
import { ReadyMessageSchema } from '@/lib/ready-message-schema'
import { cancelCreate, _resetCancelledCreates } from '@/lib/create-cancellation'
import type { SessionRuntimeOwnerMessage } from '@shared/ws-protocol'
import { flushPersistedLayoutNow } from '@/store/persistControl'

function createFreshAgentStore() {
  return configureStore({
    reducer: {
      freshAgent: freshAgentReducer,
      freshAgentLive: freshAgentLiveReducer,
    },
  })
}

function emptyPanesState(): PanesState {
  return {
    layouts: {},
    activePane: {},
    paneTitles: {},
    paneTitleSetByUser: {},
    renameRequestTabId: null,
    renameRequestPaneId: null,
    zoomedPane: {},
    refreshRequestsByPane: {},
    restoreFallbackAttemptsByPane: {},
  }
}

function createFreshAgentPaneStore(seenActionTypes: string[] = []) {
  const actionRecorder = () => (next: (action: unknown) => unknown) => (action: { type?: string }) => {
    if (typeof action.type === 'string') seenActionTypes.push(action.type)
    return next(action)
  }

  return configureStore({
    reducer: {
      freshAgent: freshAgentReducer,
      panes: panesReducer,
    },
    preloadedState: {
      panes: emptyPanesState(),
    },
    middleware: (getDefault) => getDefault().prepend(actionRecorder),
  })
}

describe('fresh-agent-ws', () => {
  beforeEach(() => {
    _resetCancelledCreates()
  })

  it('registers resumed creates with history hydration and handles freshAgent.created', () => {
    const store = createFreshAgentStore()

    registerFreshAgentCreate(store.dispatch, 'req-1', {
      resumeSessionId: 'thread-1',
      sessionType: 'freshcodex',
      provider: 'codex',
    })
    const handled = handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.created',
      requestId: 'req-1',
      sessionId: 'thread-1',
      sessionType: 'freshcodex',
      provider: 'codex',
    })

    expect(handled).toBe(true)
    expect(store.getState().freshAgent.pendingCreates['req-1']).toMatchObject({
      sessionId: 'thread-1',
      expectsHistoryHydration: true,
    })
  })

  it('kills a late freshAgent.created session when its create request was cancelled', () => {
    const store = createFreshAgentStore()
    const ws = { send: vi.fn() }

    registerFreshAgentCreate(store.dispatch, 'req-orphan', {
      sessionType: 'freshcodex',
      provider: 'codex',
    })
    cancelCreate('req-orphan')

    const handled = handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.created',
      requestId: 'req-orphan',
      sessionId: 'thread-orphan',
      sessionType: 'freshcodex',
      provider: 'codex',
    }, ws)

    expect(handled).toBe(true)
    expect(ws.send).toHaveBeenCalledWith({
      type: 'freshAgent.kill',
      sessionId: 'thread-orphan',
      sessionType: 'freshcodex',
      provider: 'codex',
    })
    expect(store.getState().freshAgent.sessions['freshcodex:codex:thread-orphan']).toBeUndefined()
  })

  it('routes a cancelled late FreshOpenCode create cleanup through the original cwd', () => {
    const store = createFreshAgentStore()
    const ws = { send: vi.fn() }

    registerFreshAgentCreate(store.dispatch, 'req-opencode-orphan', {
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/route-aware',
    })
    cancelCreate('req-opencode-orphan')

    const handled = handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.created',
      requestId: 'req-opencode-orphan',
      sessionId: 'ses_orphan',
      sessionType: 'freshopencode',
      provider: 'opencode',
    }, ws)

    expect(handled).toBe(true)
    expect(ws.send).toHaveBeenCalledWith({
      type: 'freshAgent.kill',
      sessionId: 'ses_orphan',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/route-aware',
    })
    expect(store.getState().freshAgent.sessions['freshopencode:opencode:ses_orphan']).toBeUndefined()
  })

  it('handles freshAgent.create.failed', () => {
    const store = createFreshAgentStore()

    const handled = handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.create.failed',
      requestId: 'req-2',
      code: 'NOPE',
      message: 'No provider',
      retryable: false,
    })

    expect(handled).toBe(true)
    expect(store.getState().freshAgent.pendingCreateFailures['req-2']).toEqual({
      code: 'NOPE',
      message: 'No provider',
      retryable: false,
    })
  })

  it('create.failed SESSION_RESERVED (retryable) is not projected into pendingCreateFailures and keeps the create route alive', () => {
    // Task 14: a transient reservation must never mint an error-card entry
    // (no Retry button racing the same-requestId re-drive) AND must not
    // consume the create route -- the re-driven create's eventual
    // created/failed still has to route to this pane.
    const store = createFreshAgentStore()
    const ws = { send: vi.fn() }

    registerFreshAgentCreate(store.dispatch, 'req-reserved-1', {
      sessionType: 'freshclaude',
      provider: 'claude',
      cwd: '/repo/reserved-route',
    })

    const handled = handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.create.failed',
      requestId: 'req-reserved-1',
      code: 'SESSION_RESERVED',
      message: 'Another resume for this session is in flight',
      retryable: true,
    })
    expect(handled).toBe(true)
    expect(store.getState().freshAgent.pendingCreateFailures['req-reserved-1']).toBeUndefined()

    // Route NOT consumed: a later cancelled created still routes its cleanup
    // kill through the ORIGINAL cwd (the observable the route carries).
    cancelCreate('req-reserved-1')
    handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.created',
      requestId: 'req-reserved-1',
      sessionId: 'ses_reserved_late',
      sessionType: 'freshclaude',
      provider: 'claude',
    }, ws)
    expect(ws.send).toHaveBeenCalledWith({
      type: 'freshAgent.kill',
      sessionId: 'ses_reserved_late',
      sessionType: 'freshclaude',
      provider: 'claude',
      cwd: '/repo/reserved-route',
    })
  })

  it('non-reserved create.failed still projects into pendingCreateFailures (regression)', () => {
    const store = createFreshAgentStore()
    handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.create.failed',
      requestId: 'req-hard-1',
      code: 'SPAWN_FAILED',
      message: 'x',
      retryable: false,
    })
    expect(store.getState().freshAgent.pendingCreateFailures['req-hard-1']).toEqual({
      code: 'SPAWN_FAILED',
      message: 'x',
      retryable: false,
    })
  })

  it('materializes FreshOpenCode pane and live session state from the global websocket handler', () => {
    const actionTypes: string[] = []
    const store = createFreshAgentPaneStore(actionTypes)
    const placeholderId = 'freshopencode-req-placeholder'
    const durableId = 'ses_real_1'

    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        sessionId: placeholderId,
        createRequestId: 'req-placeholder',
        status: 'running',
        resumeSessionId: placeholderId,
        sessionRef: { provider: 'opencode', sessionId: placeholderId },
        restoreError: {
          reason: 'fresh_agent_lost_session',
          message: 'stale placeholder',
        },
      },
    }))

    registerFreshAgentCreate(store.dispatch, 'req-placeholder', {
      sessionType: 'freshopencode',
      provider: 'opencode',
    })
    expect(handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.created',
      requestId: 'req-placeholder',
      sessionId: placeholderId,
      sessionType: 'freshopencode',
      provider: 'opencode',
    })).toBe(true)
    expect(handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId: placeholderId,
      sessionType: 'freshopencode',
      provider: 'opencode',
      event: {
        type: 'freshAgent.session.snapshot',
        sessionId: placeholderId,
        latestTurnId: null,
        status: 'running',
      },
    })).toBe(true)

    expect(handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.session.materialized',
      previousSessionId: placeholderId,
      sessionId: durableId,
      sessionType: 'freshopencode',
      provider: 'opencode',
      sessionRef: { provider: 'opencode', sessionId: durableId },
    })).toBe(true)

    const layout = store.getState().panes.layouts['tab-1']
    expect(layout.type).toBe('leaf')
    if (layout.type !== 'leaf') throw new Error('expected leaf layout')
    expect(layout.content).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshopencode',
      provider: 'opencode',
      sessionId: durableId,
      resumeSessionId: durableId,
      sessionRef: { provider: 'opencode', sessionId: durableId },
      status: 'running',
    })
    expect(layout.content.kind === 'fresh-agent' ? layout.content.restoreError : undefined).toBeUndefined()

    expect(store.getState().freshAgent.sessions[`freshopencode:opencode:${placeholderId}`]).toBeUndefined()
    expect(store.getState().freshAgent.sessions[`freshopencode:opencode:${durableId}`]).toMatchObject({
      sessionId: durableId,
      sessionKey: `freshopencode:opencode:${durableId}`,
      threadId: durableId,
      status: 'running',
      lost: false,
    })
    expect(store.getState().freshAgent.pendingCreates['req-placeholder']).toMatchObject({
      sessionId: durableId,
      sessionKey: `freshopencode:opencode:${durableId}`,
    })
    expect(actionTypes).toContain(flushPersistedLayoutNow.type)
  })

  it('folds an attach-path freshAgent.session.materialized into BOTH slice and pane re-keys for a placeholder-keyed pane (Task 5 reconnect pin)', () => {
    // The pane exactly as a reconnect restores it: keyed by the PLACEHOLDER id, with
    // NO create handshake anywhere in this connection (the original create happened
    // pre-disconnect; only the persisted layout survives). The Task 5 server emit on
    // the tracked attach arm must therefore need no client change — this fold pin
    // proves the existing materialized fold already covers the attach path.
    const actionTypes: string[] = []
    const store = createFreshAgentPaneStore(actionTypes)
    const placeholderId = 'freshopencode-req-reconnect'
    const durableId = 'ses_reconnect_1'

    store.dispatch(initLayout({
      tabId: 'tab-reconnect',
      paneId: 'pane-reconnect',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        sessionId: placeholderId,
        createRequestId: 'req-reconnect',
        status: 'running',
        resumeSessionId: placeholderId,
        sessionRef: { provider: 'opencode', sessionId: placeholderId },
      },
    }))

    expect(handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.session.materialized',
      previousSessionId: placeholderId,
      sessionId: durableId,
      sessionType: 'freshopencode',
      provider: 'opencode',
      sessionRef: { provider: 'opencode', sessionId: durableId },
    })).toBe(true)

    expect(actionTypes).toContain(materializeSession.type)
    expect(actionTypes).toContain(materializeFreshAgentSession.type)

    const layout = store.getState().panes.layouts['tab-reconnect']
    if (layout.type !== 'leaf') throw new Error('expected leaf layout')
    expect(layout.content).toMatchObject({
      kind: 'fresh-agent',
      sessionId: durableId,
      resumeSessionId: durableId,
      sessionRef: { provider: 'opencode', sessionId: durableId },
    })
    expect(store.getState().freshAgent.sessions[`freshopencode:opencode:${placeholderId}`]).toBeUndefined()
    expect(store.getState().freshAgent.sessions[`freshopencode:opencode:${durableId}`]).toBeDefined()
    expect(actionTypes).toContain(flushPersistedLayoutNow.type)
  })

  it('projects Claude freshAgent.event snapshot and lost-session transport updates into fresh-agent session state', () => {
    const store = createFreshAgentStore()

    expect(handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId: 'claude-thread-1',
      sessionType: 'freshclaude',
      provider: 'claude',
      event: {
        type: 'freshAgent.session.snapshot',
        sessionId: 'claude-thread-1',
        latestTurnId: 'turn-1',
        status: 'idle',
        timelineSessionId: 'cli-session-1',
        revision: 7,
      },
    })).toBe(true)

    expect(handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId: 'claude-thread-1',
      sessionType: 'freshclaude',
      provider: 'claude',
      event: {
        type: 'freshAgent.error',
        sessionId: 'claude-thread-1',
        code: 'INVALID_SESSION_ID',
        message: 'Session missing on server',
      },
    })).toBe(true)

    expect(store.getState().freshAgent.sessions['freshclaude:claude:claude-thread-1']).toEqual(expect.objectContaining({
      latestTurnId: 'turn-1',
      historySessionId: 'cli-session-1',
      historyRevision: 7,
      lost: true,
      historyLoaded: false,
    }))
  })

  it('does not handle top-level legacy SDK websocket messages', () => {
    const store = createFreshAgentStore()

    expect(handleFreshAgentMessage(store.dispatch, {
      type: 'sdk.session.snapshot',
      sessionId: 'stale-thread-1',
      latestTurnId: 'turn-stale',
      status: 'idle',
      timelineSessionId: '00000000-0000-4000-8000-000000000001',
      revision: 3,
    })).toBe(false)

    expect(store.getState().freshAgent.sessions['freshclaude:claude:stale-thread-1']).toBeUndefined()
  })

  // C17: the server's result frame says whether the session is still busy
  // (a queued send runs next); the pane follows it instead of forcing idle.
  it('passes the result frame\'s sessionBusy through to the session status', () => {
    const store = createFreshAgentStore()
    const sessionId = 'claude-thread-queued'
    const key = `freshclaude:claude:${sessionId}`
    const sendEvent = (event: Record<string, unknown>) => handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId,
      sessionType: 'freshclaude',
      provider: 'claude',
      event: { sessionId, ...event },
    })
    expect(sendEvent({ type: 'freshAgent.status', status: 'running' })).toBe(true)
    expect(sendEvent({ type: 'freshAgent.result', subtype: 'success', sessionBusy: true })).toBe(true)
    expect(store.getState().freshAgent.sessions[key].status).toBe('running')
    expect(sendEvent({ type: 'freshAgent.result', subtype: 'success', sessionBusy: false })).toBe(true)
    expect(store.getState().freshAgent.sessions[key].status).toBe('idle')
  })

  it('projects every fresh-agent provider event carried by freshAgent.event into fresh-agent state', () => {
    const store = createFreshAgentStore()
    const sessionId = 'claude-thread-parity'
    const key = `freshclaude:claude:${sessionId}`
    const sendEvent = (event: Record<string, unknown>) => handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId,
      sessionType: 'freshclaude',
      provider: 'claude',
      event: { sessionId, ...event },
    })

    expect(sendEvent({ type: 'freshAgent.session.snapshot', latestTurnId: null, status: 'idle', revision: 1 })).toBe(true)
    expect(sendEvent({ type: 'freshAgent.session.init', cliSessionId: 'cli-1', model: 'claude-opus-4-6', cwd: '/repo' })).toBe(true)
    expect(sendEvent({ type: 'freshAgent.session.metadata', cliSessionId: 'cli-2', model: 'claude-sonnet-4-6', tools: [{ name: 'Bash' }] })).toBe(true)
    expect(sendEvent({ type: 'freshAgent.status', status: 'running' })).toBe(true)
    const stream = (event: Record<string, unknown>) => sendEvent({
      type: 'freshAgent.stream', messageId: 'msg_parity', parentToolUseId: null, event,
    })
    expect(stream({ type: 'message_start', message: { id: 'msg_parity' } })).toBe(true)
    expect(stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })).toBe(true)
    expect(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } })).toBe(true)
    expect(stream({ type: 'content_block_stop', index: 0 })).toBe(true)
    expect(sendEvent({
      type: 'freshAgent.assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'partial' }],
      uuid: 'line-uuid-parity',
      messageId: 'msg_parity',
      parentToolUseId: null,
    })).toBe(true)
    // The streamed text lives in the live tail; the assistant frame flushed it
    // there without waiting for the batch timer.
    expect(store.getState().freshAgentLive.bySession[key].blocks.map((block) => block.text)).toEqual(['partial'])
    expect(sendEvent({ type: 'freshAgent.result', costUsd: 0.02, usage: { input_tokens: 10, output_tokens: 5 } })).toBe(true)
    expect(sendEvent({
      type: 'freshAgent.permission.request',
      requestId: 'perm-1',
      subtype: 'tool',
      tool: { name: 'Bash', input: { command: 'npm test' } },
    })).toBe(true)
    expect(store.getState().freshAgent.sessions[key].pendingPermissions['perm-1']).toMatchObject({
      toolName: 'Bash',
      input: { command: 'npm test' },
    })
    expect(sendEvent({ type: 'freshAgent.permission.cancelled', requestId: 'perm-1' })).toBe(true)
    expect(sendEvent({
      type: 'freshAgent.question.request',
      requestId: 'question-1',
      questions: [{ question: 'Continue?', options: [{ label: 'Yes', description: 'Proceed' }] }],
    })).toBe(true)
    expect(sendEvent({ type: 'freshAgent.error', code: 'SDK_WARNING', message: 'recoverable' })).toBe(true)

    const session = store.getState().freshAgent.sessions[key]
    expect(session).toMatchObject({
      cliSessionId: 'cli-2',
      model: 'claude-sonnet-4-6',
      streamingActive: false,
      totalCostUsd: 0.02,
      totalInputTokens: 10,
      totalOutputTokens: 5,
      lastError: 'recoverable',
    })
    // Durable content comes from the snapshot only (transcript-live P1): an
    // assistant frame never invents a client-side turn.
    expect(session.turns).toEqual([])
    expect(session.pendingPermissions).toEqual({})
    expect(session.pendingQuestions['question-1']).toMatchObject({
      questions: [{ question: 'Continue?' }],
    })

    expect(sendEvent({ type: 'freshAgent.exit', exitCode: 0 })).toBe(true)
    expect(store.getState().freshAgent.sessions[key].status).toBe('exited')
    expect(sendEvent({ type: 'freshAgent.killed' })).toBe(true)
    expect(store.getState().freshAgent.sessions[key]).toBeUndefined()
  })

  describe('stream deltas (transcript-live D1)', () => {
    const sessionId = 'claude-stream-d1'
    const key = `freshclaude:claude:${sessionId}`
    const frame = (event: Record<string, unknown>) => ({
      type: 'freshAgent.event',
      sessionId,
      sessionType: 'freshclaude',
      provider: 'claude',
      event: { sessionId, ...event },
    })
    const stream = (event: Record<string, unknown>) => frame({
      type: 'freshAgent.stream', messageId: 'msg_d1', parentToolUseId: null, event,
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('leaves the sessions map untouched by 200 text deltas after the first block start; the text accumulates in the live tail', () => {
      vi.useFakeTimers()
      const store = createFreshAgentStore()
      handleFreshAgentMessage(store.dispatch, frame({ type: 'freshAgent.status', status: 'running' }))
      handleFreshAgentMessage(store.dispatch, stream({ type: 'message_start', message: { id: 'msg_d1' } }))
      handleFreshAgentMessage(store.dispatch, stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
      const sessionsAfterStart = store.getState().freshAgent.sessions
      // The block start marks the turn as streaming (busy follows it) at once.
      expect(sessionsAfterStart[key]).toMatchObject({ status: 'running', streamingActive: true })

      const tokens = Array.from({ length: 200 }, (_, i) => `t${i} `)
      for (const text of tokens) {
        handleFreshAgentMessage(store.dispatch, stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }))
      }
      handleFreshAgentMessage(store.dispatch, stream({ type: 'content_block_stop', index: 0 }))
      // A second block of the same turn does not write the sessions map either.
      handleFreshAgentMessage(store.dispatch, stream({ type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '' } }))
      handleFreshAgentMessage(store.dispatch, stream({ type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'hmm' } }))

      // Batched: nothing reaches the tail before the flush interval.
      expect(store.getState().freshAgentLive.bySession[key]).toBeUndefined()
      vi.advanceTimersByTime(LIVE_STREAM_FLUSH_MS)

      expect(store.getState().freshAgent.sessions).toBe(sessionsAfterStart)
      expect(store.getState().freshAgentLive.bySession[key].blocks).toEqual([
        { messageId: 'msg_d1', index: 0, kind: 'text', text: tokens.join('') },
        { messageId: 'msg_d1', index: 1, kind: 'thinking', text: 'hmm' },
      ])
    })

    it('applies pending deltas before any other event of the session', () => {
      vi.useFakeTimers()
      const store = createFreshAgentStore()
      // A visible pane settles the tail, so the turn's end keeps its blocks.
      store.dispatch(liveTailViewerAdded({ sessionKey: key }))
      handleFreshAgentMessage(store.dispatch, frame({ type: 'freshAgent.status', status: 'running' }))
      handleFreshAgentMessage(store.dispatch, stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
      handleFreshAgentMessage(store.dispatch, stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }))
      handleFreshAgentMessage(store.dispatch, frame({ type: 'freshAgent.result', costUsd: 0.01 }))

      expect(store.getState().freshAgentLive.bySession[key].blocks.map((block) => block.text)).toEqual(['done'])
      expect(store.getState().freshAgent.sessions[key]).toMatchObject({ status: 'idle', streamingActive: false })
    })

    it('ignores a subagent\'s stream events: no live block and no streaming mark', () => {
      vi.useFakeTimers()
      const store = createFreshAgentStore()
      const subagent = (event: Record<string, unknown>) => frame({
        type: 'freshAgent.stream', messageId: 'msg_sub', parentToolUseId: 'toolu_agent', event,
      })
      handleFreshAgentMessage(store.dispatch, subagent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
      handleFreshAgentMessage(store.dispatch, subagent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'subagent words' } }))
      vi.advanceTimersByTime(LIVE_STREAM_FLUSH_MS)

      expect(store.getState().freshAgentLive.bySession).toEqual({})
      expect(store.getState().freshAgent.sessions[key]?.streamingActive ?? false).toBe(false)
    })

    it('marks a just-created session running when its first block opens', () => {
      const store = createFreshAgentStore()
      store.dispatch(sessionCreated({ requestId: 'req-d1', sessionId, sessionType: 'freshclaude', provider: 'claude' }))
      expect(store.getState().freshAgent.sessions[key].status).toBe('connected')
      handleFreshAgentMessage(store.dispatch, stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
      expect(store.getState().freshAgent.sessions[key]).toMatchObject({ status: 'running', streamingActive: true })
    })

    it('marks the session streaming again when the next turn opens a block', () => {
      const store = createFreshAgentStore()
      handleFreshAgentMessage(store.dispatch, stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
      handleFreshAgentMessage(store.dispatch, frame({ type: 'freshAgent.result', costUsd: 0.01 }))
      expect(store.getState().freshAgent.sessions[key].streamingActive).toBe(false)

      handleFreshAgentMessage(store.dispatch, stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
      expect(store.getState().freshAgent.sessions[key]).toMatchObject({ status: 'running', streamingActive: true })
    })
  })

  it('folds freshAgent.status(stuck) with no attention action; a companion turn.complete edge folds attention independently', () => {
    // Wedged-sidecar deadman fold: the STATUS frame itself dispatches no
    // attention — it must land (and stop the busy-driving streaming flag)
    // without recording an attention event. The deadman's companion
    // freshAgent.turn.complete edge is a SEPARATE frame: when it follows for
    // the same session, it folds attention independently (the unified
    // contract — the deadman rings deliberately). The pane layout below is
    // seeded so the completion thunk resolves its target, making the
    // companion's recordTurnComplete pin genuinely fire — and the status
    // half of the test genuinely protective against a status fold that
    // fabricated attention.
    const actionTypes: string[] = []
    const store = createFreshAgentPaneStore(actionTypes)
    const sessionId = 'thread-stuck-1'

    store.dispatch(initLayout({
      tabId: 'tab-stuck',
      paneId: 'pane-stuck',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        sessionId,
        createRequestId: 'req-stuck',
        status: 'running',
      },
    }))

    // Mid-turn shape: running + streaming, exactly what the deadman fires into.
    expect(handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId,
      sessionType: 'freshcodex',
      provider: 'codex',
      event: {
        type: 'freshAgent.session.snapshot',
        sessionId,
        latestTurnId: null,
        status: 'running',
        streamingActive: true,
        revision: 1,
      },
    })).toBe(true)
    expect(store.getState().freshAgent.sessions[`freshcodex:codex:${sessionId}`].streamingActive).toBe(true)
    // The snapshot observes the session for reconnect dedupe; only actions
    // caused by the following status frame belong to this assertion.
    actionTypes.length = 0

    expect(handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId,
      sessionType: 'freshcodex',
      provider: 'codex',
      event: { type: 'freshAgent.status', sessionId, status: 'stuck' },
    })).toBe(true)

    const session = store.getState().freshAgent.sessions[`freshcodex:codex:${sessionId}`]
    expect(session.status).toBe('stuck')
    expect(session.streamingActive).toBe(false)
    expect(actionTypes.filter((type) => type.startsWith('turnCompletion/') && type !== 'turnCompletion/advanceCompletionBaseline')).toHaveLength(0)

    // Companion edge: the deadman's discrete freshAgent.turn.complete for the
    // same session dispatches recordTurnComplete — attention folds
    // independently of the status frame (exactly one attention record;
    // observing its reconnect baselines does not record an event).
    expect(handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId,
      sessionType: 'freshcodex',
      provider: 'codex',
      event: { type: 'freshAgent.turn.complete', sessionId, at: 1_700_000_000_000 },
    })).toBe(true)
    expect(actionTypes.filter((type) => type === 'turnCompletion/recordTurnComplete')).toHaveLength(1)
    expect(actionTypes.filter((type) => type.startsWith('turnCompletion/') && type !== 'turnCompletion/advanceCompletionBaseline')).toEqual([
      'turnCompletion/recordTurnComplete',
    ])
    // The status fold itself stays untouched by the companion: still 'stuck',
    // still not streaming.
    const after = store.getState().freshAgent.sessions[`freshcodex:codex:${sessionId}`]
    expect(after.status).toBe('stuck')
    expect(after.streamingActive).toBe(false)
  })

  it('keeps the session and surfaces an error when an event-wrapped killed reports success:false', () => {
    const store = createFreshAgentStore()
    const sessionId = 'claude-thread-kill-fails'
    const key = `freshclaude:claude:${sessionId}`
    const sendEvent = (event: Record<string, unknown>) => handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId,
      sessionType: 'freshclaude',
      provider: 'claude',
      event: { sessionId, ...event },
    })

    expect(sendEvent({ type: 'freshAgent.session.snapshot', latestTurnId: null, status: 'idle' })).toBe(true)
    expect(store.getState().freshAgent.sessions[key]).toBeDefined()

    // The server's durable close FAILED (delta-r6-r2 Finding 5): the session
    // was not killed server-side, so the client must not proceed as though
    // it was — keep the record and surface the failure, like any other
    // session-scoped error frame.
    expect(sendEvent({ type: 'freshAgent.killed', success: false })).toBe(true)
    const session = store.getState().freshAgent.sessions[key]
    expect(session).toBeDefined()
    expect(session.lastErrorCode).toBe('KILL_FAILED')
    expect(session.lastError).toContain('still be running')

    // A follow-up SUCCESS still folds to removal (idempotent close).
    expect(sendEvent({ type: 'freshAgent.killed', success: true })).toBe(true)
    expect(store.getState().freshAgent.sessions[key]).toBeUndefined()
  })

  it('forgets a stopped Codex writer only after a successful recovery stop', () => {
    const store = createFreshAgentStore()
    const sessionId = 'codex-thread-recovery'
    const key = `freshcodex:codex:${sessionId}`
    const snapshot = {
      type: 'freshAgent.event', sessionId, sessionType: 'freshcodex', provider: 'codex',
      event: { type: 'freshAgent.session.snapshot', sessionId, status: 'stuck', latestTurnId: null },
    }
    expect(handleFreshAgentMessage(store.dispatch, snapshot)).toBe(true)
    expect(store.getState().freshAgent.sessions[key]).toBeDefined()

    const stop = { type: 'freshAgent.recovery.stopped', requestId: 'stop-1', sessionId,
      sessionType: 'freshcodex', provider: 'codex', success: false, code: 'TEARDOWN_NOT_CONFIRMED' }
    expect(handleFreshAgentMessage(store.dispatch, stop)).toBe(true)
    expect(store.getState().freshAgent.sessions[key]).toBeDefined()

    expect(handleFreshAgentMessage(store.dispatch, { ...stop, success: true })).toBe(true)
    expect(store.getState().freshAgent.sessions[key]).toBeUndefined()
  })

  it('folds freshAgent.question.cancelled into removeQuestion and sits in the snapshot-invalidating set', async () => {
    const store = createFreshAgentStore()
    const sessionId = 'claude-thread-question-cancel'
    const key = `freshclaude:claude:${sessionId}`
    const sendEvent = (event: Record<string, unknown>) => handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId,
      sessionType: 'freshclaude',
      provider: 'claude',
      event: { sessionId, ...event },
    })

    expect(sendEvent({ type: 'freshAgent.session.snapshot', latestTurnId: null, status: 'running' })).toBe(true)
    expect(sendEvent({
      type: 'freshAgent.question.request',
      requestId: 'question-7',
      questions: [{ question: 'Continue?', options: [{ label: 'Yes', description: 'Proceed' }] }],
    })).toBe(true)
    expect(store.getState().freshAgent.sessions[key].pendingQuestions['question-7']).toBeDefined()

    // A provider-cancelled question must clear its card (the removeQuestion reducer
    // otherwise has zero dispatch sites and the card stays actionable forever).
    expect(sendEvent({ type: 'freshAgent.question.cancelled', requestId: 'question-7' })).toBe(true)
    expect(store.getState().freshAgent.sessions[key].pendingQuestions['question-7']).toBeUndefined()

    // The snapshot-driven self-heal path must treat the cancel as invalidating too, so
    // the card clears even if the fold races (FreshAgentView.tsx's subscription re-query).
    const { isSnapshotInvalidatingFreshAgentEvent } = await import('@/components/fresh-agent/fresh-agent-event-classes')
    expect(isSnapshotInvalidatingFreshAgentEvent({
      type: 'freshAgent.event',
      sessionId,
      sessionType: 'freshclaude',
      provider: 'claude',
      event: { type: 'freshAgent.question.cancelled', sessionId, requestId: 'question-7' },
    })).toBe(true)
  })

  it('handles freshAgent.session.changed without mutating idle status', () => {
    const store = createFreshAgentStore()
    const sessionId = 'ses_opencode_idle'
    const key = `freshopencode:opencode:${sessionId}`

    expect(handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId,
      sessionType: 'freshopencode',
      provider: 'opencode',
      event: {
        type: 'freshAgent.session.snapshot',
        sessionId,
        latestTurnId: 'msg_assistant_1',
        status: 'idle',
        revision: 11,
      },
    })).toBe(true)

    expect(handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId,
      sessionType: 'freshopencode',
      provider: 'opencode',
      event: {
        type: 'freshAgent.session.changed',
        sessionId,
        reason: 'opencode-message',
      },
    })).toBe(true)

    expect(store.getState().freshAgent.sessions[key]).toMatchObject({
      status: 'idle',
      latestTurnId: 'msg_assistant_1',
      historyRevision: 11,
    })
  })

  it('bubbles OpenCode APIError data.message into FreshOpenCode UI-facing state', () => {
    const store = createFreshAgentStore()
    const sessionId = 'ses_opencode_billing'
    const key = `freshopencode:opencode:${sessionId}`
    const billingMessage = 'Insufficient balance. Manage your billing here: https://opencode.ai/workspace/wrk_01K7GPZSP6NGNSHF5ZHKBTVHVF/billing'
    const sendEvent = (event: Record<string, unknown>) => handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId,
      sessionType: 'freshopencode',
      provider: 'opencode',
      event: { sessionId, ...event },
    })

    expect(sendEvent({ type: 'freshAgent.session.snapshot', latestTurnId: null, status: 'running', revision: 1 })).toBe(true)

    // Feed the normalized Rust-baseline event shape directly. The client
    // reducer consumes the shared wire contract; importing a Node adapter here
    // would make this test pass without exercising that contract.
    const normalized = { type: 'freshAgent.error', sessionId, message: billingMessage }

    expect(handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId,
      sessionType: 'freshopencode',
      provider: 'opencode',
      event: normalized as Record<string, unknown>,
    })).toBe(true)

    expect(store.getState().freshAgent.sessions[key]).toMatchObject({
      status: 'idle',
      streamingActive: false,
      lastError: billingMessage,
    })
  })

  it('folds a stated permission mode; metadata that states none keeps it (transcript-live D7)', () => {
    const store = createFreshAgentStore()
    const sessionId = 'claude-permission-mode'
    const key = `freshclaude:claude:${sessionId}`
    const metadata = (fields: Record<string, unknown>) => handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId,
      sessionType: 'freshclaude',
      provider: 'claude',
      event: { type: 'freshAgent.session.metadata', sessionId, ...fields },
    })
    metadata({ permissionMode: 'bypassPermissions' })
    expect(store.getState().freshAgent.sessions[key].permissionMode).toBe('bypassPermissions')
    metadata({ model: 'claude-sonnet-4-6', effort: null })
    expect(store.getState().freshAgent.sessions[key].permissionMode).toBe('bypassPermissions')
    metadata({ permissionMode: 'default' })
    expect(store.getState().freshAgent.sessions[key].permissionMode).toBe('default')
  })

  it('does not let delayed metadata downgrade newer snapshot identity', () => {
    const store = createFreshAgentStore()
    const sessionId = 'claude-thread-metadata-order'
    const key = `freshclaude:claude:${sessionId}`
    const sendEvent = (event: Record<string, unknown>) => handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId,
      sessionType: 'freshclaude',
      provider: 'claude',
      event: { sessionId, ...event },
    })

    expect(sendEvent({
      type: 'freshAgent.session.snapshot',
      latestTurnId: 'turn-new',
      status: 'idle',
      timelineSessionId: 'cli-new',
      revision: 5,
    })).toBe(true)
    expect(sendEvent({
      type: 'freshAgent.session.metadata',
      cliSessionId: 'cli-old',
      model: 'claude-sonnet-4-6',
      cwd: '/repo',
    })).toBe(true)

    const session = store.getState().freshAgent.sessions[key]
    expect(session.cliSessionId).toBeUndefined()
    expect(session).toMatchObject({
      historySessionId: 'cli-new',
      historyRevision: 5,
      model: 'claude-sonnet-4-6',
      cwd: '/repo',
    })
  })

  it('deduplicates repeated permission and question requests by request id', () => {
    const store = createFreshAgentStore()
    const sessionId = 'claude-thread-interactive-dedupe'
    const key = `freshclaude:claude:${sessionId}`
    const sendEvent = (event: Record<string, unknown>) => handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId,
      sessionType: 'freshclaude',
      provider: 'claude',
      event: { sessionId, ...event },
    })

    expect(sendEvent({ type: 'freshAgent.session.snapshot', latestTurnId: null, status: 'idle', revision: 1 })).toBe(true)
    expect(sendEvent({
      type: 'freshAgent.permission.request',
      requestId: 'perm-repeat',
      subtype: 'tool',
      tool: { name: 'Bash', input: { command: 'pwd' } },
    })).toBe(true)
    expect(sendEvent({
      type: 'freshAgent.permission.request',
      requestId: 'perm-repeat',
      subtype: 'tool',
      tool: { name: 'Bash', input: { command: 'ls' } },
    })).toBe(true)
    expect(sendEvent({
      type: 'freshAgent.question.request',
      requestId: 'question-repeat',
      questions: [{ question: 'Continue?', header: 'Confirm', options: [], multiSelect: false }],
    })).toBe(true)
    expect(sendEvent({
      type: 'freshAgent.question.request',
      requestId: 'question-repeat',
      questions: [{ question: 'Proceed?', header: 'Confirm', options: [], multiSelect: false }],
    })).toBe(true)

    const session = store.getState().freshAgent.sessions[key]
    expect(Object.keys(session.pendingPermissions)).toEqual(['perm-repeat'])
    expect(session.pendingPermissions['perm-repeat']).toMatchObject({
      input: { command: 'ls' },
    })
    expect(Object.keys(session.pendingQuestions)).toEqual(['question-repeat'])
    expect(session.pendingQuestions['question-repeat'].questions[0].question).toBe('Proceed?')
  })
})

describe('rollback folds (kata 1wxv)', () => {
  it('freshAgent.session.rolledBack revokes attention for the owning pane', () => {
    const store = configureStore({
      reducer: {
        freshAgent: freshAgentReducer,
        panes: panesReducer,
        turnCompletion: turnCompletionReducer,
      },
      preloadedState: {
        panes: emptyPanesState(),
      },
    })
    store.dispatch(initLayout({
      tabId: 'tab-rb',
      paneId: 'pane-rb',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-rb',
        sessionId: 'ses_rb_1',
        sessionRef: { provider: 'opencode', sessionId: 'ses_rb_1' },
        status: 'idle',
      },
    }))
    store.dispatch(markTabAttention({ tabId: 'tab-rb' }))
    store.dispatch(markPaneAttention({ paneId: 'pane-rb' }))

    // Decision 10: an undone done is not done — the broadcast revokes green/attention
    // on every device, initiating pane included. The pane-scoped thunk handles the
    // tab-level OR re-derivation (covered in turnCompletionAttention.test.ts).
    expect(handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId: 'ses_rb_1',
      sessionType: 'freshopencode',
      provider: 'opencode',
      event: {
        type: 'freshAgent.session.rolledBack',
        sessionId: 'ses_rb_1',
        removedTurnIds: ['msg_u2'],
        canRedo: true,
        revokeAttention: true,
      },
    })).toBe(true)

    expect(store.getState().turnCompletion.attentionByPane['pane-rb']).toBeUndefined()
    expect(store.getState().turnCompletion.attentionByTab['tab-rb']).toBeUndefined()
  })

  it('rollback-flagged errors do not hit the pane error surface, but INVALID_SESSION_ID still marks lost', () => {
    const store = createFreshAgentStore()
    const sessionId = 'ses_rb_err'
    const key = `freshopencode:opencode:${sessionId}`

    expect(handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId,
      sessionType: 'freshopencode',
      provider: 'opencode',
      event: {
        type: 'freshAgent.session.snapshot',
        sessionId,
        latestTurnId: null,
        status: 'idle',
        revision: 1,
      },
    })).toBe(true)

    // A rollback-flagged refusal is routed to the initiating pane's own notice banner
    // (matched on requestId in the view) — NEVER the pane error surface.
    expect(handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId,
      sessionType: 'freshopencode',
      provider: 'opencode',
      event: {
        type: 'freshAgent.error',
        sessionId,
        code: 'BUSY_TURN',
        rollback: true,
        requestId: 'rb-req-1',
        message: 'Rollback is not supported while a turn is running — queue a steer message or wait for the turn to finish.',
      },
    })).toBe(true)
    expect(store.getState().freshAgent.sessions[key].lastError).toBeUndefined()
    expect(store.getState().freshAgent.sessions[key].lost ?? false).toBe(false)

    // …while a rollback-flagged INVALID_SESSION_ID still engages client recovery.
    expect(handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId,
      sessionType: 'freshopencode',
      provider: 'opencode',
      event: {
        type: 'freshAgent.error',
        sessionId,
        code: 'INVALID_SESSION_ID',
        rollback: true,
        requestId: 'rb-req-2',
        message: 'Session missing on server',
      },
    })).toBe(true)
    expect(store.getState().freshAgent.sessions[key].lost).toBe(true)
  })

  it('acks + session.redone are consumed without redux writes', () => {
    const actionTypes: string[] = []
    const store = createFreshAgentPaneStore(actionTypes)
    const sessionId = 'ses_rb_quiet'
    const sendEvent = (event: Record<string, unknown>) => handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId,
      sessionType: 'freshopencode',
      provider: 'opencode',
      event: { sessionId, ...event },
    })

    // Requesting-sink acks are consumed by the initiating pane's own ws subscriber
    // (composer refill); snapshot invalidation rehydrates redux — no direct writes.
    expect(sendEvent({
      type: 'freshAgent.rolledBack',
      requestId: 'rb-a1',
      direction: 'undo',
      mode: 'step',
      removedPromptText: 'prompt',
      removedTurnIds: ['msg_u1'],
      canRedo: true,
    })).toBe(true)
    expect(sendEvent({
      type: 'freshAgent.redone',
      requestId: 'rb-a2',
      direction: 'redo',
      restoredThroughTurnId: 'msg_u2',
      canRedo: false,
    })).toBe(true)
    expect(sendEvent({
      type: 'freshAgent.session.redone',
      restoredThroughTurnId: 'msg_u2',
      canRedo: false,
    })).toBe(true)

    expect(actionTypes).toEqual([])
  })
})

describe('runtime-owner folds (kata b8ke)', () => {
  beforeEach(() => {
    _resetCancelledCreates()
  })

  function ownerFrame(overrides: Partial<SessionRuntimeOwnerMessage> = {}): SessionRuntimeOwnerMessage {
    return {
      type: 'session.runtimeOwner',
      provider: 'codex',
      sessionId: 'sid-own-1',
      epoch: 7,
      generation: 3,
      ownerKind: 'terminal',
      operationId: 'handoff-1',
      transition: 'handoff-committed',
      ...overrides,
    }
  }

  it('session.runtimeOwner frames dispatch applyRuntimeOwner (the App fold path)', () => {
    const store = createFreshAgentStore()
    foldSessionRuntimeOwnerFrame(store.dispatch, ownerFrame({
      terminalId: 't-9',
      generation: 4,
    }))
    expect(store.getState().freshAgent.runtimeOwners['codex:sid-own-1']).toMatchObject({
      ownerKind: 'terminal',
      terminalId: 't-9',
      epoch: 7,
      generation: 4,
      transition: 'handoff-committed',
    })
  })

  it('ready frame carrying runtimeOwners resets then folds — stale pre-ready records are GONE', () => {
    const store = createFreshAgentStore()
    // Stale pre-reconnect records: a newer-epoch replay must replace the
    // replayed key, and the reset must drop keys the server no longer tracks.
    foldSessionRuntimeOwnerFrame(store.dispatch, ownerFrame({
      sessionId: 'sid-r',
      epoch: 6,
      generation: 10,
    }))
    foldSessionRuntimeOwnerFrame(store.dispatch, ownerFrame({
      sessionId: 'sid-stale-other',
      epoch: 6,
      generation: 4,
    }))
    foldReadyRuntimeOwners(store.dispatch, [
      { provider: 'codex', sessionId: 'sid-r', epoch: 9, generation: 2, ownerKind: 'terminal', terminalId: 't-3' },
    ])
    const owners = store.getState().freshAgent.runtimeOwners
    expect(owners['codex:sid-r']).toMatchObject({
      epoch: 9,
      generation: 2,
      terminalId: 't-3',
      ownerKind: 'terminal',
    })
    expect(owners['codex:sid-stale-other']).toBeUndefined()
    expect(Object.keys(owners)).toEqual(['codex:sid-r'])
  })

  // b8ke focused round-3 R3-5: a reconnecting device after
  // PLATFORM_LIMITED/WATCHER_FAILED must fold the FENCED truth — a fenced
  // replay record is the typed recovery state (handoff-failed + the typed
  // reason), never a false committed owner.
  it('a fenced replay record folds as the typed recovery state, never handoff-committed', () => {
    const store = createFreshAgentStore()
    foldReadyRuntimeOwners(store.dispatch, [
      {
        provider: 'claude',
        sessionId: 'sid-fenced',
        epoch: 3,
        generation: 5,
        ownerKind: 'terminal',
        state: 'fenced',
        reason: 'platform-limited',
      },
      {
        provider: 'codex',
        sessionId: 'sid-live',
        epoch: 3,
        generation: 2,
        ownerKind: 'fresh-agent',
        state: 'live',
      },
    ])
    const owners = store.getState().freshAgent.runtimeOwners
    expect(owners['claude:sid-fenced']).toMatchObject({
      ownerKind: 'terminal',
      transition: 'handoff-failed',
      reason: 'platform-limited',
      fenced: true,
      epoch: 3,
      generation: 5,
    })
    // A live record still folds as committed (the pre-existing behavior).
    expect(owners['codex:sid-live']).toMatchObject({
      ownerKind: 'fresh-agent',
      transition: 'handoff-committed',
    })
    expect(owners['codex:sid-live'].fenced).toBeUndefined()
  })

  it('a ready fold with no replay entries still resets (empty owner map)', () => {
    const store = createFreshAgentStore()
    foldSessionRuntimeOwnerFrame(store.dispatch, ownerFrame({ sessionId: 'sid-gone' }))
    foldReadyRuntimeOwners(store.dispatch, undefined)
    expect(store.getState().freshAgent.runtimeOwners).toEqual({})
  })

  // b8ke focused round-4 R4-1: the tests must exercise the PARSER
  // BOUNDARY — the App path is
  // `ReadyMessageSchema.safeParse(frame)` then
  // `foldReadyRuntimeOwners(dispatch, parsed.data.runtimeOwners)`. Zod
  // strips undeclared object properties, so a parser that does not
  // declare the replay's `state`/`reason` silently folds every fenced
  // replay as handoff-committed (the pre-fix defect these tests pin).
  describe('ready replay folds THROUGH the parser (kata b8ke R4-1/R4-6)', () => {
    function parseReadyRuntimeOwners(raw: unknown) {
      const parsed = ReadyMessageSchema.safeParse(raw)
      expect(parsed.success).toBe(true)
      return parsed.success ? parsed.data.runtimeOwners : undefined
    }

    function readyFrame(runtimeOwners: unknown[]): unknown {
      return {
        type: 'ready',
        timestamp: new Date().toISOString(),
        serverInstanceId: 'srv-1',
        bootId: 'boot-1',
        runtimeOwners,
      }
    }

    // b8ke focused episode-2 post-cap F5: an ALIASED (re-keyed) replay
    // record carries the CANONICAL record's resolved truth + `aliasOf`
    // through the parser — a cross-device pane holding the PRE-REKEY id
    // folds the authoritative owner state (never a permanent "vacant")
    // and the record names the canonical id for navigation.
    it('an aliased replay record keeps aliasOf through the parser and folds the canonical owner truth', () => {
      const store = createFreshAgentStore()
      const owners = parseReadyRuntimeOwners(readyFrame([
        {
          provider: 'claude',
          sessionId: 'sid-pre-rekey',
          epoch: 3,
          generation: 11,
          ownerKind: 'fresh-agent',
          state: 'live',
          aliasOf: 'sid-canonical',
        },
      ]))
      foldReadyRuntimeOwners(store.dispatch, owners)
      const record = store.getState().freshAgent.runtimeOwners['claude:sid-pre-rekey']
      expect(record).toMatchObject({
        // The CANONICAL record's truth — the old key is never vacant.
        ownerKind: 'fresh-agent',
        transition: 'handoff-committed',
        epoch: 3,
        generation: 11,
        aliasOf: 'sid-canonical',
      })
    })

    // The live broadcast fold carries aliasOf too (the rekey transition's
    // OLD-key mirror frame — an ONLINE old-key pane converges, not just a
    // reconnecting one).
    it('the rekey old-key mirror broadcast folds the canonical owner state with aliasOf', () => {
      const store = createFreshAgentStore()
      foldSessionRuntimeOwnerFrame(store.dispatch, ownerFrame({
        provider: 'claude',
        sessionId: 'sid-pre-rekey',
        ownerKind: 'fresh-agent',
        generation: 12,
        operationId: 'rekey-op-1',
        transition: 'handoff-committed',
        aliasOf: 'sid-canonical',
      }))
      expect(store.getState().freshAgent.runtimeOwners['claude:sid-pre-rekey']).toMatchObject({
        ownerKind: 'fresh-agent',
        generation: 12,
        aliasOf: 'sid-canonical',
      })
    })

    it('a fenced replay record keeps state/reason through the parser — typed recovery, never committed', () => {
      const store = createFreshAgentStore()
      const owners = parseReadyRuntimeOwners(readyFrame([
        {
          provider: 'claude',
          sessionId: 'sid-fenced',
          epoch: 3,
          generation: 5,
          ownerKind: 'terminal',
          state: 'fenced',
          reason: 'platform-limited',
        },
      ]))
      foldReadyRuntimeOwners(store.dispatch, owners)
      expect(store.getState().freshAgent.runtimeOwners['claude:sid-fenced']).toMatchObject({
        ownerKind: 'terminal',
        transition: 'handoff-failed',
        reason: 'platform-limited',
        fenced: true,
        epoch: 3,
        generation: 5,
      })
    })

    it('in-progress lifecycle replays (starting/handoff/stopping) fold as the transition state, never committed-live', () => {
      const store = createFreshAgentStore()
      const owners = parseReadyRuntimeOwners(readyFrame([
        {
          provider: 'codex', sessionId: 'sid-starting', epoch: 2, generation: 4,
          ownerKind: 'fresh-agent', state: 'starting',
        },
        {
          provider: 'codex', sessionId: 'sid-handoff', epoch: 2, generation: 7,
          ownerKind: 'terminal', state: 'handoff',
        },
        {
          provider: 'codex', sessionId: 'sid-stopping', epoch: 2, generation: 9,
          ownerKind: 'terminal', state: 'stopping',
        },
      ]))
      foldReadyRuntimeOwners(store.dispatch, owners)
      const owners_ = store.getState().freshAgent.runtimeOwners
      // R4-6: reconnecting during Starting/Handoff/Stopping shows the
      // transition (handoff-started — the Task 8 in-progress semantics),
      // never a committed live owner.
      expect(owners_['codex:sid-starting']).toMatchObject({
        ownerKind: 'fresh-agent',
        transition: 'handoff-started',
      })
      expect(owners_['codex:sid-handoff']).toMatchObject({
        ownerKind: 'terminal',
        transition: 'handoff-started',
      })
      expect(owners_['codex:sid-stopping']).toMatchObject({
        ownerKind: 'terminal',
        transition: 'handoff-started',
      })
      for (const key of ['codex:sid-starting', 'codex:sid-handoff', 'codex:sid-stopping']) {
        expect(owners_[key].fenced).toBeUndefined()
      }
    })

    it('live and vacant replays keep their existing folds through the parser', () => {
      const store = createFreshAgentStore()
      const owners = parseReadyRuntimeOwners(readyFrame([
        {
          provider: 'codex', sessionId: 'sid-live', epoch: 3, generation: 2,
          ownerKind: 'fresh-agent', state: 'live', terminalId: 't-1',
        },
        {
          provider: 'codex', sessionId: 'sid-vacant', epoch: 3, generation: 8,
          ownerKind: 'vacant',
        },
      ]))
      foldReadyRuntimeOwners(store.dispatch, owners)
      const owners_ = store.getState().freshAgent.runtimeOwners
      expect(owners_['codex:sid-live']).toMatchObject({
        ownerKind: 'fresh-agent',
        transition: 'handoff-committed',
        terminalId: 't-1',
      })
      expect(owners_['codex:sid-vacant']).toMatchObject({
        ownerKind: 'vacant',
        transition: 'released',
      })
    })
  })

  it('freshAgent.create.failed owner fields are preserved in the fold (typed conflict → recovery UI)', () => {
    const store = createFreshAgentStore()
    registerFreshAgentCreate(store.dispatch, 'req-owner-conflict', {
      sessionType: 'freshcodex',
      provider: 'codex',
    })
    const handled = handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.create.failed',
      requestId: 'req-owner-conflict',
      code: 'SESSION_OWNED_BY_TERMINAL',
      message: 'the session is owned by a terminal runtime',
      retryable: false,
      ownerKind: 'terminal',
      ownerGeneration: 6,
      ownerEpoch: 2,
    })
    expect(handled).toBe(true)
    expect(store.getState().freshAgent.pendingCreateFailures['req-owner-conflict']).toMatchObject({
      code: 'SESSION_OWNED_BY_TERMINAL',
      message: 'the session is owned by a terminal runtime',
      retryable: false,
      ownerKind: 'terminal',
      ownerGeneration: 6,
      ownerEpoch: 2,
    })
  })

  it('the cancelled-create cleanup kill carries the observed ownership fence', () => {
    const store = createFreshAgentStore()
    const ws = { send: vi.fn() }
    registerFreshAgentCreate(store.dispatch, 'req-orphan-fence', {
      sessionType: 'freshcodex',
      provider: 'codex',
    })
    cancelCreate('req-orphan-fence')
    const handled = handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.created',
      requestId: 'req-orphan-fence',
      sessionId: 'thread-orphan-fence',
      sessionType: 'freshcodex',
      provider: 'codex',
    }, ws, (provider, sessionId) => (
      provider === 'codex' && sessionId === 'thread-orphan-fence'
        ? { epoch: 4, generation: 9 }
        : undefined
    ))
    expect(handled).toBe(true)
    expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'freshAgent.kill',
      sessionId: 'thread-orphan-fence',
      sessionType: 'freshcodex',
      provider: 'codex',
      observedEpoch: 4,
      observedGeneration: 9,
    }))
  })

  it('the cancelled-create cleanup kill stays legacy-unfenced when no owner record is known', () => {
    const store = createFreshAgentStore()
    const ws = { send: vi.fn() }
    registerFreshAgentCreate(store.dispatch, 'req-orphan-plain', {
      sessionType: 'freshcodex',
      provider: 'codex',
    })
    cancelCreate('req-orphan-plain')
    handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.created',
      requestId: 'req-orphan-plain',
      sessionId: 'thread-orphan-plain',
      sessionType: 'freshcodex',
      provider: 'codex',
    }, ws, () => undefined)
    const sent = ws.send.mock.calls[0][0] as Record<string, unknown>
    expect(sent.observedEpoch).toBeUndefined()
    expect(sent.observedGeneration).toBeUndefined()
  })
})
