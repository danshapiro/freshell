import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import http from 'http'
import WebSocket from 'ws'
import { EventEmitter } from 'events'
import type { SessionScanResult } from '../../server/session-scanner/types.js'
import { configStore } from '../../server/config-store.js'
import { WS_PROTOCOL_VERSION } from '../../shared/ws-protocol'

const HOOK_TIMEOUT_MS = 30000
const VALID_SESSION_ID = '550e8400-e29b-41d4-a716-446655440000'
const REPAIR_WAIT_MS = 75
const REPAIR_STAGGER_MS = 20
const DUPLICATE_SETTLE_MS = 100
const DISCONNECT_SETTLE_MS = 150
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

function waitForMessage(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 10_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      ws.off('message', handler)
      ws.off('close', onClose)
      ws.off('error', onError)
    }

    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Timeout waiting for message'))
    }, timeoutMs)

    const handler = (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (predicate(msg)) {
          cleanup()
          resolve(msg)
        }
      } catch {
        // Ignore malformed frames in tests.
      }
    }

    const onClose = () => {
      cleanup()
      reject(new Error('Socket closed waiting for message'))
    }

    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }

    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      onClose()
      return
    }

    ws.on('message', handler)
    ws.once('close', onClose)
    ws.once('error', onError)
  })
}

function waitForReady(ws: WebSocket): Promise<any> {
  const readyPromise = waitForMessage(ws, (m) => m.type === 'ready')
  ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
  return readyPromise
}

function waitForCreated(ws: WebSocket, requestId: string, timeoutMs = 5000): Promise<any> {
  return waitForMessage(
    ws,
    (m) => m.type === 'terminal.created' && m.requestId === requestId,
    timeoutMs,
  )
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

    sessionRepairService = new FakeSessionRepairService()
    registry = new FakeRegistry()
    new WsHandler(server, registry as any, { sessionRepairService: sessionRepairService as any })

    const info = await listen(server)
    port = info.port
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
  }, HOOK_TIMEOUT_MS)

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
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
  }, HOOK_TIMEOUT_MS)

  it('blocks terminal.create until session repair completes', async () => {
    sessionRepairService.waitForSessionDelay = REPAIR_WAIT_MS

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      await waitForReady(ws)

      const requestId = 'resume-1'
      const createdPromise = waitForCreated(ws, requestId, 3000)
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'claude',
        sessionRef: {
          provider: 'claude',
          sessionId: VALID_SESSION_ID,
        },
      }))

      const created = await createdPromise

      expect(created.terminalId).toMatch(/^term_/)
      expect(registry.lastCreateOpts?.resumeSessionId).toBe(VALID_SESSION_ID)
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
      await waitForReady(ws)

      const requestId = 'resume-missing-1'
      const createdPromise = waitForCreated(ws, requestId)
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'claude',
        sessionRef: {
          provider: 'claude',
          sessionId: VALID_SESSION_ID,
        },
      }))

      const created = await createdPromise

      expect(registry.lastCreateOpts?.resumeSessionId).toBeUndefined()
      expect(created).not.toHaveProperty('effectiveResumeSessionId')
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
      await waitForReady(ws)

      const requestId = 'resume-repair-missing-1'
      const createdPromise = waitForCreated(ws, requestId)
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'claude',
        sessionRef: {
          provider: 'claude',
          sessionId: VALID_SESSION_ID,
        },
      }))

      const created = await createdPromise

      expect(registry.lastCreateOpts?.resumeSessionId).toBeUndefined()
      expect(created).not.toHaveProperty('effectiveResumeSessionId')
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('proceeds with resume when repair wait throws (timeout)', async () => {
    sessionRepairService.waitForSessionShouldThrow = true

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      await waitForReady(ws)

      const requestId = 'resume-timeout-1'
      const createdPromise = waitForCreated(ws, requestId, 3000)
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'claude',
        sessionRef: {
          provider: 'claude',
          sessionId: VALID_SESSION_ID,
        },
      }))

      const created = await createdPromise

      // Should still create with the resumeSessionId (repair failed, but we proceed)
      expect(created.terminalId).toMatch(/^term_/)
      expect(registry.lastCreateOpts?.resumeSessionId).toBe(VALID_SESSION_ID)
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('prevents duplicate terminal creation during async repair wait', async () => {
    sessionRepairService.waitForSessionDelay = REPAIR_WAIT_MS

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      await waitForReady(ws)

      const requestId = 'resume-dup-1'
      const createdPromise = waitForCreated(ws, requestId, 3000)

      // Send two creates with the same requestId in quick succession
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'claude',
        sessionRef: {
          provider: 'claude',
          sessionId: VALID_SESSION_ID,
        },
      }))
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'claude',
        sessionRef: {
          provider: 'claude',
          sessionId: VALID_SESSION_ID,
        },
      }))

      const created = await createdPromise

      expect(created.terminalId).toMatch(/^term_/)

      // Wait a bit to ensure no second terminal.created arrives
      await new Promise(r => setTimeout(r, DUPLICATE_SETTLE_MS))

      // Only one terminal should have been created
      expect(registry.records.size).toBe(1)
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('treats cross-socket duplicate requestIds as one in-flight claude repair wait', async () => {
    sessionRepairService.waitForSessionDelay = REPAIR_WAIT_MS

    const requestId = 'resume-cross-socket-dup-1'
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    let ws2: WebSocket | undefined

    try {
      await new Promise<void>((resolve) => ws1.on('open', () => resolve()))
      await waitForReady(ws1)

      const createdOnWs1Promise = waitForCreated(ws1, requestId, 3000)
      ws1.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'claude',
        sessionRef: {
          provider: 'claude',
          sessionId: VALID_SESSION_ID,
        },
      }))

      await new Promise((resolve) => setTimeout(resolve, REPAIR_STAGGER_MS))

      ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      await new Promise<void>((resolve) => ws2!.on('open', () => resolve()))
      await waitForReady(ws2)

      const createdOnWs2Promise = waitForCreated(ws2, requestId, 3000)
      ws2.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'claude',
        sessionRef: {
          provider: 'claude',
          sessionId: VALID_SESSION_ID,
        },
      }))

      const [createdOnWs1, createdOnWs2] = await Promise.all([
        createdOnWs1Promise,
        createdOnWs2Promise,
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
    sessionRepairService.waitForSessionDelay = REPAIR_WAIT_MS

    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    let ws2: WebSocket | undefined

    try {
      await new Promise<void>((resolve) => ws1.on('open', () => resolve()))
      await waitForReady(ws1)

      const createdOnWs1Promise = waitForCreated(ws1, 'resume-session-lock-1', 3000)
      ws1.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'resume-session-lock-1',
        mode: 'claude',
        sessionRef: {
          provider: 'claude',
          sessionId: VALID_SESSION_ID,
        },
      }))

      await new Promise((resolve) => setTimeout(resolve, REPAIR_STAGGER_MS))

      ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      await new Promise<void>((resolve) => ws2!.on('open', () => resolve()))
      await waitForReady(ws2)

      const createdOnWs2Promise = waitForCreated(ws2, 'resume-session-lock-2', 3000)
      ws2.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'resume-session-lock-2',
        mode: 'claude',
        sessionRef: {
          provider: 'claude',
          sessionId: VALID_SESSION_ID,
        },
      }))

      const [createdOnWs1, createdOnWs2] = await Promise.all([
        createdOnWs1Promise,
        createdOnWs2Promise,
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
    sessionRepairService.waitForSessionDelay = REPAIR_WAIT_MS

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      await waitForReady(ws)

      const requestId = 'resume-disconnect-1'
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'claude',
        sessionRef: {
          provider: 'claude',
          sessionId: VALID_SESSION_ID,
        },
      }))

      // Close the socket while repair is in progress
      await new Promise(r => setTimeout(r, REPAIR_STAGGER_MS))
      ws.close()
      await new Promise<void>((resolve) => ws.once('close', () => resolve()))

      // Wait for repair to complete
      await new Promise(r => setTimeout(r, DISCONNECT_SETTLE_MS))

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
      await waitForReady(ws)

      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'disconnect-during-config-load',
        mode: 'shell',
      }))

      await configStarted
      await closeWebSocket(ws)
      releaseConfig?.()
      await new Promise((resolve) => setTimeout(resolve, REPAIR_STAGGER_MS))

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
      await waitForReady(ws1)

      ws1.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'shell',
      }))

      await configStarted

      ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      await new Promise<void>((resolve) => ws2!.on('open', () => resolve()))
      await waitForReady(ws2)

      const createdOnWs2 = waitForCreated(ws2, requestId, 3000)
      ws2.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'shell',
      }))

      const createdOnWs1Promise = waitForCreated(ws1, requestId, 3000)

      await new Promise((resolve) => setTimeout(resolve, REPAIR_STAGGER_MS))
      releaseConfig?.()

      const createdOnWs1 = await createdOnWs1Promise
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
      await waitForReady(ws1)

      const firstCreatedPromise = waitForCreated(ws1, requestId)
      ws1.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'shell',
      }))

      const firstCreated = await firstCreatedPromise

      await closeWebSocket(ws1)
      now += 10 * 60_000

      ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      await new Promise<void>((resolve) => ws2.on('open', () => resolve()))
      await waitForReady(ws2)

      const secondCreatedPromise = waitForCreated(ws2, requestId)
      ws2.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'shell',
      }))

      const secondCreated = await secondCreatedPromise

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

  it('broadcasts terminals.changed when create succeeds even if a later explicit attach fails', async () => {
    registry.forceAttachFailure = true

    const observer = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    let creator: WebSocket | undefined

    try {
      await new Promise<void>((resolve) => observer.on('open', () => resolve()))
      await waitForReady(observer)

      creator = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      await new Promise<void>((resolve) => creator.on('open', () => resolve()))
      await waitForReady(creator)

      const terminalsChangedPromise = waitForMessage(observer, (m) => m.type === 'terminals.changed')
      const createdPromise = waitForCreated(creator, 'create-attach-fail-list-update')

      creator.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'create-attach-fail-list-update',
        mode: 'shell',
      }))

      const created = await createdPromise
      expect(registry.records.size).toBe(1)

      await terminalsChangedPromise

      creator.send(JSON.stringify({
        type: 'terminal.attach',
        terminalId: created.terminalId,
        intent: 'viewport_hydrate',
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

  it('does not skip resume for healthy sessions with inline-progress resume issue', async () => {
    // Simulate: getResult returns a cached result with resumeIssue
    sessionRepairService.result = {
      sessionId: VALID_SESSION_ID,
      filePath: `/tmp/${VALID_SESSION_ID}.jsonl`,
      status: 'healthy',
      chainDepth: 5,
      orphanCount: 0,
      fileSize: 500,
      messageCount: 5,
      resumeIssue: 'inline_stop_hook_progress',
    }

    // waitForSession should still be called because the cached result has a resume issue
    // After repair, it returns the clean result
    sessionRepairService.waitForSessionResult = {
      sessionId: VALID_SESSION_ID,
      filePath: `/tmp/${VALID_SESSION_ID}.jsonl`,
      status: 'healthy',
      chainDepth: 5,
      orphanCount: 0,
      fileSize: 500,
      messageCount: 5,
    }

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      await waitForReady(ws)

      const requestId = 'resume-inline-progress-1'
      const createdPromise = waitForCreated(ws, requestId, 3000)
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'claude',
        sessionRef: {
          provider: 'claude',
          sessionId: VALID_SESSION_ID,
        },
      }))

      const created = await createdPromise

      // Resume should proceed (not be dropped)
      expect(registry.lastCreateOpts?.resumeSessionId).toBe(VALID_SESSION_ID)
      // waitForSession should have been called despite cached result
      expect(sessionRepairService.waitForSessionCalls).toContain(VALID_SESSION_ID)
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('fails closed when Claude restore is requested with a non-canonical sessionRef', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      await waitForReady(ws)

      const requestId = 'resume-invalid-1'
      const responsePromise = waitForMessage(
        ws,
        (m) => (
          m.requestId === requestId
          && (m.type === 'terminal.created' || m.type === 'error')
        ),
      )
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'claude',
        restore: true,
        sessionRef: {
          provider: 'claude',
          sessionId: 'not-a-uuid',
        },
      }))

      const response = await responsePromise

      expect(response).toMatchObject({
        type: 'error',
        code: 'RESTORE_UNAVAILABLE',
      })
      expect(registry.createCallCount).toBe(0)
      expect(registry.records.size).toBe(0)
      expect(sessionRepairService.waitForSessionCalls).not.toContain('not-a-uuid')
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('fails closed when restore is requested without a canonical Claude session id', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      await waitForReady(ws)

      const requestId = 'restore-missing-canonical-1'
      const responsePromise = waitForMessage(
        ws,
        (m) => (
          m.requestId === requestId
          && (m.type === 'terminal.created' || m.type === 'error')
        ),
      )

      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'claude',
        restore: true,
      }))

      const response = await responsePromise

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
})
