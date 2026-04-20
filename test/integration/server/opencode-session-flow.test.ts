import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'http'
import { EventEmitter } from 'events'
import WebSocket from 'ws'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol.js'
import { OPENCODE_HEALTH_POLL_MS } from '../../../server/coding-cli/opencode-activity-tracker.js'
import { wireOpencodeActivityTracker } from '../../../server/coding-cli/opencode-activity-wiring.js'

const HOOK_TIMEOUT_MS = 30_000
const OPENCODE_SESSION_ID = 'opencode-session-123'
const DEFAULT_CONFIG_SNAPSHOT = vi.hoisted(() => ({
  version: 1,
  settings: {
    codingCli: {
      enabledProviders: ['opencode'],
      providers: {
        opencode: {},
      },
    },
  },
  sessionOverrides: {},
  terminalOverrides: {},
  projectColors: {},
}))

vi.mock('../../../server/config-store.js', () => ({
  configStore: {
    snapshot: vi.fn().mockResolvedValue(DEFAULT_CONFIG_SNAPSHOT),
  },
}))

function listen(server: http.Server, timeoutMs = HOOK_TIMEOUT_MS): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.off('error', onError)
      reject(new Error('Timed out waiting for server to listen'))
    }, timeoutMs)

    const onError = (error: Error) => {
      clearTimeout(timeout)
      reject(error)
    }

    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      clearTimeout(timeout)
      server.off('error', onError)
      const address = server.address()
      if (typeof address === 'object' && address) {
        resolve({ port: address.port })
      }
    })
  })
}

function waitForMessage(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 5_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      ws.off('message', handler)
      ws.off('error', onError)
      ws.off('close', onClose)
    }

    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for WebSocket message'))
    }, timeoutMs)

    const handler = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString())
      if (!predicate(msg)) return
      cleanup()
      resolve(msg)
    }

    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }

    const onClose = () => {
      cleanup()
      reject(new Error('Socket closed before the expected message arrived'))
    }

    ws.on('message', handler)
    ws.on('error', onError)
    ws.on('close', onClose)
  })
}

async function createAuthenticatedWs(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })

  ws.send(JSON.stringify({
    type: 'hello',
    token: process.env.AUTH_TOKEN || 'testtoken-testtoken',
    protocolVersion: WS_PROTOCOL_VERSION,
  }))

  await waitForMessage(ws, (msg) => msg.type === 'ready')
  return ws
}

async function closeWebSocket(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve()
      return
    }

    const timeout = setTimeout(() => {
      cleanup()
      resolve()
    }, 1_000)

    const cleanup = () => {
      clearTimeout(timeout)
      ws.off('close', onClose)
      ws.off('error', onClose)
    }

    const onClose = () => {
      cleanup()
      resolve()
    }

    ws.on('close', onClose)
    ws.on('error', onClose)
    ws.close()
  })
}

function createJsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function createSseResponse(events: unknown[]) {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      controller.close()
    },
  }), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

class FakeBuffer {
  snapshot() {
    return ''
  }
}

class FakeRegistry extends EventEmitter {
  records = new Map<string, any>()
  lastCreateOpts: any = null
  createCallCount = 0
  bindCalls: Array<{ terminalId: string; provider: string; sessionId: string; reason: string }> = []

  create(opts: any) {
    this.lastCreateOpts = opts
    this.createCallCount += 1
    const terminalId = `term-opencode-${this.createCallCount}`
    const record = {
      terminalId,
      createdAt: Date.now(),
      buffer: new FakeBuffer(),
      title: 'OpenCode',
      mode: opts.mode,
      shell: opts.shell || 'system',
      status: 'running',
      cols: 80,
      rows: 24,
      resumeSessionId: opts.resumeSessionId,
      opencodeServer: opts.providerSettings?.opencodeServer,
      clients: new Set<WebSocket>(),
    }
    this.records.set(terminalId, record)
    this.emit('terminal.created', record)
    return record
  }

  get(terminalId: string) {
    return this.records.get(terminalId) || null
  }

  attach(terminalId: string, ws: WebSocket) {
    const record = this.records.get(terminalId)
    if (!record) return null
    record.clients.add(ws)
    return record
  }

  finishAttachSnapshot() {}

  resize(terminalId: string, cols: number, rows: number) {
    const record = this.records.get(terminalId)
    if (!record) return false
    record.cols = cols
    record.rows = rows
    return true
  }

  detach(terminalId: string, ws: WebSocket) {
    const record = this.records.get(terminalId)
    if (!record) return false
    record.clients.delete(ws)
    return true
  }

  list() {
    return Array.from(this.records.values())
  }

  findRunningTerminalBySession(mode: string, sessionId: string) {
    for (const record of this.records.values()) {
      if (record.mode === mode && record.status === 'running' && record.resumeSessionId === sessionId) {
        return record
      }
    }
    return undefined
  }

  findRunningClaudeTerminalBySession(_sessionId: string) {
    return undefined
  }

  getCanonicalRunningTerminalBySession(mode: string, sessionId: string) {
    return this.findRunningTerminalBySession(mode, sessionId)
  }

  repairLegacySessionOwners(mode: string, sessionId: string) {
    const canonical = this.getCanonicalRunningTerminalBySession(mode, sessionId)
    return {
      repaired: false,
      canonicalTerminalId: canonical?.terminalId,
      clearedTerminalIds: [] as string[],
    }
  }

  bindSession(terminalId: string, provider: string, sessionId: string, reason = 'association') {
    const record = this.records.get(terminalId)
    if (!record) {
      return { ok: false, reason: 'terminal_missing' as const }
    }
    record.resumeSessionId = sessionId
    this.bindCalls.push({ terminalId, provider, sessionId, reason })
    this.emit('terminal.session.bound', { terminalId, provider, sessionId, reason })
    return { ok: true as const, terminalId, sessionId }
  }

  rebindSession(terminalId: string, provider: string, sessionId: string, reason = 'association') {
    return this.bindSession(terminalId, provider, sessionId, reason)
  }
}

describe('opencode session flow (integration)', () => {
  let server: http.Server | undefined
  let port: number
  let registry: FakeRegistry
  let originalNodeEnv: string | undefined
  let originalAuthToken: string | undefined
  let originalHelloTimeoutMs: string | undefined

  beforeEach(async () => {
    originalNodeEnv = process.env.NODE_ENV
    originalAuthToken = process.env.AUTH_TOKEN
    originalHelloTimeoutMs = process.env.HELLO_TIMEOUT_MS
    process.env.NODE_ENV = 'test'
    process.env.AUTH_TOKEN = 'testtoken-testtoken'
    process.env.HELLO_TIMEOUT_MS = '500'

    vi.resetModules()
    const { WsHandler } = await import('../../../server/ws-handler.js')

    server = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end()
    })

    registry = new FakeRegistry()
    new WsHandler(server, registry as any)

    const info = await listen(server)
    port = info.port
    registry.records.clear()
    registry.lastCreateOpts = null
    registry.createCallCount = 0
  }, HOOK_TIMEOUT_MS)

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()))
      server = undefined
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = originalNodeEnv
    }
    if (originalAuthToken === undefined) {
      delete process.env.AUTH_TOKEN
    } else {
      process.env.AUTH_TOKEN = originalAuthToken
    }
    if (originalHelloTimeoutMs === undefined) {
      delete process.env.HELLO_TIMEOUT_MS
    } else {
      process.env.HELLO_TIMEOUT_MS = originalHelloTimeoutMs
    }
  })

  it('keeps a fresh opencode terminal live-only until canonical durable identity exists', async () => {
    const ws = await createAuthenticatedWs(port)

    try {
      const requestId = 'opencode-fresh'
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'opencode',
      }))

      const response = await waitForMessage(
        ws,
        (msg) => (
          msg.requestId === requestId
          && (msg.type === 'terminal.created' || msg.type === 'error')
        ),
      )

      expect(response.type).toBe('terminal.created')
      expect(response).not.toHaveProperty('effectiveResumeSessionId')
      expect(registry.lastCreateOpts?.resumeSessionId).toBeUndefined()
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('rejects the legacy raw resumeSessionId field for opencode restore requests', async () => {
    const ws = await createAuthenticatedWs(port)

    try {
      const requestId = 'opencode-restore-title-token'
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'opencode',
        restore: true,
        resumeSessionId: 'probe-title-two',
      }))

      const response = await waitForMessage(
        ws,
        (msg) => (
          msg.requestId === requestId
          && (msg.type === 'terminal.created' || msg.type === 'error')
        ),
      )

      expect(response).toMatchObject({
        type: 'error',
        code: 'INVALID_MESSAGE',
      })
      expect(registry.createCallCount).toBe(0)
      expect(registry.records.size).toBe(0)
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('uses the canonical durable opencode session id when restore is explicit', async () => {
    const ws = await createAuthenticatedWs(port)

    try {
      const requestId = 'opencode-restore-canonical'
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'opencode',
        restore: true,
        sessionRef: {
          provider: 'opencode',
          sessionId: OPENCODE_SESSION_ID,
        },
      }))

      const response = await waitForMessage(
        ws,
        (msg) => (
          msg.requestId === requestId
          && (msg.type === 'terminal.created' || msg.type === 'error')
        ),
      )

      expect(response.type).toBe('terminal.created')
      expect(registry.lastCreateOpts?.resumeSessionId).toBe(OPENCODE_SESSION_ID)
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('keeps an OpenCode terminal live-only until the control surface reports a canonical session id', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/global/health')) {
        return createJsonResponse({ ok: true, version: '1.4.11' })
      }
      if (url.endsWith('/session/status')) {
        return createJsonResponse({})
      }
      if (url.endsWith('/event')) {
        return createSseResponse([{ type: 'server.connected', properties: {} }])
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    const wiring = wireOpencodeActivityTracker({
      registry: registry as any,
      fetchImpl: fetchImpl as typeof fetch,
      random: () => 0,
    })

    try {
      const record = registry.create({
        mode: 'opencode',
        providerSettings: {
          opencodeServer: { hostname: '127.0.0.1', port: 43123 },
        },
      })

      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(OPENCODE_HEALTH_POLL_MS)

      expect(record.resumeSessionId).toBeUndefined()
      expect(registry.bindCalls).toEqual([])
    } finally {
      wiring.dispose()
      vi.useRealTimers()
    }
  })

  it('promotes an OpenCode terminal only after authoritative control data exposes a canonical session id', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/global/health')) {
        return createJsonResponse({ ok: true, version: '1.4.11' })
      }
      if (url.endsWith('/session/status')) {
        return createJsonResponse({
          [OPENCODE_SESSION_ID]: { type: 'busy' },
        })
      }
      if (url.endsWith('/event')) {
        return createSseResponse([{ type: 'server.connected', properties: {} }])
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    const wiring = wireOpencodeActivityTracker({
      registry: registry as any,
      fetchImpl: fetchImpl as typeof fetch,
      random: () => 0,
    })

    try {
      const record = registry.create({
        mode: 'opencode',
        providerSettings: {
          opencodeServer: { hostname: '127.0.0.1', port: 43123 },
        },
      })

      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(OPENCODE_HEALTH_POLL_MS)

      expect(record.resumeSessionId).toBe(OPENCODE_SESSION_ID)
      expect(registry.bindCalls).toEqual([
        expect.objectContaining({
          terminalId: record.terminalId,
          provider: 'opencode',
          sessionId: OPENCODE_SESSION_ID,
          reason: 'association',
        }),
      ])
    } finally {
      wiring.dispose()
      vi.useRealTimers()
    }
  })
})
