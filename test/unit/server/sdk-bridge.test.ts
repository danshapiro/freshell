import { EventEmitter } from 'events'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the SDK's query function
const mockMessages: any[] = []
let mockCanUseTool: any = undefined
let mockAbortController: AbortController | undefined

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(({ options }: any) => {
    mockAbortController = options?.abortController
    mockCanUseTool = options?.canUseTool
    // Return an AsyncGenerator that yields mockMessages
    const gen = (async function* () {
      for (const msg of mockMessages) {
        yield msg
      }
    })()
    // Add Query methods
    ;(gen as any).close = vi.fn()
    ;(gen as any).interrupt = vi.fn()
    ;(gen as any).streamInput = vi.fn()
    ;(gen as any).setPermissionMode = vi.fn()
    ;(gen as any).setModel = vi.fn()
    return gen
  }),
}))

import { SdkBridge } from '../../../server/sdk-bridge.js'

describe('SdkBridge', () => {
  let bridge: SdkBridge

  beforeEach(() => {
    mockMessages.length = 0
    mockCanUseTool = undefined
    bridge = new SdkBridge()
  })

  afterEach(() => {
    bridge.close()
  })

  describe('session lifecycle', () => {
    it('creates a session with unique ID', async () => {
      const session = await bridge.createSession({ cwd: '/tmp' })
      expect(session.sessionId).toBeTruthy()
      expect(session.status).toBe('starting')
      expect(session.cwd).toBe('/tmp')
    })

    it('lists active sessions', async () => {
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

      expect(received.length).toBeGreaterThanOrEqual(2)
      expect(received[0].type).toBe('sdk.session.init')
      expect(received[1].type).toBe('sdk.assistant')
    })
  })

  describe('sendUserMessage', () => {
    it('stores user message in session history', async () => {
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
      const session = await bridge.createSession({ cwd: '/tmp' })
      expect(bridge.interrupt(session.sessionId)).toBe(true)
    })
  })
})
