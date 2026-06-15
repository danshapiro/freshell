import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import freshAgentReducer from '@/store/freshAgentSlice'
import { handleFreshAgentMessage, registerFreshAgentCreate } from '@/lib/fresh-agent-ws'
import { cancelCreate, handleSdkMessage, _resetCancelledCreates } from '@/lib/sdk-message-handler'

function createFreshAgentStore() {
  return configureStore({
    reducer: {
      freshAgent: freshAgentReducer,
    },
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

  it('recognizes freshAgent.session.materialized as a handled fresh-agent message', () => {
    const store = createFreshAgentStore()

    expect(handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.session.materialized',
      previousSessionId: 'freshopencode-req-1',
      sessionId: 'ses_real_1',
      sessionType: 'freshopencode',
      provider: 'opencode',
      sessionRef: { provider: 'opencode', sessionId: 'ses_real_1' },
    })).toBe(true)
  })

  it('projects Claude freshAgent.event snapshot and lost-session transport updates into fresh-agent session state', () => {
    const store = createFreshAgentStore()

    expect(handleFreshAgentMessage(store.dispatch, {
      type: 'freshAgent.event',
      sessionId: 'claude-thread-1',
      sessionType: 'freshclaude',
      provider: 'claude',
      event: {
        type: 'sdk.session.snapshot',
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
        type: 'sdk.error',
        sessionId: 'claude-thread-1',
        code: 'INVALID_SESSION_ID',
        message: 'Session missing on server',
      },
    })).toBe(true)

    expect(store.getState().freshAgent.sessions['freshclaude:claude:claude-thread-1']).toEqual(expect.objectContaining({
      latestTurnId: 'turn-1',
      timelineSessionId: 'cli-session-1',
      timelineRevision: 7,
      lost: true,
      historyLoaded: false,
    }))
  })

  it('keeps the stale sdk.* websocket protocol compatible with freshclaude reload state', () => {
    const store = createFreshAgentStore()

    expect(handleSdkMessage(store.dispatch, {
      type: 'sdk.session.snapshot',
      sessionId: 'stale-thread-1',
      latestTurnId: 'turn-stale',
      status: 'idle',
      timelineSessionId: '00000000-0000-4000-8000-000000000001',
      revision: 3,
    })).toBe(true)

    expect(store.getState().freshAgent.sessions['freshclaude:claude:stale-thread-1']).toMatchObject({
      sessionId: 'stale-thread-1',
      sessionType: 'freshclaude',
      provider: 'claude',
      latestTurnId: 'turn-stale',
      timelineSessionId: '00000000-0000-4000-8000-000000000001',
      timelineRevision: 3,
    })
  })

  it('projects every old sdk.* server event carried by freshAgent.event into fresh-agent state', () => {
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

    expect(sendEvent({ type: 'sdk.session.snapshot', latestTurnId: null, status: 'idle', revision: 1 })).toBe(true)
    expect(sendEvent({ type: 'sdk.session.init', cliSessionId: 'cli-1', model: 'claude-opus-4-6', cwd: '/repo' })).toBe(true)
    expect(sendEvent({ type: 'sdk.session.metadata', cliSessionId: 'cli-2', model: 'claude-sonnet-4-6', tools: [{ name: 'Bash' }] })).toBe(true)
    expect(sendEvent({ type: 'sdk.status', status: 'running' })).toBe(true)
    expect(sendEvent({ type: 'sdk.stream', event: { type: 'content_block_start' } })).toBe(true)
    expect(sendEvent({ type: 'sdk.stream', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } } })).toBe(true)
    expect(sendEvent({ type: 'sdk.stream', event: { type: 'content_block_stop' } })).toBe(true)
    expect(sendEvent({
      type: 'sdk.assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: 'final answer' }],
    })).toBe(true)
    expect(sendEvent({ type: 'sdk.result', costUsd: 0.02, usage: { input_tokens: 10, output_tokens: 5 } })).toBe(true)
    expect(sendEvent({
      type: 'sdk.permission.request',
      requestId: 'perm-1',
      subtype: 'tool',
      tool: { name: 'Bash', input: { command: 'npm test' } },
    })).toBe(true)
    expect(store.getState().freshAgent.sessions[key].pendingPermissions['perm-1']).toMatchObject({
      toolName: 'Bash',
      input: { command: 'npm test' },
    })
    expect(sendEvent({ type: 'sdk.permission.cancelled', requestId: 'perm-1' })).toBe(true)
    expect(sendEvent({
      type: 'sdk.question.request',
      requestId: 'question-1',
      questions: [{ question: 'Continue?', options: [{ label: 'Yes', description: 'Proceed' }] }],
    })).toBe(true)
    expect(sendEvent({ type: 'sdk.error', code: 'SDK_WARNING', message: 'recoverable' })).toBe(true)

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

    expect(sendEvent({ type: 'sdk.exit', exitCode: 0 })).toBe(true)
    expect(store.getState().freshAgent.sessions[key].status).toBe('exited')
    expect(sendEvent({ type: 'sdk.killed' })).toBe(true)
    expect(store.getState().freshAgent.sessions[key]).toBeUndefined()
  })
})
