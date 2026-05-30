import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import http from 'http'
import WebSocket from 'ws'
import { WS_PROTOCOL_VERSION } from '../../shared/ws-protocol.js'
import {
  ClaudeActivityRecordSchema,
  ClaudeActivityListResponseSchema,
  ClaudeActivityUpdatedSchema,
  ClaudeActivityListSchema,
  TerminalTurnCompleteSchema,
} from '../../shared/ws-protocol.js'
import {
  FakeCodexLaunchPlanner,
  FakeCodexLaunchSidecar,
  DEFAULT_CODEX_REMOTE_WS_URL,
} from '../helpers/coding-cli/fake-codex-launch-planner.js'

const TEST_TIMEOUT_MS = 30_000
const HOOK_TIMEOUT_MS = 30_000
vi.setConfig({ testTimeout: TEST_TIMEOUT_MS, hookTimeout: HOOK_TIMEOUT_MS })

// Mock the config-store module before importing ws-handler
const mockConfigStore = vi.hoisted(() => ({
  snapshot: vi.fn(),
}))

vi.mock('../../server/config-store', () => ({
  configStore: mockConfigStore,
}))

function defaultConfigSnapshot() {
  return {
    version: 1,
    settings: {},
    sessionOverrides: {},
    terminalOverrides: {},
    projectColors: {},
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

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

function waitForMessage(
  ws: WebSocket,
  predicate: (msg: any) => boolean,
  timeoutMs = 2000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', onMessage)
      ws.off('close', onClose)
      reject(new Error('Timed out waiting for expected WebSocket message'))
    }, timeoutMs)

    const onClose = (code: number, reason: Buffer) => {
      clearTimeout(timeout)
      ws.off('message', onMessage)
      ws.off('close', onClose)
      reject(new Error(`WebSocket closed before expected message (code ${code}, reason ${reason.toString()})`))
    }

    const onMessage = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString())
      if (!predicate(msg)) return
      clearTimeout(timeout)
      ws.off('message', onMessage)
      ws.off('close', onClose)
      resolve(msg)
    }

    ws.on('message', onMessage)
    ws.on('close', onClose)
  })
}

class FakeBuffer {
  private s = ''
  append(t: string) { this.s += t }
  snapshot() { return this.s }
}

class FakeRegistry {
  records = new Map<string, any>()
  // Track calls for verification
  createCalls: any[] = []
  inputCalls: { terminalId: string; data: string }[] = []
  resizeCalls: { terminalId: string; cols: number; rows: number }[] = []
  killCalls: string[] = []
  publishCalls: string[] = []

  create(opts: any) {
    this.createCalls.push(opts)
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

  input(terminalId: string, data: string) {
    const rec = this.records.get(terminalId)
    if (!rec) return { status: 'no_terminal' }
    this.inputCalls.push({ terminalId, data })
    return { status: 'written' }
  }

  resize(terminalId: string, cols: number, rows: number) {
    const rec = this.records.get(terminalId)
    if (!rec) return false
    this.resizeCalls.push({ terminalId, cols, rows })
    return true
  }

  kill(terminalId: string) {
    const rec = this.records.get(terminalId)
    if (!rec) return false
    this.killCalls.push(terminalId)
    this.records.delete(terminalId)
    return true
  }

  async killAndWait(terminalId: string) {
    return this.kill(terminalId)
  }

  publishCodexSidecar(terminalId: string) {
    this.publishCalls.push(terminalId)
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

  findRunningClaudeTerminalBySession(sessionId: string) {
    for (const rec of this.records.values()) {
      if (rec.mode !== 'claude') continue
      if (rec.status !== 'running') continue
      if (rec.resumeSessionId === sessionId) return rec
    }
    return undefined
  }

  getCanonicalRunningTerminalBySession(mode: string, sessionId: string) {
    for (const rec of this.records.values()) {
      if (rec.mode !== mode) continue
      if (rec.status !== 'running') continue
      if (rec.resumeSessionId === sessionId) return rec
    }
    return undefined
  }

  async readCodexDurabilityRecordForRestoreLocator() {
    return null
  }

  async readCodexDurabilityForRestoreLocator() {
    return null
  }

  async deleteCodexDurabilityStoreRecord() {}

  repairLegacySessionOwners() {
    return { repaired: false, clearedTerminalIds: [] }
  }
}

function createAuthenticatedState() {
  return {
    authenticated: true,
    supportsUiScreenshotV1: false,
    attachedTerminalIds: new Set(),
    createdByRequestId: new Map(),
    terminalCreateTimestamps: [],
    codingCliSessions: new Set(),
    codingCliSubscriptions: new Map(),
    sdkSessions: new Set(),
    sdkSubscriptions: new Map(),
    sdkSessionTargets: new Map(),
    interestedSessions: new Set(),
    sidebarOpenSessionKeys: new Set(),
  }
}

function createOpenFakeWs(connectionId: string, sent: any[]) {
  return {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    connectionId,
    send: vi.fn((payload: string, cb?: (err?: Error) => void) => {
      sent.push(JSON.parse(payload))
      cb?.()
    }),
    close: vi.fn(),
  }
}

function countCreateResponses(messages: any[], prefix?: string) {
  return messages.filter((m) => {
    const isCreateResponse =
      m.type === 'terminal.created' || (m.type === 'error' && m.code === 'RATE_LIMITED')
    if (!isCreateResponse) return false
    if (!prefix) return true
    return typeof m.requestId === 'string' && m.requestId.startsWith(prefix)
  }).length
}

function waitForCreateResponses(
  messages: any[],
  expected: number,
  prefix?: string,
  timeoutMs = 1000
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      if (countCreateResponses(messages, prefix) >= expected) {
        resolve()
        return
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timed out waiting for ${expected} create responses`))
        return
      }
      setTimeout(tick, 5)
    }
    tick()
  })
}

describe('ws protocol', () => {
  let server: http.Server | undefined
  let port: number
  let WsHandler: any
  let handler: any
  let registry: FakeRegistry
  let codexLaunchPlanner: FakeCodexLaunchPlanner

  beforeAll(async () => {
    process.env.NODE_ENV = 'test'
    process.env.AUTH_TOKEN = 'testtoken-testtoken'
    // Speed up hello-timeout tests, but keep enough headroom to avoid flakiness under load.
    process.env.HELLO_TIMEOUT_MS = '2000'
    process.env.TERMINAL_CREATE_RATE_LIMIT = '10'
    process.env.TERMINAL_CREATE_RATE_WINDOW_MS = '10000'

    ;({ WsHandler } = await import('../../server/ws-handler'))
    server = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end()
    })
    registry = new FakeRegistry()
    codexLaunchPlanner = new FakeCodexLaunchPlanner()
    handler = new WsHandler(server, registry as any, { codexLaunchPlanner })
    const info = await listen(server)
    port = info.port
  }, HOOK_TIMEOUT_MS)

  beforeEach(() => {
    // Clear registry state between tests
    mockConfigStore.snapshot.mockReset()
    mockConfigStore.snapshot.mockResolvedValue(defaultConfigSnapshot())
    registry.records.clear()
    registry.createCalls = []
    registry.inputCalls = []
    registry.resizeCalls = []
    registry.killCalls = []
    registry.publishCalls = []
    codexLaunchPlanner.planCreateCalls = []
    codexLaunchPlanner.sidecar.adoptCalls = []
    codexLaunchPlanner.sidecar.shutdownCalls = 0
    codexLaunchPlanner.sidecar.shutdownStarted = false
    codexLaunchPlanner.sidecar.shutdownError = null
  })

  afterAll(async () => {
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }, HOOK_TIMEOUT_MS)

  it('rejects invalid token', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const close = new Promise<{ code: number }>((resolve) => {
      ws.on('close', (code) => resolve({ code }))
    })
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'wrong', protocolVersion: WS_PROTOCOL_VERSION }))
    const result = await close
    expect(result.code).toBe(4001)
  })

  it('accepts valid hello and responds ready', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))

    const ready = await new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'ready') resolve(msg)
      })
    })
    expect(ready.type).toBe('ready')
    await closeWebSocket(ws)
  })

  it('accepts hello with capabilities', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))

    ws.send(JSON.stringify({
      type: 'hello',
      token: 'testtoken-testtoken',
      protocolVersion: WS_PROTOCOL_VERSION,
      capabilities: { uiScreenshotV1: true },
    }))

    const ready = await new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'ready') resolve(msg)
      })
    })
    expect(ready.type).toBe('ready')
    await closeWebSocket(ws)
  })

  it('respects hello client.mobile override when classifying the connection', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: {
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      },
    })
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))

    ws.send(JSON.stringify({
      type: 'hello',
      token: 'testtoken-testtoken',
      protocolVersion: WS_PROTOCOL_VERSION,
      client: { mobile: true },
    }))
    await waitForMessage(ws, (msg) => msg.type === 'ready', 5000)

    const requestId = 'req-mobile-override'
    ws.send(JSON.stringify({ type: 'terminal.create', requestId, mode: 'shell' }))
    const created = await waitForMessage(
      ws,
      (msg) => msg.type === 'terminal.created' && msg.requestId === requestId,
      5000,
    )
    ws.send(JSON.stringify({
      type: 'terminal.attach',
      terminalId: created.terminalId,
      intent: 'viewport_hydrate',
      sinceSeq: 0,
      cols: 120,
      rows: 40,
    }))
    await waitForMessage(
      ws,
      (msg) => msg.type === 'terminal.attach.ready' && msg.terminalId === created.terminalId,
      5000,
    )

    const record = registry.records.get(created.terminalId)
    expect(record).toBeDefined()
    if (!record) throw new Error('missing terminal record after create')
    const attachedClient = Array.from(record.clients)[0] as { isMobileClient?: boolean } | undefined
    expect(attachedClient?.isMobileClient).toBe(true)

    await closeWebSocket(ws)
  })

  it('creates a terminal and returns terminal.created', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))

    await new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'ready') resolve()
      })
    })

    const requestId = 'req-1'
    ws.send(JSON.stringify({ type: 'terminal.create', requestId, mode: 'shell' }))

    const created = await new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'terminal.created' && msg.requestId === requestId) resolve(msg)
      })
    })

    expect(created.terminalId).toMatch(/^term_/)
    await closeWebSocket(ws)
  })

  it('passes persisted coding CLI provider settings into registry.create', async () => {
    mockConfigStore.snapshot.mockResolvedValue({
      ...defaultConfigSnapshot(),
      settings: {
        codingCli: {
          providers: {
            codex: {
              model: 'gpt-5-codex',
              sandbox: 'workspace-write',
            },
          },
        },
      },
    })

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))

    await waitForMessage(ws, (msg) => msg.type === 'ready', 5000)

    const requestId = 'req-codex-settings'
    ws.send(JSON.stringify({ type: 'terminal.create', requestId, mode: 'codex' }))
    await waitForMessage(
      ws,
      (msg) => msg.type === 'terminal.created' && msg.requestId === requestId,
      5000,
    )

    expect(registry.createCalls).toHaveLength(1)
    expect(codexLaunchPlanner.planCreateCalls).toEqual([{
      approvalPolicy: undefined,
      cwd: undefined,
      model: 'gpt-5-codex',
      resumeSessionId: undefined,
      sandbox: 'workspace-write',
    }])
    expect(registry.createCalls[0]?.resumeSessionId).toBeUndefined()
    expect(registry.createCalls[0]?.providerSettings).toEqual({
      codexAppServer: expect.objectContaining({
        wsUrl: DEFAULT_CODEX_REMOTE_WS_URL,
      }),
    })

    await closeWebSocket(ws)
  })

  it('shuts down a pending Codex sidecar when terminal.create fails after planning', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
    await waitForMessage(ws, (msg) => msg.type === 'ready', 5000)

    const originalCreate = registry.create.bind(registry)
    registry.create = vi.fn((opts: any) => {
      registry.createCalls.push(opts)
      throw new Error('spawn failed after planning')
    }) as any

    try {
      ws.send(JSON.stringify({ type: 'terminal.create', requestId: 'codex-create-fails', mode: 'codex' }))
      const error = await waitForMessage(
        ws,
        (msg) => msg.type === 'error' && msg.requestId === 'codex-create-fails',
        5000,
      )

      expect(error.message).toContain('spawn failed after planning')
      expect(codexLaunchPlanner.sidecar.shutdownCalls).toBe(1)
      expect(codexLaunchPlanner.sidecar.adoptCalls).toEqual([])
    } finally {
      registry.create = originalCreate as any
      await closeWebSocket(ws)
    }
  })

  it('reports terminal.create cleanup failure when pending Codex sidecar shutdown fails', async () => {
    codexLaunchPlanner.sidecar.shutdownError = new Error('verified sidecar teardown failed')
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
    await waitForMessage(ws, (msg) => msg.type === 'ready', 5000)

    const originalCreate = registry.create.bind(registry)
    registry.create = vi.fn((opts: any) => {
      registry.createCalls.push(opts)
      throw new Error('spawn failed after planning')
    }) as any

    try {
      ws.send(JSON.stringify({ type: 'terminal.create', requestId: 'codex-cleanup-fails', mode: 'codex' }))
      const error = await waitForMessage(
        ws,
        (msg) => msg.type === 'error' && msg.requestId === 'codex-cleanup-fails',
        5000,
      )

      expect(error.message).toContain('spawn failed after planning')
      expect(error.message).toContain('verified sidecar teardown failed')
      expect(codexLaunchPlanner.sidecar.shutdownCalls).toBe(1)
      expect(codexLaunchPlanner.sidecar.adoptCalls).toEqual([])
    } finally {
      registry.create = originalCreate as any
      await closeWebSocket(ws)
    }
  })

  it('kills the inserted terminal when terminal.create fails before registry.create returns', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
    await waitForMessage(ws, (msg) => msg.type === 'ready', 5000)

    const originalCreate = registry.create.bind(registry)
    registry.create = vi.fn((opts: any) => {
      registry.createCalls.push(opts)
      const terminalId = 'term_inserted_before_emit_failure'
      registry.records.set(terminalId, {
        terminalId,
        createdAt: Date.now(),
        buffer: new FakeBuffer(),
        title: 'Codex',
        mode: opts.mode || 'codex',
        shell: opts.shell || 'system',
        status: 'running',
        resumeSessionId: opts.resumeSessionId,
        clients: new Set(),
      })
      const error = new Error('terminal.created listener failed') as Error & { terminalId?: string }
      error.terminalId = terminalId
      throw error
    }) as any

    try {
      ws.send(JSON.stringify({ type: 'terminal.create', requestId: 'codex-create-emit-fails', mode: 'codex' }))
      const error = await waitForMessage(
        ws,
        (msg) => msg.type === 'error' && msg.requestId === 'codex-create-emit-fails',
        5000,
      )

      expect(error.message).toContain('terminal.created listener failed')
      expect(registry.killCalls).toContain('term_inserted_before_emit_failure')
      expect(registry.records.has('term_inserted_before_emit_failure')).toBe(false)
      expect(codexLaunchPlanner.sidecar.shutdownCalls).toBe(1)
    } finally {
      registry.create = originalCreate as any
      await closeWebSocket(ws)
    }
  })

  it('rejects late terminal.create after the WebSocket handler starts closing', async () => {
    const localServer = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end()
    })
    const localRegistry = new FakeRegistry()
    const localPlanner = new FakeCodexLaunchPlanner()
    const localHandler = new WsHandler(localServer, localRegistry as any, { codexLaunchPlanner: localPlanner })
    const sent: any[] = []
    const ws = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      connectionId: 'late-create-after-close',
      send: vi.fn((payload: string, cb?: (err?: Error) => void) => {
        sent.push(JSON.parse(payload))
        cb?.()
      }),
      close: vi.fn(),
    }
    const state = {
      authenticated: true,
      supportsUiScreenshotV1: false,
      attachedTerminalIds: new Set(),
      createdByRequestId: new Map(),
      terminalCreateTimestamps: [],
      codingCliSessions: new Set(),
      codingCliSubscriptions: new Map(),
      sdkSessions: new Set(),
      sdkSubscriptions: new Map(),
      sdkSessionTargets: new Map(),
      interestedSessions: new Set(),
      sidebarOpenSessionKeys: new Set(),
    }

    localHandler.close()
    await (localHandler as any).onMessage(
      ws,
      state,
      Buffer.from(JSON.stringify({ type: 'terminal.create', requestId: 'after-close', mode: 'codex' })),
    )

    expect(sent).toContainEqual(expect.objectContaining({
      type: 'error',
      requestId: 'after-close',
    }))
    expect(localRegistry.createCalls).toEqual([])
    expect(localPlanner.planCreateCalls).toEqual([])
  })

  it('aborts in-flight Codex terminal.create when shutdown starts after planning before registry create', async () => {
    const localServer = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end()
    })
    const localRegistry = new FakeRegistry()
    const sidecar = new FakeCodexLaunchSidecar()
    const plan = deferred<any>()
    const localPlanner = {
      planCreateCalls: [] as any[],
      planCreate: vi.fn((input: any) => {
        localPlanner.planCreateCalls.push(input)
        return plan.promise
      }),
    }
    const localHandler = new WsHandler(localServer, localRegistry as any, { codexLaunchPlanner: localPlanner as any })
    const sent: any[] = []
    const ws = createOpenFakeWs('shutdown-after-plan', sent)
    const state = createAuthenticatedState()

    const message = (localHandler as any).onMessage(
      ws,
      state,
      Buffer.from(JSON.stringify({ type: 'terminal.create', requestId: 'shutdown-after-plan', mode: 'codex' })),
    )
    await vi.waitFor(() => expect(localPlanner.planCreate).toHaveBeenCalledTimes(1))
    localHandler.close()
    plan.resolve({
      sessionId: 'thread-after-plan',
      remote: { wsUrl: DEFAULT_CODEX_REMOTE_WS_URL },
      sidecar,
    })
    await message

    expect(sent).toContainEqual(expect.objectContaining({
      type: 'error',
      requestId: 'shutdown-after-plan',
    }))
    expect(localRegistry.createCalls).toEqual([])
    expect(sidecar.shutdownCalls).toBe(1)
  })

  it('aborts in-flight Codex terminal.create when shutdown starts after registry create before adoption', async () => {
    const localServer = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end()
    })
    const localRegistry = new FakeRegistry()
    const sidecar = new FakeCodexLaunchSidecar()
    const localPlanner = new FakeCodexLaunchPlanner({
      sessionId: 'thread-after-registry-create',
      remote: { wsUrl: DEFAULT_CODEX_REMOTE_WS_URL },
      sidecar,
    })
    const localHandler = new WsHandler(localServer, localRegistry as any, { codexLaunchPlanner: localPlanner })
    const originalCreate = localRegistry.create.bind(localRegistry)
    localRegistry.create = vi.fn((opts: any) => {
      const record = originalCreate(opts)
      localHandler.close()
      return record
    }) as any
    const sent: any[] = []
    const ws = createOpenFakeWs('shutdown-after-registry-create', sent)
    const state = createAuthenticatedState()

    await (localHandler as any).onMessage(
      ws,
      state,
      Buffer.from(JSON.stringify({ type: 'terminal.create', requestId: 'shutdown-after-registry-create', mode: 'codex' })),
    )

    expect(sent).toContainEqual(expect.objectContaining({
      type: 'error',
      requestId: 'shutdown-after-registry-create',
    }))
    expect(sidecar.adoptCalls).toEqual([])
    expect(sidecar.shutdownCalls).toBe(1)
    expect(localRegistry.killCalls).toHaveLength(1)
    expect(localRegistry.records.size).toBe(0)
  })

  it('aborts in-flight Codex terminal.create when shutdown starts after adoption before publication', async () => {
    const localServer = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end()
    })
    const localRegistry = new FakeRegistry()
    const sidecar = new FakeCodexLaunchSidecar()
    const originalAdopt = sidecar.adopt.bind(sidecar)
    const localPlanner = new FakeCodexLaunchPlanner({
      sessionId: 'thread-after-adoption',
      remote: { wsUrl: DEFAULT_CODEX_REMOTE_WS_URL },
      sidecar,
    })
    const localHandler = new WsHandler(localServer, localRegistry as any, { codexLaunchPlanner: localPlanner })
    vi.spyOn(sidecar, 'adopt').mockImplementation(async (input) => {
      await originalAdopt(input)
      localHandler.close()
    })
    const sent: any[] = []
    const ws = createOpenFakeWs('shutdown-after-adoption', sent)
    const state = createAuthenticatedState()

    await (localHandler as any).onMessage(
      ws,
      state,
      Buffer.from(JSON.stringify({ type: 'terminal.create', requestId: 'shutdown-after-adoption', mode: 'codex' })),
    )

    expect(sent).toContainEqual(expect.objectContaining({
      type: 'error',
      requestId: 'shutdown-after-adoption',
    }))
    expect(sidecar.adoptCalls).toHaveLength(1)
    expect(localRegistry.publishCalls).toEqual([])
    expect(localRegistry.killCalls).toHaveLength(1)
    expect(sidecar.shutdownCalls).toBe(1)
    expect(localRegistry.records.size).toBe(0)
  })

  it('reports Codex resume create success without loaded-thread readiness polling', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
    await waitForMessage(ws, (msg) => msg.type === 'ready', 5000)

    const requestId = 'codex-resume-loaded-list'
    ws.send(JSON.stringify({
      type: 'terminal.create',
      requestId,
      mode: 'codex',
      sessionRef: { provider: 'codex', sessionId: 'thread-resume-1' },
    }))
    const created = await waitForMessage(
      ws,
      (msg) => msg.type === 'terminal.created' && msg.requestId === requestId,
      5000,
    )

    expect(codexLaunchPlanner.planCreateCalls[0]).toEqual(expect.objectContaining({
      resumeSessionId: 'thread-resume-1',
    }))
    expect(registry.publishCalls).toEqual([created.terminalId])

    await closeWebSocket(ws)
  })

  it('kills the created terminal and sidecar when the Codex resume PTY exits before publication', async () => {
    const originalAdopt = codexLaunchPlanner.sidecar.adopt.bind(codexLaunchPlanner.sidecar)
    const adoptSpy = vi.spyOn(codexLaunchPlanner.sidecar, 'adopt').mockImplementation(async (input) => {
      await originalAdopt(input)
      const terminalId = codexLaunchPlanner.sidecar.adoptCalls[0]?.terminalId
      const record = terminalId ? registry.get(terminalId) : null
      if (record) record.status = 'exited'
    })
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
    await waitForMessage(ws, (msg) => msg.type === 'ready', 5000)

    const requestId = 'codex-resume-pty-exits-before-publication'
    try {
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId,
        mode: 'codex',
        sessionRef: { provider: 'codex', sessionId: 'thread-resume-exits' },
      }))
      const error = await waitForMessage(
        ws,
        (msg) => msg.type === 'error' && msg.requestId === requestId,
        5000,
      )

      expect(error.message).toContain('Codex terminal PTY exited before create completed')
      expect(codexLaunchPlanner.sidecar.shutdownCalls).toBe(1)
      expect(registry.killCalls).toHaveLength(1)
      expect(registry.records.size).toBe(0)
    } finally {
      adoptSpy.mockRestore()
      await closeWebSocket(ws)
    }
  })

  it('returns INVALID_MESSAGE when persisted Codex settings are invalid', async () => {
    mockConfigStore.snapshot.mockResolvedValue({
      ...defaultConfigSnapshot(),
      settings: {
        codingCli: {
          providers: {
            codex: {
              sandbox: 'totally-open',
            },
          },
        },
      },
    })

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))

    await waitForMessage(ws, (msg) => msg.type === 'ready', 5000)

    const requestId = 'req-codex-invalid-settings'
    ws.send(JSON.stringify({ type: 'terminal.create', requestId, mode: 'codex' }))

    const error = await waitForMessage(
      ws,
      (msg) => msg.type === 'error' && msg.requestId === requestId,
      5000,
    )

    expect(error.code).toBe('INVALID_MESSAGE')
    expect(error.message).toBe(
      'Invalid Codex sandbox setting "totally-open". Expected read-only, workspace-write, or danger-full-access.',
    )
    expect(registry.createCalls).toHaveLength(0)
    await closeWebSocket(ws)
  })

  it('accepts shell parameter with system default', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))

    await new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'ready') resolve()
      })
    })

    const requestId = 'req-shell-1'
    // shell defaults to 'system' when not specified
    ws.send(JSON.stringify({ type: 'terminal.create', requestId, mode: 'shell' }))

    const created = await new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'terminal.created' && msg.requestId === requestId) resolve(msg)
      })
    })

    expect(created.terminalId).toMatch(/^term_/)
    await closeWebSocket(ws)
  })

  it('accepts explicit shell parameter', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))

    await new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'ready') resolve()
      })
    })

    const requestId = 'req-shell-2'
    // Platform-appropriate shell: on Windows, could be cmd/powershell/wsl; on others, normalized to system
    const shell = process.platform === 'win32' ? 'powershell' : 'system'
    ws.send(JSON.stringify({ type: 'terminal.create', requestId, mode: 'shell', shell }))

    const created = await new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'terminal.created' && msg.requestId === requestId) resolve(msg)
      })
    })

    expect(created.terminalId).toMatch(/^term_/)
    await closeWebSocket(ws)
  })

  // Helper function to create authenticated connection
  async function createAuthenticatedConnection(): Promise<{ ws: WebSocket; close: () => Promise<void> }> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))

    await waitForMessage(ws, (msg) => msg.type === 'ready', 5000)

    return { ws, close: () => closeWebSocket(ws) }
  }

  // Helper function to create a terminal and return its ID
  async function createTerminal(ws: WebSocket, requestId: string): Promise<string> {
    ws.send(JSON.stringify({ type: 'terminal.create', requestId, mode: 'shell' }))

    const msg = await waitForMessage(
      ws,
      (m) => typeof m?.requestId === 'string' && m.requestId === requestId && (m.type === 'terminal.created' || m.type === 'error'),
      5000,
    )

    if (msg.type === 'error') {
      throw new Error(`terminal.create failed: ${msg.code || 'UNKNOWN_ERROR'}`)
    }
    return msg.terminalId
  }

  it('terminal.attach rejects missing intent', async () => {
    const { ws, close } = await createAuthenticatedConnection()
    const terminalId = await createTerminal(ws, 'missing-viewport-create')
    ws.send(JSON.stringify({ type: 'terminal.attach', terminalId, cols: 120, rows: 40 }))
    const err = await waitForMessage(ws, (m) => m.type === 'error')
    expect(err.code).toBe('INVALID_MESSAGE')
    await close()
  })

  it('terminal.attach rejects partial viewport payload (cols only)', async () => {
    const { ws, close } = await createAuthenticatedConnection()
    const terminalId = await createTerminal(ws, 'partial-viewport-create')
    ws.send(JSON.stringify({ type: 'terminal.attach', terminalId, intent: 'viewport_hydrate', cols: 120 }))
    const err = await waitForMessage(ws, (m) => m.type === 'error')
    expect(err.code).toBe('INVALID_MESSAGE')
    await close()
  })

  it('terminal.attach accepts paired viewport payload', async () => {
    const { ws, close } = await createAuthenticatedConnection()
    const terminalId = await createTerminal(ws, 'paired-viewport-create')
    ws.send(JSON.stringify({ type: 'terminal.attach', terminalId, intent: 'viewport_hydrate', cols: 120, rows: 40, sinceSeq: 0 }))
    const ready = await waitForMessage(ws, (m) => m.type === 'terminal.attach.ready' && m.terminalId === terminalId)
    expect(ready.terminalId).toBe(terminalId)
    await close()
  })

  // Helper to collect messages until a condition is met
  function collectUntil(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 1000): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const messages: any[] = []
      const timeout = setTimeout(() => {
        ws.off('message', handler)
        reject(new Error('Timeout waiting for message'))
      }, timeoutMs)

      const handler = (data: WebSocket.Data) => {
        const msg = JSON.parse(data.toString())
        messages.push(msg)
        if (predicate(msg)) {
          clearTimeout(timeout)
          ws.off('message', handler)
          resolve(messages)
        }
      }
      ws.on('message', handler)
    })
  }

  it('terminal.attach connects to existing terminal', async () => {
    const { ws, close } = await createAuthenticatedConnection()

    // First create a terminal
    const terminalId = await createTerminal(ws, 'create-for-attach')

    // Create a second connection to attach
    const { ws: ws2, close: close2 } = await createAuthenticatedConnection()

    ws2.send(JSON.stringify({ type: 'terminal.attach', terminalId, intent: 'viewport_hydrate', sinceSeq: 0, cols: 120, rows: 40 }))

    const ready = await new Promise<any>((resolve) => {
      ws2.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'terminal.attach.ready' && msg.terminalId === terminalId) resolve(msg)
      })
    })

    expect(ready.type).toBe('terminal.attach.ready')
    expect(ready.terminalId).toBe(terminalId)
    expect(typeof ready.replayFromSeq).toBe('number')
    expect(typeof ready.replayToSeq).toBe('number')

    await close()
    await close2()
  })

  it('terminal.attach returns error for non-existent terminal', async () => {
    const { ws, close } = await createAuthenticatedConnection()

    ws.send(JSON.stringify({ type: 'terminal.attach', terminalId: 'nonexistent_terminal', intent: 'viewport_hydrate', sinceSeq: 0, cols: 120, rows: 40 }))

    const error = await new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'error') resolve(msg)
      })
    })

    expect(error.type).toBe('error')
    expect(error.code).toBe('INVALID_TERMINAL_ID')
    expect(error.terminalId).toBe('nonexistent_terminal')

    await close()
  })

  it('terminal.detach disconnects from terminal', async () => {
    const { ws, close } = await createAuthenticatedConnection()

    // Create and attach to a terminal
    const terminalId = await createTerminal(ws, 'create-for-detach')

    ws.send(JSON.stringify({ type: 'terminal.detach', terminalId }))

    const detached = await new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'terminal.detached') resolve(msg)
      })
    })

    expect(detached.type).toBe('terminal.detached')
    expect(detached.terminalId).toBe(terminalId)

    await close()
  })

  it('terminal.detach returns error for non-existent terminal', async () => {
    const { ws, close } = await createAuthenticatedConnection()

    ws.send(JSON.stringify({ type: 'terminal.detach', terminalId: 'nonexistent_terminal' }))

    const error = await new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'error') resolve(msg)
      })
    })

    expect(error.type).toBe('error')
    expect(error.code).toBe('INVALID_TERMINAL_ID')
    expect(error.terminalId).toBe('nonexistent_terminal')

    await close()
  })

  it('terminal.input sends data to terminal', async () => {
    const { ws, close } = await createAuthenticatedConnection()

    const terminalId = await createTerminal(ws, 'create-for-input')

    ws.send(JSON.stringify({ type: 'terminal.input', terminalId, data: 'echo hello' }))

    // Give a small delay for the input to be processed
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(registry.inputCalls).toHaveLength(1)
    expect(registry.inputCalls[0].terminalId).toBe(terminalId)
    expect(registry.inputCalls[0].data).toBe('echo hello')

    await close()
  })

  it('terminal.input returns error for non-existent terminal', async () => {
    const { ws, close } = await createAuthenticatedConnection()

    ws.send(JSON.stringify({ type: 'terminal.input', terminalId: 'nonexistent_terminal', data: 'test' }))

    const error = await new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'error') resolve(msg)
      })
    })

    expect(error.type).toBe('error')
    expect(error.code).toBe('INVALID_TERMINAL_ID')
    expect(error.terminalId).toBe('nonexistent_terminal')

    await close()
  })

  it('terminal.input reports Codex identity capture timeout as blocked input', async () => {
    const { ws, close } = await createAuthenticatedConnection()

    const terminalId = await createTerminal(ws, 'create-for-codex-timeout-input')
    const originalInput = registry.input.bind(registry)
    registry.input = vi.fn(() => ({
      status: 'blocked_codex_identity_capture_timeout',
      terminalId,
    })) as any

    try {
      ws.send(JSON.stringify({ type: 'terminal.input', terminalId, data: 'test' }))

      const blocked = await waitForMessage(ws, (msg) => msg.type === 'terminal.input.blocked')
      expect(blocked).toEqual({
        type: 'terminal.input.blocked',
        terminalId,
        reason: 'codex_identity_capture_timeout',
      })
    } finally {
      registry.input = originalInput as any
      await close()
    }
  })

  it('terminal.input reports Codex lifecycle-loss proof as blocked input', async () => {
    const { ws, close } = await createAuthenticatedConnection()

    const terminalId = await createTerminal(ws, 'create-for-codex-lifecycle-loss-input')
    const originalInput = registry.input.bind(registry)
    registry.input = vi.fn(() => ({
      status: 'blocked_codex_lifecycle_loss_pending',
      terminalId,
    })) as any

    try {
      ws.send(JSON.stringify({ type: 'terminal.input', terminalId, data: 'test' }))

      const blocked = await waitForMessage(ws, (msg) => msg.type === 'terminal.input.blocked')
      expect(blocked).toEqual({
        type: 'terminal.input.blocked',
        terminalId,
        reason: 'codex_lifecycle_loss_pending',
      })
    } finally {
      registry.input = originalInput as any
      await close()
    }
  })

  it('terminal.input reports Codex clean-exit decision as blocked input', async () => {
    const { ws, close } = await createAuthenticatedConnection()

    const terminalId = await createTerminal(ws, 'create-for-codex-clean-exit-decision-input')
    const originalInput = registry.input.bind(registry)
    registry.input = vi.fn(() => ({
      status: 'blocked_codex_clean_exit_decision_pending',
      terminalId,
    })) as any

    try {
      ws.send(JSON.stringify({ type: 'terminal.input', terminalId, data: 'test' }))

      const blocked = await waitForMessage(ws, (msg) => msg.type === 'terminal.input.blocked')
      expect(blocked).toEqual({
        type: 'terminal.input.blocked',
        terminalId,
        reason: 'codex_clean_exit_decision_pending',
      })
    } finally {
      registry.input = originalInput as any
      await close()
    }
  })

  it('terminal.resize changes terminal dimensions', async () => {
    const { ws, close } = await createAuthenticatedConnection()

    const terminalId = await createTerminal(ws, 'create-for-resize')

    ws.send(JSON.stringify({ type: 'terminal.resize', terminalId, cols: 120, rows: 40 }))

    // Give a small delay for the resize to be processed
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(registry.resizeCalls).toHaveLength(1)
    expect(registry.resizeCalls[0].terminalId).toBe(terminalId)
    expect(registry.resizeCalls[0].cols).toBe(120)
    expect(registry.resizeCalls[0].rows).toBe(40)

    await close()
  })

  it('terminal.resize returns error for non-existent terminal', async () => {
    const { ws, close } = await createAuthenticatedConnection()

    ws.send(JSON.stringify({ type: 'terminal.resize', terminalId: 'nonexistent_terminal', cols: 80, rows: 24 }))

    const error = await new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'error') resolve(msg)
      })
    })

    expect(error.type).toBe('error')
    expect(error.code).toBe('INVALID_TERMINAL_ID')
    expect(error.terminalId).toBe('nonexistent_terminal')

    await close()
  })

  it('terminal.kill terminates terminal', async () => {
    const { ws, close } = await createAuthenticatedConnection()

    const terminalId = await createTerminal(ws, 'create-for-kill')

    // Verify the terminal exists
    expect(registry.records.has(terminalId)).toBe(true)

    ws.send(JSON.stringify({ type: 'terminal.kill', terminalId }))

    // Wait for directory invalidation broadcast
    await new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'terminals.changed') resolve()
      })
    })

    expect(registry.killCalls).toContain(terminalId)
    expect(registry.records.has(terminalId)).toBe(false)

    await close()
  })

  it('terminal.kill returns error for non-existent terminal', async () => {
    const { ws, close } = await createAuthenticatedConnection()

    ws.send(JSON.stringify({ type: 'terminal.kill', terminalId: 'nonexistent_terminal' }))

    const error = await new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'error') resolve(msg)
      })
    })

    expect(error.type).toBe('error')
    expect(error.code).toBe('INVALID_TERMINAL_ID')
    expect(error.terminalId).toBe('nonexistent_terminal')

    await close()
  })

  it('terminal.kill returns a protocol error when verified Codex teardown fails', async () => {
    const { ws, close } = await createAuthenticatedConnection()
    const originalKillAndWait = registry.killAndWait.bind(registry)
    registry.killAndWait = vi.fn(async () => {
      throw new Error('verified Codex teardown failed')
    }) as any

    try {
      ws.send(JSON.stringify({ type: 'terminal.kill', terminalId: 'codex-terminal-with-failed-teardown' }))

      const error = await waitForMessage(
        ws,
        (msg) => msg.type === 'error' && msg.terminalId === 'codex-terminal-with-failed-teardown',
        5000,
      )

      expect(error.code).toBe('INTERNAL_ERROR')
      expect(error.message).toContain('verified Codex teardown failed')
    } finally {
      registry.killAndWait = originalKillAndWait as any
      await close()
    }
  })

  it('rejects legacy terminal.list commands', async () => {
    const { ws, close } = await createAuthenticatedConnection()

    ws.send(JSON.stringify({ type: 'terminal.list', requestId: 'list-req-1' }))

    const error = await new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'error' && msg.requestId === 'list-req-1') resolve(msg)
      })
    })

    expect(error.type).toBe('error')
    expect(error.requestId).toBe('list-req-1')
    expect(error.code).toBe('INVALID_MESSAGE')

    await close()
  })

  it('invalid message types return error', async () => {
    const { ws, close } = await createAuthenticatedConnection()

    // Send a message with an unknown type - use raw JSON to bypass type checking
    ws.send(JSON.stringify({ type: 'unknown.message.type', requestId: 'unknown-1' }))

    const error = await new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'error') resolve(msg)
      })
    })

    expect(error.type).toBe('error')
    expect(error.code).toBe('INVALID_MESSAGE')

    await close()
  })

  it('invalid JSON returns error', async () => {
    const { ws, close } = await createAuthenticatedConnection()

    // Send invalid JSON
    ws.send('this is not json {{{')

    const error = await new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'error') resolve(msg)
      })
    })

    expect(error.type).toBe('error')
    expect(error.code).toBe('INVALID_MESSAGE')
    expect(error.message).toBe('Invalid JSON')

    await close()
  })

  it('messages before hello are rejected', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))

    // Send a terminal.create without authenticating first
    ws.send(JSON.stringify({ type: 'terminal.create', requestId: 'early-req', mode: 'shell' }))

    const close = new Promise<{ code: number }>((resolve) => {
      ws.on('close', (code) => resolve({ code }))
    })

    const error = await new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'error') resolve(msg)
      })
    })

    expect(error.type).toBe('error')
    expect(error.code).toBe('NOT_AUTHENTICATED')
    expect(error.message).toBe('Send hello first')

    const result = await close
    expect(result.code).toBe(4001)
  })

  it('connection timeout on no hello', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))

    // Don't send hello, wait for timeout (HELLO_TIMEOUT_MS is set to 100ms in test)
    const close = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    })

    const result = await close
    expect(result.code).toBe(4002) // HELLO_TIMEOUT
  })

  it('ping responds with pong', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))

    // Ping works even before authentication
    ws.send(JSON.stringify({ type: 'ping' }))

    const pong = await new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'pong') resolve(msg)
      })
    })

    expect(pong.type).toBe('pong')
    expect(pong.timestamp).toBeDefined()

    await closeWebSocket(ws)
  })

  it('rate limits terminal.create after too many requests', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))

    await new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'ready') resolve()
      })
    })

    const messages: any[] = []
    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()))
    })

    // Send 11 terminal.create requests rapidly (default limit is 10 per 10s)
    for (let i = 0; i < 11; i++) {
      ws.send(JSON.stringify({ type: 'terminal.create', requestId: `rate-test-${i}`, mode: 'shell' }))
    }

    await waitForCreateResponses(messages, 11, 'rate-test-')

    const created = messages.filter((m) =>
      m.type === 'terminal.created' && typeof m.requestId === 'string' && m.requestId.startsWith('rate-test-')
    )
    const rateLimited = messages.filter((m) =>
      m.type === 'error' && m.code === 'RATE_LIMITED' && typeof m.requestId === 'string' && m.requestId.startsWith('rate-test-')
    )

    expect(created).toHaveLength(10)
    expect(rateLimited).toHaveLength(1)
    expect(rateLimited[0].requestId).toBe('rate-test-10')

    ws.close()
  })

  it('does not rate limit restored terminal.create requests', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))

    await new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'ready') resolve()
      })
    })

    const messages: any[] = []
    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()))
    })

    // Restore requests should bypass rate limiting even when bursting.
    for (let i = 0; i < 10; i++) {
      ws.send(JSON.stringify({ type: 'terminal.create', requestId: `restore-test-${i}`, mode: 'shell', restore: true }))
    }
    ws.send(JSON.stringify({ type: 'terminal.create', requestId: 'restore-test-extra', mode: 'shell' }))

    await waitForCreateResponses(messages, 11, 'restore-test-')

    const created = messages.filter((m) =>
      m.type === 'terminal.created' && typeof m.requestId === 'string' && m.requestId.startsWith('restore-test-')
    )
    const rateLimited = messages.filter((m) =>
      m.type === 'error' && m.code === 'RATE_LIMITED' && typeof m.requestId === 'string' && m.requestId.startsWith('restore-test-')
    )

    expect(created).toHaveLength(11)
    expect(rateLimited).toHaveLength(0)

    ws.close()
  })

  it('does not rate-count deduped terminal.create requests', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))

    await new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'ready') resolve()
      })
    })

    const messages: any[] = []
    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()))
    })

    // Send the same requestId multiple times - deduped requests bypass rate counting
    const requestId = 'dedup-rate-test'
    ws.send(JSON.stringify({ type: 'terminal.create', requestId, mode: 'shell' }))
    ws.send(JSON.stringify({ type: 'terminal.create', requestId, mode: 'shell' }))

    await waitForCreateResponses(messages, 2, requestId)

    const created = messages.filter((m) => m.type === 'terminal.created' && m.requestId === requestId)
    const rateLimited = messages.filter((m) => m.type === 'error' && m.code === 'RATE_LIMITED' && m.requestId === requestId)

    // Both should succeed (first creates, second dedupes)
    expect(created).toHaveLength(2)
    expect(rateLimited).toHaveLength(0)

    ws.close()
  })

  it('dispatches screenshot request and resolves when ui.screenshot.result arrives', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({
      type: 'hello',
      token: 'testtoken-testtoken',
      protocolVersion: WS_PROTOCOL_VERSION,
      capabilities: { uiScreenshotV1: true },
    }))
    await waitForMessage(ws, (m) => m.type === 'ready')

    const pending = handler.requestUiScreenshot({ scope: 'view', timeoutMs: 10_000 })
    const req = await waitForMessage(
      ws,
      (m) => m.type === 'ui.command' && m.command === 'screenshot.capture',
    )

    ws.send(JSON.stringify({
      type: 'ui.screenshot.result',
      requestId: req.payload.requestId,
      ok: true,
      mimeType: 'image/png',
      imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2M7nQAAAAASUVORK5CYII=',
      width: 1,
      height: 1,
    }))

    await expect(pending).resolves.toMatchObject({
      ok: true,
      mimeType: 'image/png',
      width: 1,
      height: 1,
    })
    await closeWebSocket(ws)
  })

  it('accepts screenshot results above 1MB payload without ws protocol rejection', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({
      type: 'hello',
      token: 'testtoken-testtoken',
      protocolVersion: WS_PROTOCOL_VERSION,
      capabilities: { uiScreenshotV1: true },
    }))
    await waitForMessage(ws, (m) => m.type === 'ready')

    const bigImage = 'A'.repeat(1_100_000)
    const pending = handler.requestUiScreenshot({ scope: 'view', timeoutMs: 10_000 })
    const req = await waitForMessage(
      ws,
      (m) => m.type === 'ui.command' && m.command === 'screenshot.capture',
    )

    ws.send(JSON.stringify({
      type: 'ui.screenshot.result',
      requestId: req.payload.requestId,
      ok: true,
      mimeType: 'image/png',
      imageBase64: bigImage,
      width: 1200,
      height: 800,
    }))

    await expect(pending).resolves.toMatchObject({ ok: true, width: 1200, height: 800 })
    await closeWebSocket(ws)
  })

  it('rejects screenshot payload above MAX_SCREENSHOT_BASE64_BYTES', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({
      type: 'hello',
      token: 'testtoken-testtoken',
      protocolVersion: WS_PROTOCOL_VERSION,
      capabilities: { uiScreenshotV1: true },
    }))
    await waitForMessage(ws, (m) => m.type === 'ready')

    const tooLargeImage = 'B'.repeat(12 * 1024 * 1024 + 1)
    // Large payload parsing can take longer under full-suite concurrency; keep
    // timeout aligned with other screenshot protocol tests to avoid flakiness.
    const pending = handler.requestUiScreenshot({ scope: 'view', timeoutMs: 10_000 })
    const req = await waitForMessage(
      ws,
      (m) => m.type === 'ui.command' && m.command === 'screenshot.capture',
    )

    ws.send(JSON.stringify({
      type: 'ui.screenshot.result',
      requestId: req.payload.requestId,
      ok: true,
      mimeType: 'image/png',
      imageBase64: tooLargeImage,
      width: 1200,
      height: 800,
    }))

    await expect(pending).rejects.toThrow('Screenshot payload too large')
    await closeWebSocket(ws)
  })

  it('rejects screenshot requests immediately when no screenshot-capable client is connected', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({
      type: 'hello',
      token: 'testtoken-testtoken',
      protocolVersion: WS_PROTOCOL_VERSION,
    }))
    await waitForMessage(ws, (m) => m.type === 'ready')

    await expect(handler.requestUiScreenshot({ scope: 'view', timeoutMs: 10_000 }))
      .rejects.toThrow('No screenshot-capable UI client connected')

    await closeWebSocket(ws)
  })
})

describe('claude activity protocol', () => {
  it('accepts a claude activity record with idle/busy phase', () => {
    expect(ClaudeActivityRecordSchema.safeParse({ terminalId: 't1', phase: 'busy', updatedAt: 1 }).success).toBe(true)
    expect(ClaudeActivityRecordSchema.safeParse({ terminalId: 't1', phase: 'pending', updatedAt: 1 }).success).toBe(false)
  })
  it('accepts claude.activity.list request and response and updated', () => {
    expect(ClaudeActivityListSchema.safeParse({ type: 'claude.activity.list', requestId: 'r1' }).success).toBe(true)
    expect(ClaudeActivityListResponseSchema.safeParse({ type: 'claude.activity.list.response', requestId: 'r1', terminals: [] }).success).toBe(true)
    expect(ClaudeActivityUpdatedSchema.safeParse({ type: 'claude.activity.updated', upsert: [], remove: ['t1'] }).success).toBe(true)
  })
  it('terminal.turn.complete accepts provider claude and optional sessionId', () => {
    expect(TerminalTurnCompleteSchema.safeParse({ type: 'terminal.turn.complete', terminalId: 't1', provider: 'claude', at: 1 }).success).toBe(true)
    expect(TerminalTurnCompleteSchema.safeParse({ type: 'terminal.turn.complete', terminalId: 't1', provider: 'opencode', sessionId: 's1', at: 1 }).success).toBe(true)
  })
})
