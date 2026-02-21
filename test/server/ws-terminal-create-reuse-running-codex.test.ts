import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'http'
import WebSocket from 'ws'
import { WS_PROTOCOL_VERSION } from '../../shared/ws-protocol'

const HOOK_TIMEOUT_MS = 30_000
const CODEX_SESSION_ID = 'codex-session-abc-123'

function listen(server: http.Server, timeoutMs = HOOK_TIMEOUT_MS): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out')), timeoutMs)
    const onError = (err: Error) => { clearTimeout(timeout); reject(err) }
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      clearTimeout(timeout)
      server.off('error', onError)
      const addr = server.address()
      if (typeof addr === 'object' && addr) resolve({ port: addr.port })
    })
  })
}

function waitForMessage(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 2000): Promise<any> {
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

function waitForMessages(
  ws: WebSocket,
  predicates: Array<(msg: any) => boolean>,
  timeoutMs = 2000,
): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const matches: any[] = Array(predicates.length).fill(undefined)
    const timeout = setTimeout(() => {
      ws.off('message', handler)
      reject(new Error('Timeout waiting for messages'))
    }, timeoutMs)
    const handler = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString())
      for (let i = 0; i < predicates.length; i += 1) {
        if (!matches[i] && predicates[i]?.(msg)) {
          matches[i] = msg
        }
      }
      if (matches.every((m) => m !== undefined)) {
        clearTimeout(timeout)
        ws.off('message', handler)
        resolve(matches)
      }
    }
    ws.on('message', handler)
  })
}

class FakeBuffer {
  snapshot() { return 'codex session output' }
}

type FakeTerminal = {
  terminalId: string
  createdAt: number
  buffer: FakeBuffer
  mode: 'codex'
  shell: 'system'
  status: 'running'
  resumeSessionId?: string
  clients: Set<WebSocket>
}

class FakeRegistry {
  records: FakeTerminal[]
  attachCalls: Array<{ terminalId: string; opts?: any }> = []
  createCalls: any[] = []
  repairCalls: Array<{ mode: string; sessionId: string }> = []

  constructor(terminalIds: string[]) {
    const createdAt = Date.now()
    this.records = terminalIds.map((terminalId, idx) => ({
      terminalId,
      createdAt: createdAt + idx,
      buffer: new FakeBuffer(),
      mode: 'codex' as const,
      shell: 'system' as const,
      status: 'running' as const,
      resumeSessionId: CODEX_SESSION_ID,
      clients: new Set<WebSocket>(),
    }))
  }

  private findById(terminalId: string): FakeTerminal | undefined {
    return this.records.find((record) => record.terminalId === terminalId)
  }

  get(terminalId: string) {
    return this.findById(terminalId) ?? null
  }

  // Legacy non-canonical lookup returns newest matching record first.
  findRunningTerminalBySession(mode: string, sessionId: string) {
    if (mode !== 'codex' || sessionId !== CODEX_SESSION_ID) return undefined
    return this.records.slice().reverse().find((record) => record.status === 'running')
  }

  getCanonicalRunningTerminalBySession(mode: string, sessionId: string) {
    if (mode !== 'codex' || sessionId !== CODEX_SESSION_ID) return undefined
    return this.records.find((record) => record.status === 'running' && record.resumeSessionId === CODEX_SESSION_ID)
  }

  repairLegacySessionOwners(mode: string, sessionId: string) {
    this.repairCalls.push({ mode, sessionId })
    if (mode !== 'codex' || sessionId !== CODEX_SESSION_ID) return
    const canonical = this.records[0]
    this.records = this.records.map((record) => {
      if (record.terminalId === canonical?.terminalId) {
        return { ...record, resumeSessionId: CODEX_SESSION_ID }
      }
      return { ...record, resumeSessionId: undefined }
    })
  }

  findRunningClaudeTerminalBySession(sessionId: string) {
    return this.findRunningTerminalBySession('claude', sessionId)
  }

  attach(terminalId: string, ws: WebSocket, opts?: any) {
    this.attachCalls.push({ terminalId, opts })
    const record = this.findById(terminalId)
    if (!record) return null
    record.clients.add(ws)
    return record
  }

  detach(terminalId: string, ws: WebSocket) {
    const record = this.findById(terminalId)
    if (!record) return false
    record.clients.delete(ws)
    return true
  }

  create(opts: any) {
    this.createCalls.push(opts)
    return this.records[0]
  }

  list() { return [] }
}

describe('terminal.create reuse running codex terminal', () => {
  let server: http.Server | undefined
  let port: number
  let registry: FakeRegistry

  beforeAll(async () => {
    process.env.NODE_ENV = 'test'
    process.env.AUTH_TOKEN = 'testtoken-testtoken'
    process.env.HELLO_TIMEOUT_MS = '100'

    const { WsHandler } = await import('../../server/ws-handler')
    server = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
    registry = new FakeRegistry(['term-codex-existing'])
    new WsHandler(server, registry as any)
    const info = await listen(server)
    port = info.port
  }, HOOK_TIMEOUT_MS)

  beforeEach(() => {
    registry.attachCalls = []
    registry.createCalls = []
    registry.repairCalls = []
  })

  afterAll(async () => {
    if (!server) return
    await new Promise<void>((resolve) => server!.close(() => resolve()))
  }, HOOK_TIMEOUT_MS)

  it('reuses existing codex terminal instead of creating new one', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
      await waitForMessage(ws, (m) => m.type === 'ready')

      const requestId = 'codex-reuse-1'
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'codex',
        resumeSessionId: CODEX_SESSION_ID,
      }))

      const [created, ready] = await waitForMessages(ws, [
        (m) => m.type === 'terminal.created' && m.requestId === requestId,
        (m) => m.type === 'terminal.attach.ready' && m.terminalId === 'term-codex-existing',
      ])

      // Should reuse existing terminal, not create a new one
      expect(created.terminalId).toBe('term-codex-existing')
      expect(created.snapshot).toBeUndefined()
      expect(created.snapshotChunked).toBeUndefined()
      expect(registry.attachCalls).toHaveLength(1)
      expect(registry.attachCalls[0]?.terminalId).toBe('term-codex-existing')
      expect(registry.createCalls).toHaveLength(0)
      expect(ready.headSeq).toBeGreaterThanOrEqual(0)
    } finally {
      ws.close()
    }
  })

  it('returns effectiveResumeSessionId from reused codex terminal', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
      await waitForMessage(ws, (m) => m.type === 'ready')

      const requestId = 'codex-reuse-2'
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'codex',
        resumeSessionId: CODEX_SESSION_ID,
      }))

      const created = await waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === requestId)
      expect(created.effectiveResumeSessionId).toBe(CODEX_SESSION_ID)
    } finally {
      ws.close()
    }
  })

  it('reuses canonical owner and repairs duplicate session records before reuse', async () => {
    const { WsHandler } = await import('../../server/ws-handler')
    const dupeServer = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
    const dupeRegistry = new FakeRegistry(['term-canonical', 'term-duplicate'])
    new WsHandler(dupeServer, dupeRegistry as any)
    const info = await listen(dupeServer)

    const ws = new WebSocket(`ws://127.0.0.1:${info.port}/ws`)
    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
      await waitForMessage(ws, (m) => m.type === 'ready')

      // Make canonical lookup fail initially so handler must invoke repair and retry.
      const originalGetCanonical = dupeRegistry.getCanonicalRunningTerminalBySession.bind(dupeRegistry)
      let firstLookup = true
      dupeRegistry.getCanonicalRunningTerminalBySession = ((mode: string, sessionId: string) => {
        if (firstLookup) {
          firstLookup = false
          return undefined
        }
        return originalGetCanonical(mode, sessionId)
      }) as any

      const requestId = 'codex-reuse-repair'
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'codex',
        resumeSessionId: CODEX_SESSION_ID,
      }))

      const created = await waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === requestId)

      expect(created.terminalId).toBe('term-canonical')
      expect(dupeRegistry.createCalls).toHaveLength(0)
      expect(dupeRegistry.repairCalls).toHaveLength(1)
      expect(dupeRegistry.repairCalls[0]).toEqual({ mode: 'codex', sessionId: CODEX_SESSION_ID })
      expect(dupeRegistry.attachCalls[0]?.terminalId).toBe('term-canonical')
    } finally {
      ws.close()
      await new Promise<void>((resolve) => dupeServer.close(() => resolve()))
    }
  })
})
