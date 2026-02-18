import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'http'
import WebSocket from 'ws'

const HOOK_TIMEOUT_MS = 30_000
const VALID_SESSION_ID = '550e8400-e29b-41d4-a716-446655440000'

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

class FakeBuffer {
  snapshot() {
    return ''
  }
}

class FakeRegistry {
  record: any
  attachCalls: Array<{ terminalId: string; opts?: { pendingSnapshot?: boolean } }> = []
  finishAttachSnapshotCalls: Array<{ terminalId: string }> = []

  constructor(terminalId: string) {
    this.record = {
      terminalId,
      createdAt: Date.now(),
      buffer: new FakeBuffer(),
      mode: 'claude',
      shell: 'system',
      status: 'running',
      resumeSessionId: VALID_SESSION_ID,
      clients: new Set<WebSocket>(),
    }
  }

  get(terminalId: string) {
    return this.record.terminalId === terminalId ? this.record : null
  }

  findRunningTerminalBySession(mode: string, sessionId: string) {
    if (mode === this.record.mode && sessionId === VALID_SESSION_ID) return this.record
    return undefined
  }

  getCanonicalRunningTerminalBySession(mode: string, sessionId: string) {
    return this.findRunningTerminalBySession(mode, sessionId)
  }

  repairLegacySessionOwners(_mode: string, _sessionId: string) {
    return {
      repaired: false,
      canonicalTerminalId: this.record.terminalId,
      clearedTerminalIds: [] as string[],
    }
  }

  findRunningClaudeTerminalBySession(sessionId: string) {
    return this.findRunningTerminalBySession('claude', sessionId)
  }

  attach(terminalId: string, ws: WebSocket, opts?: { pendingSnapshot?: boolean }) {
    this.attachCalls.push({ terminalId, opts })
    this.record.clients.add(ws)
    return this.record
  }

  finishAttachSnapshot(terminalId: string, _ws: WebSocket) {
    this.finishAttachSnapshotCalls.push({ terminalId })
  }

  detach(_terminalId: string, ws: WebSocket) {
    this.record.clients.delete(ws)
    return true
  }

  list() {
    return []
  }
}

describe('terminal.create reuse running claude terminal', () => {
  let server: http.Server | undefined
  let port: number
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

    registry = new FakeRegistry('term-existing')
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    new WsHandler(server, registry as any)

    const info = await listen(server)
    port = info.port
  }, HOOK_TIMEOUT_MS)

  beforeEach(() => {
    registry.attachCalls = []
    registry.finishAttachSnapshotCalls = []
  })

  afterAll(async () => {
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }, HOOK_TIMEOUT_MS)

  it('attaches with pendingSnapshot and flushes snapshot queue', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))
      await waitForMessage(ws, (m) => m.type === 'ready')

      const requestId = 'reuse-1'
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'claude',
        resumeSessionId: VALID_SESSION_ID,
      }))

      const listUpdated = waitForMessage(ws, (m) => m.type === 'terminal.list.updated')
      const created = await waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === requestId)
      expect(created.terminalId).toBe('term-existing')
      await listUpdated

      expect(registry.attachCalls).toHaveLength(1)
      expect(registry.attachCalls[0]?.opts?.pendingSnapshot).toBe(true)

      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(registry.finishAttachSnapshotCalls).toHaveLength(1)
      expect(registry.finishAttachSnapshotCalls[0]?.terminalId).toBe('term-existing')
    } finally {
      ws.close()
    }
  })
})
