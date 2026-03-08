import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import http from 'http'
import WebSocket from 'ws'
import { WS_PROTOCOL_VERSION } from '../../shared/ws-protocol'

const HOOK_TIMEOUT_MS = 30_000
const MESSAGE_TIMEOUT_MS = 5_000
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

function waitForMessage(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = MESSAGE_TIMEOUT_MS): Promise<any> {
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

function waitForMessages(
  ws: WebSocket,
  predicates: Array<(msg: any) => boolean>,
  timeoutMs = MESSAGE_TIMEOUT_MS,
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

function waitForReady(ws: WebSocket): Promise<any> {
  const readyPromise = waitForMessage(ws, (m) => m.type === 'ready')
  ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
  return readyPromise
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

function closeWebSocket(ws: WebSocket, timeoutMs = 1_000): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve()
      return
    }

    const cleanup = () => {
      clearTimeout(timeout)
      ws.off('close', onClose)
      ws.off('error', onClose)
    }

    const onClose = () => {
      cleanup()
      resolve()
    }

    const timeout = setTimeout(() => {
      cleanup()
      resolve()
    }, timeoutMs)

    ws.on('close', onClose)
    ws.on('error', onClose)

    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close()
    }
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
  cols: number
  rows: number
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
      cols: 80,
      rows: 24,
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

  resize(terminalId: string, cols: number, rows: number) {
    const record = this.findById(terminalId)
    if (!record) return false
    record.cols = cols
    record.rows = rows
    return true
  }

  list() { return [] }
}

describe('terminal.create reuse running codex terminal', () => {
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
    server = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
    registry = new FakeRegistry(['term-codex-existing'])
    new WsHandler(server, registry as any)
    const info = await listen(server)
    port = info.port
    registry.attachCalls = []
    registry.createCalls = []
    registry.repairCalls = []
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
  }, HOOK_TIMEOUT_MS)

  it('reuses existing codex terminal and requires an explicit attach', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      await waitForReady(ws)

      const requestId = 'codex-reuse-1'
      const createdPromise = waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === requestId)
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'codex',
        resumeSessionId: CODEX_SESSION_ID,
      }))

      const created = await createdPromise
      const preAttachMsgs = await collectMessages(ws, 150)

      expect(created.terminalId).toBe('term-codex-existing')
      expect(preAttachMsgs.some((m) => m.type === 'terminal.attach.ready' && m.terminalId === created.terminalId)).toBe(false)
      expect(registry.attachCalls).toHaveLength(0)
      expect(registry.createCalls).toHaveLength(0)

      const attachReadyPromise = waitForMessage(
        ws,
        (m) => m.type === 'terminal.attach.ready' && m.attachRequestId === 'reuse-existing-codex-attach',
      )
      ws.send(JSON.stringify({
        type: 'terminal.attach',
        terminalId: created.terminalId,
        sinceSeq: 0,
        cols: 120,
        rows: 40,
        attachRequestId: 'reuse-existing-codex-attach',
      }))
      const ready = await attachReadyPromise
      expect(ready.headSeq).toBeGreaterThanOrEqual(0)
      expect(registry.attachCalls).toHaveLength(1)
      expect(registry.attachCalls[0]?.terminalId).toBe('term-codex-existing')
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('canonical reuse branch returns created only until explicit attach', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      await waitForReady(ws)

      const createdPromise = waitForMessage(
        ws,
        (m) => m.type === 'terminal.created' && m.requestId === 'reuse-canonical-split',
      )
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'reuse-canonical-split',
        mode: 'codex',
        resumeSessionId: CODEX_SESSION_ID,
      }))
      const created = await createdPromise
      const preAttachMsgs = await collectMessages(ws, 150)
      expect(preAttachMsgs.some((m) => m.type === 'terminal.attach.ready' && m.terminalId === created.terminalId)).toBe(false)

      const attachReadyPromise = waitForMessage(
        ws,
        (m) => m.type === 'terminal.attach.ready' && m.attachRequestId === 'reuse-canonical-split-attach',
      )
      ws.send(JSON.stringify({
        type: 'terminal.attach',
        terminalId: created.terminalId,
        sinceSeq: 0,
        cols: 120,
        rows: 40,
        attachRequestId: 'reuse-canonical-split-attach',
      }))
      const ready = await attachReadyPromise
      expect(ready.terminalId).toBe(created.terminalId)
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('existingId branch returns created only and requires explicit attach', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      await waitForReady(ws)

      const firstCreatedPromise = waitForMessage(
        ws,
        (m) => m.type === 'terminal.created' && m.requestId === 'reuse-existingId-split',
      )
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'reuse-existingId-split',
        mode: 'codex',
        resumeSessionId: CODEX_SESSION_ID,
      }))
      const firstCreated = await firstCreatedPromise
      const firstMsgs = await collectMessages(ws, 150)
      expect(firstMsgs.some((m) => m.type === 'terminal.attach.ready' && m.terminalId === firstCreated.terminalId)).toBe(false)

      const secondCreatedPromise = waitForMessage(
        ws,
        (m) => m.type === 'terminal.created' && m.requestId === 'reuse-existingId-split',
      )
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'reuse-existingId-split',
        mode: 'codex',
        resumeSessionId: CODEX_SESSION_ID,
      }))
      const secondCreated = await secondCreatedPromise
      expect(secondCreated.terminalId).toBe(firstCreated.terminalId)

      const secondMsgs = await collectMessages(ws, 150)
      expect(secondMsgs.some((m) => m.type === 'terminal.attach.ready' && m.terminalId === firstCreated.terminalId)).toBe(false)

      const attachReadyPromise = waitForMessage(
        ws,
        (m) => m.type === 'terminal.attach.ready' && m.attachRequestId === 'reuse-existingId-split-attach',
      )
      ws.send(JSON.stringify({
        type: 'terminal.attach',
        terminalId: firstCreated.terminalId,
        sinceSeq: 0,
        cols: 120,
        rows: 40,
        attachRequestId: 'reuse-existingId-split-attach',
      }))
      const ready = await attachReadyPromise
      expect(ready.terminalId).toBe(firstCreated.terminalId)
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('returns effectiveResumeSessionId from reused codex terminal', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      await waitForReady(ws)

      const requestId = 'codex-reuse-2'
      const createdPromise = waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === requestId)
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'codex',
        resumeSessionId: CODEX_SESSION_ID,
      }))
      const created = await createdPromise
      expect(created.effectiveResumeSessionId).toBe(CODEX_SESSION_ID)
    } finally {
      await closeWebSocket(ws)
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
      await waitForReady(ws)

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
      const createdPromise = waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === requestId)
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'codex',
        resumeSessionId: CODEX_SESSION_ID,
      }))
      const created = await createdPromise

      expect(created.terminalId).toBe('term-canonical')
      expect(dupeRegistry.createCalls).toHaveLength(0)
      expect(dupeRegistry.repairCalls).toHaveLength(1)
      expect(dupeRegistry.repairCalls[0]).toEqual({ mode: 'codex', sessionId: CODEX_SESSION_ID })

      ws.send(JSON.stringify({
        type: 'terminal.attach',
        terminalId: created.terminalId,
        sinceSeq: 0,
        cols: 120,
        rows: 40,
        attachRequestId: 'codex-reuse-repair-attach',
      }))
      await waitForMessage(
        ws,
        (m) => m.type === 'terminal.attach.ready' && m.attachRequestId === 'codex-reuse-repair-attach',
      )
      expect(dupeRegistry.attachCalls[0]?.terminalId).toBe('term-canonical')
    } finally {
      await closeWebSocket(ws)
      await new Promise<void>((resolve) => dupeServer.close(() => resolve()))
    }
  })
})
