import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import freshAgentReducer from '@/store/freshAgentSlice'
import panesReducer, { initLayout, type PanesState } from '@/store/panesSlice'
import { handleFreshAgentMessage, registerFreshAgentCreate } from '@/lib/fresh-agent-ws'
import { cancelCreate, _resetCancelledCreates } from '@/lib/create-cancellation'
import { flushPersistedLayoutNow } from '@/store/persistControl'

function createFreshAgentStore() {
  return configureStore({
    reducer: {
      freshAgent: freshAgentReducer,
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
    expect(sendEvent({ type: 'freshAgent.stream', event: { type: 'content_block_start' } })).toBe(true)
    expect(sendEvent({ type: 'freshAgent.stream', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } } })).toBe(true)
    expect(sendEvent({ type: 'freshAgent.stream', event: { type: 'content_block_stop' } })).toBe(true)
    expect(sendEvent({
      type: 'freshAgent.assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'final answer' }],
    })).toBe(true)
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
      streamingText: '',
      streamingActive: false,
      totalCostUsd: 0.02,
      totalInputTokens: 10,
      totalOutputTokens: 5,
      lastError: 'recoverable',
    })
    expect(session.turns.at(-1)).toMatchObject({
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      summary: 'final answer',
    })
    expect(session.pendingPermissions).toEqual({})
    expect(session.pendingQuestions['question-1']).toMatchObject({
      questions: [{ question: 'Continue?' }],
    })

    expect(sendEvent({ type: 'freshAgent.exit', exitCode: 0 })).toBe(true)
    expect(store.getState().freshAgent.sessions[key].status).toBe('exited')
    expect(sendEvent({ type: 'freshAgent.killed' })).toBe(true)
    expect(store.getState().freshAgent.sessions[key]).toBeUndefined()
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
