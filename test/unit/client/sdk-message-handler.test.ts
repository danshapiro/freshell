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

  it('dispatches setAvailableModels on sdk.models', () => {
    const { dispatch, calls } = createMockDispatch()
    const models = [
      { value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: 'Most capable' },
      { value: 'claude-sonnet-4-5-20250929', displayName: 'Sonnet 4.5', description: 'Fast' },
    ]

    const handled = handleSdkMessage(dispatch, {
      type: 'sdk.models',
      sessionId: 's1',
      models,
    })

    expect(handled).toBe(true)
    expect(dispatch).toHaveBeenCalledOnce()
    const action = calls[0]
    expect(action.type).toBe('claudeChat/setAvailableModels')
    expect(action.payload.models).toEqual(models)
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
    expect(calls[0].type).toBe('claudeChat/sessionCreated')
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
    expect(calls[0].type).toBe('claudeChat/sessionInit')
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
    expect(calls[0].type).toBe('claudeChat/turnResult')
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
