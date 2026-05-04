import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'http'
import WebSocket from 'ws'
import { WsHandler } from '../../server/ws-handler'
import { configStore } from '../../server/config-store'
import { recordSessionLifecycleEvent } from '../../server/session-observability'
import { WS_PROTOCOL_VERSION } from '../../shared/ws-protocol'

const HOOK_TIMEOUT_MS = 30_000
const DEFAULT_CONFIG_SNAPSHOT = vi.hoisted(() => ({
  version: 1,
  settings: {},
  sessionOverrides: {},
  terminalOverrides: {},
  projectColors: {},
}))

vi.mock('crypto', async () => {
  const actual = await vi.importActual<typeof import('crypto')>('crypto')
  return {
    ...actual,
    randomUUID: vi.fn(() => 'conn-1'),
  }
})

vi.mock('../../server/config-store', () => ({
  configStore: {
    snapshot: vi.fn().mockResolvedValue(DEFAULT_CONFIG_SNAPSHOT),
    pushRecentDirectory: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('../../server/session-observability.js', () => ({
  recordSessionLifecycleEvent: vi.fn(),
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

    ws.on('message', handler)
    ws.once('close', onClose)
    ws.once('error', onError)
  })
}

async function connectReady(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  await new Promise<void>((resolve) => ws.on('open', () => resolve()))
  const readyPromise = waitForMessage(ws, (msg) => msg.type === 'ready')
  ws.send(JSON.stringify({
    type: 'hello',
    token: 'testtoken-testtoken',
    protocolVersion: WS_PROTOCOL_VERSION,
  }))
  await readyPromise
  return ws
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

async function waitForLifecycleEvent(expected: Record<string, unknown>, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  let lastError: unknown
  while (Date.now() - start < timeoutMs) {
    try {
      expect(recordSessionLifecycleEvent).toHaveBeenCalledWith(expected)
      return
    } catch (err) {
      lastError = err
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  throw lastError
}

class FakeBuffer {
  snapshot() {
    return ''
  }
}

class FakeRegistry {
  records = new Map<string, any>()
  on = vi.fn()
  off = vi.fn()
  create = vi.fn((opts: any) => {
    const record = {
      terminalId: 'term-created-1',
      title: 'Shell',
      description: undefined,
      mode: opts.mode,
      shell: opts.shell,
      createdAt: 123,
      lastActivityAt: 123,
      status: 'running',
      cwd: opts.cwd,
      resumeSessionId: opts.resumeSessionId,
      runtimeStatus: undefined,
      clients: new Set(),
      buffer: new FakeBuffer(),
    }
    this.records.set(record.terminalId, record)
    return record
  })
  get = vi.fn((terminalId: string) => this.records.get(terminalId) ?? null)
  attach = vi.fn((terminalId: string, ws: WebSocket) => {
    const record = this.records.get(terminalId)
    if (!record || record.status !== 'running') return null
    record.clients.add(ws)
    return record
  })
  detach = vi.fn((terminalId: string, ws: WebSocket) => {
    const record = this.records.get(terminalId)
    if (!record) return false
    record.clients.delete(ws)
    return true
  })
  input = vi.fn((terminalId: string, _data: string) => Boolean(this.records.get(terminalId)))
  resize = vi.fn((terminalId: string, _cols: number, _rows: number) => Boolean(this.records.get(terminalId)))
  kill = vi.fn((terminalId: string) => Boolean(this.records.get(terminalId)))
  finishAttachSnapshot = vi.fn()
  list = vi.fn(() => [])
  findRunningTerminalBySession = vi.fn(() => undefined)
  getCanonicalRunningTerminalBySession = vi.fn(() => undefined)
  repairLegacySessionOwners = vi.fn(() => ({
    repaired: false,
    canonicalTerminalId: undefined,
    clearedTerminalIds: [],
  }))
}

describe('websocket session observability', () => {
  let server: http.Server | undefined
  let port = 0
  let registry: FakeRegistry
  let handler: WsHandler
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

    registry = new FakeRegistry()
    server = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end()
    })
    handler = new WsHandler(server, registry as any, { serverInstanceId: 'server-1' })
    const info = await listen(server)
    port = info.port

    vi.mocked(configStore.snapshot).mockReset()
    vi.mocked(configStore.snapshot).mockResolvedValue(DEFAULT_CONFIG_SNAPSHOT)
    vi.mocked(recordSessionLifecycleEvent).mockClear()
  }, HOOK_TIMEOUT_MS)

  afterEach(async () => {
    ;(handler as any)?.terminalStreamBroker?.close?.()
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()))
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

  it('records terminal create request and result lifecycle events', async () => {
    const ws = await connectReady(port)

    try {
      const createdPromise = waitForMessage(
        ws,
        (msg) => msg.type === 'terminal.created' && msg.requestId === 'req-create-1',
      )

      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId: 'req-create-1',
        tabId: 'tab-1',
        paneId: 'pane-1',
        cwd: '/home/user/project',
        mode: 'shell',
        shell: 'system',
      }))

      await createdPromise

      expect(recordSessionLifecycleEvent).toHaveBeenCalledWith({
        kind: 'terminal_create_requested',
        requestId: 'req-create-1',
        connectionId: 'conn-1',
        tabId: 'tab-1',
        paneId: 'pane-1',
        cwd: '/home/user/project',
        mode: 'shell',
        restoreRequested: false,
        hasRequestedSessionRef: false,
      })
      expect(recordSessionLifecycleEvent).toHaveBeenCalledWith({
        kind: 'terminal_created',
        requestId: 'req-create-1',
        connectionId: 'conn-1',
        terminalId: 'term-created-1',
        tabId: 'tab-1',
        paneId: 'pane-1',
        cwd: '/home/user/project',
        mode: 'shell',
        reused: false,
        hasSessionRef: false,
      })
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('records stale terminal input without logging input data', async () => {
    registry.input.mockReturnValue(false)
    const ws = await connectReady(port)

    try {
      const errorPromise = waitForMessage(
        ws,
        (msg) => msg.type === 'error' && msg.code === 'INVALID_TERMINAL_ID',
      )
      ws.send(JSON.stringify({
        type: 'terminal.input',
        terminalId: 'term-missing',
        data: 'hello',
      }))
      await errorPromise

      expect(recordSessionLifecycleEvent).toHaveBeenCalledWith({
        kind: 'invalid_terminal_id_without_session_ref',
        terminalId: 'term-missing',
        connectionId: 'conn-1',
        operation: 'terminal.input',
        attemptedInputBytes: 5,
      })
      expect(JSON.stringify(vi.mocked(recordSessionLifecycleEvent).mock.calls)).not.toContain('hello')
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('records restore-unavailable client diagnostics', async () => {
    const ws = await connectReady(port)

    try {
      ws.send(JSON.stringify({
        type: 'client.diagnostic',
        event: 'restore_unavailable',
        reason: 'dead_live_handle',
        terminalId: 'term-stale',
        tabId: 'tab-1',
        paneId: 'pane-1',
        mode: 'codex',
        hasSessionRef: false,
      }))

      await waitForLifecycleEvent({
        kind: 'client_restore_unavailable',
        terminalId: 'term-stale',
        connectionId: 'conn-1',
        tabId: 'tab-1',
        paneId: 'pane-1',
        mode: 'codex',
        reason: 'dead_live_handle',
        hasSessionRef: false,
      })
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('records stale terminal resize operations', async () => {
    registry.resize.mockReturnValue(false)
    const ws = await connectReady(port)

    try {
      const errorPromise = waitForMessage(
        ws,
        (msg) => msg.type === 'error' && msg.code === 'INVALID_TERMINAL_ID',
      )
      ws.send(JSON.stringify({
        type: 'terminal.resize',
        terminalId: 'term-missing',
        cols: 120,
        rows: 40,
      }))
      await errorPromise

      expect(recordSessionLifecycleEvent).toHaveBeenCalledWith({
        kind: 'invalid_terminal_id_without_session_ref',
        terminalId: 'term-missing',
        connectionId: 'conn-1',
        operation: 'terminal.resize',
      })
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('records missing terminal attach before stream broker attach', async () => {
    registry.get.mockReturnValue(null)
    const ws = await connectReady(port)

    try {
      const errorPromise = waitForMessage(
        ws,
        (msg) => msg.type === 'error' && msg.code === 'INVALID_TERMINAL_ID',
      )
      ws.send(JSON.stringify({
        type: 'terminal.attach',
        terminalId: 'term-missing',
        intent: 'viewport_hydrate',
        cols: 80,
        rows: 24,
      }))
      await errorPromise

      expect(recordSessionLifecycleEvent).toHaveBeenCalledWith({
        kind: 'invalid_terminal_id_without_session_ref',
        terminalId: 'term-missing',
        connectionId: 'conn-1',
        operation: 'terminal.attach',
      })
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('records exited terminal attach before stream broker attach', async () => {
    registry.get.mockReturnValue({
      terminalId: 'term-missing',
      title: 'Codex',
      mode: 'codex',
      status: 'exited',
      exitCode: 0,
      buffer: new FakeBuffer(),
    })
    const ws = await connectReady(port)

    try {
      const errorPromise = waitForMessage(
        ws,
        (msg) => msg.type === 'error' && msg.code === 'INVALID_TERMINAL_ID',
      )
      ws.send(JSON.stringify({
        type: 'terminal.attach',
        terminalId: 'term-missing',
        intent: 'viewport_hydrate',
        cols: 80,
        rows: 24,
      }))
      await errorPromise

      expect(recordSessionLifecycleEvent).toHaveBeenCalledWith({
        kind: 'invalid_terminal_id_without_session_ref',
        terminalId: 'term-missing',
        connectionId: 'conn-1',
        operation: 'terminal.attach',
      })
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('records broker-missing attach when the latest record is exited', async () => {
    const running = {
      terminalId: 'term-missing',
      title: 'Codex',
      mode: 'codex',
      status: 'running',
      buffer: new FakeBuffer(),
    }
    const exited = { ...running, status: 'exited', exitCode: 0 }
    registry.get
      .mockReturnValueOnce(running)
      .mockReturnValueOnce(exited)
    ;(handler as any).terminalStreamBroker = {
      attach: vi.fn().mockResolvedValue('missing'),
      detach: vi.fn(),
      detachAllForSocket: vi.fn(),
      close: vi.fn(),
    }
    const ws = await connectReady(port)

    try {
      const errorPromise = waitForMessage(
        ws,
        (msg) => msg.type === 'error' && msg.code === 'INVALID_TERMINAL_ID',
      )
      ws.send(JSON.stringify({
        type: 'terminal.attach',
        terminalId: 'term-missing',
        intent: 'viewport_hydrate',
        cols: 80,
        rows: 24,
      }))
      await errorPromise

      expect(recordSessionLifecycleEvent).toHaveBeenCalledWith({
        kind: 'invalid_terminal_id_without_session_ref',
        terminalId: 'term-missing',
        connectionId: 'conn-1',
        operation: 'terminal.attach',
      })
    } finally {
      await closeWebSocket(ws)
    }
  })

  it('records broker-missing attach when no latest record exists', async () => {
    const running = {
      terminalId: 'term-missing',
      title: 'Codex',
      mode: 'codex',
      status: 'running',
      buffer: new FakeBuffer(),
    }
    registry.get
      .mockReturnValueOnce(running)
      .mockReturnValueOnce(null)
    ;(handler as any).terminalStreamBroker = {
      attach: vi.fn().mockResolvedValue('missing'),
      detach: vi.fn(),
      detachAllForSocket: vi.fn(),
      close: vi.fn(),
    }
    const ws = await connectReady(port)

    try {
      const errorPromise = waitForMessage(
        ws,
        (msg) => msg.type === 'error' && msg.code === 'INVALID_TERMINAL_ID',
      )
      ws.send(JSON.stringify({
        type: 'terminal.attach',
        terminalId: 'term-missing',
        intent: 'viewport_hydrate',
        cols: 80,
        rows: 24,
      }))
      await errorPromise

      expect(recordSessionLifecycleEvent).toHaveBeenCalledWith({
        kind: 'invalid_terminal_id_without_session_ref',
        terminalId: 'term-missing',
        connectionId: 'conn-1',
        operation: 'terminal.attach',
      })
    } finally {
      await closeWebSocket(ws)
    }
  })
})
