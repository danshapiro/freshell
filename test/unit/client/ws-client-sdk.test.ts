import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleSdkMessage, cancelCreate, _resetCancelledCreates } from '../../../src/lib/sdk-message-handler'
import * as agentChatSlice from '../../../src/store/agentChatSlice'

describe('SDK Message Handler', () => {
  const dispatch = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    _resetCancelledCreates()
  })

  it('handles sdk.created', () => {
    const handled = handleSdkMessage(dispatch, {
      type: 'sdk.created',
      requestId: 'req-1',
      sessionId: 'sess-1',
    })
    expect(handled).toBe(true)
    expect(dispatch).toHaveBeenCalledWith(
      agentChatSlice.sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' })
    )
  })

  it('kills orphan on sdk.created when createRequestId was cancelled', () => {
    const wsMock = { send: vi.fn() }
    cancelCreate('req-orphan')
    const handled = handleSdkMessage(dispatch, {
      type: 'sdk.created',
      requestId: 'req-orphan',
      sessionId: 'sess-orphan',
    }, wsMock)
    expect(handled).toBe(true)
    // Should NOT dispatch sessionCreated
    expect(dispatch).not.toHaveBeenCalled()
    // Should send sdk.kill to the server
    expect(wsMock.send).toHaveBeenCalledWith({ type: 'sdk.kill', sessionId: 'sess-orphan' })
  })

  it('does not kill non-cancelled creates', () => {
    const wsMock = { send: vi.fn() }
    cancelCreate('req-other')
    const handled = handleSdkMessage(dispatch, {
      type: 'sdk.created',
      requestId: 'req-1',
      sessionId: 'sess-1',
    }, wsMock)
    expect(handled).toBe(true)
    expect(dispatch).toHaveBeenCalledWith(
      agentChatSlice.sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' })
    )
    expect(wsMock.send).not.toHaveBeenCalled()
  })

  it('handles sdk.session.init', () => {
    const handled = handleSdkMessage(dispatch, {
      type: 'sdk.session.init',
      sessionId: 'sess-1',
      cliSessionId: 'cli-123',
      model: 'claude-sonnet-4-5-20250929',
      cwd: '/home/user',
      tools: [{ name: 'Bash' }],
    })
    expect(handled).toBe(true)
    expect(dispatch).toHaveBeenCalledWith(
      agentChatSlice.sessionInit({
        sessionId: 'sess-1',
        cliSessionId: 'cli-123',
        model: 'claude-sonnet-4-5-20250929',
        cwd: '/home/user',
        tools: [{ name: 'Bash' }],
      })
    )
  })

  it('handles sdk.assistant', () => {
    const handled = handleSdkMessage(dispatch, {
      type: 'sdk.assistant',
      sessionId: 'sess-1',
      content: [{ type: 'text', text: 'Hello' }],
      model: 'claude-sonnet-4-5-20250929',
    })
    expect(handled).toBe(true)
    expect(dispatch).toHaveBeenCalledWith(
      agentChatSlice.addAssistantMessage({
        sessionId: 'sess-1',
        content: [{ type: 'text', text: 'Hello' }],
        model: 'claude-sonnet-4-5-20250929',
      })
    )
  })

  it('handles sdk.stream content_block_start', () => {
    const handled = handleSdkMessage(dispatch, {
      type: 'sdk.stream',
      sessionId: 'sess-1',
      event: { type: 'content_block_start' },
    })
    expect(handled).toBe(true)
    expect(dispatch).toHaveBeenCalledWith(
      agentChatSlice.setStreaming({ sessionId: 'sess-1', active: true })
    )
  })

  it('handles sdk.stream content_block_delta with text_delta', () => {
    const handled = handleSdkMessage(dispatch, {
      type: 'sdk.stream',
      sessionId: 'sess-1',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
    })
    expect(handled).toBe(true)
    expect(dispatch).toHaveBeenCalledWith(
      agentChatSlice.appendStreamDelta({ sessionId: 'sess-1', text: 'Hello' })
    )
  })

  it('handles sdk.stream content_block_stop', () => {
    const handled = handleSdkMessage(dispatch, {
      type: 'sdk.stream',
      sessionId: 'sess-1',
      event: { type: 'content_block_stop' },
    })
    expect(handled).toBe(true)
    expect(dispatch).toHaveBeenCalledWith(
      agentChatSlice.clearStreaming({ sessionId: 'sess-1' })
    )
  })

  it('handles sdk.stream with unknown event type without dispatching', () => {
    const handled = handleSdkMessage(dispatch, {
      type: 'sdk.stream',
      sessionId: 'sess-1',
      event: { type: 'message_start' },
    })
    expect(handled).toBe(true)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('handles sdk.result', () => {
    const handled = handleSdkMessage(dispatch, {
      type: 'sdk.result',
      sessionId: 'sess-1',
      costUsd: 0.05,
      durationMs: 3000,
      usage: { input_tokens: 1000, output_tokens: 500 },
    })
    expect(handled).toBe(true)
    expect(dispatch).toHaveBeenCalledWith(
      agentChatSlice.turnResult({
        sessionId: 'sess-1',
        costUsd: 0.05,
        durationMs: 3000,
        usage: { input_tokens: 1000, output_tokens: 500 },
      })
    )
  })

  it('handles sdk.permission.request', () => {
    const handled = handleSdkMessage(dispatch, {
      type: 'sdk.permission.request',
      sessionId: 'sess-1',
      requestId: 'perm-1',
      subtype: 'can_use_tool',
      tool: { name: 'Bash', input: { command: 'ls' } },
    })
    expect(handled).toBe(true)
    expect(dispatch).toHaveBeenCalledWith(
      agentChatSlice.addPermissionRequest({
        sessionId: 'sess-1',
        requestId: 'perm-1',
        subtype: 'can_use_tool',
        tool: { name: 'Bash', input: { command: 'ls' } },
      })
    )
  })

  it('handles sdk.permission.cancelled', () => {
    const handled = handleSdkMessage(dispatch, {
      type: 'sdk.permission.cancelled',
      sessionId: 'sess-1',
      requestId: 'perm-1',
    })
    expect(handled).toBe(true)
    expect(dispatch).toHaveBeenCalledWith(
      agentChatSlice.removePermission({
        sessionId: 'sess-1',
        requestId: 'perm-1',
      })
    )
  })

  it('handles sdk.status', () => {
    const handled = handleSdkMessage(dispatch, {
      type: 'sdk.status',
      sessionId: 'sess-1',
      status: 'idle',
    })
    expect(handled).toBe(true)
    expect(dispatch).toHaveBeenCalledWith(
      agentChatSlice.setSessionStatus({
        sessionId: 'sess-1',
        status: 'idle',
      })
    )
  })

  it('handles sdk.exit', () => {
    const handled = handleSdkMessage(dispatch, {
      type: 'sdk.exit',
      sessionId: 'sess-1',
      exitCode: 0,
    })
    expect(handled).toBe(true)
    expect(dispatch).toHaveBeenCalledWith(
      agentChatSlice.sessionExited({
        sessionId: 'sess-1',
        exitCode: 0,
      })
    )
  })

  it('handles sdk.history by dispatching replayHistory', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: '2026-01-01T00:00:00Z' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: '2026-01-01T00:00:01Z' },
    ]
    const handled = handleSdkMessage(dispatch, {
      type: 'sdk.history',
      sessionId: 'sess-1',
      messages,
    })
    expect(handled).toBe(true)
    expect(dispatch).toHaveBeenCalledWith(
      agentChatSlice.replayHistory({ sessionId: 'sess-1', messages })
    )
  })

  it('handles sdk.error by dispatching sessionError', () => {
    const handled = handleSdkMessage(dispatch, {
      type: 'sdk.error',
      sessionId: 'sess-1',
      message: 'Something went wrong',
    })
    expect(handled).toBe(true)
    expect(dispatch).toHaveBeenCalledWith(
      agentChatSlice.sessionError({ sessionId: 'sess-1', message: 'Something went wrong' })
    )
  })

  it('handles sdk.error with legacy error field', () => {
    const handled = handleSdkMessage(dispatch, {
      type: 'sdk.error',
      sessionId: 'sess-1',
      error: 'Legacy error',
    })
    expect(handled).toBe(true)
    expect(dispatch).toHaveBeenCalledWith(
      agentChatSlice.sessionError({ sessionId: 'sess-1', message: 'Legacy error' })
    )
  })

  it('handles sdk.killed by dispatching removeSession', () => {
    const handled = handleSdkMessage(dispatch, {
      type: 'sdk.killed',
      sessionId: 'sess-1',
      success: true,
    })
    expect(handled).toBe(true)
    expect(dispatch).toHaveBeenCalledWith(
      agentChatSlice.removeSession({ sessionId: 'sess-1' })
    )
  })

  it('returns false for non-SDK messages', () => {
    const handled = handleSdkMessage(dispatch, {
      type: 'terminal.created',
      terminalId: 'term-1',
    })
    expect(handled).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('returns false for messages without a type', () => {
    const handled = handleSdkMessage(dispatch, {
      sessionId: 'sess-1',
    })
    expect(handled).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
  })
})
