import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleSdkMessage, cancelCreate, _resetCancelledCreates } from '../../../src/lib/sdk-message-handler'

// Create a mock dispatch that records calls
function createMockDispatch() {
  const calls: Array<{ type: string; payload: any }> = []
  const dispatch = vi.fn((action: any) => {
    calls.push(action)
    return action
  })
  return { dispatch, calls }
}

describe('sdk-message-handler', () => {
  beforeEach(() => {
    _resetCancelledCreates()
  })

  it('ignores the obsolete sdk.models websocket path', () => {
    const { dispatch } = createMockDispatch()

    const handled = handleSdkMessage(dispatch, {
      type: 'sdk.models',
      sessionId: 's1',
      models: [{ value: 'opus', displayName: 'Opus' }],
    })

    expect(handled).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('dispatches sessionCreated on sdk.created', () => {
    const { dispatch, calls } = createMockDispatch()

    const handled = handleSdkMessage(dispatch, {
      type: 'sdk.created',
      requestId: 'req-1',
      sessionId: 'sess-1',
    })

    expect(handled).toBe(true)
    expect(dispatch).toHaveBeenCalledOnce()
    expect(calls[0].type).toBe('agentChat/sessionCreated')
    expect(calls[0].payload).toEqual({ requestId: 'req-1', sessionId: 'sess-1' })
  })

  it('kills orphaned session on sdk.created for cancelled create', () => {
    const { dispatch } = createMockDispatch()
    const ws = { send: vi.fn() }

    cancelCreate('req-1')

    const handled = handleSdkMessage(dispatch, {
      type: 'sdk.created',
      requestId: 'req-1',
      sessionId: 'sess-1',
    }, ws)

    expect(handled).toBe(true)
    expect(dispatch).not.toHaveBeenCalled()
    expect(ws.send).toHaveBeenCalledWith({ type: 'sdk.kill', sessionId: 'sess-1' })
  })

  it('dispatches sessionInit on sdk.session.init', () => {
    const { dispatch, calls } = createMockDispatch()

    const handled = handleSdkMessage(dispatch, {
      type: 'sdk.session.init',
      sessionId: 's1',
      cliSessionId: 'cli-abc',
      model: 'claude-opus-4-6',
      cwd: '/home/user',
      tools: [{ name: 'Bash' }],
    })

    expect(handled).toBe(true)
    expect(calls[0].type).toBe('agentChat/sessionInit')
  })

  it('dispatches sessionSnapshotReceived on sdk.session.snapshot', () => {
    const { dispatch, calls } = createMockDispatch()

    const handled = handleSdkMessage(dispatch, {
      type: 'sdk.session.snapshot',
      sessionId: 's1',
      latestTurnId: 'turn-9',
      status: 'idle',
      timelineSessionId: 'cli-1',
      revision: 2,
      streamingActive: true,
      streamingText: 'partial reply',
    })

    expect(handled).toBe(true)
    expect(dispatch).toHaveBeenCalledOnce()
    expect(calls[0].type).toBe('agentChat/sessionSnapshotReceived')
    expect(calls[0].payload).toEqual({
      sessionId: 's1',
      latestTurnId: 'turn-9',
      status: 'idle',
      timelineSessionId: 'cli-1',
      revision: 2,
      streamingActive: true,
      streamingText: 'partial reply',
    })
  })

  it('dispatches createFailed on sdk.create.failed without fabricating a session id', () => {
    const { dispatch, calls } = createMockDispatch()

    const handled = handleSdkMessage(dispatch, {
      type: 'sdk.create.failed',
      requestId: 'req-1',
      code: 'RESTORE_INTERNAL',
      message: 'boom',
      retryable: true,
    })

    expect(handled).toBe(true)
    expect(dispatch).toHaveBeenCalledOnce()
    expect(calls[0]).toEqual({
      type: 'agentChat/createFailed',
      payload: {
        requestId: 'req-1',
        code: 'RESTORE_INTERNAL',
        message: 'boom',
        retryable: true,
      },
    })
  })

  it('dispatches sessionMetadataReceived on sdk.session.metadata', () => {
    const { dispatch, calls } = createMockDispatch()

    const handled = handleSdkMessage(dispatch, {
      type: 'sdk.session.metadata',
      sessionId: 's1',
      cliSessionId: 'cli-abc',
      model: 'claude-opus-4-6',
      cwd: '/home/user',
      tools: [{ name: 'Bash' }],
    })

    expect(handled).toBe(true)
    expect(dispatch).toHaveBeenCalledOnce()
    expect(calls[0]).toEqual({
      type: 'agentChat/sessionMetadataReceived',
      payload: {
        sessionId: 's1',
        cliSessionId: 'cli-abc',
        model: 'claude-opus-4-6',
        cwd: '/home/user',
        tools: [{ name: 'Bash' }],
      },
    })
  })

  it('dispatches turnResult on sdk.result', () => {
    const { dispatch, calls } = createMockDispatch()

    const handled = handleSdkMessage(dispatch, {
      type: 'sdk.result',
      sessionId: 's1',
      costUsd: 0.05,
      durationMs: 3000,
      usage: { input_tokens: 1000, output_tokens: 500 },
    })

    expect(handled).toBe(true)
    expect(calls[0].type).toBe('agentChat/turnResult')
  })

  it('marks streaming inactive without clearing partial text on content_block_stop', () => {
    const { dispatch, calls } = createMockDispatch()

    const handled = handleSdkMessage(dispatch, {
      type: 'sdk.stream',
      sessionId: 's1',
      event: { type: 'content_block_stop' },
    })

    expect(handled).toBe(true)
    expect(dispatch).toHaveBeenCalledOnce()
    expect(calls[0]).toEqual({
      type: 'agentChat/setStreaming',
      payload: {
        sessionId: 's1',
        active: false,
      },
    })
  })

  it('returns false for unknown message types', () => {
    const { dispatch } = createMockDispatch()

    const handled = handleSdkMessage(dispatch, {
      type: 'unknown.type',
      sessionId: 's1',
    })

    expect(handled).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
  })
})
