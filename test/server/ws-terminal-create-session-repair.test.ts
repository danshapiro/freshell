import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import http from 'http'
import WebSocket from 'ws'
import { EventEmitter } from 'events'
import type { SessionScanResult } from '../../server/session-scanner/types.js'

const HOOK_TIMEOUT_MS = 30000
const VALID_SESSION_ID = '550e8400-e29b-41d4-a716-446655440000'

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

  findRunningTerminalBySession(mode: string, sessionId: string) {
    for (const rec of this.records.values()) {
      if (rec.mode !== mode) continue
      if (rec.status !== 'running') continue
      if (rec.resumeSessionId === sessionId) return rec
    }
    return undefined
  }

  findRunningClaudeTerminalBySession(sessionId: string) {
    return this.findRunningTerminalBySession('claude', sessionId)
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

class FakeSessionRepairService extends EventEmitter {
  waitForSessionCalls: string[] = []
  result: SessionScanResult | undefined
  waitForSessionResult: SessionScanResult | undefined
  waitForSessionDelay: number = 0
  waitForSessionShouldThrow: boolean = false

  prioritizeSessions() {}

  getResult(_sessionId: string): SessionScanResult | undefined {
    return this.result
  }

  async waitForSession(sessionId: string, _timeoutMs?: number): Promise<SessionScanResult> {
    this.waitForSessionCalls.push(sessionId)
    if (this.waitForSessionDelay > 0) {
      await new Promise(r => setTimeout(r, this.waitForSessionDelay))
    }
    if (this.waitForSessionShouldThrow) {
      throw new Error('Timeout')
    }
    if (this.waitForSessionResult) {
      return this.waitForSessionResult
    }
    // Default: resolve as healthy
    return {
      sessionId,
      filePath: `/tmp/${sessionId}.jsonl`,
      status: 'healthy',
      chainDepth: 10,
      orphanCount: 0,
      fileSize: 1024,
      messageCount: 10,
    }
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
    new WsHandler(server, registry as any, undefined, undefined, sessionRepairService as any)

    const info = await listen(server)
    port = info.port
  }, HOOK_TIMEOUT_MS)

  beforeEach(() => {
    sessionRepairService.waitForSessionCalls = []
    sessionRepairService.result = undefined
    sessionRepairService.waitForSessionResult = undefined
    sessionRepairService.waitForSessionDelay = 0
    sessionRepairService.waitForSessionShouldThrow = false
    registry.records.clear()
    registry.lastCreateOpts = null
  })

  afterAll(async () => {
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }, HOOK_TIMEOUT_MS)

  it('blocks terminal.create until session repair completes', async () => {
    sessionRepairService.waitForSessionDelay = 100

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
        resumeSessionId: VALID_SESSION_ID,
      }))

      const created = await waitForMessage(
        ws,
        (m) => m.type === 'terminal.created' && m.requestId === requestId,
        3000,
      )

      expect(created.terminalId).toMatch(/^term_/)
      expect(created.effectiveResumeSessionId).toBe(VALID_SESSION_ID)
      expect(sessionRepairService.waitForSessionCalls).toContain(VALID_SESSION_ID)
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('drops resumeSessionId when cached result is missing', async () => {
    sessionRepairService.result = {
      sessionId: VALID_SESSION_ID,
      filePath: `/tmp/${VALID_SESSION_ID}.jsonl`,
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
        resumeSessionId: VALID_SESSION_ID,
      }))

      const created = await waitForMessage(
        ws,
        (m) => m.type === 'terminal.created' && m.requestId === requestId,
      )

      expect(registry.lastCreateOpts?.resumeSessionId).toBeUndefined()
      expect(created.effectiveResumeSessionId).toBeUndefined()
      expect(sessionRepairService.waitForSessionCalls).not.toContain(VALID_SESSION_ID)
    } finally {
      await closeWebSocket(ws)
      sessionRepairService.result = undefined
    }
  })

  it('drops resumeSessionId when repair resolves as missing', async () => {
    sessionRepairService.waitForSessionResult = {
      sessionId: VALID_SESSION_ID,
      filePath: `/tmp/${VALID_SESSION_ID}.jsonl`,
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

      const requestId = 'resume-repair-missing-1'
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'claude',
        resumeSessionId: VALID_SESSION_ID,
      }))

      const created = await waitForMessage(
        ws,
        (m) => m.type === 'terminal.created' && m.requestId === requestId,
      )

      expect(registry.lastCreateOpts?.resumeSessionId).toBeUndefined()
      expect(created.effectiveResumeSessionId).toBeUndefined()
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('proceeds with resume when repair wait throws (timeout)', async () => {
    sessionRepairService.waitForSessionShouldThrow = true

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))
      await waitForMessage(ws, (m) => m.type === 'ready')

      const requestId = 'resume-timeout-1'
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'claude',
        resumeSessionId: VALID_SESSION_ID,
      }))

      const created = await waitForMessage(
        ws,
        (m) => m.type === 'terminal.created' && m.requestId === requestId,
        3000,
      )

      // Should still create with the resumeSessionId (repair failed, but we proceed)
      expect(created.terminalId).toMatch(/^term_/)
      expect(created.effectiveResumeSessionId).toBe(VALID_SESSION_ID)
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('prevents duplicate terminal creation during async repair wait', async () => {
    sessionRepairService.waitForSessionDelay = 300

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))
      await waitForMessage(ws, (m) => m.type === 'ready')

      const requestId = 'resume-dup-1'

      // Send two creates with the same requestId in quick succession
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'claude',
        resumeSessionId: VALID_SESSION_ID,
      }))
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'claude',
        resumeSessionId: VALID_SESSION_ID,
      }))

      const created = await waitForMessage(
        ws,
        (m) => m.type === 'terminal.created' && m.requestId === requestId,
        3000,
      )

      expect(created.terminalId).toMatch(/^term_/)

      // Wait a bit to ensure no second terminal.created arrives
      await new Promise(r => setTimeout(r, 500))

      // Only one terminal should have been created
      expect(registry.records.size).toBe(1)
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('does not create terminal if client disconnects during repair wait', async () => {
    sessionRepairService.waitForSessionDelay = 500

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))
      await waitForMessage(ws, (m) => m.type === 'ready')

      const requestId = 'resume-disconnect-1'
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'claude',
        resumeSessionId: VALID_SESSION_ID,
      }))

      // Close the socket while repair is in progress
      await new Promise(r => setTimeout(r, 50))
      ws.close()
      await new Promise<void>((resolve) => ws.once('close', () => resolve()))

      // Wait for repair to complete
      await new Promise(r => setTimeout(r, 600))

      // No terminal should have been created
      expect(registry.records.size).toBe(0)
    } finally {
      if (ws.readyState !== WebSocket.CLOSED) {
        await closeWebSocket(ws)
      }
    }
  })

  it('ignores invalid resumeSessionId and skips session repair wait', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))
      await waitForMessage(ws, (m) => m.type === 'ready')

      const requestId = 'resume-invalid-1'
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'claude',
        resumeSessionId: 'not-a-uuid',
      }))

      const created = await waitForMessage(
        ws,
        (m) => m.type === 'terminal.created' && m.requestId === requestId,
      )

      expect(registry.lastCreateOpts?.resumeSessionId).toBeUndefined()
      expect(created.effectiveResumeSessionId).toBeUndefined()
      expect(sessionRepairService.waitForSessionCalls).not.toContain('not-a-uuid')
    } finally {
      await closeWebSocket(ws)
    }
  })
})
