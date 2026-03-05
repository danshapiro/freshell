import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import http from 'http'
import WebSocket from 'ws'
import { WS_PROTOCOL_VERSION } from '../../shared/ws-protocol'

const HOOK_TIMEOUT_MS = 30_000
const VALID_SESSION_ID = '550e8400-e29b-41d4-a716-446655440000'
const { snapshotSpy } = vi.hoisted(() => ({
  snapshotSpy: vi.fn().mockResolvedValue({
    version: 1,
    settings: { codingCli: { providers: {} } },
    sessionOverrides: {},
    terminalOverrides: {},
    projectColors: {},
    recentDirectories: [],
  }),
}))

vi.mock('../../server/config-store', () => ({
  configStore: {
    snapshot: snapshotSpy,
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

function waitForMessage(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 5000): Promise<any> {
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

function collectMessages(ws: WebSocket, durationMs: number): Promise<any[]> {
  return new Promise((resolve) => {
    const messages: any[] = []
    const handler = (data: WebSocket.Data) => {
      try {
        messages.push(JSON.parse(data.toString()))
      } catch {
        // ignore malformed test frames
      }
    }
    ws.on('message', handler)
    setTimeout(() => {
      ws.off('message', handler)
      resolve(messages)
    }, durationMs)
  })
}

class FakeBuffer {
  snapshot() {
    return ''
  }
}

class FakeRegistry {
  record: any
  attachCalls: Array<{ terminalId: string; opts?: { suppressOutput?: boolean } }> = []

  constructor(terminalId: string) {
    this.record = {
      terminalId,
      createdAt: Date.now(),
      buffer: new FakeBuffer(),
      mode: 'claude',
      shell: 'system',
      status: 'running',
      cols: 80,
      rows: 24,
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

  attach(terminalId: string, ws: WebSocket, opts?: { suppressOutput?: boolean }) {
    this.attachCalls.push({ terminalId, opts })
    this.record.clients.add(ws)
    return this.record
  }

  resize(terminalId: string, cols: number, rows: number) {
    if (this.record.terminalId !== terminalId) return false
    this.record.cols = cols
    this.record.rows = rows
    return true
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
    snapshotSpy.mockClear()
  })

  afterAll(async () => {
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }, HOOK_TIMEOUT_MS)

  it('reuses running terminal via broker auto-attach without snapshot pipeline', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
      await waitForMessage(ws, (m) => m.type === 'ready')

      const requestId = 'reuse-1'
      const createdPromise = waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === requestId)
      const readyPromise = waitForMessage(
        ws,
        (m) => m.type === 'terminal.attach.ready' && m.terminalId === 'term-existing',
      )
      const listUpdatedPromise = waitForMessage(ws, (m) => m.type === 'terminal.list.updated')

      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'claude',
        resumeSessionId: VALID_SESSION_ID,
      }))

      const created = await createdPromise
      const ready = await readyPromise
      expect(created.terminalId).toBe('term-existing')
      expect(created.snapshot).toBeUndefined()
      expect(created.snapshotChunked).toBeUndefined()
      expect(ready.type).toBe('terminal.attach.ready')
      await listUpdatedPromise

      expect(registry.attachCalls).toHaveLength(1)
      expect(registry.attachCalls[0]?.opts?.suppressOutput).toBe(true)
      expect(snapshotSpy).not.toHaveBeenCalled()
    } finally {
      ws.close()
    }
  })

  it('existingAfterConfig branch + attachOnCreate:false returns created only until explicit attach', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
      await waitForMessage(ws, (m) => m.type === 'ready')

      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'reuse-split-existingAfterConfig',
        mode: 'claude',
        resumeSessionId: VALID_SESSION_ID,
        attachOnCreate: false,
      }))
      const created = await waitForMessage(
        ws,
        (m) => m.type === 'terminal.created' && m.requestId === 'reuse-split-existingAfterConfig',
      )
      const preAttachMsgs = await collectMessages(ws, 150)
      expect(preAttachMsgs.some((m) => m.type === 'terminal.attach.ready' && m.terminalId === created.terminalId)).toBe(false)

      ws.send(JSON.stringify({
        type: 'terminal.attach',
        terminalId: created.terminalId,
        sinceSeq: 0,
        cols: 120,
        rows: 40,
        attachRequestId: 'reuse-split-existingAfterConfig-attach',
      }))
      const ready = await waitForMessage(
        ws,
        (m) => m.type === 'terminal.attach.ready' && m.attachRequestId === 'reuse-split-existingAfterConfig-attach',
      )
      expect(ready.terminalId).toBe(created.terminalId)
    } finally {
      ws.close()
    }
  })

  it('duplicate requestId in split mode => one created, no duplicate replay churn', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
      await waitForMessage(ws, (m) => m.type === 'ready')

      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'reuse-claude-dup-split',
        mode: 'claude',
        resumeSessionId: VALID_SESSION_ID,
        attachOnCreate: false,
      }))
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'reuse-claude-dup-split',
        mode: 'claude',
        resumeSessionId: VALID_SESSION_ID,
        attachOnCreate: false,
      }))

      const created = await waitForMessage(
        ws,
        (m) => m.type === 'terminal.created' && m.requestId === 'reuse-claude-dup-split',
      )
      const msgs = await collectMessages(ws, 200)
      const createdCount = msgs.filter((m) => m.type === 'terminal.created' && m.requestId === 'reuse-claude-dup-split').length + 1
      expect(createdCount).toBe(1)
      expect(msgs.some((m) => m.type === 'terminal.attach.ready' && m.terminalId === created.terminalId)).toBe(false)

      ws.send(JSON.stringify({
        type: 'terminal.attach',
        terminalId: created.terminalId,
        sinceSeq: 0,
        cols: 120,
        rows: 40,
        attachRequestId: 'reuse-claude-dup-split-attach',
      }))
      const ready = await waitForMessage(
        ws,
        (m) => m.type === 'terminal.attach.ready' && m.attachRequestId === 'reuse-claude-dup-split-attach',
      )
      expect(ready.terminalId).toBe(created.terminalId)
    } finally {
      ws.close()
    }
  })
})
