import path from 'path'
import { EventEmitter } from 'events'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createAgentHistorySource } from '../../../server/agent-timeline/history-source.js'

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

    it('returns an explicit replay gate handle from createSession', async () => {
      mockKeepStreamOpen = true
      const session = await bridge.createSession({ cwd: '/tmp' })

      expect(session).toHaveProperty('replayGate')
      expect((session as any).replayGate.drain()).toMatchObject({
        watermark: 0,
        session: expect.objectContaining({
          sessionId: session.sessionId,
          status: 'starting',
          cwd: '/tmp',
        }),
        bufferedMessages: [],
      })
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

    it('finds a session by cliSessionId after init', async () => {
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
      bridge.subscribe(session.sessionId, () => {})
      await new Promise(resolve => setTimeout(resolve, 100))

      expect(bridge.findSessionByCliSessionId('cli-123')?.sessionId).toBe(session.sessionId)
    })

    it('finds a session by resumeSessionId before the SDK init arrives', async () => {
      mockKeepStreamOpen = true
      mockMessages.length = 0

      const session = await bridge.createSession({
        cwd: '/tmp',
        resumeSessionId: '00000000-0000-4000-8000-000000000241',
      })

      expect(bridge.findSessionByCliSessionId('00000000-0000-4000-8000-000000000241')?.sessionId).toBe(session.sessionId)
    })

    it('assigns stable message ids to locally ingested user turns before any durable history exists', async () => {
      mockKeepStreamOpen = true
      const session = await bridge.createSession({ cwd: '/tmp' })

      expect(bridge.sendUserMessage(session.sessionId, 'hello world')).toBe(true)

      const stored = bridge.getSession(session.sessionId)
      expect(stored?.messages).toHaveLength(1)
      expect(stored?.messages[0]?.messageId).toBeTruthy()
    })

    it('assigns live-scoped ids to repeated local messages instead of reusing durable ids', async () => {
      mockKeepStreamOpen = true
      const session = await bridge.createSession({ cwd: '/tmp' })
      const liveState = bridge.getSession(session.sessionId)
      expect(liveState).toBeDefined()
      if (!liveState) throw new Error('expected live state')

      const assignMessageId = (bridge as any).assignMessageId.bind(bridge) as (
        state: typeof liveState,
        message: { role: 'user'; content: Array<{ type: 'text'; text: string }>; timestamp: string },
      ) => string
      const message = {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'hello' }],
        timestamp: '2026-04-03T12:00:00.000Z',
      }

      const firstId = assignMessageId(liveState, message)
      liveState.messages.push({ ...message, messageId: firstId })
      const secondId = assignMessageId(liveState, message)

      expect(firstId).toMatch(/^live:/)
      expect(secondId).toMatch(/^live:/)
      expect(firstId).not.toMatch(/^durable:/)
      expect(secondId).not.toBe(firstId)
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
      expect(bridge.getSession(session.sessionId)?.messages[0]?.messageId).toBeTruthy()
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

    it('tracks stream snapshot state for reconnect restore', async () => {
      mockKeepStreamOpen = true
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_start' },
        session_id: 'cli-123',
        uuid: 'uuid-1',
      })
      mockMessages.push({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'par' },
        },
        session_id: 'cli-123',
        uuid: 'uuid-2',
      })

      const session = await bridge.createSession({ cwd: '/tmp' })
      bridge.subscribe(session.sessionId, () => {})
      await new Promise(resolve => setTimeout(resolve, 100))

      expect(bridge.getSession(session.sessionId)).toMatchObject({
        streamingActive: true,
        streamingText: 'par',
      })
    })

    it('preserves partial streaming text after content_block_stop until the final assistant message arrives', async () => {
      mockKeepStreamOpen = true
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_start' },
        session_id: 'cli-123',
        uuid: 'uuid-1',
      })
      mockMessages.push({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'partial reply' },
        },
        session_id: 'cli-123',
        uuid: 'uuid-2',
      })
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_stop' },
        session_id: 'cli-123',
        uuid: 'uuid-3',
      })

      const session = await bridge.createSession({ cwd: '/tmp' })
      bridge.subscribe(session.sessionId, () => {})
      await new Promise(resolve => setTimeout(resolve, 100))

      expect(bridge.getSession(session.sessionId)).toMatchObject({
        streamingActive: false,
        streamingText: 'partial reply',
      })
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
      const sub = bridge.subscribe(session.sessionId, (msg) => received.push(msg))
      sub!.off()

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

  describe('canUseTool branching', () => {
    it('blocks on AskUserQuestion and resolves when respondQuestion is called', async () => {
      mockKeepStreamOpen = true
      const session = await bridge.createSession({ cwd: '/tmp' })
      const received: any[] = []
      bridge.subscribe(session.sessionId, (msg) => received.push(msg))

      // Wait for stream to start
      await new Promise(resolve => setTimeout(resolve, 50))

      // Simulate canUseTool being called with AskUserQuestion
      const questions = [
        { question: 'Which option?', header: 'Choice', options: [{ label: 'A', description: 'Option A' }], multiSelect: false },
      ]
      const canUseToolPromise = mockCanUseTool('AskUserQuestion', { questions }, {
        signal: new AbortController().signal,
        toolUseID: 'tool-1',
      })

      // Wait for broadcast
      await new Promise(resolve => setTimeout(resolve, 50))

      // Should have broadcast sdk.question.request
      const questionMsg = received.find(m => m.type === 'sdk.question.request')
      expect(questionMsg).toBeDefined()
      expect(questionMsg.questions).toEqual(questions)

      // Respond to the question
      const answers = { 'Which option?': 'A' }
      bridge.respondQuestion(session.sessionId, questionMsg.requestId, answers)

      // canUseTool should resolve with allow + updatedInput
      const result = await canUseToolPromise
      expect(result.behavior).toBe('allow')
      expect(result.updatedInput).toEqual({
        questions,
        answers,
      })
    })

    it('auto-allows non-AskUserQuestion tools in bypass mode', async () => {
      mockKeepStreamOpen = true
      const session = await bridge.createSession({ cwd: '/tmp', permissionMode: 'bypassPermissions' })
      bridge.subscribe(session.sessionId, () => {})

      await new Promise(resolve => setTimeout(resolve, 50))

      // Simulate canUseTool for a normal tool
      const result = await mockCanUseTool('Bash', { command: 'ls' }, {
        signal: new AbortController().signal,
        toolUseID: 'tool-2',
      })

      expect(result.behavior).toBe('allow')
      expect(result.updatedInput).toEqual({ command: 'ls' })
    })

    it('still blocks AskUserQuestion even in bypass mode', async () => {
      mockKeepStreamOpen = true
      const session = await bridge.createSession({ cwd: '/tmp', permissionMode: 'bypassPermissions' })
      const received: any[] = []
      bridge.subscribe(session.sessionId, (msg) => received.push(msg))

      await new Promise(resolve => setTimeout(resolve, 50))

      const questions = [
        { question: 'Pick one', header: 'Pick', options: [{ label: 'X', description: 'X desc' }], multiSelect: false },
      ]
      const canUseToolPromise = mockCanUseTool('AskUserQuestion', { questions }, {
        signal: new AbortController().signal,
        toolUseID: 'tool-3',
      })

      await new Promise(resolve => setTimeout(resolve, 50))

      // Should still broadcast sdk.question.request, not auto-allow
      const questionMsg = received.find(m => m.type === 'sdk.question.request')
      expect(questionMsg).toBeDefined()

      // No sdk.permission.request should be broadcast
      const permMsg = received.find(m => m.type === 'sdk.permission.request')
      expect(permMsg).toBeUndefined()

      // Respond to unblock
      bridge.respondQuestion(session.sessionId, questionMsg.requestId, { 'Pick one': 'X' })
      const result = await canUseToolPromise
      expect(result.behavior).toBe('allow')
    })

    it('routes non-AskUserQuestion tools through permission request in non-bypass mode', async () => {
      mockKeepStreamOpen = true
      const session = await bridge.createSession({ cwd: '/tmp', permissionMode: 'default' })
      const received: any[] = []
      bridge.subscribe(session.sessionId, (msg) => received.push(msg))

      await new Promise(resolve => setTimeout(resolve, 50))

      // Fire canUseTool for a normal tool - should go to permission flow
      const canUseToolPromise = mockCanUseTool('Bash', { command: 'rm -rf /' }, {
        signal: new AbortController().signal,
        toolUseID: 'tool-4',
      })

      await new Promise(resolve => setTimeout(resolve, 50))

      const permMsg = received.find(m => m.type === 'sdk.permission.request')
      expect(permMsg).toBeDefined()
      expect(permMsg.tool.name).toBe('Bash')

      // Respond to unblock
      bridge.respondPermission(session.sessionId, permMsg.requestId, { behavior: 'allow', updatedInput: { command: 'rm -rf /' } })
      const result = await canUseToolPromise
      expect(result.behavior).toBe('allow')
    })

    it('does not pass allowDangerouslySkipPermissions to SDK query', async () => {
      mockKeepStreamOpen = true
      await bridge.createSession({ cwd: '/tmp', permissionMode: 'bypassPermissions' })
      expect(mockQueryOptions?.allowDangerouslySkipPermissions).toBeUndefined()
    })

    it('auto-allows AskUserQuestion with malformed (non-array) questions input', async () => {
      mockKeepStreamOpen = true
      const session = await bridge.createSession({ cwd: '/tmp' })
      bridge.subscribe(session.sessionId, () => {})

      await new Promise(resolve => setTimeout(resolve, 50))

      // Malformed input: questions is not an array
      const result = await mockCanUseTool('AskUserQuestion', { questions: 'not-an-array' }, {
        signal: new AbortController().signal,
        toolUseID: 'tool-malformed',
      })

      // Should pass through without blocking
      expect(result.behavior).toBe('allow')
    })

    it('auto-allows AskUserQuestion with empty questions array', async () => {
      mockKeepStreamOpen = true
      const session = await bridge.createSession({ cwd: '/tmp' })
      bridge.subscribe(session.sessionId, () => {})

      await new Promise(resolve => setTimeout(resolve, 50))

      const result = await mockCanUseTool('AskUserQuestion', { questions: [] }, {
        signal: new AbortController().signal,
        toolUseID: 'tool-empty',
      })

      expect(result.behavior).toBe('allow')
    })

    it('auto-allows AskUserQuestion when all entries are null', async () => {
      mockKeepStreamOpen = true
      const session = await bridge.createSession({ cwd: '/tmp' })
      bridge.subscribe(session.sessionId, () => {})

      await new Promise(resolve => setTimeout(resolve, 50))

      const result = await mockCanUseTool('AskUserQuestion', { questions: [null, null] }, {
        signal: new AbortController().signal,
        toolUseID: 'tool-nulls',
      })

      expect(result.behavior).toBe('allow')
    })

    it('filters null options within questions', async () => {
      mockKeepStreamOpen = true
      const session = await bridge.createSession({ cwd: '/tmp' })
      const received: any[] = []
      bridge.subscribe(session.sessionId, (msg) => received.push(msg))

      await new Promise(resolve => setTimeout(resolve, 50))

      const canUseToolPromise = mockCanUseTool('AskUserQuestion', {
        questions: [{ question: 'Test?', header: 'H', options: [null, { label: 'A', description: 'ok' }, null], multiSelect: false }],
      }, {
        signal: new AbortController().signal,
        toolUseID: 'tool-null-opts',
      })

      await new Promise(resolve => setTimeout(resolve, 50))

      const questionMsg = received.find(m => m.type === 'sdk.question.request')
      expect(questionMsg).toBeDefined()
      // Only non-null option should survive
      expect(questionMsg.questions[0].options).toEqual([{ label: 'A', description: 'ok' }])

      bridge.respondQuestion(session.sessionId, questionMsg.requestId, { 'Test?': 'A' })
      await canUseToolPromise
    })

    it('sanitizes question fields to safe types', async () => {
      mockKeepStreamOpen = true
      const session = await bridge.createSession({ cwd: '/tmp' })
      const received: any[] = []
      bridge.subscribe(session.sessionId, (msg) => received.push(msg))

      await new Promise(resolve => setTimeout(resolve, 50))

      // Malformed question: missing fields, wrong types
      const canUseToolPromise = mockCanUseTool('AskUserQuestion', {
        questions: [{ question: 123, options: 'not-an-array' }],
      }, {
        signal: new AbortController().signal,
        toolUseID: 'tool-sanitize',
      })

      await new Promise(resolve => setTimeout(resolve, 50))

      const questionMsg = received.find(m => m.type === 'sdk.question.request')
      expect(questionMsg).toBeDefined()
      // Fields should be coerced to safe types
      expect(questionMsg.questions[0].question).toBe('123')
      expect(questionMsg.questions[0].header).toBe('')
      expect(questionMsg.questions[0].options).toEqual([])
      expect(questionMsg.questions[0].multiSelect).toBe(false)

      // Clean up: respond to unblock
      bridge.respondQuestion(session.sessionId, questionMsg.requestId, { '123': 'ok' })
      await canUseToolPromise
    })

    it('reads live permissionMode from session state for bypass check', async () => {
      mockKeepStreamOpen = true
      const session = await bridge.createSession({ cwd: '/tmp', permissionMode: 'default' })
      bridge.subscribe(session.sessionId, () => {})

      await new Promise(resolve => setTimeout(resolve, 50))

      // Change to bypass mid-session
      bridge.setPermissionMode(session.sessionId, 'bypassPermissions')

      // Now canUseTool for a normal tool should auto-allow
      const result = await mockCanUseTool('Bash', { command: 'ls' }, {
        signal: new AbortController().signal,
        toolUseID: 'tool-5',
      })
      expect(result.behavior).toBe('allow')
    })
  })

  describe('respondQuestion', () => {
    it('returns false for nonexistent session', () => {
      expect(bridge.respondQuestion('nonexistent', 'q-1', {})).toBe(false)
    })

    it('returns false for nonexistent question request', async () => {
      mockKeepStreamOpen = true
      const session = await bridge.createSession({ cwd: '/tmp' })
      expect(bridge.respondQuestion(session.sessionId, 'q-nonexistent', {})).toBe(false)
    })

    it('preserves extra root-level fields from original input', async () => {
      mockKeepStreamOpen = true
      const session = await bridge.createSession({ cwd: '/tmp' })
      bridge.subscribe(session.sessionId, () => {})

      await new Promise(resolve => setTimeout(resolve, 50))

      const questions = [
        { question: 'Pick one', header: 'H', options: [{ label: 'A', description: '' }], multiSelect: false },
      ]
      // Original input has extra root fields beyond just "questions"
      const canUseToolPromise = mockCanUseTool('AskUserQuestion', {
        questions,
        metadata: { source: 'test' },
        annotations: { foo: 'bar' },
      }, {
        signal: new AbortController().signal,
        toolUseID: 'tool-preserve',
      })

      await new Promise(resolve => setTimeout(resolve, 50))

      const state = bridge.getSession(session.sessionId)!
      const requestId = Array.from(state.pendingQuestions.keys())[0]

      bridge.respondQuestion(session.sessionId, requestId, { 'Pick one': 'A' })

      const result = await canUseToolPromise
      expect(result.behavior).toBe('allow')
      // Extra fields should be preserved in updatedInput
      expect(result.updatedInput.metadata).toEqual({ source: 'test' })
      expect(result.updatedInput.annotations).toEqual({ foo: 'bar' })
      expect(result.updatedInput.answers).toEqual({ 'Pick one': 'A' })
    })

    it('formats multi-select answers as comma-separated strings', async () => {
      mockKeepStreamOpen = true
      const session = await bridge.createSession({ cwd: '/tmp' })
      bridge.subscribe(session.sessionId, () => {})

      await new Promise(resolve => setTimeout(resolve, 50))

      const questions = [
        { question: 'Pick many', header: 'Multi', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }], multiSelect: true },
      ]
      const canUseToolPromise = mockCanUseTool('AskUserQuestion', { questions }, {
        signal: new AbortController().signal,
        toolUseID: 'tool-6',
      })

      await new Promise(resolve => setTimeout(resolve, 50))

      const state = bridge.getSession(session.sessionId)!
      const requestId = Array.from(state.pendingQuestions.keys())[0]

      // Answers should already be comma-separated strings from client
      bridge.respondQuestion(session.sessionId, requestId, { 'Pick many': 'A, B' })

      const result = await canUseToolPromise
      expect(result.behavior).toBe('allow')
      expect(result.updatedInput).toEqual({
        questions,
        answers: { 'Pick many': 'A, B' },
      })
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
    it('falls back to durable-only restore after a stream ends naturally and the session is no longer live', async () => {
      mockMessages.push({
        type: 'system',
        subtype: 'init',
        session_id: '00000000-0000-4000-8000-000000000123',
        model: 'claude-sonnet-4-5-20250929',
        cwd: '/tmp',
        tools: ['Bash'],
        uuid: 'test-uuid',
      })
      mockMessages.push({
        type: 'result',
        subtype: 'success',
        duration_ms: 100,
        duration_api_ms: 80,
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0.01,
        usage: { input_tokens: 100, output_tokens: 50 },
        session_id: '00000000-0000-4000-8000-000000000123',
        uuid: 'test-uuid',
      })

      const loadSessionHistory = vi.fn().mockResolvedValue([
        {
          role: 'user' as const,
          content: [{ type: 'text' as const, text: 'durable prompt' }],
          timestamp: '2026-04-03T00:00:00.000Z',
          messageId: 'durable-msg-1',
        },
      ])
      let bridgeWithHistory!: SdkBridge
      const historySource = createAgentHistorySource({
        loadSessionHistory,
        getLiveSessionBySdkSessionId: (id) => bridgeWithHistory.getLiveSession(id),
        getLiveSessionByCliSessionId: (id) => bridgeWithHistory.findLiveSessionByCliSessionId(id),
      })
      bridgeWithHistory = new SdkBridge(historySource)

      const session = await bridgeWithHistory.createSession({ cwd: '/tmp' })
      bridgeWithHistory.subscribe(session.sessionId, () => {})
      await new Promise(resolve => setTimeout(resolve, 150))

      expect(bridgeWithHistory.getLiveSession(session.sessionId)).toBeUndefined()

      const resolved = await historySource.resolve('00000000-0000-4000-8000-000000000123')
      expect(resolved).toMatchObject({
        kind: 'resolved',
        readiness: 'durable_only',
        liveSessionId: undefined,
        timelineSessionId: '00000000-0000-4000-8000-000000000123',
      })
      if (resolved.kind !== 'resolved') throw new Error('expected resolved')
      expect(loadSessionHistory).toHaveBeenCalledTimes(1)
      expect(resolved.turns.map((turn) => turn.messageId)).toEqual(['durable-msg-1'])

      bridgeWithHistory.close()
    })

    it('cleans up process on natural stream end so sendUserMessage returns false', async () => {
      mockMessages.push({
        type: 'system',
        subtype: 'init',
        session_id: 'cli-123',
        model: 'claude-sonnet-4-5-20250929',
        cwd: '/tmp',
        tools: ['Bash'],
        uuid: 'test-uuid',
      })
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

      expect(bridge.getLiveSession(session.sessionId)).toBeUndefined()
      expect(bridge.findLiveSessionByCliSessionId('cli-123')).toBeUndefined()
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

  describe('plugins option', () => {
    it('passes plugins to SDK query options as SdkPluginConfig array', async () => {
      await bridge.createSession({
        cwd: '/tmp',
        plugins: ['/path/to/plugin-a', '/path/to/plugin-b'],
      })
      expect(mockQueryOptions?.plugins).toEqual([
        { type: 'local', path: '/path/to/plugin-a' },
        { type: 'local', path: '/path/to/plugin-b' },
      ])
    })

    it('uses default plugins when not set', async () => {
      await bridge.createSession({ cwd: '/tmp' })
      expect(mockQueryOptions?.plugins).toBeDefined()
      expect(mockQueryOptions?.plugins).toHaveLength(1)
      expect(mockQueryOptions?.plugins[0].path).toContain('freshell-orchestration')
    })

    it('passes empty plugins array when given empty array', async () => {
      await bridge.createSession({ cwd: '/tmp', plugins: [] })
      expect(mockQueryOptions?.plugins).toEqual([])
    })
  })

  describe('default plugins', () => {
    it('resolves freshell-orchestration as default when no plugins specified', async () => {
      await bridge.createSession({ cwd: '/tmp' })
      expect(mockQueryOptions?.plugins).toBeDefined()
      expect(mockQueryOptions?.plugins).toHaveLength(1)
      expect(mockQueryOptions?.plugins[0].type).toBe('local')
      // Must resolve from process.cwd(), not import.meta.url (which would land in dist/)
      const expectedPath = path.join(process.cwd(), '.claude', 'plugins', 'freshell-orchestration')
      expect(mockQueryOptions?.plugins[0].path).toBe(expectedPath)
    })

    it('does not add defaults when plugins are explicitly provided', async () => {
      await bridge.createSession({ cwd: '/tmp', plugins: ['/custom/plugin'] })
      expect(mockQueryOptions?.plugins).toEqual([
        { type: 'local', path: '/custom/plugin' },
      ])
    })

    it('does not add defaults when empty plugins array is provided', async () => {
      await bridge.createSession({ cwd: '/tmp', plugins: [] })
      expect(mockQueryOptions?.plugins).toEqual([])
    })
  })

  describe('mcpServers injection', () => {
    it('passes freshell MCP server config to SDK query', async () => {
      await bridge.createSession({ cwd: '/tmp' })
      expect(mockQueryOptions?.mcpServers).toBeDefined()
      expect(mockQueryOptions.mcpServers.freshell).toBeDefined()
      expect(mockQueryOptions.mcpServers.freshell.command).toBe('node')
      expect(Array.isArray(mockQueryOptions.mcpServers.freshell.args)).toBe(true)
      expect(mockQueryOptions.mcpServers.freshell.args.length).toBeGreaterThan(0)
    })

    it('includes FRESHELL_URL and FRESHELL_TOKEN in MCP server env', async () => {
      await bridge.createSession({ cwd: '/tmp' })
      const env = mockQueryOptions?.mcpServers?.freshell?.env
      expect(env).toBeDefined()
      expect(env.FRESHELL_URL).toBeDefined()
      expect(typeof env.FRESHELL_URL).toBe('string')
      expect(typeof env.FRESHELL_TOKEN).toBe('string')
    })

    it('derives FRESHELL_URL from PORT env var', async () => {
      const origPort = process.env.PORT
      const origUrl = process.env.FRESHELL_URL
      process.env.PORT = '4455'
      delete process.env.FRESHELL_URL
      try {
        await bridge.createSession({ cwd: '/tmp' })
        expect(mockQueryOptions.mcpServers.freshell.env.FRESHELL_URL).toBe('http://localhost:4455')
      } finally {
        if (origPort !== undefined) process.env.PORT = origPort
        else delete process.env.PORT
        if (origUrl !== undefined) process.env.FRESHELL_URL = origUrl
        else delete process.env.FRESHELL_URL
      }
    })

    it('uses FRESHELL_URL env var when set', async () => {
      const origUrl = process.env.FRESHELL_URL
      process.env.FRESHELL_URL = 'http://custom:9999'
      try {
        await bridge.createSession({ cwd: '/tmp' })
        expect(mockQueryOptions.mcpServers.freshell.env.FRESHELL_URL).toBe('http://custom:9999')
      } finally {
        if (origUrl !== undefined) process.env.FRESHELL_URL = origUrl
        else delete process.env.FRESHELL_URL
      }
    })

    it('uses AUTH_TOKEN env var as FRESHELL_TOKEN', async () => {
      const origToken = process.env.AUTH_TOKEN
      process.env.AUTH_TOKEN = 'test-secret-token'
      try {
        await bridge.createSession({ cwd: '/tmp' })
        expect(mockQueryOptions.mcpServers.freshell.env.FRESHELL_TOKEN).toBe('test-secret-token')
      } finally {
        if (origToken !== undefined) process.env.AUTH_TOKEN = origToken
        else delete process.env.AUTH_TOKEN
      }
    })

    it('defaults FRESHELL_URL to localhost:3001 when no env vars set', async () => {
      const origPort = process.env.PORT
      const origUrl = process.env.FRESHELL_URL
      delete process.env.PORT
      delete process.env.FRESHELL_URL
      try {
        await bridge.createSession({ cwd: '/tmp' })
        expect(mockQueryOptions.mcpServers.freshell.env.FRESHELL_URL).toBe('http://localhost:3001')
      } finally {
        if (origPort !== undefined) process.env.PORT = origPort
        if (origUrl !== undefined) process.env.FRESHELL_URL = origUrl
      }
    })

    it('defaults FRESHELL_TOKEN to empty string when AUTH_TOKEN unset', async () => {
      const origToken = process.env.AUTH_TOKEN
      delete process.env.AUTH_TOKEN
      try {
        await bridge.createSession({ cwd: '/tmp' })
        expect(mockQueryOptions.mcpServers.freshell.env.FRESHELL_TOKEN).toBe('')
      } finally {
        if (origToken !== undefined) process.env.AUTH_TOKEN = origToken
      }
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

    it('formats raw model IDs into human-readable display names', async () => {
      mockKeepStreamOpen = true
      // Simulate SDK returning raw model IDs as displayName
      mockSupportedModels = [
        { value: 'claude-opus-4-6', displayName: 'claude-opus-4-6', description: '' },
        { value: 'claude-sonnet-4-5-20250929', displayName: 'claude-sonnet-4-5-20250929', description: '' },
        { value: 'claude-haiku-4-5-20251001', displayName: 'claude-haiku-4-5-20251001', description: '' },
      ]
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

      const modelsMsg = received.find(m => m.type === 'sdk.models')
      expect(modelsMsg).toBeDefined()
      expect(modelsMsg.models[0].displayName).toBe('Opus 4.6')
      expect(modelsMsg.models[1].displayName).toBe('Sonnet 4.5')
      expect(modelsMsg.models[2].displayName).toBe('Haiku 4.5')
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
