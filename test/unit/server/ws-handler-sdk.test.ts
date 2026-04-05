import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import http from 'http'
import WebSocket from 'ws'
import { WsHandler } from '../../../server/ws-handler.js'
import { TerminalRegistry } from '../../../server/terminal-registry.js'
import {
  SdkCreateSchema,
  SdkSendSchema,
  SdkPermissionRespondSchema,
  SdkInterruptSchema,
  SdkKillSchema,
  SdkAttachSchema,
} from '../../../server/sdk-bridge-types.js'
import { BrowserSdkMessageSchema, WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'

const loadSessionHistoryMock = vi.hoisted(() => vi.fn())

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}))

vi.mock('../../../server/session-history-loader.js', async () => {
  const actual = await vi.importActual<typeof import('../../../server/session-history-loader.js')>('../../../server/session-history-loader.js')
  return {
    ...actual,
    loadSessionHistory: (...args: Parameters<typeof actual.loadSessionHistory>) => loadSessionHistoryMock(...args),
  }
})

const TEST_AUTH_TOKEN = 'testtoken-testtoken'

function makeMessage(role: 'user' | 'assistant', text: string, timestamp?: string) {
  return {
    role,
    content: [{ type: 'text' as const, text }],
    ...(timestamp ? { timestamp } : {}),
  }
}

function makeResolvedHistory(options: {
  queryId?: string
  liveSessionId?: string
  timelineSessionId?: string
  revision?: number
  messages: ReturnType<typeof makeMessage>[]
}) {
  const queryId = options.queryId ?? options.liveSessionId ?? options.timelineSessionId ?? 'sdk-sess-1'
  return {
    kind: 'resolved' as const,
    queryId,
    liveSessionId: options.liveSessionId,
    timelineSessionId: options.timelineSessionId,
    readiness: options.liveSessionId && options.timelineSessionId ? 'merged' as const : options.timelineSessionId ? 'durable_only' as const : 'live_only' as const,
    revision: options.revision ?? 1,
    latestTurnId: options.messages.length > 0 ? `turn-${options.messages.length - 1}` : null,
    turns: options.messages.map((message, index) => ({
      turnId: `turn-${index}`,
      messageId: `message-${index}`,
      ordinal: index,
      source: options.timelineSessionId ? 'durable' as const : 'live' as const,
      message: {
        ...message,
        messageId: `message-${index}`,
      },
    })),
  }
}

function makeCreatedSession(overrides: Record<string, any> = {}) {
  const { replayGate, ...sessionOverrides } = overrides
  const session = {
    sessionId: 'sdk-sess-1',
    status: 'starting',
    messages: [],
    streamingActive: false,
    streamingText: '',
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    ...sessionOverrides,
  }

  return {
    ...session,
    replayGate: replayGate ?? {
      capture: vi.fn(() => ({
        watermark: 0,
        session: { ...session },
      })),
    },
  }
}

describe('WS Handler SDK Integration', () => {
  let originalAuthToken: string | undefined

  beforeEach(() => {
    originalAuthToken = process.env.AUTH_TOKEN
    process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
  })

  afterEach(() => {
    if (originalAuthToken === undefined) {
      delete process.env.AUTH_TOKEN
      return
    }
    process.env.AUTH_TOKEN = originalAuthToken
  })

  describe('schema parsing', () => {
    it('parses sdk.create message', () => {
      const result = SdkCreateSchema.safeParse({
        type: 'sdk.create',
        requestId: 'req-1',
        cwd: '/home/user/project',
      })
      expect(result.success).toBe(true)
    })

    it('parses sdk.create with all optional fields', () => {
      const result = SdkCreateSchema.safeParse({
        type: 'sdk.create',
        requestId: 'req-1',
        cwd: '/home/user/project',
        resumeSessionId: 'session-abc',
        model: 'claude-sonnet-4-20250514',
        permissionMode: 'plan',
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.resumeSessionId).toBe('session-abc')
        expect(result.data.model).toBe('claude-sonnet-4-20250514')
        expect(result.data.permissionMode).toBe('plan')
      }
    })

    it('parses sdk.create with plugins array', () => {
      const result = SdkCreateSchema.safeParse({
        type: 'sdk.create',
        requestId: 'req-1',
        cwd: '/home/user/project',
        plugins: ['/path/to/.claude/plugins/my-skill'],
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.plugins).toEqual(['/path/to/.claude/plugins/my-skill'])
      }
    })

    it('parses sdk.create without plugins (optional)', () => {
      const result = SdkCreateSchema.safeParse({
        type: 'sdk.create',
        requestId: 'req-1',
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.plugins).toBeUndefined()
      }
    })

    it('rejects sdk.create with empty requestId', () => {
      const result = SdkCreateSchema.safeParse({
        type: 'sdk.create',
        requestId: '',
      })
      expect(result.success).toBe(false)
    })

    it('parses sdk.send message', () => {
      const result = SdkSendSchema.safeParse({
        type: 'sdk.send',
        sessionId: 'sess-1',
        text: 'Hello Claude',
      })
      expect(result.success).toBe(true)
    })

    it('parses sdk.send with images', () => {
      const result = SdkSendSchema.safeParse({
        type: 'sdk.send',
        sessionId: 'sess-1',
        text: 'Describe this image',
        images: [{ mediaType: 'image/png', data: 'base64data' }],
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.images).toHaveLength(1)
      }
    })

    it('rejects sdk.send with empty text', () => {
      const result = SdkSendSchema.safeParse({
        type: 'sdk.send',
        sessionId: 'sess-1',
        text: '',
      })
      expect(result.success).toBe(false)
    })

    it('rejects sdk.send with empty sessionId', () => {
      const result = SdkSendSchema.safeParse({
        type: 'sdk.send',
        sessionId: '',
        text: 'hello',
      })
      expect(result.success).toBe(false)
    })

    it('parses sdk.permission.respond message', () => {
      const result = SdkPermissionRespondSchema.safeParse({
        type: 'sdk.permission.respond',
        sessionId: 'sess-1',
        requestId: 'perm-1',
        behavior: 'allow',
      })
      expect(result.success).toBe(true)
    })

    it('parses sdk.permission.respond with optional fields', () => {
      const result = SdkPermissionRespondSchema.safeParse({
        type: 'sdk.permission.respond',
        sessionId: 'sess-1',
        requestId: 'perm-1',
        behavior: 'deny',
        updatedInput: { path: '/tmp/foo' },
        message: 'Not allowed',
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.behavior).toBe('deny')
        expect(result.data.updatedInput).toEqual({ path: '/tmp/foo' })
        expect(result.data.message).toBe('Not allowed')
      }
    })

    it('rejects sdk.permission.respond with invalid behavior', () => {
      const result = SdkPermissionRespondSchema.safeParse({
        type: 'sdk.permission.respond',
        sessionId: 'sess-1',
        requestId: 'perm-1',
        behavior: 'maybe',
      })
      expect(result.success).toBe(false)
    })

    it('parses sdk.interrupt message', () => {
      const result = SdkInterruptSchema.safeParse({
        type: 'sdk.interrupt',
        sessionId: 'sess-1',
      })
      expect(result.success).toBe(true)
    })

    it('parses sdk.kill message', () => {
      const result = SdkKillSchema.safeParse({
        type: 'sdk.kill',
        sessionId: 'sess-1',
      })
      expect(result.success).toBe(true)
    })

    it('parses sdk.attach message', () => {
      const result = SdkAttachSchema.safeParse({
        type: 'sdk.attach',
        sessionId: 'sess-1',
        resumeSessionId: '00000000-0000-4000-8000-000000000321',
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.resumeSessionId).toBe('00000000-0000-4000-8000-000000000321')
      }
    })

    it('rejects sdk.attach with empty sessionId', () => {
      const result = SdkAttachSchema.safeParse({
        type: 'sdk.attach',
        sessionId: '',
      })
      expect(result.success).toBe(false)
    })

    it('sdk.create with plugins field is valid in BrowserSdkMessageSchema', () => {
      const result = BrowserSdkMessageSchema.safeParse({
        type: 'sdk.create',
        requestId: 'req-1',
        cwd: '/tmp',
        plugins: ['/path/to/plugin'],
      })
      expect(result.success).toBe(true)
    })
  })

  describe('WsHandler SDK message routing', () => {
    let server: http.Server
    let handler: WsHandler
    let registry: TerminalRegistry
    let mockSdkBridge: any
    let mockHistorySource: {
      resolve: ReturnType<typeof vi.fn>
      teardownLiveSession: ReturnType<typeof vi.fn>
    }

    beforeEach(async () => {
      server = http.createServer()
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      registry = new TerminalRegistry()
      loadSessionHistoryMock.mockReset()
      mockHistorySource = {
        resolve: vi.fn().mockResolvedValue(makeResolvedHistory({
          queryId: 'sdk-sess-1',
          liveSessionId: 'sdk-sess-1',
          revision: 1,
          messages: [makeMessage('user', 'hello', '2026-01-01T00:00:00Z')],
        })),
        teardownLiveSession: vi.fn(),
      }

      mockSdkBridge = {
        createSession: vi.fn().mockReturnValue(makeCreatedSession()),
        subscribe: vi.fn().mockReturnValue({ off: () => {}, replayed: false }),
        captureReplayState: vi.fn().mockImplementation((sessionId: string) => ({
          watermark: 0,
          session: {
            sessionId,
            status: 'starting',
            messages: [],
            streamingActive: false,
            streamingText: '',
            pendingPermissions: new Map(),
            pendingQuestions: new Map(),
          },
        })),
        sendUserMessage: vi.fn().mockReturnValue(true),
        respondPermission: vi.fn().mockReturnValue(true),
        interrupt: vi.fn().mockReturnValue(true),
        killSession: vi.fn().mockReturnValue(true),
        getSession: vi.fn().mockReturnValue({
          sessionId: 'sdk-sess-1',
          status: 'idle',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: '2026-01-01T00:00:00Z' }],
          streamingActive: false,
          streamingText: '',
          pendingPermissions: new Map(),
          pendingQuestions: new Map(),
        }),
        getLiveSession: vi.fn().mockImplementation((sessionId: string) => mockSdkBridge.getSession(sessionId)),
        findSessionByCliSessionId: vi.fn(),
        findLiveSessionByCliSessionId: vi.fn().mockImplementation((timelineSessionId: string) => (
          mockSdkBridge.findSessionByCliSessionId(timelineSessionId)
        )),
      }

      handler = new WsHandler(
        server,
        registry,
        undefined, // codingCliManager
        mockSdkBridge,
        undefined, // sessionRepairService
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        mockHistorySource,
      )
    })

    afterEach(async () => {
      handler.close()
      registry.shutdown()
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })

    function connectAndAuth(): Promise<WebSocket> {
      return new Promise<WebSocket>((resolve, reject) => {
        const addr = server.address()
        const port = typeof addr === 'object' ? addr!.port : 0
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
        const timeout = setTimeout(() => {
          cleanup()
          reject(new Error('Timeout waiting for ready'))
        }, 5000)

        const cleanup = () => {
          clearTimeout(timeout)
          ws.off('open', onOpen)
          ws.off('message', onMessage)
          ws.off('error', onError)
          ws.off('close', onClose)
        }

        const onOpen = () => {
          ws.send(JSON.stringify({
            type: 'hello',
            token: TEST_AUTH_TOKEN,
            protocolVersion: WS_PROTOCOL_VERSION,
          }))
        }

        const onMessage = (data: WebSocket.RawData) => {
          const msg = JSON.parse(data.toString())
          if (msg.type === 'ready') {
            cleanup()
            resolve(ws)
          }
        }

        const onError = (err: Error) => {
          cleanup()
          reject(err)
        }

        const onClose = (code: number, reason: Buffer) => {
          cleanup()
          reject(new Error(`Socket closed before ready (code=${code}, reason=${reason.toString()})`))
        }

        ws.on('open', onOpen)
        ws.on('message', onMessage)
        ws.on('error', onError)
        ws.on('close', onClose)
      })
    }

    function sendAndWaitForResponse(ws: WebSocket, msg: object, responseType: string): Promise<any> {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timeout waiting for ${responseType}`)), 3000)
        const onMessage = (data: WebSocket.RawData) => {
          const parsed = JSON.parse(data.toString())
          if (parsed.type === responseType) {
            clearTimeout(timeout)
            ws.off('message', onMessage)
            resolve(parsed)
          }
        }
        ws.on('message', onMessage)
        ws.send(JSON.stringify(msg))
      })
    }

    it('routes sdk.create to sdkBridge.createSession', async () => {
      const ws = await connectAndAuth()
      try {
        const response = await sendAndWaitForResponse(ws, {
          type: 'sdk.create',
          requestId: 'req-1',
          cwd: '/tmp/project',
        }, 'sdk.created')

        expect(response.type).toBe('sdk.created')
        expect(response.requestId).toBe('req-1')
        expect(response.sessionId).toBe('sdk-sess-1')
        expect(mockSdkBridge.createSession).toHaveBeenCalledWith({
          cwd: '/tmp/project',
          resumeSessionId: undefined,
          model: undefined,
          permissionMode: undefined,
        })
        expect(mockSdkBridge.subscribe).toHaveBeenCalledWith('sdk-sess-1', expect.any(Function))
      } finally {
        ws.close()
      }
    })

    it('does not emit sdk.created when create-time restore resolution fails', async () => {
      mockHistorySource.resolve.mockResolvedValue({
        kind: 'fatal',
        code: 'RESTORE_INTERNAL',
        message: 'boom',
      })
      const ws = await connectAndAuth()
      try {
        const messages: any[] = []
        const response = await new Promise<any>((resolve) => {
          const onMessage = (data: WebSocket.RawData) => {
            const parsed = JSON.parse(data.toString())
            messages.push(parsed)
            if (parsed.type === 'sdk.create.failed') {
              ws.off('message', onMessage)
              resolve(parsed)
            }
          }
          ws.on('message', onMessage)
          ws.send(JSON.stringify({
            type: 'sdk.create',
            requestId: 'req-fail',
            cwd: '/tmp/project',
          }))
        })

        expect(response).toEqual({
          type: 'sdk.create.failed',
          requestId: 'req-fail',
          code: 'RESTORE_INTERNAL',
          message: 'boom',
          retryable: true,
        })
        expect(messages.some((message) => message.type === 'sdk.created')).toBe(false)
        expect(mockSdkBridge.killSession).toHaveBeenCalledWith('sdk-sess-1')
        expect(mockHistorySource.teardownLiveSession).toHaveBeenCalledWith('sdk-sess-1', { recoverable: false })
      } finally {
        ws.close()
      }
    })

    it('routes sdk.send to sdkBridge.sendUserMessage', async () => {
      const ws = await connectAndAuth()
      try {
        // First create a session so it's tracked
        await sendAndWaitForResponse(ws, {
          type: 'sdk.create',
          requestId: 'req-1',
        }, 'sdk.created')

        // Send a message - no direct response expected, but no error either
        ws.send(JSON.stringify({
          type: 'sdk.send',
          sessionId: 'sdk-sess-1',
          text: 'Hello Claude',
        }))

        await vi.waitFor(
          () => expect(mockSdkBridge.sendUserMessage).toHaveBeenCalledWith('sdk-sess-1', 'Hello Claude', undefined),
          { timeout: 3000 },
        )
      } finally {
        ws.close()
      }
    })

    it('routes sdk.permission.respond to sdkBridge.respondPermission', async () => {
      const ws = await connectAndAuth()
      try {
        // First create a session so client owns it
        await sendAndWaitForResponse(ws, {
          type: 'sdk.create',
          requestId: 'req-perm',
        }, 'sdk.created')

        ws.send(JSON.stringify({
          type: 'sdk.permission.respond',
          sessionId: 'sdk-sess-1',
          requestId: 'perm-1',
          behavior: 'allow',
        }))

        await vi.waitFor(
          () => expect(mockSdkBridge.respondPermission).toHaveBeenCalledWith(
            'sdk-sess-1', 'perm-1', { behavior: 'allow', updatedInput: {} },
          ),
          { timeout: 3000 },
        )
      } finally {
        ws.close()
      }
    })

    it('rejects sdk.permission.respond for unowned session', async () => {
      const ws = await connectAndAuth()
      try {
        const response = await sendAndWaitForResponse(ws, {
          type: 'sdk.permission.respond',
          sessionId: 'not-my-session',
          requestId: 'perm-1',
          behavior: 'allow',
        }, 'error')

        expect(response.code).toBe('UNAUTHORIZED')
      } finally {
        ws.close()
      }
    })

    it('routes sdk.interrupt to sdkBridge.interrupt', async () => {
      const ws = await connectAndAuth()
      try {
        // First create a session so client owns it
        await sendAndWaitForResponse(ws, {
          type: 'sdk.create',
          requestId: 'req-int',
        }, 'sdk.created')

        ws.send(JSON.stringify({
          type: 'sdk.interrupt',
          sessionId: 'sdk-sess-1',
        }))

        await vi.waitFor(
          () => expect(mockSdkBridge.interrupt).toHaveBeenCalledWith('sdk-sess-1'),
          { timeout: 3000 },
        )
      } finally {
        ws.close()
      }
    })

    it('routes sdk.kill and returns sdk.killed', async () => {
      const ws = await connectAndAuth()
      try {
        // First create a session so client owns it
        await sendAndWaitForResponse(ws, {
          type: 'sdk.create',
          requestId: 'req-kill',
        }, 'sdk.created')

        const response = await sendAndWaitForResponse(ws, {
          type: 'sdk.kill',
          sessionId: 'sdk-sess-1',
        }, 'sdk.killed')

        expect(response.type).toBe('sdk.killed')
        expect(response.sessionId).toBe('sdk-sess-1')
        expect(response.success).toBe(true)
        expect(mockSdkBridge.killSession).toHaveBeenCalledWith('sdk-sess-1')
        expect(mockHistorySource.teardownLiveSession).toHaveBeenCalledWith('sdk-sess-1', { recoverable: false })
      } finally {
        ws.close()
      }
    })

    it('routes sdk.attach and returns snapshot + status without sdk.history', async () => {
      mockHistorySource.resolve.mockResolvedValue(makeResolvedHistory({
        queryId: 'sdk-sess-1',
        liveSessionId: 'sdk-sess-1',
        revision: 1,
        messages: [makeMessage('user', 'hello', '2026-01-01T00:00:00Z')],
      }))
      const ws = await connectAndAuth()
      try {
        const messages: any[] = []
        const collectDone = new Promise<void>((resolve) => {
          let count = 0
          const onMessage = (data: WebSocket.RawData) => {
            const parsed = JSON.parse(data.toString())
            messages.push(parsed)
            if (parsed.type === 'sdk.session.snapshot' || parsed.type === 'sdk.status') {
              count++
              if (count >= 2) {
                ws.off('message', onMessage)
                resolve()
              }
            }
          }
          ws.on('message', onMessage)
        })

        ws.send(JSON.stringify({
          type: 'sdk.attach',
          sessionId: 'sdk-sess-1',
        }))

        await collectDone

        const snapshotMsg = messages.find((m) => m.type === 'sdk.session.snapshot')
        const statusMsg = messages.find((m) => m.type === 'sdk.status')

        expect(snapshotMsg).toBeDefined()
        expect(snapshotMsg.sessionId).toBe('sdk-sess-1')
        expect(snapshotMsg.latestTurnId).toBe('turn-0')
        expect(statusMsg).toBeDefined()
        expect(statusMsg.sessionId).toBe('sdk-sess-1')
        expect(statusMsg.status).toBe('idle')
        expect(messages.some((m) => m.type === 'sdk.history')).toBe(false)
        expect(mockSdkBridge.getSession).toHaveBeenCalledWith('sdk-sess-1')
        expect(mockHistorySource.resolve).toHaveBeenCalledWith(
          'sdk-sess-1',
          expect.objectContaining({
            liveSessionOverride: expect.objectContaining({
              sessionId: 'sdk-sess-1',
            }),
          }),
        )
        expect(mockSdkBridge.subscribe).toHaveBeenCalledWith('sdk-sess-1', expect.any(Function))
      } finally {
        ws.close()
      }
    })

    it('sdk.attach snapshot includes canonical timelineSessionId, revision, and stream snapshot', async () => {
      mockSdkBridge.getSession.mockReturnValue({
        sessionId: 'sdk-sess-1',
        resumeSessionId: 'cli-sess-1',
        status: 'running',
        messages: [makeMessage('user', 'delta prompt', '2026-03-10T10:02:00.000Z')],
        streamingActive: true,
        streamingText: 'partial reply',
        pendingPermissions: new Map(),
        pendingQuestions: new Map(),
      })
      mockHistorySource.resolve.mockResolvedValue(makeResolvedHistory({
        queryId: 'sdk-sess-1',
        liveSessionId: 'sdk-sess-1',
        timelineSessionId: 'cli-sess-1',
        revision: 123,
        messages: [
          makeMessage('user', 'older prompt', '2026-03-10T10:00:00.000Z'),
          makeMessage('assistant', 'older reply', '2026-03-10T10:01:00.000Z'),
          makeMessage('user', 'delta prompt', '2026-03-10T10:02:00.000Z'),
        ],
      }))

      const ws = await connectAndAuth()
      try {
        const messages: any[] = []
        const collectDone = new Promise<void>((resolve) => {
          let count = 0
          const onMessage = (data: WebSocket.RawData) => {
            const parsed = JSON.parse(data.toString())
            messages.push(parsed)
            if (parsed.type === 'sdk.session.snapshot' || parsed.type === 'sdk.status') {
              count += 1
              if (count >= 2) {
                ws.off('message', onMessage)
                resolve()
              }
            }
          }
          ws.on('message', onMessage)
        })

        ws.send(JSON.stringify({
          type: 'sdk.attach',
          sessionId: 'sdk-sess-1',
        }))

        await collectDone

        expect(messages.find((m) => m.type === 'sdk.session.snapshot')).toEqual(expect.objectContaining({
          type: 'sdk.session.snapshot',
          sessionId: 'sdk-sess-1',
          timelineSessionId: 'cli-sess-1',
          revision: 123,
          latestTurnId: 'turn-2',
          status: 'running',
          streamingActive: true,
          streamingText: 'partial reply',
        }))
      } finally {
        ws.close()
      }
    })

    it('returns sdk.error instead of fabricating a revision-0 snapshot when live sdk.attach restore resolution is missing', async () => {
      mockSdkBridge.getSession.mockReturnValue({
        sessionId: 'sdk-sess-1',
        status: 'running',
        messages: [makeMessage('user', 'delta prompt', '2026-03-10T10:02:00.000Z')],
        streamingActive: true,
        streamingText: 'partial reply',
        pendingPermissions: new Map(),
        pendingQuestions: new Map(),
      })
      mockHistorySource.resolve.mockResolvedValue({
        kind: 'missing',
        code: 'RESTORE_NOT_FOUND',
      })

      const ws = await connectAndAuth()
      try {
        const messages: any[] = []
        const collectDone = new Promise<void>((resolve) => {
          const onMessage = (data: WebSocket.RawData) => {
            const parsed = JSON.parse(data.toString())
            messages.push(parsed)
            if (parsed.type === 'sdk.error') {
              ws.off('message', onMessage)
              resolve()
            }
          }
          ws.on('message', onMessage)
        })

        ws.send(JSON.stringify({
          type: 'sdk.attach',
          sessionId: 'sdk-sess-1',
        }))

        await collectDone

        expect(messages.find((m) => m.type === 'sdk.error')).toEqual({
          type: 'sdk.error',
          sessionId: 'sdk-sess-1',
          code: 'RESTORE_NOT_FOUND',
          message: 'SDK session history not found',
        })
        expect(messages.some((m) => m.type === 'sdk.session.snapshot')).toBe(false)
        expect(messages.some((m) => m.type === 'sdk.status')).toBe(false)
        expect(mockSdkBridge.subscribe).not.toHaveBeenCalledWith('sdk-sess-1', expect.any(Function))
      } finally {
        ws.close()
      }
    })

    it('sends sdk.attach snapshot before replaying buffered SDK messages', async () => {
      mockSdkBridge.getSession.mockReturnValue({
        sessionId: 'sdk-sess-1',
        resumeSessionId: 'cli-sess-1',
        status: 'running',
        messages: [makeMessage('user', 'delta prompt', '2026-03-10T10:02:00.000Z')],
        streamingActive: true,
        streamingText: 'partial reply',
        pendingPermissions: new Map(),
        pendingQuestions: new Map(),
      })
      mockSdkBridge.subscribe.mockImplementation((sessionId: string, listener: (msg: any) => void) => {
        listener({
          type: 'sdk.session.init',
          sessionId,
          cliSessionId: 'cli-sess-1',
          model: 'claude-sonnet-4-5-20250929',
          cwd: '/tmp/project',
          tools: [],
        })
        return { off: () => {}, replayed: true }
      })
      mockHistorySource.resolve.mockResolvedValue(makeResolvedHistory({
        queryId: 'sdk-sess-1',
        liveSessionId: 'sdk-sess-1',
        timelineSessionId: 'cli-sess-1',
        revision: 123,
        messages: [
          makeMessage('user', 'older prompt', '2026-03-10T10:00:00.000Z'),
          makeMessage('assistant', 'older reply', '2026-03-10T10:01:00.000Z'),
          makeMessage('user', 'delta prompt', '2026-03-10T10:02:00.000Z'),
        ],
      }))

      const ws = await connectAndAuth()
      try {
        const messages: any[] = []
        const collectDone = new Promise<void>((resolve) => {
          const onMessage = (data: WebSocket.RawData) => {
            const parsed = JSON.parse(data.toString())
            if (
              parsed.type === 'sdk.session.snapshot'
              || parsed.type === 'sdk.status'
              || parsed.type === 'sdk.session.init'
            ) {
              messages.push(parsed)
            }
            if (
              messages.some((m) => m.type === 'sdk.session.snapshot')
              && messages.some((m) => m.type === 'sdk.session.init')
              && messages.some((m) => m.type === 'sdk.status')
            ) {
              ws.off('message', onMessage)
              resolve()
            }
          }
          ws.on('message', onMessage)
        })

        ws.send(JSON.stringify({
          type: 'sdk.attach',
          sessionId: 'sdk-sess-1',
        }))

        await collectDone

        const orderedTypes = messages.map((message) => message.type)
        expect(orderedTypes.indexOf('sdk.session.snapshot')).toBeLessThan(orderedTypes.indexOf('sdk.session.init'))
      } finally {
        ws.close()
      }
    })

    it('hydrates sdk.attach from durable Claude history when no live SDK session exists, then marks it lost for recovery', async () => {
      const durableSessionId = '00000000-0000-4000-8000-000000000241'
      mockSdkBridge.getLiveSession.mockReturnValue(undefined)
      mockHistorySource.resolve.mockResolvedValue(makeResolvedHistory({
        queryId: durableSessionId,
        timelineSessionId: durableSessionId,
        revision: 123,
        messages: [
          makeMessage('user', 'Earlier question', '2026-03-10T10:00:00.000Z'),
          makeMessage('assistant', 'Earlier answer', '2026-03-10T10:00:01.000Z'),
        ],
      }))

      const ws = await connectAndAuth()
      try {
        const messages: any[] = []
        const collectDone = new Promise<void>((resolve) => {
          const onMessage = (data: WebSocket.RawData) => {
            const parsed = JSON.parse(data.toString())
            messages.push(parsed)
            if (
              messages.some((message) => message.type === 'sdk.session.snapshot')
              && messages.some((message) => message.type === 'sdk.error')
            ) {
              ws.off('message', onMessage)
              resolve()
            }
          }
          ws.on('message', onMessage)
        })

        ws.send(JSON.stringify({
          type: 'sdk.attach',
          sessionId: durableSessionId,
        }))

        await collectDone

        const snapshotMsg = messages.find((m) => m.type === 'sdk.session.snapshot')
        const errorMsg = messages.find((m) => m.type === 'sdk.error')

        expect(snapshotMsg).toEqual({
          type: 'sdk.session.snapshot',
          sessionId: durableSessionId,
          latestTurnId: 'turn-1',
          status: 'idle',
          timelineSessionId: durableSessionId,
          revision: 123,
        })
        expect(errorMsg).toEqual({
          type: 'sdk.error',
          sessionId: durableSessionId,
          code: 'INVALID_SESSION_ID',
          message: 'SDK session not found',
        })
        expect(messages.some((m) => m.type === 'sdk.status')).toBe(false)
        expect(messages.some((m) => m.type === 'sdk.history')).toBe(false)
        expect(mockHistorySource.resolve).toHaveBeenCalledWith(durableSessionId)
        expect(mockSdkBridge.subscribe).not.toHaveBeenCalledWith(durableSessionId, expect.any(Function))
      } finally {
        ws.close()
      }
    })

    it('hydrates sdk.attach through the canonical durable resumeSessionId when the persisted sdk session id is stale and then marks it lost for recovery', async () => {
      const durableSessionId = '00000000-0000-4000-8000-000000000321'
      mockSdkBridge.getLiveSession.mockReturnValue(undefined)
      mockHistorySource.resolve.mockResolvedValue(makeResolvedHistory({
        queryId: durableSessionId,
        timelineSessionId: durableSessionId,
        revision: 42,
        messages: [
          makeMessage('user', 'Recovered durable question', '2026-03-10T10:00:00.000Z'),
          makeMessage('assistant', 'Recovered durable answer', '2026-03-10T10:00:20.000Z'),
        ],
      }))

      const ws = await connectAndAuth()
      try {
        const messages: any[] = []
        const collectDone = new Promise<void>((resolve) => {
          const onMessage = (data: WebSocket.RawData) => {
            const parsed = JSON.parse(data.toString())
            messages.push(parsed)
            if (
              messages.some((message) => message.type === 'sdk.session.snapshot')
              && messages.some((message) => message.type === 'sdk.error')
            ) {
              ws.off('message', onMessage)
              resolve()
            }
          }
          ws.on('message', onMessage)
        })

        ws.send(JSON.stringify({
          type: 'sdk.attach',
          sessionId: 'sdk-stale-321',
          resumeSessionId: durableSessionId,
        }))

        await collectDone

        expect(messages.find((m) => m.type === 'sdk.session.snapshot')).toEqual({
          type: 'sdk.session.snapshot',
          sessionId: 'sdk-stale-321',
          latestTurnId: 'turn-1',
          status: 'idle',
          timelineSessionId: durableSessionId,
          revision: 42,
        })
        expect(messages.find((m) => m.type === 'sdk.error')).toEqual({
          type: 'sdk.error',
          sessionId: 'sdk-stale-321',
          code: 'INVALID_SESSION_ID',
          message: 'SDK session not found',
        })
        expect(messages.some((m) => m.type === 'sdk.status')).toBe(false)
        expect(mockHistorySource.resolve).toHaveBeenCalledWith(durableSessionId)
        expect(mockSdkBridge.subscribe).not.toHaveBeenCalledWith('sdk-stale-321', expect.any(Function))
      } finally {
        ws.close()
      }
    })

    it('rebuilds sdk.attach from durable history when only ended in-memory SDK state remains, then marks it lost for recovery', async () => {
      const durableSessionId = '00000000-0000-4000-8000-000000000243'
      mockSdkBridge.getSession.mockReturnValue({
        sessionId: 'sdk-ended-1',
        cliSessionId: durableSessionId,
        status: 'idle',
        messages: [makeMessage('assistant', 'stale in-memory reply', '2026-03-10T10:00:01.000Z')],
        streamingActive: false,
        streamingText: '',
        pendingPermissions: new Map(),
        pendingQuestions: new Map(),
      })
      mockSdkBridge.getLiveSession.mockReturnValue(undefined)
      mockHistorySource.resolve.mockResolvedValue(makeResolvedHistory({
        queryId: 'sdk-ended-1',
        timelineSessionId: durableSessionId,
        revision: 7,
        messages: [
          makeMessage('user', 'Earlier question', '2026-03-10T10:00:00.000Z'),
          makeMessage('assistant', 'Earlier durable answer', '2026-03-10T10:00:01.000Z'),
        ],
      }))

      const ws = await connectAndAuth()
      try {
        const messages: any[] = []
        const collectDone = new Promise<void>((resolve) => {
          const onMessage = (data: WebSocket.RawData) => {
            const parsed = JSON.parse(data.toString())
            messages.push(parsed)
            if (
              messages.some((message) => message.type === 'sdk.session.snapshot')
              && messages.some((message) => message.type === 'sdk.error')
            ) {
              ws.off('message', onMessage)
              resolve()
            }
          }
          ws.on('message', onMessage)
        })

        ws.send(JSON.stringify({
          type: 'sdk.attach',
          sessionId: 'sdk-ended-1',
        }))

        await collectDone

        expect(messages.find((m) => m.type === 'sdk.session.snapshot')).toEqual({
          type: 'sdk.session.snapshot',
          sessionId: 'sdk-ended-1',
          latestTurnId: 'turn-1',
          status: 'idle',
          timelineSessionId: durableSessionId,
          revision: 7,
        })
        expect(messages.find((m) => m.type === 'sdk.error')).toEqual({
          type: 'sdk.error',
          sessionId: 'sdk-ended-1',
          code: 'INVALID_SESSION_ID',
          message: 'SDK session not found',
        })
        expect(messages.some((m) => m.type === 'sdk.status')).toBe(false)
        expect(mockHistorySource.resolve).toHaveBeenCalledWith('sdk-ended-1')
        expect(mockSdkBridge.subscribe).not.toHaveBeenCalledWith('sdk-ended-1', expect.any(Function))
      } finally {
        ws.close()
      }
    })

    it('reuses the live SDK session when sdk.attach targets the canonical durable Claude id', async () => {
      const durableSessionId = '00000000-0000-4000-8000-000000000242'
      const liveSession = {
        sessionId: 'sdk-live-242',
        cliSessionId: durableSessionId,
        status: 'running',
        messages: [makeMessage('user', 'delta prompt', '2026-03-10T10:02:00.000Z')],
        streamingActive: true,
        streamingText: 'partial reply',
        pendingPermissions: new Map(),
        pendingQuestions: new Map(),
      }
      let subscriptionListener: ((msg: any) => void) | undefined

      mockSdkBridge.getSession.mockImplementation((sessionId: string) => {
        if (sessionId === durableSessionId) return undefined
        if (sessionId === liveSession.sessionId) return liveSession
        return undefined
      })
      mockSdkBridge.sendUserMessage.mockImplementation((sessionId: string) => sessionId === liveSession.sessionId)
      mockSdkBridge.subscribe.mockImplementation((sessionId: string, listener: (msg: any) => void) => {
        subscriptionListener = listener
        return { off: () => {}, replayed: false }
      })
      mockHistorySource.resolve.mockResolvedValue(makeResolvedHistory({
        queryId: durableSessionId,
        liveSessionId: liveSession.sessionId,
        timelineSessionId: durableSessionId,
        revision: 123,
        messages: [
          makeMessage('user', 'older prompt', '2026-03-10T10:00:00.000Z'),
          makeMessage('assistant', 'older reply', '2026-03-10T10:01:00.000Z'),
          makeMessage('user', 'delta prompt', '2026-03-10T10:02:00.000Z'),
        ],
      }))

      const ws = await connectAndAuth()
      try {
        const messages: any[] = []
        const collectedAttach = new Promise<void>((resolve) => {
          const onMessage = (data: WebSocket.RawData) => {
            const parsed = JSON.parse(data.toString())
            messages.push(parsed)
            const snapshotReceived = messages.some((m) => m.type === 'sdk.session.snapshot')
            const statusReceived = messages.some((m) => m.type === 'sdk.status')
            if (snapshotReceived && statusReceived) {
              ws.off('message', onMessage)
              resolve()
            }
          }
          ws.on('message', onMessage)
        })

        ws.send(JSON.stringify({
          type: 'sdk.attach',
          sessionId: durableSessionId,
        }))

        await collectedAttach

        expect(messages.find((m) => m.type === 'sdk.session.snapshot')).toEqual(expect.objectContaining({
          type: 'sdk.session.snapshot',
          sessionId: durableSessionId,
          status: 'running',
          timelineSessionId: durableSessionId,
          revision: 123,
          streamingActive: true,
          streamingText: 'partial reply',
        }))
        expect(messages.find((m) => m.type === 'sdk.status')).toEqual({
          type: 'sdk.status',
          sessionId: durableSessionId,
          status: 'running',
        })
        await vi.waitFor(() => {
          expect(mockSdkBridge.subscribe).toHaveBeenCalledWith(liveSession.sessionId, expect.any(Function))
        })

        const forwardedUpdate = new Promise<any>((resolve) => {
          const onMessage = (data: WebSocket.RawData) => {
            const parsed = JSON.parse(data.toString())
            if (parsed.type === 'sdk.status' && parsed.status === 'running') {
              ws.off('message', onMessage)
              resolve(parsed)
            }
          }
          ws.on('message', onMessage)
        })
        subscriptionListener?.({
          type: 'sdk.status',
          sessionId: liveSession.sessionId,
          status: 'running',
        })
        await expect(forwardedUpdate).resolves.toEqual({
          type: 'sdk.status',
          sessionId: durableSessionId,
          status: 'running',
        })

        ws.send(JSON.stringify({
          type: 'sdk.send',
          sessionId: durableSessionId,
          text: 'continue working',
        }))

        await vi.waitFor(() => {
          expect(mockSdkBridge.sendUserMessage).toHaveBeenCalledWith(
            liveSession.sessionId,
            'continue working',
            undefined,
          )
        })
      } finally {
        ws.close()
      }
    })

    it('reuses the live SDK session when sdk.attach resolves the canonical durable id through the live cli-session alias lookup', async () => {
      const durableSessionId = '00000000-0000-4000-8000-000000000244'
      const liveSession = {
        sessionId: 'sdk-live-244',
        cliSessionId: durableSessionId,
        status: 'running',
        messages: [makeMessage('user', 'delta prompt', '2026-03-10T10:02:00.000Z')],
        streamingActive: true,
        streamingText: 'partial reply',
        pendingPermissions: new Map(),
        pendingQuestions: new Map(),
      }
      let subscriptionListener: ((msg: any) => void) | undefined

      mockSdkBridge.getLiveSession.mockReturnValue(undefined)
      mockSdkBridge.findLiveSessionByCliSessionId.mockImplementation((sessionId: string) => (
        sessionId === durableSessionId ? liveSession : undefined
      ))
      mockSdkBridge.sendUserMessage.mockImplementation((sessionId: string) => sessionId === liveSession.sessionId)
      mockSdkBridge.subscribe.mockImplementation((sessionId: string, listener: (msg: any) => void) => {
        subscriptionListener = listener
        return { off: () => {}, replayed: false }
      })
      mockHistorySource.resolve.mockResolvedValue({
        ...makeResolvedHistory({
          queryId: durableSessionId,
          timelineSessionId: durableSessionId,
          revision: 125,
          messages: [
            makeMessage('user', 'older prompt', '2026-03-10T10:00:00.000Z'),
            makeMessage('assistant', 'older reply', '2026-03-10T10:01:00.000Z'),
            makeMessage('user', 'delta prompt', '2026-03-10T10:02:00.000Z'),
          ],
        }),
        liveSessionId: undefined,
        readiness: 'merged' as const,
      })

      const ws = await connectAndAuth()
      try {
        const messages: any[] = []
        const collectedAttach = new Promise<void>((resolve) => {
          const onMessage = (data: WebSocket.RawData) => {
            const parsed = JSON.parse(data.toString())
            messages.push(parsed)
            const snapshotReceived = messages.some((m) => m.type === 'sdk.session.snapshot')
            const statusReceived = messages.some((m) => m.type === 'sdk.status')
            if (snapshotReceived && statusReceived) {
              ws.off('message', onMessage)
              resolve()
            }
          }
          ws.on('message', onMessage)
        })

        ws.send(JSON.stringify({
          type: 'sdk.attach',
          sessionId: durableSessionId,
        }))

        await collectedAttach

        expect(messages.find((m) => m.type === 'sdk.session.snapshot')).toEqual(expect.objectContaining({
          type: 'sdk.session.snapshot',
          sessionId: durableSessionId,
          status: 'running',
          timelineSessionId: durableSessionId,
          revision: 125,
          streamingActive: true,
          streamingText: 'partial reply',
        }))
        await vi.waitFor(() => {
          expect(mockSdkBridge.findLiveSessionByCliSessionId).toHaveBeenCalledWith(durableSessionId)
          expect(mockSdkBridge.subscribe).toHaveBeenCalledWith(liveSession.sessionId, expect.any(Function))
        })

        const forwardedUpdate = new Promise<any>((resolve) => {
          const onMessage = (data: WebSocket.RawData) => {
            const parsed = JSON.parse(data.toString())
            if (parsed.type === 'sdk.status' && parsed.status === 'running') {
              ws.off('message', onMessage)
              resolve(parsed)
            }
          }
          ws.on('message', onMessage)
        })
        subscriptionListener?.({
          type: 'sdk.status',
          sessionId: liveSession.sessionId,
          status: 'running',
        })
        await expect(forwardedUpdate).resolves.toEqual({
          type: 'sdk.status',
          sessionId: durableSessionId,
          status: 'running',
        })

        ws.send(JSON.stringify({
          type: 'sdk.send',
          sessionId: durableSessionId,
          text: 'continue working',
        }))

        await vi.waitFor(() => {
          expect(mockSdkBridge.sendUserMessage).toHaveBeenCalledWith(liveSession.sessionId, 'continue working', undefined)
        })
      } finally {
        ws.close()
      }
    })

    it('ignores a conflicting sdk.attach resumeSessionId once the direct live SDK session is identified', async () => {
      const liveDurableSessionId = '00000000-0000-4000-8000-000000000246'
      const conflictingResumeSessionId = '00000000-0000-4000-8000-000000000999'
      const liveSession = {
        sessionId: 'sdk-live-246',
        cliSessionId: liveDurableSessionId,
        status: 'running',
        messages: [makeMessage('user', 'live prompt', '2026-03-10T10:02:00.000Z')],
        streamingActive: true,
        streamingText: 'live partial',
        pendingPermissions: new Map(),
        pendingQuestions: new Map(),
      }

      mockSdkBridge.getLiveSession.mockImplementation((sessionId: string) => (
        sessionId === liveSession.sessionId ? liveSession : undefined
      ))
      mockSdkBridge.sendUserMessage.mockImplementation((sessionId: string) => sessionId === liveSession.sessionId)

      mockHistorySource.resolve.mockImplementation(async (queryId: string, options?: { liveSessionOverride?: typeof liveSession }) => {
        if (options?.liveSessionOverride?.sessionId === liveSession.sessionId) {
          return makeResolvedHistory({
            queryId,
            liveSessionId: liveSession.sessionId,
            timelineSessionId: liveDurableSessionId,
            revision: 246,
            messages: [
              makeMessage('user', 'older prompt', '2026-03-10T10:00:00.000Z'),
              makeMessage('assistant', 'older reply', '2026-03-10T10:01:00.000Z'),
              makeMessage('user', 'live prompt', '2026-03-10T10:02:00.000Z'),
            ],
          })
        }
        return makeResolvedHistory({
          queryId,
          timelineSessionId: conflictingResumeSessionId,
          revision: 999,
          messages: [
            makeMessage('assistant', 'wrong hinted history', '2026-03-10T09:59:00.000Z'),
          ],
        })
      })

      const ws = await connectAndAuth()
      try {
        const messages: any[] = []
        const collectedAttach = new Promise<void>((resolve) => {
          const onMessage = (data: WebSocket.RawData) => {
            const parsed = JSON.parse(data.toString())
            messages.push(parsed)
            const snapshotReceived = messages.some((m) => m.type === 'sdk.session.snapshot')
            const statusReceived = messages.some((m) => m.type === 'sdk.status')
            if (snapshotReceived && statusReceived) {
              ws.off('message', onMessage)
              resolve()
            }
          }
          ws.on('message', onMessage)
        })

        ws.send(JSON.stringify({
          type: 'sdk.attach',
          sessionId: liveSession.sessionId,
          resumeSessionId: conflictingResumeSessionId,
        }))

        await collectedAttach

        expect(mockHistorySource.resolve).toHaveBeenCalledWith(
          conflictingResumeSessionId,
          { liveSessionOverride: liveSession },
        )
        expect(messages.find((m) => m.type === 'sdk.session.snapshot')).toEqual(expect.objectContaining({
          type: 'sdk.session.snapshot',
          sessionId: liveSession.sessionId,
          status: 'running',
          timelineSessionId: liveDurableSessionId,
          revision: 246,
          streamingActive: true,
          streamingText: 'live partial',
        }))
        expect(messages.find((m) => m.type === 'sdk.session.snapshot')?.latestTurnId).toBe('turn-2')
        expect(messages.find((m) => m.type === 'sdk.status')).toEqual({
          type: 'sdk.status',
          sessionId: liveSession.sessionId,
          status: 'running',
        })
        expect(messages.find((m) => m.type === 'sdk.session.snapshot')?.timelineSessionId).not.toBe(conflictingResumeSessionId)
        expect(messages.find((m) => m.type === 'sdk.session.snapshot')?.revision).not.toBe(999)

        ws.send(JSON.stringify({
          type: 'sdk.send',
          sessionId: liveSession.sessionId,
          text: 'continue working',
        }))

        await vi.waitFor(() => {
          expect(mockSdkBridge.sendUserMessage).toHaveBeenCalledWith(
            liveSession.sessionId,
            'continue working',
            undefined,
          )
        })
      } finally {
        ws.close()
      }
    })

    it('keeps the canonical durable attach alias routable even when subscribe cannot establish live stream bookkeeping', async () => {
      const durableSessionId = '00000000-0000-4000-8000-000000000243'
      const liveSession = {
        sessionId: 'sdk-live-243',
        cliSessionId: durableSessionId,
        status: 'running',
        messages: [makeMessage('user', 'delta prompt', '2026-03-10T10:02:00.000Z')],
        streamingActive: false,
        streamingText: '',
        pendingPermissions: new Map(),
        pendingQuestions: new Map(),
      }

      mockSdkBridge.getSession.mockImplementation((sessionId: string) => {
        if (sessionId === durableSessionId) return undefined
        if (sessionId === liveSession.sessionId) return liveSession
        return undefined
      })
      mockSdkBridge.sendUserMessage.mockImplementation((sessionId: string) => sessionId === liveSession.sessionId)
      mockSdkBridge.subscribe.mockReturnValue(null)
      mockHistorySource.resolve.mockResolvedValue(makeResolvedHistory({
        queryId: durableSessionId,
        liveSessionId: liveSession.sessionId,
        timelineSessionId: durableSessionId,
        revision: 124,
        messages: [
          makeMessage('user', 'older prompt', '2026-03-10T10:00:00.000Z'),
          makeMessage('assistant', 'older reply', '2026-03-10T10:01:00.000Z'),
          makeMessage('user', 'delta prompt', '2026-03-10T10:02:00.000Z'),
        ],
      }))

      const ws = await connectAndAuth()
      try {
        const collectedAttach = new Promise<void>((resolve) => {
          let snapshotReceived = false
          let statusReceived = false
          const onMessage = (data: WebSocket.RawData) => {
            const parsed = JSON.parse(data.toString())
            snapshotReceived ||= parsed.type === 'sdk.session.snapshot'
            statusReceived ||= parsed.type === 'sdk.status'
            if (snapshotReceived && statusReceived) {
              ws.off('message', onMessage)
              resolve()
            }
          }
          ws.on('message', onMessage)
        })

        ws.send(JSON.stringify({
          type: 'sdk.attach',
          sessionId: durableSessionId,
        }))

        await collectedAttach

        ws.send(JSON.stringify({
          type: 'sdk.send',
          sessionId: durableSessionId,
          text: 'continue working',
        }))

        await vi.waitFor(() => {
          expect(mockSdkBridge.sendUserMessage).toHaveBeenCalledWith(liveSession.sessionId, 'continue working', undefined)
        })
      } finally {
        ws.close()
      }
    })

    it('for resumed sdk.create sends sdk.created, then sdk.session.snapshot, then sdk.session.init', async () => {
      const durableSessionId = '00000000-0000-4000-8000-000000000241'
      mockHistorySource.resolve.mockResolvedValue(makeResolvedHistory({
        queryId: 'sdk-sess-1',
        liveSessionId: 'sdk-sess-1',
        timelineSessionId: durableSessionId,
        revision: 123,
        messages: [
          makeMessage('user', 'Earlier question', '2026-03-10T10:00:00.000Z'),
          makeMessage('assistant', 'Earlier answer', '2026-03-10T10:00:01.000Z'),
        ],
      }))

      const ws = await connectAndAuth()
      try {
        const messages: any[] = []
        const collected = new Promise<void>((resolve) => {
          const onMessage = (data: WebSocket.RawData) => {
            const parsed = JSON.parse(data.toString())
            if (
              parsed.type === 'sdk.created'
              || parsed.type === 'sdk.session.snapshot'
              || parsed.type === 'sdk.session.init'
            ) {
              messages.push(parsed)
            }
            if (messages.length >= 3) {
              ws.off('message', onMessage)
              resolve()
            }
          }
          ws.on('message', onMessage)
        })

        ws.send(JSON.stringify({
          type: 'sdk.create',
          requestId: 'req-resume-order',
          resumeSessionId: durableSessionId,
        }))

        await collected

        expect(messages.map((m) => m.type).slice(0, 3)).toEqual([
          'sdk.created',
          'sdk.session.snapshot',
          'sdk.session.init',
        ])
        expect(messages[1]).toEqual(expect.objectContaining({
          type: 'sdk.session.snapshot',
          sessionId: 'sdk-sess-1',
          timelineSessionId: durableSessionId,
          latestTurnId: 'turn-1',
        }))
        expect(messages.some((m) => m.type === 'sdk.history')).toBe(false)
        expect(mockHistorySource.resolve).toHaveBeenCalledWith('sdk-sess-1', expect.objectContaining({
          liveSessionOverride: expect.objectContaining({
            sessionId: 'sdk-sess-1',
          }),
        }))
      } finally {
        ws.close()
      }
    })

    it('for named resume sdk.create resolves snapshot history by the live SDK session id and leaves timelineSessionId undefined', async () => {
      mockSdkBridge.createSession.mockResolvedValue(makeCreatedSession({
        sessionId: 'sdk-sess-named',
        resumeSessionId: 'worktree-hotfix',
        status: 'starting',
        messages: [],
      }))
      mockHistorySource.resolve.mockResolvedValue(makeResolvedHistory({
        queryId: 'sdk-sess-named',
        liveSessionId: 'sdk-sess-named',
        revision: 1,
        messages: [makeMessage('user', 'live only', '2026-03-10T10:00:00.000Z')],
      }))

      const ws = await connectAndAuth()
      try {
        const snapshot = await sendAndWaitForResponse(ws, {
          type: 'sdk.create',
          requestId: 'req-named',
          resumeSessionId: 'worktree-hotfix',
        }, 'sdk.session.snapshot')

        expect(mockHistorySource.resolve).toHaveBeenCalledWith('sdk-sess-named', expect.objectContaining({
          liveSessionOverride: expect.objectContaining({
            sessionId: 'sdk-sess-named',
          }),
        }))
        expect(mockHistorySource.resolve).not.toHaveBeenCalledWith('worktree-hotfix', expect.anything())
        expect(snapshot.timelineSessionId).toBeUndefined()
      } finally {
        ws.close()
      }
    })

    it('returns sdk.create.failed instead of fabricating a live-only snapshot when sdk.create history resolution fails unexpectedly', async () => {
      mockSdkBridge.createSession.mockResolvedValue(makeCreatedSession({
        sessionId: 'sdk-sess-live-only',
        status: 'running',
        messages: [makeMessage('user', 'live prompt', '2026-03-10T10:00:00.000Z')],
        streamingActive: true,
        streamingText: 'partial reply',
        pendingPermissions: new Map(),
        pendingQuestions: new Map(),
      }))
      mockHistorySource.resolve.mockRejectedValue(new Error('jsonl read failed'))

      const ws = await connectAndAuth()
      try {
        const messages: any[] = []
        const collected = new Promise<void>((resolve) => {
          const onMessage = (data: WebSocket.RawData) => {
            const parsed = JSON.parse(data.toString())
            if (
              parsed.type === 'sdk.created'
              || parsed.type === 'sdk.session.snapshot'
              || parsed.type === 'sdk.session.init'
              || parsed.type === 'sdk.create.failed'
            ) {
              messages.push(parsed)
            }
            if (messages.some((message) => message.type === 'sdk.create.failed')) {
              ws.off('message', onMessage)
              resolve()
            }
          }
          ws.on('message', onMessage)
        })

        ws.send(JSON.stringify({
          type: 'sdk.create',
          requestId: 'req-live-only',
        }))

        await collected

        expect(messages.some((message) => message.type === 'sdk.created')).toBe(false)
        expect(messages.find((message) => message.type === 'sdk.create.failed')).toEqual({
          type: 'sdk.create.failed',
          requestId: 'req-live-only',
          code: 'RESTORE_INTERNAL',
          message: 'jsonl read failed',
          retryable: true,
        })
        expect(messages.some((message) => message.type === 'sdk.session.snapshot')).toBe(false)
        expect(messages.some((message) => message.type === 'sdk.session.init')).toBe(false)
        expect(mockSdkBridge.killSession).toHaveBeenCalledWith('sdk-sess-live-only')
        expect(mockHistorySource.teardownLiveSession).toHaveBeenCalledWith('sdk-sess-live-only', { recoverable: false })
      } finally {
        ws.close()
      }
    })

    it('returns sdk.create.failed instead of leaking a usable session when sdk.create restore resolution is missing', async () => {
      mockSdkBridge.createSession.mockResolvedValue(makeCreatedSession({
        sessionId: 'sdk-sess-create-missing',
        status: 'running',
        messages: [makeMessage('user', 'live prompt', '2026-03-10T10:00:00.000Z')],
        streamingActive: true,
        streamingText: 'partial reply',
        pendingPermissions: new Map(),
        pendingQuestions: new Map(),
      }))
      mockHistorySource.resolve.mockResolvedValue({
        kind: 'missing',
        code: 'RESTORE_NOT_FOUND',
      })

      const ws = await connectAndAuth()
      try {
        const messages: any[] = []
        const collected = new Promise<void>((resolve) => {
          const onMessage = (data: WebSocket.RawData) => {
            const parsed = JSON.parse(data.toString())
            if (
              parsed.type === 'sdk.created'
              || parsed.type === 'sdk.session.snapshot'
              || parsed.type === 'sdk.session.init'
              || parsed.type === 'sdk.create.failed'
            ) {
              messages.push(parsed)
            }
            if (messages.some((message) => message.type === 'sdk.create.failed')) {
              ws.off('message', onMessage)
              resolve()
            }
          }
          ws.on('message', onMessage)
        })

        ws.send(JSON.stringify({
          type: 'sdk.create',
          requestId: 'req-create-missing',
        }))

        await collected

        expect(messages.some((message) => message.type === 'sdk.created')).toBe(false)
        expect(messages.find((message) => message.type === 'sdk.create.failed')).toEqual({
          type: 'sdk.create.failed',
          requestId: 'req-create-missing',
          code: 'RESTORE_NOT_FOUND',
          message: 'SDK session history not found',
          retryable: true,
        })
        expect(messages.some((message) => message.type === 'sdk.session.snapshot')).toBe(false)
        expect(messages.some((message) => message.type === 'sdk.session.init')).toBe(false)
        expect(mockSdkBridge.killSession).toHaveBeenCalledWith('sdk-sess-create-missing')
        expect(mockHistorySource.teardownLiveSession).toHaveBeenCalledWith('sdk-sess-create-missing', { recoverable: false })
      } finally {
        ws.close()
      }
    })

    it('returns sdk.create.failed when the transactional replay gate cannot capture create replay state', async () => {
      mockSdkBridge.createSession.mockResolvedValue(makeCreatedSession({
        sessionId: 'sdk-sess-gate-missing',
        replayGate: {
          capture: vi.fn(() => null),
        },
      }))
      delete mockSdkBridge.captureReplayState

      const ws = await connectAndAuth()
      try {
        const messages: any[] = []
        ws.on('message', (data: WebSocket.RawData) => {
          const parsed = JSON.parse(data.toString())
          if (
            parsed.type === 'sdk.created'
            || parsed.type === 'sdk.session.snapshot'
            || parsed.type === 'sdk.session.init'
            || parsed.type === 'sdk.create.failed'
          ) {
            messages.push(parsed)
          }
        })

        ws.send(JSON.stringify({
          type: 'sdk.create',
          requestId: 'req-gate-missing',
        }))

        await vi.waitFor(() => expect(messages.some((message) => message.type === 'sdk.create.failed')).toBe(true), { timeout: 3000 })

        expect(messages.some((message) => message.type === 'sdk.created')).toBe(false)
        expect(messages.some((message) => message.type === 'sdk.session.snapshot')).toBe(false)
        expect(messages.some((message) => message.type === 'sdk.session.init')).toBe(false)
        expect(messages.find((message) => message.type === 'sdk.create.failed')).toEqual({
          type: 'sdk.create.failed',
          requestId: 'req-gate-missing',
          code: 'RESTORE_INTERNAL',
          message: 'SDK create replay gate unavailable',
          retryable: true,
        })
        expect(mockSdkBridge.killSession).toHaveBeenCalledWith('sdk-sess-gate-missing')
        expect(mockHistorySource.teardownLiveSession).toHaveBeenCalledWith('sdk-sess-gate-missing', { recoverable: false })
      } finally {
        ws.close()
      }
    })

    it('returns sdk.error instead of fabricating a live-only snapshot when live sdk.attach history resolution fails unexpectedly', async () => {
      mockSdkBridge.getSession.mockReturnValue({
        sessionId: 'sdk-sess-live-attach',
        status: 'running',
        messages: [makeMessage('user', 'live prompt', '2026-03-10T10:00:00.000Z')],
        streamingActive: true,
        streamingText: 'partial reply',
        pendingPermissions: new Map(),
        pendingQuestions: new Map(),
      })
      mockHistorySource.resolve.mockRejectedValue(new Error('jsonl read failed'))

      const ws = await connectAndAuth()
      try {
        const messages: any[] = []
        const collected = new Promise<void>((resolve) => {
          const onMessage = (data: WebSocket.RawData) => {
            const parsed = JSON.parse(data.toString())
            if (
              parsed.type === 'sdk.session.snapshot'
              || parsed.type === 'sdk.status'
              || parsed.type === 'sdk.error'
            ) {
              messages.push(parsed)
            }
            if (messages.some((message) => message.type === 'sdk.error')) {
              ws.off('message', onMessage)
              resolve()
            }
          }
          ws.on('message', onMessage)
        })

        ws.send(JSON.stringify({
          type: 'sdk.attach',
          sessionId: 'sdk-sess-live-attach',
        }))

        await collected

        expect(messages).toContainEqual({
          type: 'sdk.error',
          sessionId: 'sdk-sess-live-attach',
          code: 'RESTORE_INTERNAL',
          message: 'Failed to restore SDK session history',
        })
        expect(messages.some((message) => message.type === 'sdk.session.snapshot')).toBe(false)
        expect(messages.some((message) => message.type === 'sdk.status')).toBe(false)
      } finally {
        ws.close()
      }
    })

    it('returns sdk.error instead of fabricating a snapshot when live sdk.attach resolves to a fatal restore outcome', async () => {
      mockSdkBridge.getSession.mockReturnValue({
        sessionId: 'sdk-sess-live-fatal',
        status: 'running',
        messages: [makeMessage('user', 'live prompt', '2026-03-10T10:00:00.000Z')],
        streamingActive: true,
        streamingText: 'partial reply',
        pendingPermissions: new Map(),
        pendingQuestions: new Map(),
      })
      mockHistorySource.resolve.mockResolvedValue({
        kind: 'fatal',
        code: 'RESTORE_DIVERGED',
        message: 'Live restore state diverged from durable history',
      })

      const ws = await connectAndAuth()
      try {
        const messages: any[] = []
        const collected = new Promise<void>((resolve) => {
          const onMessage = (data: WebSocket.RawData) => {
            const parsed = JSON.parse(data.toString())
            if (
              parsed.type === 'sdk.session.snapshot'
              || parsed.type === 'sdk.status'
              || parsed.type === 'sdk.error'
            ) {
              messages.push(parsed)
            }
            if (messages.some((message) => message.type === 'sdk.error')) {
              ws.off('message', onMessage)
              resolve()
            }
          }
          ws.on('message', onMessage)
        })

        ws.send(JSON.stringify({
          type: 'sdk.attach',
          sessionId: 'sdk-sess-live-fatal',
        }))

        await collected

        expect(messages).toContainEqual({
          type: 'sdk.error',
          sessionId: 'sdk-sess-live-fatal',
          code: 'RESTORE_DIVERGED',
          message: 'Live restore state diverged from durable history',
        })
        expect(messages.some((message) => message.type === 'sdk.session.snapshot')).toBe(false)
        expect(messages.some((message) => message.type === 'sdk.status')).toBe(false)
      } finally {
        ws.close()
      }
    })

    it('returns sdk.error when sdk.attach cannot resolve durable history and no live session exists', async () => {
      mockSdkBridge.getSession.mockReturnValue(undefined)
      mockHistorySource.resolve.mockRejectedValue(new Error('jsonl read failed'))

      const ws = await connectAndAuth()
      try {
        const response = await sendAndWaitForResponse(ws, {
          type: 'sdk.attach',
          sessionId: 'sdk-missing-history',
        }, 'sdk.error')

        expect(response).toEqual({
          type: 'sdk.error',
          sessionId: 'sdk-missing-history',
          code: 'RESTORE_INTERNAL',
          message: 'Failed to restore SDK session history',
        })
      } finally {
        ws.close()
      }
    })

    it('returns sdk.error with RESTORE_NOT_FOUND for sdk.attach when durable restore state is missing', async () => {
      mockSdkBridge.getSession.mockReturnValue(undefined)
      mockHistorySource.resolve.mockResolvedValue({
        kind: 'missing',
        code: 'RESTORE_NOT_FOUND',
      })
      const ws = await connectAndAuth()
      try {
        const response = await sendAndWaitForResponse(ws, {
          type: 'sdk.attach',
          sessionId: 'nonexistent',
        }, 'sdk.error')

        expect(response).toEqual({
          type: 'sdk.error',
          sessionId: 'nonexistent',
          code: 'RESTORE_NOT_FOUND',
          message: 'SDK session history not found',
        })
      } finally {
        ws.close()
      }
    })

    it('sends sdk.created before replaying buffered session messages', async () => {
      // Make createSession return a session, but make subscribe replay a buffered message
      const subscribeFn = vi.fn().mockImplementation((_sessionId: string, listener: Function) => {
        // Simulate buffer replay: the init message is sent synchronously during subscribe
        listener({
          type: 'sdk.session.init',
          sessionId: 'sdk-sess-1',
          cliSessionId: 'cli-123',
          model: 'claude-sonnet-4-5-20250929',
          cwd: '/tmp',
          tools: [],
        })
        return { off: () => {}, replayed: true }
      })
      mockSdkBridge.subscribe = subscribeFn

      const ws = await connectAndAuth()
      try {
        const received: any[] = []
        ws.on('message', (data: WebSocket.RawData) => {
          const parsed = JSON.parse(data.toString())
          if (parsed.type === 'sdk.created' || parsed.type === 'sdk.session.init') {
            received.push(parsed)
          }
        })

        ws.send(JSON.stringify({
          type: 'sdk.create',
          requestId: 'req-order',
          cwd: '/tmp',
        }))

        // Wait for both messages
        await vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(2), { timeout: 3000 })

        // sdk.created MUST arrive before sdk.session.init
        expect(received[0].type).toBe('sdk.created')
        expect(received[1].type).toBe('sdk.session.init')
      } finally {
        ws.close()
      }
    })

    it('replays only post-watermark events and converts buffered raw init into sdk.session.metadata during transactional create', async () => {
      mockSdkBridge.createSession.mockResolvedValue(makeCreatedSession({
        sessionId: 'sdk-sess-1',
        status: 'connected',
        cliSessionId: 'cli-123',
        model: 'claude-sonnet-4-5-20250929',
        cwd: '/tmp',
        tools: [{ name: 'Bash' }],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: '2026-01-01T00:00:00Z' }],
        replayGate: {
          capture: vi.fn(() => ({
            watermark: 1,
            session: {
              sessionId: 'sdk-sess-1',
              status: 'connected',
              cliSessionId: 'cli-123',
              model: 'claude-sonnet-4-5-20250929',
              cwd: '/tmp',
              tools: [{ name: 'Bash' }],
              messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: '2026-01-01T00:00:00Z' }],
              streamingActive: false,
              streamingText: '',
              pendingPermissions: new Map(),
              pendingQuestions: new Map(),
            },
          })),
        },
      }))
      mockSdkBridge.subscribe.mockImplementation((_sessionId: string, listener: (msg: any, meta?: { sequence: number }) => void) => {
        listener({
          type: 'sdk.session.init',
          sessionId: 'sdk-sess-1',
          cliSessionId: 'cli-123',
          model: 'claude-sonnet-4-5-20250929',
          cwd: '/tmp',
          tools: [{ name: 'Bash' }],
        }, { sequence: 1 })
        listener({
          type: 'sdk.stream',
          sessionId: 'sdk-sess-1',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'after watermark' },
          },
        }, { sequence: 2 })
        return { off: () => {}, replayed: true }
      })

      const ws = await connectAndAuth()
      try {
        const received: any[] = []
        ws.on('message', (data: WebSocket.RawData) => {
          const parsed = JSON.parse(data.toString())
          if (
            parsed.type === 'sdk.created'
            || parsed.type === 'sdk.session.snapshot'
            || parsed.type === 'sdk.session.init'
            || parsed.type === 'sdk.session.metadata'
            || parsed.type === 'sdk.stream'
          ) {
            received.push(parsed)
          }
        })

        ws.send(JSON.stringify({
          type: 'sdk.create',
          requestId: 'req-transactional-replay',
          cwd: '/tmp',
        }))

        await vi.waitFor(() => expect(received.map((message) => message.type)).toEqual([
          'sdk.created',
          'sdk.session.snapshot',
          'sdk.session.init',
          'sdk.stream',
          'sdk.session.metadata',
        ]), { timeout: 3000 })

        expect(received[3]).toMatchObject({
          type: 'sdk.stream',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'after watermark' },
          },
        })
        expect(received[4]).toMatchObject({
          type: 'sdk.session.metadata',
          cliSessionId: 'cli-123',
          cwd: '/tmp',
        })
      } finally {
        ws.close()
      }
    })

    it('does not lose post-watermark events that arrive during transactional create replay cutover', async () => {
      let subscriptionListener: ((msg: any, meta?: { sequence: number }) => void) | undefined
      let injectedStatus = false

      mockSdkBridge.createSession.mockResolvedValue(makeCreatedSession({
        sessionId: 'sdk-sess-cutover',
        status: 'connected',
        cliSessionId: 'cli-cutover',
        model: 'claude-sonnet-4-5-20250929',
        cwd: '/tmp',
        tools: [],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: '2026-01-01T00:00:00Z' }],
        replayGate: {
          capture: vi.fn(() => ({
            watermark: 1,
            session: {
              sessionId: 'sdk-sess-cutover',
              status: 'connected',
              cliSessionId: 'cli-cutover',
              model: 'claude-sonnet-4-5-20250929',
              cwd: '/tmp',
              tools: [],
              messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: '2026-01-01T00:00:00Z' }],
              streamingActive: false,
              streamingText: '',
              pendingPermissions: new Map(),
              pendingQuestions: new Map(),
            },
          })),
        },
      }))
      mockSdkBridge.subscribe.mockImplementation((_sessionId: string, listener: (msg: any, meta?: { sequence: number }) => void) => {
        subscriptionListener = listener
        listener({
          type: 'sdk.session.init',
          sessionId: 'sdk-sess-cutover',
          cliSessionId: 'cli-cutover',
          model: 'claude-sonnet-4-5-20250929',
          cwd: '/tmp',
          tools: [],
        }, { sequence: 1 })
        listener({
          type: 'sdk.stream',
          sessionId: 'sdk-sess-cutover',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'queued replay event' },
          },
        }, { sequence: 2 })
        return { off: () => {}, replayed: true }
      })

      const originalFlushTransactionalCreateReplay = (handler as any).flushTransactionalCreateReplay.bind(handler)
      vi.spyOn(handler as any, 'flushTransactionalCreateReplay').mockImplementation((
        ws: WebSocket,
        clientSessionId: string,
        queuedMessages: Array<{ message: any; sequence: number }>,
        watermark: number,
      ) => {
        originalFlushTransactionalCreateReplay(ws, clientSessionId, queuedMessages, watermark)
        if (injectedStatus) return
        injectedStatus = true
        subscriptionListener?.({
          type: 'sdk.status',
          sessionId: 'sdk-sess-cutover',
          status: 'running',
        }, { sequence: 3 })
      })

      const ws = await connectAndAuth()
      try {
        const received: any[] = []
        ws.on('message', (data: WebSocket.RawData) => {
          const parsed = JSON.parse(data.toString())
          if (
            parsed.type === 'sdk.created'
            || parsed.type === 'sdk.session.snapshot'
            || parsed.type === 'sdk.session.init'
            || parsed.type === 'sdk.session.metadata'
            || parsed.type === 'sdk.stream'
            || parsed.type === 'sdk.status'
          ) {
            received.push(parsed)
          }
        })

        ws.send(JSON.stringify({
          type: 'sdk.create',
          requestId: 'req-cutover',
          cwd: '/tmp',
        }))

        await vi.waitFor(() => {
          expect(received.some((message) => message.type === 'sdk.status' && message.status === 'running')).toBe(true)
        }, { timeout: 3000 })

        expect(received.map((message) => message.type)).toContain('sdk.stream')
        expect(received.map((message) => message.type)).toContain('sdk.status')
      } finally {
        ws.close()
      }
    })

    it('routes sdk.create with plugins to sdkBridge.createSession', async () => {
      const ws = await connectAndAuth()
      try {
        await sendAndWaitForResponse(ws, {
          type: 'sdk.create',
          requestId: 'req-plugins',
          cwd: '/tmp',
          plugins: ['/path/to/plugin-a', '/path/to/plugin-b'],
        }, 'sdk.created')

        expect(mockSdkBridge.createSession).toHaveBeenCalledWith(
          expect.objectContaining({ plugins: ['/path/to/plugin-a', '/path/to/plugin-b'] }),
        )
      } finally {
        ws.close()
      }
    })

    it('routes sdk.create with effort to sdkBridge.createSession', async () => {
      const ws = await connectAndAuth()
      try {
        await sendAndWaitForResponse(ws, {
          type: 'sdk.create',
          requestId: 'req-effort',
          cwd: '/tmp',
          effort: 'max',
        }, 'sdk.created')

        expect(mockSdkBridge.createSession).toHaveBeenCalledWith(
          expect.objectContaining({ effort: 'max' }),
        )
      } finally {
        ws.close()
      }
    })

    it('routes sdk.set-model to sdkBridge.setModel', async () => {
      mockSdkBridge.setModel = vi.fn().mockReturnValue(true)
      const ws = await connectAndAuth()
      try {
        // First create a session so client owns it
        await sendAndWaitForResponse(ws, {
          type: 'sdk.create',
          requestId: 'req-setmodel',
        }, 'sdk.created')

        ws.send(JSON.stringify({
          type: 'sdk.set-model',
          sessionId: 'sdk-sess-1',
          model: 'claude-sonnet-4-5-20250929',
        }))

        await vi.waitFor(
          () => expect(mockSdkBridge.setModel).toHaveBeenCalledWith('sdk-sess-1', 'claude-sonnet-4-5-20250929'),
          { timeout: 3000 },
        )
      } finally {
        ws.close()
      }
    })

    it('rejects sdk.set-model for unowned session', async () => {
      mockSdkBridge.setModel = vi.fn().mockReturnValue(true)
      const ws = await connectAndAuth()
      try {
        const response = await sendAndWaitForResponse(ws, {
          type: 'sdk.set-model',
          sessionId: 'not-my-session',
          model: 'claude-sonnet-4-5-20250929',
        }, 'error')

        expect(response.code).toBe('UNAUTHORIZED')
      } finally {
        ws.close()
      }
    })

    it('routes sdk.set-permission-mode to sdkBridge.setPermissionMode', async () => {
      mockSdkBridge.setPermissionMode = vi.fn().mockReturnValue(true)
      const ws = await connectAndAuth()
      try {
        await sendAndWaitForResponse(ws, {
          type: 'sdk.create',
          requestId: 'req-setperm',
        }, 'sdk.created')

        ws.send(JSON.stringify({
          type: 'sdk.set-permission-mode',
          sessionId: 'sdk-sess-1',
          permissionMode: 'default',
        }))

        await vi.waitFor(
          () => expect(mockSdkBridge.setPermissionMode).toHaveBeenCalledWith('sdk-sess-1', 'default'),
          { timeout: 3000 },
        )
      } finally {
        ws.close()
      }
    })

    it('rejects sdk.set-permission-mode for unowned session', async () => {
      mockSdkBridge.setPermissionMode = vi.fn().mockReturnValue(true)
      const ws = await connectAndAuth()
      try {
        const response = await sendAndWaitForResponse(ws, {
          type: 'sdk.set-permission-mode',
          sessionId: 'not-my-session',
          permissionMode: 'default',
        }, 'error')

        expect(response.code).toBe('UNAUTHORIZED')
      } finally {
        ws.close()
      }
    })

    it('sends preliminary sdk.session.init to break init deadlock', async () => {
      // The SDK subprocess only emits system/init after the first user message,
      // but the UI waits for sdk.session.init before showing the chat input.
      // The ws-handler must send a preliminary sdk.session.init immediately
      // after sdk.created so the client can start interacting.
      mockSdkBridge.createSession = vi.fn().mockReturnValue(makeCreatedSession({
        sessionId: 'sdk-sess-1',
        status: 'starting',
        model: 'claude-sonnet-4-5-20250929',
        cwd: '/tmp/project',
        messages: [],
      }))

      const ws = await connectAndAuth()
      try {
        const received: any[] = []
        ws.on('message', (data: WebSocket.RawData) => {
          const parsed = JSON.parse(data.toString())
          if (parsed.type === 'sdk.created' || parsed.type === 'sdk.session.init') {
            received.push(parsed)
          }
        })

        ws.send(JSON.stringify({
          type: 'sdk.create',
          requestId: 'req-init',
          cwd: '/tmp/project',
          model: 'claude-sonnet-4-5-20250929',
        }))

        await vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(2), { timeout: 3000 })

        expect(received[0].type).toBe('sdk.created')
        expect(received[1].type).toBe('sdk.session.init')
        expect(received[1].sessionId).toBe('sdk-sess-1')
        expect(received[1].model).toBe('claude-sonnet-4-5-20250929')
        expect(received[1].cwd).toBe('/tmp/project')
        expect(received[1].tools).toEqual([])
      } finally {
        ws.close()
      }
    })

    it('returns error for sdk.send with unowned session', async () => {
      const ws = await connectAndAuth()
      try {
        const response = await sendAndWaitForResponse(ws, {
          type: 'sdk.send',
          sessionId: 'nonexistent',
          text: 'hello',
        }, 'error')

        expect(response.type).toBe('error')
        expect(response.code).toBe('UNAUTHORIZED')
      } finally {
        ws.close()
      }
    })
  })

  describe('WsHandler without SDK bridge', () => {
    let server: http.Server
    let handler: WsHandler
    let registry: TerminalRegistry

    beforeEach(async () => {
      server = http.createServer()
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      registry = new TerminalRegistry()

      // No sdkBridge passed
      handler = new WsHandler(server, registry)
    })

    afterEach(async () => {
      handler.close()
      registry.shutdown()
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })

    function connectAndAuth(): Promise<WebSocket> {
      return new Promise<WebSocket>((resolve, reject) => {
        const addr = server.address()
        const port = typeof addr === 'object' ? addr!.port : 0
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
        const timeout = setTimeout(() => {
          cleanup()
          reject(new Error('Timeout waiting for ready'))
        }, 5000)

        const cleanup = () => {
          clearTimeout(timeout)
          ws.off('open', onOpen)
          ws.off('message', onMessage)
          ws.off('error', onError)
          ws.off('close', onClose)
        }

        const onOpen = () => {
          ws.send(JSON.stringify({
            type: 'hello',
            token: TEST_AUTH_TOKEN,
            protocolVersion: WS_PROTOCOL_VERSION,
          }))
        }

        const onMessage = (data: WebSocket.RawData) => {
          const msg = JSON.parse(data.toString())
          if (msg.type === 'ready') {
            cleanup()
            resolve(ws)
          }
        }

        const onError = (err: Error) => {
          cleanup()
          reject(err)
        }

        const onClose = (code: number, reason: Buffer) => {
          cleanup()
          reject(new Error(`Socket closed before ready (code=${code}, reason=${reason.toString()})`))
        }

        ws.on('open', onOpen)
        ws.on('message', onMessage)
        ws.on('error', onError)
        ws.on('close', onClose)
      })
    }

    function sendAndWaitForResponse(ws: WebSocket, msg: object, responseType: string): Promise<any> {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timeout waiting for ${responseType}`)), 3000)
        const onMessage = (data: WebSocket.RawData) => {
          const parsed = JSON.parse(data.toString())
          if (parsed.type === responseType) {
            clearTimeout(timeout)
            ws.off('message', onMessage)
            resolve(parsed)
          }
        }
        ws.on('message', onMessage)
        ws.send(JSON.stringify(msg))
      })
    }

    it('returns INTERNAL_ERROR for sdk.create when bridge not enabled', async () => {
      const ws = await connectAndAuth()
      try {
        const response = await sendAndWaitForResponse(ws, {
          type: 'sdk.create',
          requestId: 'req-1',
          cwd: '/tmp',
        }, 'error')

        expect(response.type).toBe('error')
        expect(response.code).toBe('INTERNAL_ERROR')
        expect(response.message).toBe('SDK bridge not enabled')
      } finally {
        ws.close()
      }
    })

    it('returns INTERNAL_ERROR for sdk.send when bridge not enabled', async () => {
      const ws = await connectAndAuth()
      try {
        const response = await sendAndWaitForResponse(ws, {
          type: 'sdk.send',
          sessionId: 'sess-1',
          text: 'hello',
        }, 'error')

        expect(response.type).toBe('error')
        expect(response.code).toBe('INTERNAL_ERROR')
      } finally {
        ws.close()
      }
    })

    it('returns INTERNAL_ERROR for sdk.kill when bridge not enabled', async () => {
      const ws = await connectAndAuth()
      try {
        const response = await sendAndWaitForResponse(ws, {
          type: 'sdk.kill',
          sessionId: 'sess-1',
        }, 'error')

        expect(response.type).toBe('error')
        expect(response.code).toBe('INTERNAL_ERROR')
      } finally {
        ws.close()
      }
    })
  })
})
