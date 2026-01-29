import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import http from 'http'
import WebSocket from 'ws'

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

function listen(server: http.Server): Promise<{ port: number }> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (typeof addr === 'object' && addr) resolve({ port: addr.port })
    })
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
}

describe('ws protocol', () => {
  let server: http.Server
  let port: number
  let WsHandler: any
  let registry: FakeRegistry

  beforeAll(async () => {
    process.env.NODE_ENV = 'test'
    process.env.AUTH_TOKEN = 'testtoken-testtoken'
    process.env.HELLO_TIMEOUT_MS = '100'

    ;({ WsHandler } = await import('../../server/ws-handler'))
    server = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end()
    })
    registry = new FakeRegistry()
    new WsHandler(server, registry as any)
    const info = await listen(server)
    port = info.port
  })

  beforeEach(() => {
    // Clear registry state between tests
    registry.records.clear()
    registry.inputCalls = []
    registry.resizeCalls = []
    registry.killCalls = []
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

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
    ws.close()
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
    ws.close()
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
    ws.close()
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
    ws.close()
  })

  // Helper function to create authenticated connection
  async function createAuthenticatedConnection(): Promise<{ ws: WebSocket; close: () => void }> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))

    await new Promise<void>((resolve) => {
      const handler = (data: WebSocket.Data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'ready') {
          ws.off('message', handler)
          resolve()
        }
      }
      ws.on('message', handler)
    })

    return { ws, close: () => ws.close() }
  }

  // Helper function to create a terminal and return its ID
  async function createTerminal(ws: WebSocket, requestId: string): Promise<string> {
    ws.send(JSON.stringify({ type: 'terminal.create', requestId, mode: 'shell' }))

    return new Promise((resolve) => {
      const handler = (data: WebSocket.Data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'terminal.created' && msg.requestId === requestId) {
          ws.off('message', handler)
          resolve(msg.terminalId)
        }
      }
      ws.on('message', handler)
    })
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

    close()
    close2()
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

    close()
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

    close()
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

    close()
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

    close()
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

    close()
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

    close()
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

    close()
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

    close()
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

    close()
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

    close()
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

    close()
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

    close()
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

    ws.close()
  })
})
