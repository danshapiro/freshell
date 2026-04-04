import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import http from 'http'
import WebSocket from 'ws'
import { WsHandler } from '../../../server/ws-handler.js'
import { TerminalRegistry } from '../../../server/terminal-registry.js'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'

// Module-level mock for loadSessionHistory (the import-level default)
const moduleLoadSessionHistoryMock = vi.hoisted(() => vi.fn())

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}))

vi.mock('../../../server/session-history-loader.js', async () => {
  const actual = await vi.importActual<typeof import('../../../server/session-history-loader.js')>('../../../server/session-history-loader.js')
  return {
    ...actual,
    loadSessionHistory: (...args: Parameters<typeof actual.loadSessionHistory>) => moduleLoadSessionHistoryMock(...args),
  }
})

const TEST_AUTH_TOKEN = 'testtoken-testtoken'

function makeResolvedHistory(options: {
  queryId?: string
  liveSessionId?: string
  timelineSessionId?: string
  revision?: number
  messages: Array<{
    role: 'user' | 'assistant'
    content: Array<{ type: 'text'; text: string }>
    timestamp: string
  }>
}) {
  const queryId = options.queryId ?? options.liveSessionId ?? options.timelineSessionId ?? 'sdk-sess-1'
  return {
    kind: 'resolved' as const,
    queryId,
    liveSessionId: options.liveSessionId,
    timelineSessionId: options.timelineSessionId,
    readiness: options.liveSessionId && options.timelineSessionId
      ? 'merged' as const
      : options.timelineSessionId
        ? 'durable_only' as const
        : 'live_only' as const,
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

function connectAndAuth(server: http.Server): Promise<WebSocket> {
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

    ws.on('open', onOpen)
    ws.on('message', onMessage)
    ws.on('error', onError)
  })
}

function waitForMessage(ws: WebSocket, filter: (data: any) => boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', handler)
      reject(new Error('Timed out waiting for message'))
    }, 5000)
    function handler(raw: WebSocket.RawData) {
      try {
        const data = JSON.parse(raw.toString())
        if (filter(data)) {
          clearTimeout(timeout)
          ws.off('message', handler)
          resolve(data)
        }
      } catch {
        // ignore parse errors
      }
    }
    ws.on('message', handler)
  })
}

describe('WsHandler agent history source DI', () => {
  let originalAuthToken: string | undefined
  let server: http.Server
  let handler: WsHandler
  let registry: TerminalRegistry

  beforeEach(async () => {
    originalAuthToken = process.env.AUTH_TOKEN
    process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
    moduleLoadSessionHistoryMock.mockReset()

    server = http.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    registry = new TerminalRegistry()
  })

  afterEach(async () => {
    if (originalAuthToken === undefined) {
      delete process.env.AUTH_TOKEN
    } else {
      process.env.AUTH_TOKEN = originalAuthToken
    }
    if (handler) handler.close()
    if (registry) registry.shutdown()
    if (server?.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('sdk.create with resumeSessionId calls injected history source', async () => {
    const injectedHistorySource = {
      resolve: vi.fn().mockResolvedValue(makeResolvedHistory({
        queryId: 'sdk-sess-1',
        liveSessionId: 'sdk-sess-1',
        revision: 1,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Hello from injected' }],
            timestamp: '2026-01-01T00:00:01Z',
          },
        ],
      })),
      teardownLiveSession: vi.fn(),
    }

    const mockSdkBridge = {
      createSession: vi.fn().mockReturnValue(makeCreatedSession({
        sessionId: 'sdk-sess-1',
        status: 'starting',
        messages: [],
        model: 'claude-sonnet-4-20250514',
        cwd: '/tmp',
        resumeSessionId: 'resume-sess-1',
        streamingActive: false,
        streamingText: '',
      })),
      subscribe: vi.fn().mockReturnValue({ off: () => {}, replayed: false }),
      getSession: vi.fn(),
      getLiveSession: vi.fn().mockImplementation((sessionId: string) => mockSdkBridge.getSession(sessionId)),
      findSessionByCliSessionId: vi.fn(),
      findLiveSessionByCliSessionId: vi.fn().mockImplementation((timelineSessionId: string) => (
        mockSdkBridge.findSessionByCliSessionId(timelineSessionId)
      )),
      killSession: vi.fn(),
      sendUserMessage: vi.fn(),
      respondPermission: vi.fn(),
      respondQuestion: vi.fn(),
      interrupt: vi.fn(),
      setModel: vi.fn(),
      setPermissionMode: vi.fn(),
      close: vi.fn(),
    }

    handler = new WsHandler(
      server,
      registry,
      undefined, // codingCliManager
      mockSdkBridge as any,
      undefined, // sessionRepairService
      undefined, // handshakeSnapshotProvider
      undefined, // terminalMetaListProvider
      undefined, // tabsRegistryStore
      undefined, // serverInstanceId
      undefined, // layoutStore
      undefined, // extensionManager
      undefined, // codexActivityListProvider
      injectedHistorySource,
    )

    const ws = await connectAndAuth(server)

    ws.send(JSON.stringify({
      type: 'sdk.create',
      requestId: 'req-1',
      cwd: '/tmp',
      resumeSessionId: 'resume-sess-1',
    }))

    await waitForMessage(ws, (d) => d.type === 'sdk.session.snapshot')

    expect(injectedHistorySource.resolve).toHaveBeenCalledWith('sdk-sess-1', expect.objectContaining({
      liveSessionOverride: expect.objectContaining({
        sessionId: 'sdk-sess-1',
        resumeSessionId: 'resume-sess-1',
      }),
    }))
    expect(moduleLoadSessionHistoryMock).not.toHaveBeenCalled()

    ws.close()
  })

  it('sdk.attach for durable session calls injected history source', async () => {
    const injectedHistorySource = {
      resolve: vi.fn().mockResolvedValue(makeResolvedHistory({
        timelineSessionId: '01234567-89ab-cdef-0123-456789abcdef',
        revision: 1,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Historical message' }],
            timestamp: '2026-01-01T00:00:01Z',
          },
        ],
      })),
      teardownLiveSession: vi.fn(),
    }

    const mockSdkBridge = {
      createSession: vi.fn(),
      subscribe: vi.fn(),
      getSession: vi.fn().mockReturnValue(null),
      getLiveSession: vi.fn().mockReturnValue(null),
      findSessionByCliSessionId: vi.fn(),
      findLiveSessionByCliSessionId: vi.fn(),
      killSession: vi.fn(),
      sendUserMessage: vi.fn(),
      respondPermission: vi.fn(),
      respondQuestion: vi.fn(),
      interrupt: vi.fn(),
      setModel: vi.fn(),
      setPermissionMode: vi.fn(),
      close: vi.fn(),
    }

    handler = new WsHandler(
      server,
      registry,
      undefined,
      mockSdkBridge as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      injectedHistorySource,
    )

    const ws = await connectAndAuth(server)

    const sessionId = '01234567-89ab-cdef-0123-456789abcdef'

    ws.send(JSON.stringify({
      type: 'sdk.attach',
      sessionId,
    }))

    await waitForMessage(ws, (d) => d.type === 'sdk.session.snapshot')

    expect(injectedHistorySource.resolve).toHaveBeenCalledWith(sessionId)
    expect(moduleLoadSessionHistoryMock).not.toHaveBeenCalled()

    ws.close()
  })

  it('multiple attaches to same session: injected history source resolves per attach', async () => {
    const injectedHistorySource = {
      resolve: vi.fn().mockResolvedValue(makeResolvedHistory({
        timelineSessionId: '01234567-89ab-cdef-0123-456789abcdef',
        revision: 1,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Message' }],
            timestamp: '2026-01-01T00:00:01Z',
          },
        ],
      })),
      teardownLiveSession: vi.fn(),
    }

    const mockSdkBridge = {
      createSession: vi.fn(),
      subscribe: vi.fn(),
      getSession: vi.fn().mockReturnValue(null),
      getLiveSession: vi.fn().mockReturnValue(null),
      findSessionByCliSessionId: vi.fn(),
      findLiveSessionByCliSessionId: vi.fn(),
      killSession: vi.fn(),
      sendUserMessage: vi.fn(),
      respondPermission: vi.fn(),
      respondQuestion: vi.fn(),
      interrupt: vi.fn(),
      setModel: vi.fn(),
      setPermissionMode: vi.fn(),
      close: vi.fn(),
    }

    handler = new WsHandler(
      server,
      registry,
      undefined,
      mockSdkBridge as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      injectedHistorySource,
    )

    const ws = await connectAndAuth(server)
    const sessionId = '01234567-89ab-cdef-0123-456789abcdef'

    ws.send(JSON.stringify({ type: 'sdk.attach', sessionId }))
    await waitForMessage(ws, (d) => d.type === 'sdk.session.snapshot')

    ws.send(JSON.stringify({ type: 'sdk.attach', sessionId }))
    await waitForMessage(ws, (d) => d.type === 'sdk.session.snapshot')

    expect(injectedHistorySource.resolve).toHaveBeenCalledTimes(2)
    expect(moduleLoadSessionHistoryMock).not.toHaveBeenCalled()

    ws.close()
  })

  it('sdk.create without an injected history source falls back through the module-backed shared history source', async () => {
    moduleLoadSessionHistoryMock.mockResolvedValue([
      {
        role: 'user',
        content: [{ type: 'text', text: 'Hello from module loader' }],
        timestamp: '2026-01-01T00:00:01Z',
      },
    ])

    const mockSdkBridge = {
      getSession: vi.fn().mockImplementation((sessionId: string) => (
        sessionId === 'sdk-sess-module'
          ? {
              sessionId: 'sdk-sess-module',
              status: 'starting',
              messages: [],
              model: 'claude-sonnet-4-20250514',
              cwd: '/tmp',
              resumeSessionId: '01234567-89ab-cdef-0123-456789abcdef',
              streamingActive: false,
              streamingText: '',
              pendingPermissions: new Map(),
              pendingQuestions: new Map(),
            }
          : undefined
      )),
      getLiveSession: vi.fn().mockImplementation((sessionId: string) => (
        mockSdkBridge.getSession(sessionId)
      )),
      createSession: vi.fn().mockReturnValue(makeCreatedSession({
        sessionId: 'sdk-sess-module',
        status: 'starting',
        messages: [],
        model: 'claude-sonnet-4-20250514',
        cwd: '/tmp',
        resumeSessionId: '01234567-89ab-cdef-0123-456789abcdef',
        streamingActive: false,
        streamingText: '',
      })),
      subscribe: vi.fn().mockReturnValue({ off: () => {}, replayed: false }),
      findSessionByCliSessionId: vi.fn(),
      findLiveSessionByCliSessionId: vi.fn().mockImplementation((timelineSessionId: string) => (
        mockSdkBridge.findSessionByCliSessionId(timelineSessionId)
      )),
      killSession: vi.fn(),
      sendUserMessage: vi.fn(),
      respondPermission: vi.fn(),
      respondQuestion: vi.fn(),
      interrupt: vi.fn(),
      setModel: vi.fn(),
      setPermissionMode: vi.fn(),
      close: vi.fn(),
    }

    handler = new WsHandler(
      server,
      registry,
      undefined,
      mockSdkBridge as any,
    )

    const ws = await connectAndAuth(server)

    ws.send(JSON.stringify({
      type: 'sdk.create',
      requestId: 'req-module',
      cwd: '/tmp',
      resumeSessionId: '01234567-89ab-cdef-0123-456789abcdef',
    }))

    await waitForMessage(ws, (d) => d.type === 'sdk.session.snapshot')

    expect(moduleLoadSessionHistoryMock).toHaveBeenCalledWith('01234567-89ab-cdef-0123-456789abcdef')

    ws.close()
  })
})
