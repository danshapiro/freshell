import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import http from 'http'
import WebSocket from 'ws'

const TEST_TIMEOUT_MS = 30_000
const HOOK_TIMEOUT_MS = 30_000
vi.setConfig({ testTimeout: TEST_TIMEOUT_MS, hookTimeout: HOOK_TIMEOUT_MS })

// Mock the config-store module before importing ws-handler
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
  inputCalls: { terminalId: string; data: string }[] = []
  resizeCalls: { terminalId: string; cols: number; rows: number }[] = []
  killCalls: string[] = []

  create(opts: any) {
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
    if (!rec) return false
    this.inputCalls.push({ terminalId, data })
    return true
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
  let registry: FakeRegistry

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
    new WsHandler(server, registry as any)
    const info = await listen(server)
    port = info.port
  }, HOOK_TIMEOUT_MS)

  beforeEach(() => {
    // Clear registry state between tests
    registry.records.clear()
    registry.inputCalls = []
    registry.resizeCalls = []
    registry.killCalls = []
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
    ws.send(JSON.stringify({ type: 'hello', token: 'wrong' }))
    const result = await close
    expect(result.code).toBe(4001)
  })

  it('accepts valid hello and responds ready', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))

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
      capabilities: { sessionsPatchV1: true },
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
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))

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

  it('accepts shell parameter with system default', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))

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
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))

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
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))

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

    ws2.send(JSON.stringify({ type: 'terminal.attach', terminalId }))

    const attached = await new Promise<any>((resolve) => {
      ws2.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'terminal.attached') resolve(msg)
      })
    })

    expect(attached.type).toBe('terminal.attached')
    expect(attached.terminalId).toBe(terminalId)
    expect(attached.snapshot).toBeDefined()

    await close()
    await close2()
  })

  it('terminal.attach returns error for non-existent terminal', async () => {
    const { ws, close } = await createAuthenticatedConnection()

    ws.send(JSON.stringify({ type: 'terminal.attach', terminalId: 'nonexistent_terminal' }))

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

    // Wait for list.updated broadcast
    await new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'terminal.list.updated') resolve()
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

  it('terminal.list returns all terminals', async () => {
    const { ws, close } = await createAuthenticatedConnection()

    // Create two terminals
    const terminalId1 = await createTerminal(ws, 'list-term-1')
    const terminalId2 = await createTerminal(ws, 'list-term-2')

    ws.send(JSON.stringify({ type: 'terminal.list', requestId: 'list-req-1' }))

    const listResponse = await new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'terminal.list.response' && msg.requestId === 'list-req-1') resolve(msg)
      })
    })

    expect(listResponse.type).toBe('terminal.list.response')
    expect(listResponse.requestId).toBe('list-req-1')
    expect(listResponse.terminals).toHaveLength(2)

    const ids = listResponse.terminals.map((t: any) => t.terminalId)
    expect(ids).toContain(terminalId1)
    expect(ids).toContain(terminalId2)

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
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))

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
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))

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
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))

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
})
