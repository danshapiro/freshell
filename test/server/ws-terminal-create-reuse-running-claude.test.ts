import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
    pushRecentDirectory: vi.fn().mockResolvedValue(undefined),
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
  timeoutMs = 5_000,
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
      if (matches.every((entry) => entry !== undefined)) {
        clearTimeout(timeout)
        ws.off('message', handler)
        resolve(matches)
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

function waitForReady(ws: WebSocket): Promise<any> {
  const readyPromise = waitForMessage(ws, (m) => m.type === 'ready')
  ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
  return readyPromise
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
  snapshot() {
    return ''
  }
}

class FakeRegistry {
  record: any
  records = new Map<string, any>()
  createCalls: any[] = []
  attachCalls: Array<{ terminalId: string; opts?: { suppressOutput?: boolean } }> = []

  constructor(terminalId: string) {
    this.record = {
      terminalId,
      createdAt: Date.now(),
      buffer: new FakeBuffer(),
      title: 'Shell',
      mode: 'claude',
      shell: 'system',
      status: 'running',
      cols: 80,
      rows: 24,
      resumeSessionId: VALID_SESSION_ID,
      lastActivityAt: Date.now(),
      clients: new Set<WebSocket>(),
    }
    this.records.set(terminalId, this.record)
  }

  get(terminalId: string) {
    return this.records.get(terminalId) ?? null
  }

  findRunningTerminalBySession(mode: string, sessionId: string) {
    for (const record of this.records.values()) {
      if (record.mode === mode && record.status === 'running' && record.resumeSessionId === sessionId) {
        return record
      }
    }
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
    const record = this.records.get(terminalId)
    if (!record) return undefined
    record.clients.add(ws)
    return record
  }

  resize(terminalId: string, cols: number, rows: number) {
    const record = this.records.get(terminalId)
    if (!record) return false
    record.cols = cols
    record.rows = rows
    return true
  }

  detach(_terminalId: string, ws: WebSocket) {
    for (const record of this.records.values()) {
      record.clients.delete(ws)
    }
    return true
  }

  async killAndWait(terminalId: string) {
    this.records.delete(terminalId)
    return true
  }

  create(opts: any) {
    this.createCalls.push(opts)
    const record = {
      terminalId: `term-created-${this.createCalls.length}`,
      createdAt: Date.now(),
      buffer: new FakeBuffer(),
      title: 'Claude',
      mode: opts.mode,
      shell: opts.shell ?? 'system',
      status: 'running',
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd,
      resumeSessionId: opts.resumeSessionId,
      lastActivityAt: Date.now(),
      clients: new Set<WebSocket>(),
    }
    this.records.set(record.terminalId, record)
    return record
  }

  list() {
    return [...this.records.values()].map((record) => ({
      terminalId: record.terminalId,
      title: record.title,
      mode: record.mode,
      resumeSessionId: record.resumeSessionId,
      sessionRef: record.resumeSessionId
        ? { provider: record.mode, sessionId: record.resumeSessionId }
        : undefined,
      createdAt: record.createdAt,
      lastActivityAt: record.lastActivityAt,
      status: record.status,
      hasClients: record.clients.size > 0,
      cwd: record.cwd,
    }))
  }
}

describe('terminal.create reuse running claude terminal', () => {
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

    registry = new FakeRegistry('term-existing')
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    new WsHandler(server, registry as any)

    const info = await listen(server)
    port = info.port
    registry.attachCalls = []
    snapshotSpy.mockClear()
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

  it('reuses running terminal and requires explicit attach without snapshot pipeline', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      await waitForReady(ws)

      const requestId = 'reuse-1'
      const createdPromise = waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === requestId)
      const terminalsChangedPromise = waitForMessage(ws, (m) => m.type === 'terminals.changed')

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
      const preAttachMsgs = await collectMessages(ws, 150)
      expect(created.terminalId).toBe('term-existing')
      expect(created.snapshot).toBeUndefined()
      expect(created.snapshotChunked).toBeUndefined()
      expect(preAttachMsgs.some((m) => m.type === 'terminal.attach.ready' && m.terminalId === 'term-existing')).toBe(false)
      await terminalsChangedPromise

      expect(registry.attachCalls).toHaveLength(0)
      const attachReadyPromise = waitForMessage(ws,
        (m) => m.type === 'terminal.attach.ready' && m.attachRequestId === 'reuse-1-attach',
      )
      ws.send(JSON.stringify({
        type: 'terminal.attach',
        terminalId: created.terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
        cols: 120,
        rows: 40,
        attachRequestId: 'reuse-1-attach',
      }))
      const ready = await attachReadyPromise

      expect(ready.type).toBe('terminal.attach.ready')
      expect(registry.attachCalls).toHaveLength(1)
      expect(registry.attachCalls[0]?.opts?.suppressOutput).toBe(true)
      expect(snapshotSpy).not.toHaveBeenCalled()
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('existingAfterConfig branch returns created only until explicit attach', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      const readyPromise = waitForMessage(ws, (m) => m.type === 'ready')
      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
      await readyPromise

      const createdPromise = waitForMessage(
        ws,
        (m) => m.type === 'terminal.created' && m.requestId === 'reuse-split-existingAfterConfig',
      )
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'reuse-split-existingAfterConfig',
        mode: 'claude',
        sessionRef: {
          provider: 'claude',
          sessionId: VALID_SESSION_ID,
        },
      }))
      const created = await createdPromise
      const preAttachMsgs = await collectMessages(ws, 150)
      expect(preAttachMsgs.some((m) => m.type === 'terminal.attach.ready' && m.terminalId === created.terminalId)).toBe(false)

      const attachReadyPromise = waitForMessage(
        ws,
        (m) => m.type === 'terminal.attach.ready' && m.attachRequestId === 'reuse-split-existingAfterConfig-attach',
      )
      ws.send(JSON.stringify({
        type: 'terminal.attach',
        terminalId: created.terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
        cols: 120,
        rows: 40,
        attachRequestId: 'reuse-split-existingAfterConfig-attach',
      }))
      const ready = await attachReadyPromise
      expect(ready.terminalId).toBe(created.terminalId)
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('duplicate requestId => one created, no duplicate replay churn', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      const readyPromise = waitForMessage(ws, (m) => m.type === 'ready')
      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
      await readyPromise

      const createdPromise = waitForMessage(
        ws,
        (m) => m.type === 'terminal.created' && m.requestId === 'reuse-claude-dup-split',
      )
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'reuse-claude-dup-split',
        mode: 'claude',
        sessionRef: {
          provider: 'claude',
          sessionId: VALID_SESSION_ID,
        },
      }))
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'reuse-claude-dup-split',
        mode: 'claude',
        sessionRef: {
          provider: 'claude',
          sessionId: VALID_SESSION_ID,
        },
      }))

      const created = await createdPromise
      const msgs = await collectMessages(ws, 200)
      const createdCount = msgs.filter((m) => m.type === 'terminal.created' && m.requestId === 'reuse-claude-dup-split').length + 1
      expect(createdCount).toBe(1)
      expect(msgs.some((m) => m.type === 'terminal.attach.ready' && m.terminalId === created.terminalId)).toBe(false)

      const attachReadyPromise = waitForMessage(
        ws,
        (m) => m.type === 'terminal.attach.ready' && m.attachRequestId === 'reuse-claude-dup-split-attach',
      )
      ws.send(JSON.stringify({
        type: 'terminal.attach',
        terminalId: created.terminalId,
        intent: 'viewport_hydrate',
        sinceSeq: 0,
        cols: 120,
        rows: 40,
        attachRequestId: 'reuse-claude-dup-split-attach',
      }))
      const ready = await attachReadyPromise
      expect(ready.terminalId).toBe(created.terminalId)
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('fresh Claude terminal.create returns a canonical sessionRef immediately', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      await waitForReady(ws)

      const requestId = 'fresh-claude-preallocated'
      const createdPromise = waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === requestId)

      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'claude',
        shell: 'system',
        cwd: '/home/user/project',
        tabId: 'tab-claude-fresh',
        paneId: 'pane-claude-fresh',
      }))

      const created = await createdPromise
      expect(created.sessionRef?.provider).toBe('claude')
      expect(created.sessionRef?.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
      expect(created.cwd).toBe('/home/user/project')
      expect(registry.createCalls.at(-1)).toMatchObject({
        mode: 'claude',
        resumeSessionId: created.sessionRef.sessionId,
        sessionBindingReason: 'start',
        cwd: '/home/user/project',
      })
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('fresh Claude recovery terminal.create also preallocates a canonical sessionRef', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      await waitForReady(ws)

      const requestId = 'fresh-claude-recovery-preallocated'
      const createdPromise = waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === requestId)
      // Live directory: replayed (recovery) creates now drop a persisted cwd
      // that no longer exists, so the pass-through assertions need a real path.
      const liveCwd = process.cwd()

      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'claude',
        shell: 'system',
        cwd: liveCwd,
        recoveryIntent: 'fresh_after_restore_unavailable',
        tabId: 'tab-claude-recovery',
        paneId: 'pane-claude-recovery',
      }))

      const created = await createdPromise
      expect(created.sessionRef?.provider).toBe('claude')
      expect(created.sessionRef?.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
      expect(created.cwd).toBe(liveCwd)
      expect(registry.createCalls.at(-1)).toMatchObject({
        mode: 'claude',
        resumeSessionId: created.sessionRef.sessionId,
        sessionBindingReason: 'start',
        cwd: liveCwd,
      })
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('duplicate fresh Claude terminal.create reuses the preallocated sessionRef', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    try {
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))
      await waitForReady(ws)

      const requestId = 'fresh-claude-duplicate'
      const createdPromise = waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === requestId)

      const payload = {
        type: 'terminal.create',
        requestId,
        mode: 'claude',
        shell: 'system',
        cwd: '/home/user/project',
      }
      ws.send(JSON.stringify(payload))
      ws.send(JSON.stringify(payload))

      const first = await createdPromise
      const extraMessages = await collectMessages(ws, 200)
      const duplicateCreated = extraMessages.filter((m) => m.type === 'terminal.created' && m.requestId === requestId)
      expect(duplicateCreated).toHaveLength(0)
      expect(registry.createCalls).toHaveLength(1)
      expect(registry.createCalls[0]?.resumeSessionId).toBe(first.sessionRef.sessionId)
    } finally {
      await closeWebSocket(ws)
    }
  })
})
