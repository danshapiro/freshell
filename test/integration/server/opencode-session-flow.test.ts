import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'http'
import WebSocket from 'ws'
import { WS_PROTOCOL_VERSION } from '../../shared/ws-protocol'

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

vi.mock('../../server/config-store', () => ({
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

class FakeBuffer {
  snapshot() {
    return ''
  }
}

class FakeRegistry {
  records = new Map<string, any>()
  lastCreateOpts: any = null
  createCallCount = 0

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
      clients: new Set<WebSocket>(),
    }
    this.records.set(terminalId, record)
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
    const { WsHandler } = await import('../../server/ws-handler')

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
      expect(response.effectiveResumeSessionId).toBeUndefined()
      expect(registry.lastCreateOpts?.resumeSessionId).toBeUndefined()
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('fails closed when opencode restore is requested without canonical durable identity', async () => {
    const ws = await createAuthenticatedWs(port)

    try {
      const requestId = 'opencode-restore-no-canonical'
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'opencode',
        restore: true,
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
        code: 'RESTORE_UNAVAILABLE',
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
        resumeSessionId: OPENCODE_SESSION_ID,
      }))

      const response = await waitForMessage(
        ws,
        (msg) => (
          msg.requestId === requestId
          && (msg.type === 'terminal.created' || msg.type === 'error')
        ),
      )

      expect(response.type).toBe('terminal.created')
      expect(response.effectiveResumeSessionId).toBe(OPENCODE_SESSION_ID)
      expect(registry.lastCreateOpts?.resumeSessionId).toBe(OPENCODE_SESSION_ID)
    } finally {
      await closeWebSocket(ws)
    }
  })
})
