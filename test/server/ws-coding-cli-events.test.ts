import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import http from 'http'
import express from 'express'
import WebSocket from 'ws'
import { WsHandler } from '../../server/ws-handler'
import { TerminalRegistry } from '../../server/terminal-registry'
import { CodingCliSessionManager } from '../../server/coding-cli/session-manager'
import { claudeProvider } from '../../server/coding-cli/providers/claude'
import { configStore } from '../../server/config-store'
import { EventEmitter } from 'events'

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}))

// Set auth token for tests
process.env.AUTH_TOKEN = 'test-token'

// Mock logger
vi.mock('../../server/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

vi.mock('../../server/config-store', () => ({
  configStore: {
    snapshot: vi.fn(),
  },
}))

describe('WebSocket Coding CLI Events', () => {
  let server: http.Server
  let port: number
  let wsHandler: WsHandler
  let registry: TerminalRegistry
  let cliManager: CodingCliSessionManager

  beforeEach(async () => {
    vi.mocked(configStore.snapshot).mockResolvedValue({
      settings: {
        codingCli: {
          enabledProviders: ['claude'],
          providers: {},
        },
      },
    })
    const app = express()
    server = http.createServer(app)
    registry = new TerminalRegistry()
    cliManager = new CodingCliSessionManager([claudeProvider])
    wsHandler = new WsHandler(server, registry, cliManager)

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as any).port
        resolve()
      })
    })
  })

  afterEach(async () => {
    cliManager.shutdown()
    registry.shutdown()
    wsHandler.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  function createAuthenticatedWs(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'hello', token: 'test-token' }))
      })
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'ready') resolve(ws)
        if (msg.type === 'error' && !msg.requestId) reject(new Error(msg.message))
      })
      ws.on('error', reject)
      setTimeout(() => reject(new Error('Timeout')), 5000)
    })
  }

  it('validates codingcli.create message schema', async () => {
    const ws = await createAuthenticatedWs()

    const responsePromise = new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'error' && msg.code === 'INVALID_MESSAGE') resolve(msg)
      })
    })

    // Missing required prompt field
    ws.send(
      JSON.stringify({
        type: 'codingcli.create',
        requestId: 'req-123',
        provider: 'claude',
      })
    )

    const response = await responsePromise
    expect(response.type).toBe('error')
    expect(response.code).toBe('INVALID_MESSAGE')

    ws.close()
  })

  it('rejects codingcli.create when provider disabled', async () => {
    vi.mocked(configStore.snapshot).mockResolvedValueOnce({
      settings: {
        codingCli: {
          enabledProviders: [],
          providers: {},
        },
      },
    })

    const ws = await createAuthenticatedWs()

    const responsePromise = new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'error' && msg.requestId === 'req-disabled') resolve(msg)
      })
    })

    ws.send(
      JSON.stringify({
        type: 'codingcli.create',
        requestId: 'req-disabled',
        provider: 'claude',
        prompt: 'test',
      })
    )

    const response = await responsePromise
    expect(response.type).toBe('error')
    expect(response.code).toBe('INVALID_MESSAGE')

    ws.close()
  })

  it('rejects codingcli.create when provider is unsupported', async () => {
    const ws = await createAuthenticatedWs()

    const responsePromise = new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'error' && msg.requestId === 'req-unsupported') resolve(msg)
      })
    })

    ws.send(
      JSON.stringify({
        type: 'codingcli.create',
        requestId: 'req-unsupported',
        provider: 'gemini',
        prompt: 'test',
      })
    )

    const response = await responsePromise
    expect(response.type).toBe('error')
    expect(response.code).toBe('INVALID_MESSAGE')
    expect(response.message).toContain('not supported')

    ws.close()
  })

  it('handles codingcli.input for unknown session', async () => {
    const ws = await createAuthenticatedWs()

    const responsePromise = new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'error') resolve(msg)
      })
    })

    ws.send(
      JSON.stringify({
        type: 'codingcli.input',
        sessionId: 'unknown-session',
        data: 'test input',
      })
    )

    const response = await responsePromise
    expect(response.type).toBe('error')

    ws.close()
  })

  it('handles codingcli.kill for unknown session', async () => {
    const ws = await createAuthenticatedWs()

    const responsePromise = new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'codingcli.killed') resolve(msg)
      })
    })

    ws.send(
      JSON.stringify({
        type: 'codingcli.kill',
        sessionId: 'unknown-session',
      })
    )

    const response = await responsePromise
    expect(response.type).toBe('codingcli.killed')
    expect(response.success).toBe(false)

    ws.close()
  })

  it('applies provider defaults from settings', async () => {
    const createMock = vi.fn()
    class FakeSession extends EventEmitter {
      id = 'session-1'
      provider = { name: 'claude' }
    }

    const fakeManager = {
      create: (...args: any[]) => {
        createMock(...args)
        return new FakeSession()
      },
      hasProvider: (name: string) => name === 'claude',
      get: vi.fn(),
      remove: vi.fn(),
    } as unknown as CodingCliSessionManager

    wsHandler.close()
    wsHandler = new WsHandler(server, registry, fakeManager)

    vi.mocked(configStore.snapshot).mockResolvedValueOnce({
      settings: {
        codingCli: {
          enabledProviders: ['claude'],
          providers: {
            claude: {
              model: 'claude-test',
              permissionMode: 'plan',
              maxTurns: 3,
            },
          },
        },
      },
    })

    const ws = await createAuthenticatedWs()

    const createdPromise = new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'codingcli.created') resolve()
      })
    })

    ws.send(
      JSON.stringify({
        type: 'codingcli.create',
        requestId: 'req-defaults',
        provider: 'claude',
        prompt: 'test',
      })
    )

    await createdPromise

    expect(createMock).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({
        prompt: 'test',
        model: 'claude-test',
        permissionMode: 'plan',
        maxTurns: 3,
      })
    )

    ws.close()
  })

  it('detaches coding cli listeners on socket close', async () => {
    const fakeSession = Object.assign(new EventEmitter(), {
      id: 'fake-session-1',
      provider: { name: 'claude' },
      sendInput: vi.fn(),
      kill: vi.fn(),
    })

    const createSpy = vi.spyOn(cliManager, 'create').mockReturnValue(fakeSession as any)

    const ws = {
      bufferedAmount: 0,
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    } as any

    const state = {
      authenticated: true,
      attachedTerminalIds: new Set<string>(),
      createdByRequestId: new Map<string, string>(),
      codingCliSessions: new Set<string>(),
      codingCliSubscriptions: new Map<string, () => void>(),
      interestedSessions: new Set<string>(),
    }

    await (wsHandler as any).onMessage(
      ws,
      state,
      Buffer.from(JSON.stringify({ type: 'codingcli.create', requestId: 'req-1', provider: 'claude', prompt: 'hello' }))
    )

    expect(fakeSession.listenerCount('event')).toBe(1)
    expect(fakeSession.listenerCount('exit')).toBe(1)
    expect(fakeSession.listenerCount('stderr')).toBe(1)

    ;(wsHandler as any).onClose(ws, state)

    expect(fakeSession.listenerCount('event')).toBe(0)
    expect(fakeSession.listenerCount('exit')).toBe(0)
    expect(fakeSession.listenerCount('stderr')).toBe(0)

    createSpy.mockRestore()
  })
})

describe('WebSocket Coding CLI Events - Without Manager', () => {
  let server: http.Server
  let port: number
  let wsHandler: WsHandler
  let registry: TerminalRegistry

  beforeEach(async () => {
    const app = express()
    server = http.createServer(app)
    registry = new TerminalRegistry()
    // No manager - tests the error case
    wsHandler = new WsHandler(server, registry)

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as any).port
        resolve()
      })
    })
  })

  afterEach(async () => {
    registry.shutdown()
    wsHandler.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  function createAuthenticatedWs(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'hello', token: 'test-token' }))
      })
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'ready') resolve(ws)
        if (msg.type === 'error' && !msg.requestId) reject(new Error(msg.message))
      })
      ws.on('error', reject)
      setTimeout(() => reject(new Error('Timeout')), 5000)
    })
  }

  it('rejects codingcli.create when manager not provided', async () => {
    const ws = await createAuthenticatedWs()

    const responsePromise = new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'error' && msg.requestId === 'req-123') resolve(msg)
      })
    })

    ws.send(
      JSON.stringify({
        type: 'codingcli.create',
        requestId: 'req-123',
        provider: 'claude',
        prompt: 'test',
      })
    )

    const response = await responsePromise
    expect(response.type).toBe('error')
    expect(response.code).toBe('INTERNAL_ERROR')
    expect(response.message).toContain('not enabled')

    ws.close()
  })
})
