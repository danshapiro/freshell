import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import http from 'http'
import WebSocket from 'ws'
import { EventEmitter } from 'events'
import type { SessionScanResult } from '../../server/session-scanner/types.js'
import { configStore } from '../../server/config-store.js'
import { WS_PROTOCOL_VERSION } from '../../shared/ws-protocol'

const HOOK_TIMEOUT_MS = 30000
const VALID_SESSION_ID = '550e8400-e29b-41d4-a716-446655440000'
const DEFAULT_CONFIG_SNAPSHOT = vi.hoisted(() => ({
  version: 1,
  settings: {},
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
  createCallCount = 0
  forceAttachFailure = false

  create(opts: any) {
    this.lastCreateOpts = opts
    this.createCallCount += 1
    const terminalId = 'term_' + Math.random().toString(16).slice(2)
    const rec = {
      terminalId,
      createdAt: Date.now(),
      buffer: new FakeBuffer(),
      title: opts.mode === 'claude' ? 'Claude' : 'Shell',
      mode: opts.mode || 'shell',
      shell: opts.shell || 'system',
      status: 'running',
      cols: 80,
      rows: 24,
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
    if (this.forceAttachFailure) return null
    const rec = this.records.get(terminalId)
    if (!rec) return null
    rec.clients.add(ws)
    return rec
  }

  finishAttachSnapshot(_terminalId: string, _ws: any) {}

  resize(terminalId: string, cols: number, rows: number) {
    const rec = this.records.get(terminalId)
    if (!rec) return false
    rec.cols = cols
    rec.rows = rows
    return true
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
    vi.mocked(configStore.snapshot).mockReset()
    vi.mocked(configStore.snapshot).mockResolvedValue(DEFAULT_CONFIG_SNAPSHOT)
    sessionRepairService.waitForSessionCalls = []
    sessionRepairService.result = undefined
    sessionRepairService.waitForSessionResult = undefined
    sessionRepairService.waitForSessionDelay = 0
    sessionRepairService.waitForSessionShouldThrow = false
    registry.records.clear()
    registry.lastCreateOpts = null
    registry.createCallCount = 0
    registry.forceAttachFailure = false
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
      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
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
      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
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
      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
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
      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
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
      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
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

  it('treats cross-socket duplicate requestIds as one in-flight claude repair wait', async () => {
    sessionRepairService.waitForSessionDelay = 300

    const requestId = 'resume-cross-socket-dup-1'
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    let ws2: WebSocket | undefined

    try {
      await new Promise<void>((resolve) => ws1.on('open', () => resolve()))
      ws1.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
      await waitForMessage(ws1, (m) => m.type === 'ready')

      ws1.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'claude',
        resumeSessionId: VALID_SESSION_ID,
      }))

      await new Promise((resolve) => setTimeout(resolve, 50))

      ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      await new Promise<void>((resolve) => ws2!.on('open', () => resolve()))
      ws2.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
      await waitForMessage(ws2, (m) => m.type === 'ready')

      ws2.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'claude',
        resumeSessionId: VALID_SESSION_ID,
      }))

      const [createdOnWs1, createdOnWs2] = await Promise.all([
        waitForMessage(ws1, (m) => m.type === 'terminal.created' && m.requestId === requestId, 3000),
        waitForMessage(ws2, (m) => m.type === 'terminal.created' && m.requestId === requestId, 3000),
      ])

      expect(createdOnWs2.terminalId).toBe(createdOnWs1.terminalId)
      expect(registry.records.size).toBe(1)
      expect(registry.createCallCount).toBe(1)
    } finally {
      await closeWebSocket(ws1)
      if (ws2) {
        await closeWebSocket(ws2)
      }
    }
  })

  it('coalesces concurrent claude repair waits by session across sockets', async () => {
    sessionRepairService.waitForSessionDelay = 300

    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    let ws2: WebSocket | undefined

    try {
      await new Promise<void>((resolve) => ws1.on('open', () => resolve()))
      ws1.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
      await waitForMessage(ws1, (m) => m.type === 'ready')

      ws1.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'resume-session-lock-1',
        mode: 'claude',
        resumeSessionId: VALID_SESSION_ID,
      }))

      await new Promise((resolve) => setTimeout(resolve, 50))

      ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      await new Promise<void>((resolve) => ws2!.on('open', () => resolve()))
      ws2.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
      await waitForMessage(ws2, (m) => m.type === 'ready')

      ws2.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'resume-session-lock-2',
        mode: 'claude',
        resumeSessionId: VALID_SESSION_ID,
      }))

      const [createdOnWs1, createdOnWs2] = await Promise.all([
        waitForMessage(ws1, (m) => m.type === 'terminal.created' && m.requestId === 'resume-session-lock-1', 3000),
        waitForMessage(ws2, (m) => m.type === 'terminal.created' && m.requestId === 'resume-session-lock-2', 3000),
      ])

      expect(createdOnWs2.terminalId).toBe(createdOnWs1.terminalId)
      expect(registry.records.size).toBe(1)
      expect(registry.createCallCount).toBe(1)
    } finally {
      await closeWebSocket(ws1)
      if (ws2) {
        await closeWebSocket(ws2)
      }
    }
  })

  it('does not create terminal if client disconnects during repair wait', async () => {
    sessionRepairService.waitForSessionDelay = 500

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
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

  it('does not create shell terminal if client disconnects during config load', async () => {
    let releaseConfig: (() => void) | undefined
    let markConfigStarted: (() => void) | undefined
    const configStarted = new Promise<void>((resolve) => {
      markConfigStarted = resolve
    })
    vi.mocked(configStore.snapshot).mockImplementationOnce(() => {
      markConfigStarted?.()
      return new Promise((resolve) => {
        releaseConfig = () => resolve(DEFAULT_CONFIG_SNAPSHOT)
      })
    })

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
      await waitForMessage(ws, (m) => m.type === 'ready')

      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'disconnect-during-config-load',
        mode: 'shell',
      }))

      await configStarted
      await closeWebSocket(ws)
      releaseConfig?.()
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(registry.records.size).toBe(0)
      expect(registry.createCallCount).toBe(0)
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('treats cross-socket duplicate creates as one in-flight request during config load', async () => {
    let releaseConfig: (() => void) | undefined
    let markConfigStarted: (() => void) | undefined
    const configStarted = new Promise<void>((resolve) => {
      markConfigStarted = resolve
    })
    vi.mocked(configStore.snapshot).mockImplementationOnce(() => {
      markConfigStarted?.()
      return new Promise((resolve) => {
        releaseConfig = () => resolve(DEFAULT_CONFIG_SNAPSHOT)
      })
    })

    const requestId = 'pending-config-cross-socket-dup'
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    let ws2: WebSocket | undefined

    try {
      await new Promise<void>((resolve) => ws1.on('open', () => resolve()))
      ws1.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
      await waitForMessage(ws1, (m) => m.type === 'ready')

      ws1.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'shell',
      }))

      await configStarted

      ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      await new Promise<void>((resolve) => ws2!.on('open', () => resolve()))
      ws2.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
      await waitForMessage(ws2, (m) => m.type === 'ready')

      ws2.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'shell',
      }))

      const createdOnWs2 = waitForMessage(
        ws2,
        (m) => m.type === 'terminal.created' && m.requestId === requestId,
        3000,
      )

      await new Promise((resolve) => setTimeout(resolve, 50))
      releaseConfig?.()

      const createdOnWs1 = await waitForMessage(
        ws1,
        (m) => m.type === 'terminal.created' && m.requestId === requestId,
        3000,
      )
      const createdOnWs2Resolved = await createdOnWs2

      expect(createdOnWs2Resolved.terminalId).toBe(createdOnWs1.terminalId)
      expect(registry.records.size).toBe(1)
      expect(registry.createCallCount).toBe(1)
    } finally {
      await closeWebSocket(ws1)
      if (ws2) {
        await closeWebSocket(ws2)
      }
    }
  })

  it('reuses requestId across reconnects to avoid duplicate shell create', async () => {
    const requestId = 'reconnect-idempotent-create-1'
    const baseNow = 1_700_000_000_000
    let now = baseNow
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    let ws2: WebSocket | undefined

    try {
      await new Promise<void>((resolve) => ws1.on('open', () => resolve()))
      ws1.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
      await waitForMessage(ws1, (m) => m.type === 'ready')

      ws1.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'shell',
      }))

      const firstCreated = await waitForMessage(
        ws1,
        (m) => m.type === 'terminal.created' && m.requestId === requestId,
      )

      await closeWebSocket(ws1)
      now += 10 * 60_000

      ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      await new Promise<void>((resolve) => ws2.on('open', () => resolve()))
      ws2.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
      await waitForMessage(ws2, (m) => m.type === 'ready')

      ws2.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'shell',
      }))

      const secondCreated = await waitForMessage(
        ws2,
        (m) => m.type === 'terminal.created' && m.requestId === requestId,
      )

      expect(secondCreated.terminalId).toBe(firstCreated.terminalId)
      expect(registry.records.size).toBe(1)
      expect(registry.createCallCount).toBe(1)
    } finally {
      dateNowSpy.mockRestore()
      await closeWebSocket(ws1)
      if (ws2) {
        await closeWebSocket(ws2)
      }
    }
  })

  it('broadcasts terminal.list.updated when create succeeds even if a later explicit attach fails', async () => {
    registry.forceAttachFailure = true

    const observer = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    let creator: WebSocket | undefined

    try {
      await new Promise<void>((resolve) => observer.on('open', () => resolve()))
      observer.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
      await waitForMessage(observer, (m) => m.type === 'ready')

      creator = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      await new Promise<void>((resolve) => creator.on('open', () => resolve()))
      creator.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
      await waitForMessage(creator, (m) => m.type === 'ready')

      creator.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'create-attach-fail-list-update',
        mode: 'shell',
      }))

      const created = await waitForMessage(
        creator,
        (m) => m.type === 'terminal.created' && m.requestId === 'create-attach-fail-list-update',
      )
      expect(registry.records.size).toBe(1)

      await waitForMessage(observer, (m) => m.type === 'terminal.list.updated')

      creator.send(JSON.stringify({
        type: 'terminal.attach',
        terminalId: created.terminalId,
        sinceSeq: 0,
        cols: 120,
        rows: 40,
      }))

      const err = await waitForMessage(
        creator,
        (m) => m.type === 'error' && m.code === 'INVALID_TERMINAL_ID' && m.terminalId === created.terminalId,
      )
      expect(err.requestId).toBeUndefined()
    } finally {
      await closeWebSocket(observer)
      if (creator) {
        await closeWebSocket(creator)
      }
      registry.forceAttachFailure = false
    }
  })

  it('ignores invalid resumeSessionId and skips session repair wait', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
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
