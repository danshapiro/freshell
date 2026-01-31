import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest'
import http from 'http'
import express from 'express'
import WebSocket from 'ws'
import { EventEmitter } from 'events'
import { WsHandler } from '../../server/ws-handler'
import { TerminalRegistry } from '../../server/terminal-registry'
import { ClaudeSessionManager } from '../../server/claude-session'

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

describe('WebSocket Claude Events', () => {
  let server: http.Server
  let port: number
  let wsHandler: WsHandler
  let registry: TerminalRegistry
  let claudeManager: ClaudeSessionManager

  beforeEach(async () => {
    const app = express()
    server = http.createServer(app)
    registry = new TerminalRegistry()
    claudeManager = new ClaudeSessionManager()
    wsHandler = new WsHandler(server, registry, claudeManager)

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as any).port
        resolve()
      })
    })
  })

  afterEach(async () => {
    claudeManager.shutdown()
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

  it('validates claude.create message schema', async () => {
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
        type: 'claude.create',
        requestId: 'req-123',
        // no prompt
      })
    )

    const response = await responsePromise
    expect(response.type).toBe('error')
    expect(response.code).toBe('INVALID_MESSAGE')

    ws.close()
  })

  it('handles claude.input for unknown session', async () => {
    const ws = await createAuthenticatedWs()

    const responsePromise = new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'error') resolve(msg)
      })
    })

    ws.send(
      JSON.stringify({
        type: 'claude.input',
        sessionId: 'unknown-session',
        data: 'test input',
      })
    )

    const response = await responsePromise
    expect(response.type).toBe('error')

    ws.close()
  })

  it('handles claude.kill for unknown session', async () => {
    const ws = await createAuthenticatedWs()

    const responsePromise = new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'claude.killed') resolve(msg)
      })
    })

    ws.send(
      JSON.stringify({
        type: 'claude.kill',
        sessionId: 'unknown-session',
      })
    )

    const response = await responsePromise
    expect(response.type).toBe('claude.killed')
    expect(response.success).toBe(false)

    ws.close()
  })

  it('detaches Claude listeners on socket close', async () => {
    const fakeSession = Object.assign(new EventEmitter(), {
      id: 'fake-session-1',
      sendInput: vi.fn(),
      kill: vi.fn(),
    })

    const createSpy = vi.spyOn(claudeManager, 'create').mockReturnValue(fakeSession as any)

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
      claudeSessions: new Set<string>(),
      claudeSubscriptions: new Map<string, () => void>(),
      interestedSessions: new Set<string>(),
    }

    await (wsHandler as any).onMessage(
      ws,
      state,
      Buffer.from(JSON.stringify({ type: 'claude.create', requestId: 'req-1', prompt: 'hello' }))
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

describe('WebSocket Claude Events - Without ClaudeManager', () => {
  let server: http.Server
  let port: number
  let wsHandler: WsHandler
  let registry: TerminalRegistry

  beforeEach(async () => {
    const app = express()
    server = http.createServer(app)
    registry = new TerminalRegistry()
    // No claudeManager - tests the error case
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

  it('rejects claude.create when claudeManager not provided', async () => {
    const ws = await createAuthenticatedWs()

    const responsePromise = new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'error' && msg.requestId === 'req-123') resolve(msg)
      })
    })

    ws.send(
      JSON.stringify({
        type: 'claude.create',
        requestId: 'req-123',
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
