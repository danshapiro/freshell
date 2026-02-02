import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import http from 'http'
import WebSocket from 'ws'
import { EventEmitter } from 'events'
import type { SessionScanResult } from '../../server/session-scanner/types.js'

const HOOK_TIMEOUT_MS = 30000

vi.mock('../../server/config-store', () => ({
  configStore: {
    snapshot: vi.fn().mockResolvedValue({
      version: 1,
      settings: {},
      sessionOverrides: {},
      terminalOverrides: {},
      projectColors: {},
    }),
  },
}))

function listen(server: http.Server, timeoutMs = HOOK_TIMEOUT_MS): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.off('error', onError)
      reject(new Error('Timed out waiting for server to listen'))
    }, timeoutMs)

    const onError = (err: Error) => {
      clearTimeout(timeout)
      reject(err)
    }

    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      clearTimeout(timeout)
      server.off('error', onError)
      const addr = server.address()
      if (typeof addr === 'object' && addr) resolve({ port: addr.port })
    })
  })
}

function waitForMessage(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 1500): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', handler)
      reject(new Error('Timeout waiting for message'))
    }, timeoutMs)

    const handler = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString())
      if (predicate(msg)) {
        clearTimeout(timeout)
        ws.off('message', handler)
        resolve(msg)
      }
    }
    ws.on('message', handler)
  })
}

function closeWebSocket(ws: WebSocket, timeoutMs = 500): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve()
      return
    }

    const timeout = setTimeout(() => {
      ws.terminate()
      resolve()
    }, timeoutMs)

    ws.once('close', () => {
      clearTimeout(timeout)
      resolve()
    })
    ws.close()
  })
}

class FakeBuffer {
  private s = ''
  append(t: string) { this.s += t }
  snapshot() { return this.s }
}

class FakeRegistry {
  records = new Map<string, any>()
  lastCreateOpts: any = null

  create(opts: any) {
    this.lastCreateOpts = opts
    const terminalId = 'term_' + Math.random().toString(16).slice(2)
    const rec = {
      terminalId,
      createdAt: Date.now(),
      buffer: new FakeBuffer(),
      title: opts.mode === 'claude' ? 'Claude' : 'Shell',
      mode: opts.mode || 'shell',
      shell: opts.shell || 'system',
      clients: new Set(),
    }
    this.records.set(terminalId, rec)
    return rec
  }

  get(terminalId: string) {
    return this.records.get(terminalId) || null
  }

  attach(terminalId: string, ws: any) {
    const rec = this.records.get(terminalId)
    if (!rec) return null
    rec.clients.add(ws)
    return rec
  }

  detach(terminalId: string, ws: any) {
    const rec = this.records.get(terminalId)
    if (!rec) return false
    rec.clients.delete(ws)
    return true
  }

  list() {
    return Array.from(this.records.values()).map((r) => ({
      terminalId: r.terminalId,
      title: r.title,
      mode: r.mode,
      createdAt: r.createdAt,
      lastActivityAt: r.createdAt,
      status: 'running',
      hasClients: r.clients.size > 0,
    }))
  }
}

class FakeSessionRepairService extends EventEmitter {
  waitForSessionCalls: string[] = []
  result: SessionScanResult | undefined

  prioritizeSessions() {}

  getResult(_sessionId: string): SessionScanResult | undefined {
    return this.result
  }

  waitForSession(sessionId: string): Promise<SessionScanResult> {
    this.waitForSessionCalls.push(sessionId)
    return new Promise<SessionScanResult>(() => {})
  }
}

describe('terminal.create session repair wait', () => {
  let server: http.Server | undefined
  let port: number
  let sessionRepairService: FakeSessionRepairService
  let registry: FakeRegistry

  beforeAll(async () => {
    process.env.NODE_ENV = 'test'
    process.env.AUTH_TOKEN = 'testtoken-testtoken'
    process.env.HELLO_TIMEOUT_MS = '100'

    const { WsHandler } = await import('../../server/ws-handler')
    server = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end()
    })

    sessionRepairService = new FakeSessionRepairService()
    registry = new FakeRegistry()
    new WsHandler(server, registry as any, undefined, sessionRepairService as any)

    const info = await listen(server)
    port = info.port
  }, HOOK_TIMEOUT_MS)

  beforeEach(() => {
    sessionRepairService.waitForSessionCalls = []
    sessionRepairService.result = undefined
    registry.records.clear()
    registry.lastCreateOpts = null
  })

  afterAll(async () => {
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }, HOOK_TIMEOUT_MS)

  it('does not block terminal.create while session repair runs', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))
      await waitForMessage(ws, (m) => m.type === 'ready')

      const requestId = 'resume-1'
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'claude',
        resumeSessionId: 'session-1',
      }))

      const created = await waitForMessage(
        ws,
        (m) => m.type === 'terminal.created' && m.requestId === requestId,
      )

      expect(created.terminalId).toMatch(/^term_/)
      expect(sessionRepairService.waitForSessionCalls).toContain('session-1')
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('drops resumeSessionId when cached result is missing', async () => {
    sessionRepairService.result = {
      sessionId: 'session-1',
      filePath: '/tmp/session-1.jsonl',
      status: 'missing',
      chainDepth: 0,
      orphanCount: 0,
      fileSize: 0,
      messageCount: 0,
    }

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))
      await waitForMessage(ws, (m) => m.type === 'ready')

      const requestId = 'resume-missing-1'
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'claude',
        resumeSessionId: 'session-1',
      }))

      await waitForMessage(
        ws,
        (m) => m.type === 'terminal.created' && m.requestId === requestId,
      )

      expect(registry.lastCreateOpts?.resumeSessionId).toBeUndefined()
      expect(sessionRepairService.waitForSessionCalls).not.toContain('session-1')
    } finally {
      await closeWebSocket(ws)
      sessionRepairService.result = undefined
    }
  })
})
