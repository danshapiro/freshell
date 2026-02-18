import { describe, it, expect } from 'vitest'
import claudeChatReducer, {
  sessionCreated,
  sessionInit,
  addAssistantMessage,
  addUserMessage,
  setStreaming,
  appendStreamDelta,
  clearStreaming,
  addPermissionRequest,
  removePermission,
  setSessionStatus,
  turnResult,
  sessionExited,
  replayHistory,
  sessionError,
  clearPendingCreate,
  removeSession,
  setAvailableModels,
} from '../../../src/store/claudeChatSlice'

describe('claudeChatSlice', () => {
  const initial = claudeChatReducer(undefined, { type: 'init' })

  it('has empty initial state', () => {
    expect(initial.sessions).toEqual({})
    expect(initial.availableModels).toEqual([])
  })

  it('creates a session', () => {
    const state = claudeChatReducer(initial, sessionCreated({
      requestId: 'req-1',
      sessionId: 'sess-1',
    }))
    expect(state.sessions['sess-1']).toBeDefined()
    expect(state.sessions['sess-1'].messages).toEqual([])
    expect(state.sessions['sess-1'].status).toBe('starting')
  })

  it('initializes session with CLI details', () => {
    let state = claudeChatReducer(initial, sessionCreated({ requestId: 'r', sessionId: 's1' }))
    state = claudeChatReducer(state, sessionInit({
      sessionId: 's1',
      cliSessionId: 'cli-abc',
      model: 'claude-opus-4-6',
      cwd: '/home/user',
      tools: [{ name: 'Bash' }],
    }))
    expect(state.sessions['s1'].cliSessionId).toBe('cli-abc')
    expect(state.sessions['s1'].model).toBe('claude-opus-4-6')
    expect(state.sessions['s1'].status).toBe('connected')
  })

  it('stores user messages', () => {
    let state = claudeChatReducer(initial, sessionCreated({ requestId: 'r', sessionId: 's1' }))
    state = claudeChatReducer(state, addUserMessage({ sessionId: 's1', text: 'Hello' }))
    expect(state.sessions['s1'].messages).toHaveLength(1)
    expect(state.sessions['s1'].messages[0].role).toBe('user')
    expect(state.sessions['s1'].status).toBe('running')
  })

  it('stores assistant messages', () => {
    let state = claudeChatReducer(initial, sessionCreated({ requestId: 'r', sessionId: 's1' }))
    state = claudeChatReducer(state, addAssistantMessage({
      sessionId: 's1',
      content: [{ type: 'text', text: 'Hello' }],
      model: 'claude-sonnet-4-5-20250929',
    }))
    expect(state.sessions['s1'].messages).toHaveLength(1)
    expect(state.sessions['s1'].messages[0].role).toBe('assistant')
  })

  it('tracks streaming text', () => {
    let state = claudeChatReducer(initial, sessionCreated({ requestId: 'r', sessionId: 's1' }))
    state = claudeChatReducer(state, setStreaming({ sessionId: 's1', active: true }))
    state = claudeChatReducer(state, appendStreamDelta({ sessionId: 's1', text: 'Hel' }))
    state = claudeChatReducer(state, appendStreamDelta({ sessionId: 's1', text: 'lo' }))
    expect(state.sessions['s1'].streamingText).toBe('Hello')
    expect(state.sessions['s1'].streamingActive).toBe(true)
  })

  it('clears streaming state', () => {
    let state = claudeChatReducer(initial, sessionCreated({ requestId: 'r', sessionId: 's1' }))
    state = claudeChatReducer(state, setStreaming({ sessionId: 's1', active: true }))
    state = claudeChatReducer(state, appendStreamDelta({ sessionId: 's1', text: 'Hello' }))
    state = claudeChatReducer(state, clearStreaming({ sessionId: 's1' }))
    expect(state.sessions['s1'].streamingText).toBe('')
    expect(state.sessions['s1'].streamingActive).toBe(false)
  })

  it('tracks permission requests', () => {
    let state = claudeChatReducer(initial, sessionCreated({ requestId: 'r', sessionId: 's1' }))
    state = claudeChatReducer(state, addPermissionRequest({
      sessionId: 's1',
      requestId: 'perm-1',
      subtype: 'can_use_tool',
      tool: { name: 'Bash', input: { command: 'ls' } },
    }))
    expect(state.sessions['s1'].pendingPermissions['perm-1']).toBeDefined()
    state = claudeChatReducer(state, removePermission({ sessionId: 's1', requestId: 'perm-1' }))
    expect(state.sessions['s1'].pendingPermissions['perm-1']).toBeUndefined()
  })

  it('accumulates cost on result', () => {
    let state = claudeChatReducer(initial, sessionCreated({ requestId: 'r', sessionId: 's1' }))
    state = claudeChatReducer(state, turnResult({
      sessionId: 's1',
      costUsd: 0.05,
      durationMs: 3000,
      usage: { input_tokens: 1000, output_tokens: 500 },
    }))
    expect(state.sessions['s1'].totalCostUsd).toBe(0.05)
    expect(state.sessions['s1'].totalInputTokens).toBe(1000)
    expect(state.sessions['s1'].status).toBe('idle')
  })

  it('handles session exit', () => {
    let state = claudeChatReducer(initial, sessionCreated({ requestId: 'r', sessionId: 's1' }))
    state = claudeChatReducer(state, sessionExited({ sessionId: 's1', exitCode: 0 }))
    expect(state.sessions['s1'].status).toBe('exited')
  })

  it('ignores actions for unknown sessions', () => {
    const state = claudeChatReducer(initial, addUserMessage({ sessionId: 'nonexistent', text: 'hello' }))
    expect(state).toEqual(initial)
  })

  it('replays history messages into session (replaces, not appends)', () => {
    let state = claudeChatReducer(initial, sessionCreated({ requestId: 'r', sessionId: 's1' }))
    // Add an existing message
    state = claudeChatReducer(state, addUserMessage({ sessionId: 's1', text: 'existing' }))
    expect(state.sessions['s1'].messages).toHaveLength(1)

    // Replay should replace, not append
    state = claudeChatReducer(state, replayHistory({
      sessionId: 's1',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: '2026-01-01T00:00:00Z' },
        { role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: '2026-01-01T00:00:01Z' },
      ],
    }))
    expect(state.sessions['s1'].messages).toHaveLength(2)
    expect(state.sessions['s1'].messages[0].role).toBe('user')
    expect(state.sessions['s1'].messages[0].content[0].text).toBe('hello')
    expect(state.sessions['s1'].messages[1].role).toBe('assistant')
  })

  it('bootstraps session on replayHistory for unknown sessionId', () => {
    const state = claudeChatReducer(initial, replayHistory({
      sessionId: 'unknown-sess',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: '2026-01-01T00:00:00Z' },
      ],
    }))
    expect(state.sessions['unknown-sess']).toBeDefined()
    expect(state.sessions['unknown-sess'].messages).toHaveLength(1)
  })

  it('bootstraps session on setSessionStatus for unknown sessionId', () => {
    const state = claudeChatReducer(initial, setSessionStatus({
      sessionId: 'unknown-sess',
      status: 'idle',
    }))
    expect(state.sessions['unknown-sess']).toBeDefined()
    expect(state.sessions['unknown-sess'].status).toBe('idle')
  })

  it('bootstraps session on sessionInit for unknown sessionId', () => {
    const state = claudeChatReducer(initial, sessionInit({
      sessionId: 'unknown-sess',
      cliSessionId: 'cli-123',
      model: 'claude-opus-4-6',
    }))
    expect(state.sessions['unknown-sess']).toBeDefined()
    expect(state.sessions['unknown-sess'].cliSessionId).toBe('cli-123')
    expect(state.sessions['unknown-sess'].status).toBe('connected')
  })

  it('sets lastError on sessionError', () => {
    let state = claudeChatReducer(initial, sessionCreated({ requestId: 'r', sessionId: 's1' }))
    state = claudeChatReducer(state, sessionError({ sessionId: 's1', message: 'CLI crashed' }))
    expect(state.sessions['s1'].lastError).toBe('CLI crashed')
  })

  it('clears a pendingCreates entry', () => {
    let state = claudeChatReducer(initial, sessionCreated({ requestId: 'req-1', sessionId: 's1' }))
    expect(state.pendingCreates['req-1']).toBe('s1')
    state = claudeChatReducer(state, clearPendingCreate({ requestId: 'req-1' }))
    expect(state.pendingCreates['req-1']).toBeUndefined()
  })

  it('removes a session', () => {
    let state = claudeChatReducer(initial, sessionCreated({ requestId: 'r', sessionId: 's1' }))
    state = claudeChatReducer(state, removeSession({ sessionId: 's1' }))
    expect(state.sessions['s1']).toBeUndefined()
  })

  it('setAvailableModels populates models', () => {
    const models = [
      { value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: 'Most capable' },
      { value: 'claude-sonnet-4-5-20250929', displayName: 'Sonnet 4.5', description: 'Fast' },
    ]
    const state = claudeChatReducer(initial, setAvailableModels({ models }))
    expect(state.availableModels).toEqual(models)
    expect(state.availableModels).toHaveLength(2)
  })

  it('accumulates cost when costUsd is 0', () => {
    let state = claudeChatReducer(initial, sessionCreated({ requestId: 'r', sessionId: 's1' }))
    state = claudeChatReducer(state, turnResult({
      sessionId: 's1',
      costUsd: 0.05,
      usage: { input_tokens: 100, output_tokens: 50 },
    }))
    state = claudeChatReducer(state, turnResult({
      sessionId: 's1',
      costUsd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    }))
    // costUsd 0 should still be accumulated (no-op, but not skipped)
    expect(state.sessions['s1'].totalCostUsd).toBe(0.05)
    expect(state.sessions['s1'].totalInputTokens).toBe(100)
  })
})
