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

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}))

const TEST_AUTH_TOKEN = 'testtoken-testtoken'

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
      })
      expect(result.success).toBe(true)
    })

    it('rejects sdk.attach with empty sessionId', () => {
      const result = SdkAttachSchema.safeParse({
        type: 'sdk.attach',
        sessionId: '',
      })
      expect(result.success).toBe(false)
    })
  })

  describe('WsHandler SDK message routing', () => {
    let server: http.Server
    let handler: WsHandler
    let registry: TerminalRegistry
    let mockSdkBridge: any

    beforeEach(async () => {
      server = http.createServer()
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      registry = new TerminalRegistry()

      mockSdkBridge = {
        createSession: vi.fn().mockReturnValue({ sessionId: 'sdk-sess-1', status: 'starting', messages: [] }),
        subscribe: vi.fn().mockReturnValue(() => {}),
        sendUserMessage: vi.fn().mockReturnValue(true),
        respondPermission: vi.fn().mockReturnValue(true),
        interrupt: vi.fn().mockReturnValue(true),
        killSession: vi.fn().mockReturnValue(true),
        getSession: vi.fn().mockReturnValue({
          sessionId: 'sdk-sess-1',
          status: 'idle',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: '2026-01-01T00:00:00Z' }],
        }),
      }

      handler = new WsHandler(
        server,
        registry,
        undefined, // codingCliManager
        mockSdkBridge,
        undefined, // sessionRepairService
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

        // Give it a moment to process
        await new Promise((resolve) => setTimeout(resolve, 100))

        expect(mockSdkBridge.sendUserMessage).toHaveBeenCalledWith('sdk-sess-1', 'Hello Claude', undefined)
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

        await new Promise((resolve) => setTimeout(resolve, 100))

        expect(mockSdkBridge.respondPermission).toHaveBeenCalledWith(
          'sdk-sess-1', 'perm-1', { behavior: 'allow', updatedInput: {} },
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

        await new Promise((resolve) => setTimeout(resolve, 100))

        expect(mockSdkBridge.interrupt).toHaveBeenCalledWith('sdk-sess-1')
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
      } finally {
        ws.close()
      }
    })

    it('routes sdk.attach and returns history + status', async () => {
      const ws = await connectAndAuth()
      try {
        const messages: any[] = []
        const collectDone = new Promise<void>((resolve) => {
          let count = 0
          const onMessage = (data: WebSocket.RawData) => {
            const parsed = JSON.parse(data.toString())
            if (parsed.type === 'sdk.history' || parsed.type === 'sdk.status') {
              messages.push(parsed)
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

        const historyMsg = messages.find((m) => m.type === 'sdk.history')
        const statusMsg = messages.find((m) => m.type === 'sdk.status')

        expect(historyMsg).toBeDefined()
        expect(historyMsg.sessionId).toBe('sdk-sess-1')
        expect(historyMsg.messages).toHaveLength(1)
        expect(statusMsg).toBeDefined()
        expect(statusMsg.sessionId).toBe('sdk-sess-1')
        expect(statusMsg.status).toBe('idle')
        expect(mockSdkBridge.getSession).toHaveBeenCalledWith('sdk-sess-1')
        expect(mockSdkBridge.subscribe).toHaveBeenCalledWith('sdk-sess-1', expect.any(Function))
      } finally {
        ws.close()
      }
    })

    it('returns error for sdk.attach with unknown session', async () => {
      mockSdkBridge.getSession.mockReturnValue(undefined)
      const ws = await connectAndAuth()
      try {
        const response = await sendAndWaitForResponse(ws, {
          type: 'sdk.attach',
          sessionId: 'nonexistent',
        }, 'error')

        expect(response.type).toBe('error')
        expect(response.code).toBe('INVALID_SESSION_ID')
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
        return () => {}
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

        await new Promise((resolve) => setTimeout(resolve, 100))

        expect(mockSdkBridge.setModel).toHaveBeenCalledWith('sdk-sess-1', 'claude-sonnet-4-5-20250929')
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

        await new Promise((resolve) => setTimeout(resolve, 100))

        expect(mockSdkBridge.setPermissionMode).toHaveBeenCalledWith('sdk-sess-1', 'default')
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
      mockSdkBridge.createSession = vi.fn().mockReturnValue({
        sessionId: 'sdk-sess-1',
        status: 'starting',
        model: 'claude-sonnet-4-5-20250929',
        cwd: '/tmp/project',
        messages: [],
      })

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
