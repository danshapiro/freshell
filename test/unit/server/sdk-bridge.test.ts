import { EventEmitter } from 'events'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the SDK's query function
const mockMessages: any[] = []
let mockCanUseTool: any = undefined
let mockAbortController: AbortController | undefined
let mockQueryOptions: any = undefined
/** Set to an Error to make the mock generator throw after yielding all messages */
let mockStreamError: Error | null = null
/** Set to a rejecting promise to simulate interrupt failure */
let mockInterruptFn: (() => Promise<void>) | undefined
/** When true, the mock generator pauses after yielding all messages (simulates a live session) */
let mockKeepStreamOpen = false
/** Call this to release a held-open stream */
let mockStreamEndResolve: (() => void) | null = null
/** Mock supportedModels return value */
let mockSupportedModels: any[] = [
  { value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: 'Most capable' },
  { value: 'claude-sonnet-4-5-20250929', displayName: 'Sonnet 4.5', description: 'Fast' },
]
/** When set, supportedModels() rejects with this error */
let mockSupportedModelsError: Error | null = null

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(({ options }: any) => {
    mockAbortController = options?.abortController
    mockCanUseTool = options?.canUseTool
    mockQueryOptions = options
    // Return an AsyncGenerator that yields mockMessages
    const gen = (async function* () {
      for (const msg of mockMessages) {
        yield msg
      }
      if (mockStreamError) {
        throw mockStreamError
      }
      if (mockKeepStreamOpen) {
        await new Promise<void>(resolve => { mockStreamEndResolve = resolve })
      }
    })()
    // Add Query methods
    ;(gen as any).close = vi.fn()
    ;(gen as any).interrupt = mockInterruptFn ?? vi.fn().mockResolvedValue(undefined)
    ;(gen as any).streamInput = vi.fn()
    ;(gen as any).setPermissionMode = vi.fn().mockResolvedValue(undefined)
    ;(gen as any).setModel = vi.fn().mockResolvedValue(undefined)
    ;(gen as any).supportedModels = mockSupportedModelsError
      ? vi.fn().mockRejectedValue(mockSupportedModelsError)
      : vi.fn().mockResolvedValue(mockSupportedModels)
    return gen
  }),
}))

import { SdkBridge } from '../../../server/sdk-bridge.js'

describe('SdkBridge', () => {
  let bridge: SdkBridge

  beforeEach(() => {
    mockMessages.length = 0
    mockCanUseTool = undefined
    mockQueryOptions = undefined
    mockStreamError = null
    mockInterruptFn = undefined
    mockKeepStreamOpen = false
    mockStreamEndResolve = null
    mockSupportedModels = [
      { value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: 'Most capable' },
      { value: 'claude-sonnet-4-5-20250929', displayName: 'Sonnet 4.5', description: 'Fast' },
    ]
    mockSupportedModelsError = null
    bridge = new SdkBridge()
  })

  afterEach(() => {
    // Release any held streams before closing to avoid hanging
    mockStreamEndResolve?.()
    bridge.close()
  })

  describe('session lifecycle', () => {
    it('creates a session with unique ID', async () => {
      mockKeepStreamOpen = true
      const session = await bridge.createSession({ cwd: '/tmp' })
      expect(session.sessionId).toBeTruthy()
      expect(session.status).toBe('starting')
      expect(session.cwd).toBe('/tmp')
    })

    it('lists active sessions', async () => {
      mockKeepStreamOpen = true
      await bridge.createSession({ cwd: '/tmp' })
      await bridge.createSession({ cwd: '/home' })
      expect(bridge.listSessions()).toHaveLength(2)
    })

    it('gets session by ID', async () => {
      const session = await bridge.createSession({ cwd: '/tmp' })
      expect(bridge.getSession(session.sessionId)).toBeDefined()
      expect(bridge.getSession('nonexistent')).toBeUndefined()
    })

    it('kills a session', async () => {
      const session = await bridge.createSession({ cwd: '/tmp' })
      const killed = bridge.killSession(session.sessionId)
      expect(killed).toBe(true)
      expect(bridge.getSession(session.sessionId)?.status).toBe('exited')
    })

    it('returns false when killing nonexistent session', () => {
      expect(bridge.killSession('nonexistent')).toBe(false)
    })
  })

  describe('SDK message translation', () => {
    it('translates system init to sdk.session.init', async () => {
      mockKeepStreamOpen = true
      mockMessages.push({
        type: 'system',
        subtype: 'init',
        session_id: 'cli-123',
        model: 'claude-sonnet-4-5-20250929',
        cwd: '/home/user',
        tools: ['Bash', 'Read'],
        uuid: 'test-uuid',
      })

      const session = await bridge.createSession({ cwd: '/tmp' })
      const received: any[] = []
      bridge.subscribe(session.sessionId, (msg) => received.push(msg))

      // Wait for async generator to process
      await new Promise(resolve => setTimeout(resolve, 100))

      const initMsg = received.find(m => m.type === 'sdk.session.init')
      expect(initMsg).toBeDefined()
      expect(initMsg.cliSessionId).toBe('cli-123')
      expect(initMsg.model).toBe('claude-sonnet-4-5-20250929')
    })

    it('translates assistant messages to sdk.assistant', async () => {
      mockKeepStreamOpen = true
      mockMessages.push({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello' }],
          model: 'claude-sonnet-4-5-20250929',
        },
        parent_tool_use_id: null,
        uuid: 'test-uuid',
        session_id: 'cli-123',
      })

      const session = await bridge.createSession({ cwd: '/tmp' })
      const received: any[] = []
      bridge.subscribe(session.sessionId, (msg) => received.push(msg))

      await new Promise(resolve => setTimeout(resolve, 100))

      const assistantMsg = received.find(m => m.type === 'sdk.assistant')
      expect(assistantMsg).toBeDefined()
    })

    it('translates result to sdk.result with cost tracking', async () => {
      mockKeepStreamOpen = true
      mockMessages.push({
        type: 'result',
        subtype: 'success',
        duration_ms: 3000,
        duration_api_ms: 2500,
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0.05,
        usage: { input_tokens: 1000, output_tokens: 500 },
        session_id: 'cli-123',
        uuid: 'test-uuid',
      })

      const session = await bridge.createSession({ cwd: '/tmp' })
      const received: any[] = []
      bridge.subscribe(session.sessionId, (msg) => received.push(msg))

      await new Promise(resolve => setTimeout(resolve, 100))

      const resultMsg = received.find(m => m.type === 'sdk.result')
      expect(resultMsg).toBeDefined()
      expect(resultMsg.costUsd).toBe(0.05)
      expect(bridge.getSession(session.sessionId)?.costUsd).toBe(0.05)
      expect(bridge.getSession(session.sessionId)?.totalInputTokens).toBe(1000)
    })

    it('translates stream_event with parent_tool_use_id', async () => {
      mockKeepStreamOpen = true
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
        parent_tool_use_id: 'tool-1',
        uuid: 'test-uuid',
        session_id: 'cli-123',
      })

      const session = await bridge.createSession({ cwd: '/tmp' })
      const received: any[] = []
      bridge.subscribe(session.sessionId, (msg) => received.push(msg))

      await new Promise(resolve => setTimeout(resolve, 100))

      const streamMsg = received.find(m => m.type === 'sdk.stream')
      expect(streamMsg).toBeDefined()
      expect(streamMsg.parentToolUseId).toBe('tool-1')
    })

    it('sets status to idle on result', async () => {
      mockKeepStreamOpen = true
      mockMessages.push({
        type: 'result',
        subtype: 'success',
        duration_ms: 100,
        duration_api_ms: 80,
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0.01,
        usage: { input_tokens: 100, output_tokens: 50 },
        session_id: 'cli-123',
        uuid: 'test-uuid',
      })

      const session = await bridge.createSession({ cwd: '/tmp' })
      // Subscribe to prevent buffering
      bridge.subscribe(session.sessionId, () => {})
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(bridge.getSession(session.sessionId)?.status).toBe('idle')
    })

    it('sets status to running on assistant message', async () => {
      mockKeepStreamOpen = true
      mockMessages.push({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'working...' }] },
        parent_tool_use_id: null,
        uuid: 'test-uuid',
        session_id: 'cli-123',
      })

      const session = await bridge.createSession({ cwd: '/tmp' })
      bridge.subscribe(session.sessionId, () => {})
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(bridge.getSession(session.sessionId)?.status).toBe('running')
    })
  })

  describe('subscribe/unsubscribe', () => {
    it('subscribe returns null for nonexistent session', () => {
      expect(bridge.subscribe('nonexistent', () => {})).toBeNull()
    })

    it('unsubscribe removes listener', async () => {
      mockKeepStreamOpen = true
      mockMessages.push({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello' }] },
        parent_tool_use_id: null,
        uuid: 'test-uuid',
        session_id: 'cli-123',
      })

      const session = await bridge.createSession({ cwd: '/tmp' })
      const received: any[] = []
      const unsub = bridge.subscribe(session.sessionId, (msg) => received.push(msg))
      unsub!()

      await new Promise(resolve => setTimeout(resolve, 100))
      // Messages should be buffered, not sent to unsubscribed listener
      expect(received).toHaveLength(0)
    })

    it('emits message event on broadcast', async () => {
      mockKeepStreamOpen = true
      mockMessages.push({
        type: 'system',
        subtype: 'init',
        session_id: 'cli-123',
        model: 'claude-sonnet-4-5-20250929',
        cwd: '/tmp',
        tools: ['Bash'],
        uuid: 'test-uuid',
      })

      const session = await bridge.createSession({ cwd: '/tmp' })
      const emitted: any[] = []
      bridge.on('message', (_sid: string, msg: any) => emitted.push(msg))
      bridge.subscribe(session.sessionId, () => {})

      await new Promise(resolve => setTimeout(resolve, 100))
      expect(emitted.length).toBeGreaterThan(0)
    })
  })

  describe('permission round-trip', () => {
    it('broadcasts permission request with SDK context and resolves on respond', async () => {
      mockKeepStreamOpen = true
      const session = await bridge.createSession({ cwd: '/tmp' })
      const received: any[] = []
      bridge.subscribe(session.sessionId, (msg) => received.push(msg))

      const state = bridge.getSession(session.sessionId)!
      const resolvePromise = new Promise<any>((resolve) => {
        state.pendingPermissions.set('req-1', {
          toolName: 'Bash',
          input: { command: 'rm -rf /' },
          toolUseID: 'tool-1',
          suggestions: [],
          resolve,
        })
      })

      bridge.respondPermission(session.sessionId, 'req-1', {
        behavior: 'allow',
        updatedInput: { command: 'ls' },
      })

      const result = await resolvePromise
      expect(result.behavior).toBe('allow')
      expect(result.updatedInput).toEqual({ command: 'ls' })
      expect(state.pendingPermissions.has('req-1')).toBe(false)
    })

    it('deny requires message field', async () => {
      mockKeepStreamOpen = true
      const session = await bridge.createSession({ cwd: '/tmp' })
      const state = bridge.getSession(session.sessionId)!
      const resolvePromise = new Promise<any>((resolve) => {
        state.pendingPermissions.set('req-2', {
          toolName: 'Bash',
          input: { command: 'rm -rf /' },
          toolUseID: 'tool-2',
          resolve,
        })
      })

      bridge.respondPermission(session.sessionId, 'req-2', {
        behavior: 'deny',
        message: 'Too dangerous',
        interrupt: true,
      })

      const result = await resolvePromise
      expect(result.behavior).toBe('deny')
      expect(result.message).toBe('Too dangerous')
      expect(result.interrupt).toBe(true)
    })
  })

  describe('message buffering', () => {
    it('buffers messages before first subscriber and replays on subscribe', async () => {
      mockKeepStreamOpen = true
      mockMessages.push(
        {
          type: 'system',
          subtype: 'init',
          session_id: 'cli-123',
          model: 'claude-sonnet-4-5-20250929',
          cwd: '/tmp',
          tools: ['Bash'],
          uuid: 'test-uuid-1',
        },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Hello' }],
            model: 'claude-sonnet-4-5-20250929',
          },
          parent_tool_use_id: null,
          uuid: 'test-uuid-2',
          session_id: 'cli-123',
        },
      )

      const session = await bridge.createSession({ cwd: '/tmp' })

      // Wait for stream to be consumed (messages buffered, no subscriber yet)
      await new Promise(resolve => setTimeout(resolve, 100))

      // NOW subscribe — should get buffered messages replayed
      const received: any[] = []
      bridge.subscribe(session.sessionId, (msg) => received.push(msg))

      // sdk.session.init + sdk.models (async) + sdk.assistant
      expect(received.length).toBeGreaterThanOrEqual(2)
      expect(received[0].type).toBe('sdk.session.init')
      expect(received.find(m => m.type === 'sdk.assistant')).toBeDefined()
    })
  })

  describe('sendUserMessage', () => {
    it('stores user message in session history', async () => {
      mockKeepStreamOpen = true
      const session = await bridge.createSession({ cwd: '/tmp' })
      bridge.sendUserMessage(session.sessionId, 'hello')
      const state = bridge.getSession(session.sessionId)
      expect(state?.messages).toHaveLength(1)
      expect(state?.messages[0].role).toBe('user')
    })

    it('returns false for nonexistent session', () => {
      expect(bridge.sendUserMessage('nonexistent', 'hello')).toBe(false)
    })
  })

  describe('interrupt', () => {
    it('returns false for nonexistent session', () => {
      expect(bridge.interrupt('nonexistent')).toBe(false)
    })

    it('calls query.interrupt() for existing session', async () => {
      mockKeepStreamOpen = true
      const session = await bridge.createSession({ cwd: '/tmp' })
      expect(bridge.interrupt(session.sessionId)).toBe(true)
    })

    it('handles interrupt rejection without unhandled rejection', async () => {
      mockKeepStreamOpen = true
      mockInterruptFn = vi.fn().mockRejectedValue(new Error('interrupt failed'))
      const session = await bridge.createSession({ cwd: '/tmp' })
      // Should return true (fire-and-forget) and not throw
      expect(bridge.interrupt(session.sessionId)).toBe(true)
      // Let the rejection handler run
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mockInterruptFn).toHaveBeenCalled()
    })
  })

  describe('stream end cleanup', () => {
    it('cleans up process on natural stream end so sendUserMessage returns false', async () => {
      mockMessages.push({
        type: 'result',
        subtype: 'success',
        duration_ms: 100,
        duration_api_ms: 80,
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0.01,
        usage: { input_tokens: 100, output_tokens: 50 },
        session_id: 'cli-123',
        uuid: 'test-uuid',
      })

      const session = await bridge.createSession({ cwd: '/tmp' })
      bridge.subscribe(session.sessionId, () => {})
      // Wait for stream to complete and cleanup to run
      await new Promise(resolve => setTimeout(resolve, 150))

      // Session state still exists for display
      expect(bridge.getSession(session.sessionId)).toBeDefined()
      expect(bridge.getSession(session.sessionId)?.status).toBe('idle')
      // But process is gone — sendUserMessage returns false
      expect(bridge.sendUserMessage(session.sessionId, 'hello')).toBe(false)
      // subscribe returns null
      expect(bridge.subscribe(session.sessionId, () => {})).toBeNull()
      // interrupt returns false
      expect(bridge.interrupt(session.sessionId)).toBe(false)
    })

    it('cleans up process on stream error so sendUserMessage returns false', async () => {
      mockStreamError = new Error('SDK crashed')
      mockMessages.push({
        type: 'system',
        subtype: 'init',
        session_id: 'cli-123',
        model: 'claude-sonnet-4-5-20250929',
        cwd: '/tmp',
        tools: ['Bash'],
        uuid: 'test-uuid',
      })

      const session = await bridge.createSession({ cwd: '/tmp' })
      const received: any[] = []
      bridge.subscribe(session.sessionId, (msg) => received.push(msg))
      await new Promise(resolve => setTimeout(resolve, 150))

      // Error should have been broadcast
      const errorMsg = received.find(m => m.type === 'sdk.error')
      expect(errorMsg).toBeDefined()
      expect(errorMsg.message).toContain('SDK crashed')

      // Session state still exists for display
      expect(bridge.getSession(session.sessionId)).toBeDefined()
      expect(bridge.getSession(session.sessionId)?.status).toBe('idle')
      // Process cleaned up
      expect(bridge.sendUserMessage(session.sessionId, 'hello')).toBe(false)
    })

    it('killSession works for sessions whose stream has ended', async () => {
      const session = await bridge.createSession({ cwd: '/tmp' })
      bridge.subscribe(session.sessionId, () => {})
      await new Promise(resolve => setTimeout(resolve, 150))

      // Process is gone but session exists
      expect(bridge.getSession(session.sessionId)).toBeDefined()
      // killSession still works for cleanup
      expect(bridge.killSession(session.sessionId)).toBe(true)
      expect(bridge.getSession(session.sessionId)?.status).toBe('exited')
    })
  })

  describe('effort option', () => {
    it('passes effort to SDK query options', async () => {
      await bridge.createSession({ cwd: '/tmp', effort: 'max' })
      expect(mockQueryOptions?.effort).toBe('max')
    })

    it('omits effort from SDK query options when not set', async () => {
      await bridge.createSession({ cwd: '/tmp' })
      expect(mockQueryOptions?.effort).toBeUndefined()
    })
  })

  describe('setModel', () => {
    it('returns false for nonexistent session', () => {
      expect(bridge.setModel('nonexistent', 'claude-sonnet-4-5-20250929')).toBe(false)
    })

    it('calls query.setModel() and updates session state', async () => {
      mockKeepStreamOpen = true
      const session = await bridge.createSession({ cwd: '/tmp', model: 'claude-opus-4-6' })
      const result = bridge.setModel(session.sessionId, 'claude-sonnet-4-5-20250929')
      expect(result).toBe(true)
      expect(bridge.getSession(session.sessionId)?.model).toBe('claude-sonnet-4-5-20250929')
    })
  })

  describe('setPermissionMode', () => {
    it('returns false for nonexistent session', () => {
      expect(bridge.setPermissionMode('nonexistent', 'default')).toBe(false)
    })

    it('calls query.setPermissionMode() and updates session state', async () => {
      mockKeepStreamOpen = true
      const session = await bridge.createSession({ cwd: '/tmp', permissionMode: 'bypassPermissions' })
      const result = bridge.setPermissionMode(session.sessionId, 'default')
      expect(result).toBe(true)
      expect(bridge.getSession(session.sessionId)?.permissionMode).toBe('default')
    })
  })

  describe('fetchAndBroadcastModels', () => {
    it('broadcasts sdk.models after system/init', async () => {
      mockKeepStreamOpen = true
      mockMessages.push({
        type: 'system',
        subtype: 'init',
        session_id: 'cli-123',
        model: 'claude-sonnet-4-5-20250929',
        cwd: '/home/user',
        tools: ['Bash'],
        uuid: 'test-uuid',
      })

      const session = await bridge.createSession({ cwd: '/tmp' })
      const received: any[] = []
      bridge.subscribe(session.sessionId, (msg) => received.push(msg))

      await new Promise(resolve => setTimeout(resolve, 200))

      const modelsMsg = received.find(m => m.type === 'sdk.models')
      expect(modelsMsg).toBeDefined()
      expect(modelsMsg.models).toHaveLength(2)
      expect(modelsMsg.models[0].value).toBe('claude-opus-4-6')
    })

    it('uses cached models for subsequent sessions', async () => {
      mockKeepStreamOpen = true
      const initMsg = {
        type: 'system',
        subtype: 'init',
        session_id: 'cli-123',
        model: 'claude-sonnet-4-5-20250929',
        cwd: '/tmp',
        tools: ['Bash'],
        uuid: 'test-uuid',
      }

      // First session — triggers fetch
      mockMessages.push(initMsg)
      const s1 = await bridge.createSession({ cwd: '/tmp' })
      const r1: any[] = []
      bridge.subscribe(s1.sessionId, (msg) => r1.push(msg))
      await new Promise(resolve => setTimeout(resolve, 200))
      expect(r1.find(m => m.type === 'sdk.models')).toBeDefined()

      // Second session — should use cache (change mock to prove it's not re-fetched)
      mockMessages.length = 0
      mockMessages.push({ ...initMsg, uuid: 'test-uuid-2' })
      mockSupportedModels = [{ value: 'different-model', displayName: 'Different', description: 'New' }]
      const s2 = await bridge.createSession({ cwd: '/tmp' })
      const r2: any[] = []
      bridge.subscribe(s2.sessionId, (msg) => r2.push(msg))
      await new Promise(resolve => setTimeout(resolve, 200))

      const modelsMsg = r2.find(m => m.type === 'sdk.models')
      expect(modelsMsg).toBeDefined()
      // Should be cached value, not the new mock
      expect(modelsMsg.models[0].value).toBe('claude-opus-4-6')
    })

    it('handles supportedModels() failure gracefully', async () => {
      mockKeepStreamOpen = true
      mockSupportedModelsError = new Error('Not supported')
      mockMessages.push({
        type: 'system',
        subtype: 'init',
        session_id: 'cli-123',
        model: 'claude-sonnet-4-5-20250929',
        cwd: '/tmp',
        tools: ['Bash'],
        uuid: 'test-uuid',
      })

      const session = await bridge.createSession({ cwd: '/tmp' })
      const received: any[] = []
      bridge.subscribe(session.sessionId, (msg) => received.push(msg))

      await new Promise(resolve => setTimeout(resolve, 200))

      // Should get sdk.session.init but no sdk.models (failure was swallowed)
      expect(received.find(m => m.type === 'sdk.session.init')).toBeDefined()
      expect(received.find(m => m.type === 'sdk.models')).toBeUndefined()
    })
  })

  describe('environment handling', () => {
    it('passes CLAUDE_CMD env var as pathToClaudeCodeExecutable', async () => {
      const original = process.env.CLAUDE_CMD
      try {
        process.env.CLAUDE_CMD = '/usr/local/bin/my-claude'
        await bridge.createSession({ cwd: '/tmp' })
        expect(mockQueryOptions?.pathToClaudeCodeExecutable).toBe('/usr/local/bin/my-claude')
      } finally {
        if (original !== undefined) {
          process.env.CLAUDE_CMD = original
        } else {
          delete process.env.CLAUDE_CMD
        }
      }
    })

    it('does not pass pathToClaudeCodeExecutable when CLAUDE_CMD is unset', async () => {
      const original = process.env.CLAUDE_CMD
      try {
        delete process.env.CLAUDE_CMD
        await bridge.createSession({ cwd: '/tmp' })
        expect(mockQueryOptions?.pathToClaudeCodeExecutable).toBeUndefined()
      } finally {
        if (original !== undefined) {
          process.env.CLAUDE_CMD = original
        } else {
          delete process.env.CLAUDE_CMD
        }
      }
    })

    it('strips CLAUDECODE from env passed to SDK query', async () => {
      const original = process.env.CLAUDECODE
      try {
        process.env.CLAUDECODE = '1'
        await bridge.createSession({ cwd: '/tmp' })
        const passedEnv = mockQueryOptions?.env
        expect(passedEnv).toBeDefined()
        expect(passedEnv.CLAUDECODE).toBeUndefined()
      } finally {
        if (original !== undefined) {
          process.env.CLAUDECODE = original
        } else {
          delete process.env.CLAUDECODE
        }
      }
    })

    it('passes stderr callback to SDK query', async () => {
      await bridge.createSession({ cwd: '/tmp' })
      expect(mockQueryOptions?.stderr).toBeInstanceOf(Function)
    })

    it('passes env even when CLAUDECODE is not set', async () => {
      const original = process.env.CLAUDECODE
      try {
        delete process.env.CLAUDECODE
        await bridge.createSession({ cwd: '/tmp' })
        const passedEnv = mockQueryOptions?.env
        expect(passedEnv).toBeDefined()
        expect(passedEnv.CLAUDECODE).toBeUndefined()
      } finally {
        if (original !== undefined) {
          process.env.CLAUDECODE = original
        } else {
          delete process.env.CLAUDECODE
        }
      }
    })
  })
})
