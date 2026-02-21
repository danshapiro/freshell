// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import http from 'http'
import WebSocket from 'ws'
import express, { type Express } from 'express'
import request from 'supertest'
import { detectPlatform, detectAvailableClis } from '../../../server/platform.js'
import { createPlatformRouter } from '../../../server/platform-router'

const TEST_TIMEOUT_MS = 30_000
const HOOK_TIMEOUT_MS = 30_000
vi.setConfig({ testTimeout: TEST_TIMEOUT_MS, hookTimeout: HOOK_TIMEOUT_MS })

const { mockPushRecentDirectory } = vi.hoisted(() => ({
  mockPushRecentDirectory: vi.fn().mockResolvedValue(undefined),
}))

// Mock the config-store module before importing ws-handler
vi.mock('../../../server/config-store', () => ({
  configStore: {
    snapshot: vi.fn().mockResolvedValue({
      version: 1,
      settings: {},
      sessionOverrides: {},
      terminalOverrides: {},
      projectColors: {},
    }),
    pushRecentDirectory: mockPushRecentDirectory,
  },
}))

const TEST_AUTH_TOKEN = 'test-auth-token-pane-picker'

class FakeBuffer {
  private s = ''
  append(t: string) { this.s += t }
  snapshot() { return this.s }
}

class FakeRegistry {
  records = new Map<string, any>()

  create(opts: any) {
    const terminalId = 'term_' + Math.random().toString(16).slice(2)
    const rec = {
      terminalId,
      createdAt: Date.now(),
      buffer: new FakeBuffer(),
      title: opts.mode === 'shell' ? 'Shell' : opts.mode.charAt(0).toUpperCase() + opts.mode.slice(1),
      mode: opts.mode || 'shell',
      shell: opts.shell || 'system',
      cwd: opts.cwd,
      status: 'running',
      resumeSessionId: opts.resumeSessionId,
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

  finishAttachSnapshot(_terminalId: string, _ws: any) {}

  detach(terminalId: string, ws: any) {
    const rec = this.records.get(terminalId)
    if (!rec) return false
    rec.clients.delete(ws)
    return true
  }

  input(terminalId: string, _data: string) {
    return this.records.has(terminalId)
  }

  resize(terminalId: string, _cols: number, _rows: number) {
    return this.records.has(terminalId)
  }

  kill(terminalId: string) {
    const rec = this.records.get(terminalId)
    if (!rec) return false
    this.records.delete(terminalId)
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

  findRunningClaudeTerminalBySession(_sessionId: string) {
    return undefined
  }
}

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

describe('Pane Picker CLI Integration', () => {
  describe('GET /api/platform with availableClis', () => {
    let app: Express

    beforeAll(() => {
      process.env.AUTH_TOKEN = TEST_AUTH_TOKEN

      app = express()
      app.use(express.json())

      app.use('/api', (req, res, next) => {
        if (req.path === '/health') return next()
        const token = process.env.AUTH_TOKEN
        if (!token) return res.status(500).json({ error: 'Server misconfigured' })
        const provided = req.headers['x-auth-token'] as string | undefined
        if (!provided || provided !== token) {
          return res.status(401).json({ error: 'Unauthorized' })
        }
        next()
      })

      // Mount real platform router
      app.use('/api', createPlatformRouter({
        detectPlatform,
        detectAvailableClis,
        detectHostName: vi.fn().mockResolvedValue('test-host'),
        checkForUpdate: vi.fn().mockResolvedValue(null),
        appVersion: '0.0.0-test',
      }))
    })

    afterAll(() => {
      delete process.env.AUTH_TOKEN
    })

    it('returns availableClis object alongside platform', async () => {
      const res = await request(app)
        .get('/api/platform')
        .set('x-auth-token', TEST_AUTH_TOKEN)

      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('platform')
      expect(res.body).toHaveProperty('availableClis')
      expect(typeof res.body.availableClis).toBe('object')
    })

    it('availableClis contains boolean values for known CLIs', async () => {
      const res = await request(app)
        .get('/api/platform')
        .set('x-auth-token', TEST_AUTH_TOKEN)

      const { availableClis } = res.body
      expect(typeof availableClis.claude).toBe('boolean')
      expect(typeof availableClis.codex).toBe('boolean')
    })

    it('availableClis includes all expected CLI names', async () => {
      const res = await request(app)
        .get('/api/platform')
        .set('x-auth-token', TEST_AUTH_TOKEN)

      const { availableClis } = res.body
      const expectedClis = ['claude', 'codex', 'opencode', 'gemini', 'kimi']
      for (const cli of expectedClis) {
        expect(availableClis).toHaveProperty(cli)
        expect(typeof availableClis[cli]).toBe('boolean')
      }
    })
  })

  describe('WebSocket terminal.create with mode: claude', () => {
    let server: http.Server | undefined
    let port: number
    let WsHandler: any
    let registry: FakeRegistry

    beforeAll(async () => {
      process.env.NODE_ENV = 'test'
      process.env.AUTH_TOKEN = TEST_AUTH_TOKEN
      process.env.HELLO_TIMEOUT_MS = '100'
      process.env.TERMINAL_CREATE_RATE_LIMIT = '10'
      process.env.TERMINAL_CREATE_RATE_WINDOW_MS = '10000'

      ;({ WsHandler } = await import('../../../server/ws-handler'))
      server = http.createServer((_req, res) => {
        res.statusCode = 404
        res.end()
      })
      registry = new FakeRegistry()
      new WsHandler(server, registry as any)
      const info = await listen(server)
      port = info.port
    }, HOOK_TIMEOUT_MS)

    beforeEach(() => {
      registry.records.clear()
      mockPushRecentDirectory.mockClear()
    })

    afterAll(async () => {
      if (!server) return
      await new Promise<void>((resolve) => server!.close(() => resolve()))
    }, HOOK_TIMEOUT_MS)

    async function connectAndAuth(): Promise<WebSocket> {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      ws.send(JSON.stringify({ type: 'hello', token: TEST_AUTH_TOKEN }))

      await new Promise<void>((resolve) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString())
          if (msg.type === 'ready') resolve()
        })
      })
      return ws
    }

    it('creates a terminal with mode: claude', async () => {
      const ws = await connectAndAuth()

      const requestId = 'req-claude-1'
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'claude',
      }))

      const created = await new Promise<any>((resolve) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString())
          if (msg.type === 'terminal.created' && msg.requestId === requestId) resolve(msg)
        })
      })

      expect(created.terminalId).toMatch(/^term_/)
      expect(created.requestId).toBe(requestId)

      // Verify the registry recorded the terminal with mode: claude
      const rec = registry.get(created.terminalId)
      expect(rec).not.toBeNull()
      expect(rec.mode).toBe('claude')

      await closeWebSocket(ws)
    })

    it('creates a terminal with mode: codex', async () => {
      const ws = await connectAndAuth()

      const requestId = 'req-codex-1'
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'codex',
      }))

      const created = await new Promise<any>((resolve) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString())
          if (msg.type === 'terminal.created' && msg.requestId === requestId) resolve(msg)
        })
      })

      expect(created.terminalId).toMatch(/^term_/)
      const rec = registry.get(created.terminalId)
      expect(rec).not.toBeNull()
      expect(rec.mode).toBe('codex')

      await closeWebSocket(ws)
    })

    it('passes cwd through to registry on terminal.create', async () => {
      const ws = await connectAndAuth()

      const requestId = 'req-claude-cwd'
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'claude',
        cwd: '/tmp/test-project',
      }))

      const created = await new Promise<any>((resolve) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString())
          if (msg.type === 'terminal.created' && msg.requestId === requestId) resolve(msg)
        })
      })

      const rec = registry.get(created.terminalId)
      expect(rec).not.toBeNull()
      expect(rec.cwd).toBe('/tmp/test-project')

      await closeWebSocket(ws)
    })

    it('records explicit cwd in recent directories for coding CLI terminal create', async () => {
      const ws = await connectAndAuth()

      const requestId = 'req-claude-recent-dir'
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'claude',
        cwd: '/tmp/recent-dir',
      }))

      await new Promise<void>((resolve) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString())
          if (msg.type === 'terminal.created' && msg.requestId === requestId) resolve()
        })
      })

      expect(mockPushRecentDirectory).toHaveBeenCalledWith('/tmp/recent-dir')

      await closeWebSocket(ws)
    })
  })
})
