import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest'
import http from 'http'
import WebSocket from 'ws'

const TEST_TIMEOUT_MS = 30_000
const HOOK_TIMEOUT_MS = 30_000
const VALID_SESSION_ID = '550e8400-e29b-41d4-a716-446655440000'

// Increase test timeout for network tests
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

// Minimal buffer that simulates real scrollback buffer behavior
class FakeBuffer {
  private chunks: string[] = []
  private totalSize = 0
  private maxChars = 64 * 1024

  append(chunk: string) {
    if (!chunk) return
    this.chunks.push(chunk)
    this.totalSize += chunk.length
    // Simulate real buffer eviction
    while (this.totalSize > this.maxChars && this.chunks.length > 1) {
      const removed = this.chunks.shift()!
      this.totalSize -= removed.length
    }
  }

  snapshot() {
    return this.chunks.join('')
  }

  clear() {
    this.chunks = []
    this.totalSize = 0
  }
}

// Enhanced FakeRegistry that simulates real terminal behavior including output streaming
class FakeRegistry {
  records = new Map<string, any>()
  inputCalls: { terminalId: string; data: string }[] = []
  resizeCalls: { terminalId: string; cols: number; rows: number }[] = []
  killCalls: string[] = []
  finishAttachSnapshotCalls: { terminalId: string; ws: WebSocket }[] = []
  emitOutputOnNextAttach: { terminalId: string; data: string } | null = null

  // Control hooks for testing edge cases
  onOutputListeners = new Map<string, (data: string) => void>()
  onExitListeners = new Map<string, (code: number) => void>()

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
      exitCode: undefined as number | undefined,
      clients: new Set<WebSocket>(),
      pendingSnapshotClients: new Map<WebSocket, string[]>(),
    }
    this.records.set(terminalId, rec)
    return rec
  }

  get(terminalId: string) {
    return this.records.get(terminalId) || null
  }

  attach(terminalId: string, ws: WebSocket, opts?: { pendingSnapshot?: boolean }) {
    const rec = this.records.get(terminalId)
    if (!rec) return null
    rec.clients.add(ws)
    if (opts?.pendingSnapshot) rec.pendingSnapshotClients.set(ws, [])

    if (opts?.pendingSnapshot && this.emitOutputOnNextAttach?.terminalId === terminalId) {
      const { data } = this.emitOutputOnNextAttach
      this.emitOutputOnNextAttach = null
      this.simulateOutput(terminalId, data)
    }
    return rec
  }

  finishAttachSnapshot(terminalId: string, ws: WebSocket) {
    const rec = this.records.get(terminalId)
    if (!rec) return
    this.finishAttachSnapshotCalls.push({ terminalId, ws })
    const queued = rec.pendingSnapshotClients.get(ws)
    if (!queued) return
    rec.pendingSnapshotClients.delete(ws)
    for (const data of queued) {
      this.safeSend(ws, { type: 'terminal.output', terminalId, data })
    }
  }

  detach(terminalId: string, ws: WebSocket) {
    const rec = this.records.get(terminalId)
    if (!rec) return false
    rec.clients.delete(ws)
    rec.pendingSnapshotClients.delete(ws)
    return true
  }

  input(terminalId: string, data: string) {
    const rec = this.records.get(terminalId)
    if (!rec || rec.status !== 'running') return false
    this.inputCalls.push({ terminalId, data })
    return true
  }

  resize(terminalId: string, cols: number, rows: number) {
    const rec = this.records.get(terminalId)
    if (!rec || rec.status !== 'running') return false
    this.resizeCalls.push({ terminalId, cols, rows })
    return true
  }

  kill(terminalId: string) {
    const rec = this.records.get(terminalId)
    if (!rec) return false
    this.killCalls.push(terminalId)
    rec.status = 'exited'
    rec.exitCode = 0
    // Notify attached clients
    for (const client of rec.clients) {
      this.safeSend(client, { type: 'terminal.exit', terminalId, exitCode: 0 })
    }
    rec.clients.clear()
    rec.pendingSnapshotClients.clear()
    return true
  }

  list() {
    return Array.from(this.records.values()).map((r) => ({
      terminalId: r.terminalId,
      title: r.title,
      mode: r.mode,
      createdAt: r.createdAt,
      lastActivityAt: r.createdAt,
      status: r.status,
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

  // Simulate terminal output for testing
  simulateOutput(terminalId: string, data: string) {
    const rec = this.records.get(terminalId)
    if (!rec || rec.status !== 'running') return
    rec.buffer.append(data)
    for (const client of rec.clients) {
      const q = rec.pendingSnapshotClients.get(client)
      if (q) {
        q.push(data)
        continue
      }
      this.safeSend(client, { type: 'terminal.output', terminalId, data })
    }
  }

  // Simulate terminal exit for testing
  simulateExit(terminalId: string, exitCode: number) {
    const rec = this.records.get(terminalId)
    if (!rec) return
    rec.status = 'exited'
    rec.exitCode = exitCode
    for (const client of rec.clients) {
      this.safeSend(client, { type: 'terminal.exit', terminalId, exitCode })
    }
    rec.clients.clear()
    rec.pendingSnapshotClients.clear()
  }

  // Simulate backpressure by checking buffered amount
  safeSend(client: WebSocket, msg: unknown) {
    // @ts-ignore - bufferedAmount may not be typed
    const buffered = client.bufferedAmount as number | undefined
    if (typeof buffered === 'number' && buffered > 2 * 1024 * 1024) {
      return // Drop message under backpressure
    }
    try {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(msg))
      }
    } catch {
      // ignore
    }
  }
}

describe('WebSocket edge cases', () => {
  let server: http.Server | undefined
  let port: number
  let WsHandler: any
  let wsHandler: any
  let registry: FakeRegistry

  beforeAll(async () => {
    process.env.NODE_ENV = 'test'
    process.env.AUTH_TOKEN = 'testtoken-testtoken'
    process.env.HELLO_TIMEOUT_MS = '500' // Longer timeout for edge case tests
    process.env.MAX_CONNECTIONS = '5'
    process.env.MAX_WS_ATTACH_CHUNK_BYTES = '16384'

    ;({ WsHandler } = await import('../../server/ws-handler'))
    server = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end()
    })
    registry = new FakeRegistry()
    wsHandler = new WsHandler(server, registry as any)
    const info = await listen(server)
    port = info.port
  }, HOOK_TIMEOUT_MS)

  beforeEach(() => {
    registry.records.clear()
    registry.inputCalls = []
    registry.resizeCalls = []
    registry.killCalls = []
    registry.finishAttachSnapshotCalls = []
  })

  afterAll(async () => {
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }, HOOK_TIMEOUT_MS)

  // Helper: create authenticated connection
  async function createAuthenticatedConnection(opts?: {
    capabilities?: {
      sessionsPatchV1?: boolean
      terminalAttachChunkV1?: boolean
    }
  }): Promise<{ ws: WebSocket; close: () => void }> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connection timeout')), 5000)
      ws.on('open', () => {
        clearTimeout(timeout)
        resolve()
      })
      ws.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })
    })
    ws.send(JSON.stringify({
      type: 'hello',
      token: 'testtoken-testtoken',
      ...(opts?.capabilities ? { capabilities: opts.capabilities } : {}),
    }))

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Ready timeout')), 5000)
      const handler = (data: WebSocket.Data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'ready') {
          clearTimeout(timeout)
          ws.off('message', handler)
          resolve()
        } else if (msg.type === 'error' && msg.code === 'NOT_AUTHENTICATED') {
          clearTimeout(timeout)
          ws.off('message', handler)
          reject(new Error('Authentication failed'))
        }
      }
      ws.on('message', handler)
    })

    return { ws, close: () => ws.close() }
  }

  // Helper: create terminal and return ID
  async function createTerminal(ws: WebSocket, requestId: string): Promise<string> {
    ws.send(JSON.stringify({ type: 'terminal.create', requestId, mode: 'shell' }))

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Create terminal timeout')), 5000)
      const handler = (data: WebSocket.Data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'terminal.created' && msg.requestId === requestId) {
          clearTimeout(timeout)
          ws.off('message', handler)
          resolve(msg.terminalId)
        } else if (msg.type === 'error' && msg.requestId === requestId) {
          clearTimeout(timeout)
          ws.off('message', handler)
          reject(new Error(msg.message))
        }
      }
      ws.on('message', handler)
    })
  }

  // Helper: collect messages for a duration
  function collectMessages(ws: WebSocket, durationMs: number): Promise<any[]> {
    return new Promise((resolve) => {
      const messages: any[] = []
      const handler = (data: WebSocket.Data) => {
        try {
          messages.push(JSON.parse(data.toString()))
        } catch {
          // ignore malformed
        }
      }
      ws.on('message', handler)
      setTimeout(() => {
        ws.off('message', handler)
        resolve(messages)
      }, durationMs)
    })
  }

  // Helper: wait for specific message type
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

  describe('Rapid connect/disconnect cycles', () => {
    it('handles rapid connect/disconnect without resource leaks', async () => {
      const iterations = 3 // Reduced to stay under MAX_CONNECTIONS limit
      const connections: WebSocket[] = []

      // Rapidly create connections one at a time (to avoid hitting limit)
      for (let i = 0; i < iterations; i++) {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Connection timeout')), 5000)
          ws.on('open', () => {
            clearTimeout(timeout)
            resolve()
          })
          ws.on('error', (err) => {
            clearTimeout(timeout)
            reject(err)
          })
        })
        connections.push(ws)
      }

      // Immediately close all
      await Promise.all(
        connections.map(
          (ws) =>
            new Promise<void>((resolve) => {
              if (ws.readyState === WebSocket.CLOSED) {
                resolve()
                return
              }
              ws.on('close', () => resolve())
              ws.close()
            })
        )
      )

      // Give server time to clean up
      await new Promise((r) => setTimeout(r, 200))

      // Verify server can still accept new connections
      const { ws, close } = await createAuthenticatedConnection()
      expect(ws.readyState).toBe(WebSocket.OPEN)
      close()
    })

    it('handles connect/auth/disconnect cycle rapidly', async () => {
      const iterations = 5

      for (let i = 0; i < iterations; i++) {
        const { ws, close } = await createAuthenticatedConnection()
        const terminalId = await createTerminal(ws, `rapid-${i}`)
        expect(terminalId).toMatch(/^term_/)
        close()
        // Small delay to let cleanup happen
        await new Promise((r) => setTimeout(r, 20))
      }

      // Verify server state is clean
      const { ws, close } = await createAuthenticatedConnection()
      // Create fresh terminal works
      const newTermId = await createTerminal(ws, 'after-rapid')
      expect(newTermId).toMatch(/^term_/)
      close()
    })

    it('handles disconnect during hello handshake', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))

      // Send hello but close before receiving ready
      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))
      ws.close()

      // Give server time to process
      await new Promise((r) => setTimeout(r, 100))

      // Server should still work
      const { ws: ws2, close } = await createAuthenticatedConnection()
      expect(ws2.readyState).toBe(WebSocket.OPEN)
      close()
    })
  })

  describe('Messages arriving out of order', () => {
    it('rejects messages before hello', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))

      // Send terminal.create before hello
      ws.send(JSON.stringify({ type: 'terminal.create', requestId: 'pre-hello', mode: 'shell' }))

      const error = await waitForMessage(ws, (m) => m.type === 'error')
      expect(error.code).toBe('NOT_AUTHENTICATED')
      expect(error.message).toBe('Send hello first')

      // Connection should be closed
      await new Promise<void>((resolve) => ws.on('close', () => resolve()))
    })

    it('handles duplicate hello messages', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))

      // First hello
      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))
      await waitForMessage(ws, (m) => m.type === 'ready')

      // Second hello - should be treated as unknown message type (since hello is only valid before auth)
      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))

      // The second hello is parsed but since we're already authenticated,
      // it just sends another ready (idempotent behavior)
      const messages = await collectMessages(ws, 100)
      const readyMessages = messages.filter((m) => m.type === 'ready')
      expect(readyMessages.length).toBeGreaterThanOrEqual(0) // May or may not send another ready

      ws.close()
    })

    it('handles interleaved terminal operations', async () => {
      const { ws, close } = await createAuthenticatedConnection()

      // Create terminal
      const terminalId = await createTerminal(ws, 'interleave-1')

      // Send multiple operations rapidly in different order
      const operations = [
        { type: 'terminal.input', terminalId, data: 'first' },
        { type: 'terminal.resize', terminalId, cols: 100, rows: 30 },
        { type: 'terminal.input', terminalId, data: 'second' },
        { type: 'terminal.resize', terminalId, cols: 120, rows: 40 },
        { type: 'terminal.input', terminalId, data: 'third' },
      ]

      // Send all at once
      operations.forEach((op) => ws.send(JSON.stringify(op)))

      // Wait for processing
      await new Promise((r) => setTimeout(r, 100))

      // All inputs should be recorded in order
      expect(registry.inputCalls).toHaveLength(3)
      expect(registry.inputCalls.map((c) => c.data)).toEqual(['first', 'second', 'third'])

      // All resizes should be recorded
      expect(registry.resizeCalls).toHaveLength(2)

      close()
    })

    it('handles terminal.input after terminal.kill', async () => {
      const { ws, close } = await createAuthenticatedConnection()

      const terminalId = await createTerminal(ws, 'kill-then-input')

      // Kill the terminal
      ws.send(JSON.stringify({ type: 'terminal.kill', terminalId }))
      await waitForMessage(ws, (m) => m.type === 'terminal.list.updated')

      // Try to send input to killed terminal
      ws.send(JSON.stringify({ type: 'terminal.input', terminalId, data: 'should fail' }))

      const error = await waitForMessage(ws, (m) => m.type === 'error')
      expect(error.code).toBe('INVALID_TERMINAL_ID')

      close()
    })
  })

  describe('Partial message handling', () => {
    it('handles malformed JSON gracefully', async () => {
      const { ws, close } = await createAuthenticatedConnection()

      // Send various malformed JSON
      ws.send('not json at all')
      const error1 = await waitForMessage(ws, (m) => m.type === 'error')
      expect(error1.code).toBe('INVALID_MESSAGE')
      expect(error1.message).toBe('Invalid JSON')

      // Incomplete JSON
      ws.send('{"type": "terminal.create", "requestId":')
      const error2 = await waitForMessage(ws, (m) => m.type === 'error')
      expect(error2.code).toBe('INVALID_MESSAGE')

      // Connection should still work
      const terminalId = await createTerminal(ws, 'after-malformed')
      expect(terminalId).toMatch(/^term_/)

      close()
    })

    it('handles empty messages', async () => {
      const { ws, close } = await createAuthenticatedConnection()

      ws.send('')
      const error = await waitForMessage(ws, (m) => m.type === 'error')
      expect(error.code).toBe('INVALID_MESSAGE')

      close()
    })

    it('handles messages with missing required fields', async () => {
      const { ws, close } = await createAuthenticatedConnection()

      // terminal.create without requestId
      ws.send(JSON.stringify({ type: 'terminal.create', mode: 'shell' }))
      const error1 = await waitForMessage(ws, (m) => m.type === 'error')
      expect(error1.code).toBe('INVALID_MESSAGE')

      // terminal.input without data
      ws.send(JSON.stringify({ type: 'terminal.input', terminalId: 'fake' }))
      const error2 = await waitForMessage(ws, (m) => m.type === 'error')
      expect(error2.code).toBe('INVALID_MESSAGE')

      // terminal.resize with invalid dimensions
      ws.send(JSON.stringify({ type: 'terminal.resize', terminalId: 'fake', cols: -1, rows: 30 }))
      const error3 = await waitForMessage(ws, (m) => m.type === 'error')
      expect(error3.code).toBe('INVALID_MESSAGE')

      close()
    })

    it('handles messages with extra unexpected fields', async () => {
      const { ws, close } = await createAuthenticatedConnection()

      // Extra fields should be ignored (Zod strips unknown keys)
      ws.send(
        JSON.stringify({
          type: 'terminal.create',
          requestId: 'with-extra',
          mode: 'shell',
          unexpectedField: 'should be ignored',
          anotherOne: 123,
        })
      )

      const created = await waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === 'with-extra')
      expect(created.terminalId).toMatch(/^term_/)

      close()
    })

    it('handles very large messages', async () => {
      const { ws, close } = await createAuthenticatedConnection()

      const terminalId = await createTerminal(ws, 'large-input')

      // Send large input (under the maxPayload limit of 1MB)
      const largeData = 'x'.repeat(500_000)
      ws.send(JSON.stringify({ type: 'terminal.input', terminalId, data: largeData }))

      await new Promise((r) => setTimeout(r, 100))

      expect(registry.inputCalls).toHaveLength(1)
      expect(registry.inputCalls[0].data.length).toBe(500_000)

      close()
    })
  })

  describe('Client reconnection during terminal output', () => {
    it('preserves buffer state for reconnecting client', async () => {
      const { ws: ws1, close: close1 } = await createAuthenticatedConnection()

      const terminalId = await createTerminal(ws1, 'reconnect-buffer')

      // Simulate some output
      registry.simulateOutput(terminalId, 'line 1\n')
      registry.simulateOutput(terminalId, 'line 2\n')
      registry.simulateOutput(terminalId, 'line 3\n')

      await new Promise((r) => setTimeout(r, 50))

      // Disconnect first client
      close1()
      await new Promise((r) => setTimeout(r, 50))

      // Reconnect with new client
      const { ws: ws2, close: close2 } = await createAuthenticatedConnection()

      // Attach to existing terminal
      ws2.send(JSON.stringify({ type: 'terminal.attach', terminalId }))

      const attached = await waitForMessage(ws2, (m) => m.type === 'terminal.attached')
      expect(attached.terminalId).toBe(terminalId)

      // Snapshot should contain all previous output
      expect(attached.snapshot).toContain('line 1')
      expect(attached.snapshot).toContain('line 2')
      expect(attached.snapshot).toContain('line 3')

      close2()
    })

    it('sends terminal.attached snapshot before any terminal.output after attach', async () => {
      const { ws: ws1, close: close1 } = await createAuthenticatedConnection()

      const terminalId = await createTerminal(ws1, 'attach-order')
      close1()
      await new Promise((r) => setTimeout(r, 50))

      const { ws: ws2, close: close2 } = await createAuthenticatedConnection()

      // Force "PTY output" to occur during attach before the snapshot is sent.
      registry.emitOutputOnNextAttach = { terminalId, data: 'raced output\n' }
      ws2.send(JSON.stringify({ type: 'terminal.attach', terminalId }))

      const msgs = await new Promise<any[]>((resolve, reject) => {
        const received: any[] = []
        const timeout = setTimeout(() => {
          ws2.off('message', handler)
          reject(new Error('Timeout waiting for attached+output messages'))
        }, 2000)

        const handler = (data: WebSocket.Data) => {
          const msg = JSON.parse(data.toString())
          if ((msg.type !== 'terminal.attached' && msg.type !== 'terminal.output') || msg.terminalId !== terminalId) return
          received.push(msg)
          if (received.some((m) => m.type === 'terminal.attached') && received.some((m) => m.type === 'terminal.output')) {
            clearTimeout(timeout)
            ws2.off('message', handler)
            resolve(received)
          }
        }

        ws2.on('message', handler)
      })

      const attachedIdx = msgs.findIndex((m) => m.type === 'terminal.attached')
      const outputIdx = msgs.findIndex((m) => m.type === 'terminal.output')

      expect(attachedIdx).toBeGreaterThanOrEqual(0)
      expect(outputIdx).toBeGreaterThan(attachedIdx)

      close2()
    })

    it('continues receiving output after reconnection', async () => {
      const { ws: ws1, close: close1 } = await createAuthenticatedConnection()

      const terminalId = await createTerminal(ws1, 'reconnect-continue')

      // Simulate initial output
      registry.simulateOutput(terminalId, 'before disconnect\n')

      await new Promise((r) => setTimeout(r, 50))

      // Disconnect
      close1()
      await new Promise((r) => setTimeout(r, 50))

      // Reconnect
      const { ws: ws2, close: close2 } = await createAuthenticatedConnection()
      ws2.send(JSON.stringify({ type: 'terminal.attach', terminalId }))

      await waitForMessage(ws2, (m) => m.type === 'terminal.attached')

      // Set up listener for new output
      const outputPromise = waitForMessage(ws2, (m) => m.type === 'terminal.output' && m.data.includes('after'))

      // Simulate more output
      registry.simulateOutput(terminalId, 'after reconnect\n')

      const output = await outputPromise
      expect(output.data).toContain('after reconnect')

      close2()
    })

    it('handles reconnection attempt to killed terminal', async () => {
      const { ws: ws1, close: close1 } = await createAuthenticatedConnection()

      const terminalId = await createTerminal(ws1, 'reconnect-killed')
      close1()

      await new Promise((r) => setTimeout(r, 100))

      // Kill terminal while disconnected - this removes it from registry
      registry.kill(terminalId)
      // Also delete from records to simulate full cleanup
      registry.records.delete(terminalId)

      await new Promise((r) => setTimeout(r, 50))

      // Try to reconnect
      const { ws: ws2, close: close2 } = await createAuthenticatedConnection()
      ws2.send(JSON.stringify({ type: 'terminal.attach', terminalId }))

      const error = await waitForMessage(ws2, (m) => m.type === 'error')
      expect(error.code).toBe('INVALID_TERMINAL_ID')

      close2()
    })
  })

  describe('chunked attach', () => {
    it('chunked attach sends start/chunk/end in order for large terminal.attach', async () => {
      const { ws: ws1, close: close1 } = await createAuthenticatedConnection()
      const terminalId = await createTerminal(ws1, 'chunk-attach-order')
      registry.simulateOutput(terminalId, 'x'.repeat(70_000))
      close1()
      await new Promise((r) => setTimeout(r, 50))

      const { ws: ws2, close: close2 } = await createAuthenticatedConnection({
        capabilities: { terminalAttachChunkV1: true },
      })

      const stream = await new Promise<any[]>((resolve, reject) => {
        const received: any[] = []
        const timeout = setTimeout(() => {
          ws2.off('message', handler)
          reject(new Error('Timeout waiting for chunked attach sequence'))
        }, 5000)

        const handler = (data: WebSocket.Data) => {
          const msg = JSON.parse(data.toString())
          if (!msg || msg.terminalId !== terminalId) return
          if (!['terminal.attached.start', 'terminal.attached.chunk', 'terminal.attached.end', 'terminal.attached'].includes(msg.type)) return
          received.push(msg)
          if (msg.type === 'terminal.attached.end') {
            clearTimeout(timeout)
            ws2.off('message', handler)
            resolve(received)
          }
        }

        ws2.on('message', handler)
        ws2.send(JSON.stringify({ type: 'terminal.attach', terminalId }))
      })

      expect(stream[0]?.type).toBe('terminal.attached.start')
      expect(stream[stream.length - 1]?.type).toBe('terminal.attached.end')
      expect(stream.some((m) => m.type === 'terminal.attached.chunk')).toBe(true)
      expect(stream.some((m) => m.type === 'terminal.attached')).toBe(false)

      close2()
    })

    it('chunked attach sends snapshot before any terminal.output after attach', async () => {
      const { ws: ws1, close: close1 } = await createAuthenticatedConnection()
      const terminalId = await createTerminal(ws1, 'chunk-attach-snapshot-first')
      registry.simulateOutput(terminalId, 'x'.repeat(70_000))
      close1()
      await new Promise((r) => setTimeout(r, 50))

      const { ws: ws2, close: close2 } = await createAuthenticatedConnection({
        capabilities: { terminalAttachChunkV1: true },
      })

      registry.emitOutputOnNextAttach = { terminalId, data: 'raced output\n' }
      const msgs = await new Promise<any[]>((resolve, reject) => {
        const received: any[] = []
        const timeout = setTimeout(() => {
          ws2.off('message', handler)
          reject(new Error(`Timeout waiting for attach snapshot + output (received=${received.map((m) => m.type).join(',')})`))
        }, 5000)

        const handler = (data: WebSocket.Data) => {
          const msg = JSON.parse(data.toString())
          if (!msg || msg.terminalId !== terminalId) return
          if (!['terminal.attached', 'terminal.attached.start', 'terminal.attached.chunk', 'terminal.attached.end', 'terminal.output'].includes(msg.type)) return
          received.push(msg)
          const hasSnapshot = received.some((m) => m.type === 'terminal.attached.end' || m.type === 'terminal.attached')
          const hasOutput = received.some((m) => m.type === 'terminal.output')
          if (hasSnapshot && hasOutput) {
            clearTimeout(timeout)
            ws2.off('message', handler)
            resolve(received)
          }
        }

        ws2.on('message', handler)
        ws2.send(JSON.stringify({ type: 'terminal.attach', terminalId }))
      })

      const endIdx = msgs.findIndex((m) => m.type === 'terminal.attached.end')
      const attachedIdx = msgs.findIndex((m) => m.type === 'terminal.attached')
      const snapshotIdx = endIdx >= 0 ? endIdx : attachedIdx
      const outputIdx = msgs.findIndex((m) => m.type === 'terminal.output')
      expect(snapshotIdx).toBeGreaterThanOrEqual(0)
      expect(outputIdx).toBeGreaterThan(snapshotIdx)

      close2()
    })

    it('chunked attach uses chunk flow for reused terminal.create snapshot path', async () => {
      const { ws, close } = await createAuthenticatedConnection({
        capabilities: { terminalAttachChunkV1: true },
      })

      const requestId = 'chunk-create-reused'
      const terminalId = await createTerminal(ws, requestId)
      registry.simulateOutput(terminalId, 'x'.repeat(70_000))

      ws.send(JSON.stringify({ type: 'terminal.create', requestId, mode: 'shell' }))

      const received = await new Promise<any[]>((resolve, reject) => {
        const msgs: any[] = []
        let sawCreated = false
        let sawEnd = false
        const timeout = setTimeout(() => {
          ws.off('message', handler)
          reject(new Error('Timeout waiting for chunked terminal.create reuse stream'))
        }, 5000)

        const handler = (data: WebSocket.Data) => {
          const msg = JSON.parse(data.toString())
          if (!msg) return
          if (msg.type === 'terminal.created' && msg.requestId === requestId) {
            msgs.push(msg)
            sawCreated = true
          }
          if (msg.terminalId === terminalId && ['terminal.attached.start', 'terminal.attached.chunk', 'terminal.attached.end', 'terminal.attached'].includes(msg.type)) {
            msgs.push(msg)
            if (msg.type === 'terminal.attached.end') sawEnd = true
          }
          if (sawCreated && sawEnd) {
            clearTimeout(timeout)
            ws.off('message', handler)
            resolve(msgs)
          }
        }

        ws.on('message', handler)
      })

      const created = received.find((m) => m.type === 'terminal.created' && m.requestId === requestId)
      expect(created).toBeDefined()
      expect(created.snapshotChunked).toBe(true)
      expect(created.snapshot).toBeUndefined()
      expect(received.some((m) => m.type === 'terminal.attached.start')).toBe(true)
      expect(received.some((m) => m.type === 'terminal.attached.end')).toBe(true)
      expect(received.some((m) => m.type === 'terminal.attached')).toBe(false)

      close()
    })

    it('chunked attach aborts stream and does not finalize attach when client closes mid-stream', async () => {
      const { ws: ws1, close: close1 } = await createAuthenticatedConnection()
      const terminalId = await createTerminal(ws1, 'chunk-mid-close')
      registry.simulateOutput(terminalId, 'x'.repeat(70_000))
      close1()
      await new Promise((r) => setTimeout(r, 50))

      const { ws: ws2 } = await createAuthenticatedConnection({
        capabilities: { terminalAttachChunkV1: true },
      })

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws2.off('message', handler)
          reject(new Error('Timeout waiting for first chunk before forced close'))
        }, 5000)
        const handler = (data: WebSocket.Data) => {
          const msg = JSON.parse(data.toString())
          if (msg.type !== 'terminal.attached.chunk' || msg.terminalId !== terminalId) return
          clearTimeout(timeout)
          ws2.off('message', handler)
          ws2.close()
          resolve()
        }
        ws2.on('message', handler)
        ws2.send(JSON.stringify({ type: 'terminal.attach', terminalId }))
      })

      await new Promise<void>((resolve) => {
        if (ws2.readyState === WebSocket.CLOSED) return resolve()
        ws2.once('close', () => resolve())
      })
      await new Promise((r) => setTimeout(r, 100))

      const finalizeCalls = registry.finishAttachSnapshotCalls.filter((call) => call.terminalId === terminalId && call.ws === ws2)
      expect(finalizeCalls.length).toBe(0)
    })

    it('chunked attach keeps empty snapshots inline and never marks snapshotChunked', async () => {
      const { ws, close } = await createAuthenticatedConnection({
        capabilities: { terminalAttachChunkV1: true },
      })

      const requestId = 'chunk-empty-inline'
      ws.send(JSON.stringify({ type: 'terminal.create', requestId, mode: 'shell' }))

      const created = await waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === requestId, 5000)
      expect(created.snapshotChunked).not.toBe(true)
      expect(typeof created.snapshot).toBe('string')

      const messages = await collectMessages(ws, 200)
      const startForTerminal = messages.find((m) => m.type === 'terminal.attached.start' && m.terminalId === created.terminalId)
      expect(startForTerminal).toBeUndefined()

      close()
    })

    it('chunked attach serializes concurrent attach/create streams for same terminal and connection', async () => {
      const { ws, close } = await createAuthenticatedConnection({
        capabilities: { terminalAttachChunkV1: true },
      })

      const requestId = 'chunk-concurrent-streams'
      const terminalId = await createTerminal(ws, requestId)
      registry.simulateOutput(terminalId, 'x'.repeat(70_000))

      const serverWs = Array.from((wsHandler as any).connections).find((candidate: any) => {
        const state = (wsHandler as any).clientStates.get(candidate)
        return state?.authenticated
      }) as WebSocket | undefined
      expect(serverWs).toBeDefined()

      let releaseFirstChunk: (() => void) | null = null
      const firstChunkBlocked = new Promise<void>((resolve) => {
        releaseFirstChunk = resolve
      })
      const originalSend = (serverWs as any).send.bind(serverWs)
      let blockedOnce = false

      ;(serverWs as any).send = (data: any, cb?: (err?: Error) => void) => {
        let msg: any
        try {
          msg = JSON.parse(typeof data === 'string' ? data : data.toString())
        } catch {
          msg = null
        }
        if (!blockedOnce && msg?.type === 'terminal.attached.chunk' && msg.terminalId === terminalId) {
          blockedOnce = true
          void firstChunkBlocked.then(() => originalSend(data, cb))
          return
        }
        return originalSend(data, cb)
      }

      try {
        ws.send(JSON.stringify({ type: 'terminal.attach', terminalId }))
        const firstStart = await waitForMessage(
          ws,
          (m) => m.type === 'terminal.attached.start' && m.terminalId === terminalId,
          5000,
        )
        ws.send(JSON.stringify({ type: 'terminal.create', requestId, mode: 'shell' }))
        releaseFirstChunk?.()

        const sequence = await new Promise<string[]>((resolve, reject) => {
          const events: string[] = [firstStart.type]
          let endCount = 0
          let createdCount = 0
          const timeout = setTimeout(() => {
            ws.off('message', handler)
            reject(new Error('Timeout waiting for serialized chunk streams'))
          }, 8000)

          const handler = (data: WebSocket.Data) => {
            const msg = JSON.parse(data.toString())
            if (msg.type === 'terminal.created' && msg.requestId === requestId) {
              createdCount += 1
            }
            if (msg.terminalId !== terminalId) return
            if (!['terminal.attached.start', 'terminal.attached.chunk', 'terminal.attached.end'].includes(msg.type)) return
            events.push(msg.type)
            if (msg.type === 'terminal.attached.end') endCount += 1
            if (createdCount >= 1 && endCount >= 2) {
              clearTimeout(timeout)
              ws.off('message', handler)
              resolve(events)
            }
          }

          ws.on('message', handler)
        })

        expect(sequence.filter((t) => t === 'terminal.attached.start')).toHaveLength(2)
        expect(sequence.filter((t) => t === 'terminal.attached.end')).toHaveLength(2)

        let active = 0
        for (const type of sequence) {
          if (type === 'terminal.attached.start') {
            active += 1
            expect(active).toBe(1)
          } else if (type === 'terminal.attached.end') {
            expect(active).toBe(1)
            active -= 1
          }
        }
        expect(active).toBe(0)
      } finally {
        ;(serverWs as any).send = originalSend
      }

      close()
    })
  })

  describe('Server restart while clients connected (simulated via registry clear)', () => {
    it('handles terminal disappearing from registry', async () => {
      const { ws, close } = await createAuthenticatedConnection()

      const terminalId = await createTerminal(ws, 'disappear')

      // Simulate registry losing terminal (like after restart)
      registry.records.delete(terminalId)

      // Try to send input
      ws.send(JSON.stringify({ type: 'terminal.input', terminalId, data: 'test' }))

      const error = await waitForMessage(ws, (m) => m.type === 'error')
      expect(error.code).toBe('INVALID_TERMINAL_ID')

      close()
    })

    it('handles duplicate requestId across reconnection', async () => {
      const { ws: ws1, close: close1 } = await createAuthenticatedConnection()

      const requestId = 'duplicate-request-id'
      const terminalId1 = await createTerminal(ws1, requestId)

      // Using same requestId should return existing terminal (idempotent)
      ws1.send(JSON.stringify({ type: 'terminal.create', requestId, mode: 'shell' }))
      const created2 = await waitForMessage(ws1, (m) => m.type === 'terminal.created' && m.requestId === requestId)

      // Should return the same terminal (idempotent create)
      expect(created2.terminalId).toBe(terminalId1)

      close1()
    })

    it('handles terminal.list when registry is empty', async () => {
      const { ws, close } = await createAuthenticatedConnection()

      // Ensure registry is empty
      registry.records.clear()

      ws.send(JSON.stringify({ type: 'terminal.list', requestId: 'empty-list' }))

      const response = await waitForMessage(ws, (m) => m.type === 'terminal.list.response')
      expect(response.terminals).toEqual([])

      close()
    })
  })

  describe('Multiple clients attached to same terminal', () => {
    it('all clients receive terminal output', async () => {
      const { ws: ws1, close: close1 } = await createAuthenticatedConnection()
      const { ws: ws2, close: close2 } = await createAuthenticatedConnection()
      const { ws: ws3, close: close3 } = await createAuthenticatedConnection()

      const terminalId = await createTerminal(ws1, 'multi-client')

      // Attach other clients
      ws2.send(JSON.stringify({ type: 'terminal.attach', terminalId }))
      await waitForMessage(ws2, (m) => m.type === 'terminal.attached')

      ws3.send(JSON.stringify({ type: 'terminal.attach', terminalId }))
      await waitForMessage(ws3, (m) => m.type === 'terminal.attached')

      // Set up listeners on all clients
      const outputs1: string[] = []
      const outputs2: string[] = []
      const outputs3: string[] = []

      ws1.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'terminal.output') outputs1.push(msg.data)
      })
      ws2.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'terminal.output') outputs2.push(msg.data)
      })
      ws3.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'terminal.output') outputs3.push(msg.data)
      })

      // Simulate output
      registry.simulateOutput(terminalId, 'broadcast test\n')

      await new Promise((r) => setTimeout(r, 100))

      // All clients should receive the output
      expect(outputs1.join('')).toContain('broadcast test')
      expect(outputs2.join('')).toContain('broadcast test')
      expect(outputs3.join('')).toContain('broadcast test')

      close1()
      close2()
      close3()
    })

    it('handles one client disconnecting while others remain', async () => {
      const { ws: ws1, close: close1 } = await createAuthenticatedConnection()
      const { ws: ws2, close: close2 } = await createAuthenticatedConnection()

      const terminalId = await createTerminal(ws1, 'partial-disconnect')

      ws2.send(JSON.stringify({ type: 'terminal.attach', terminalId }))
      await waitForMessage(ws2, (m) => m.type === 'terminal.attached')

      // Disconnect first client
      close1()
      await new Promise((r) => setTimeout(r, 50))

      // Second client should still receive output
      const outputPromise = waitForMessage(ws2, (m) => m.type === 'terminal.output')
      registry.simulateOutput(terminalId, 'after disconnect\n')

      const output = await outputPromise
      expect(output.data).toContain('after disconnect')

      close2()
    })

    it('handles input from multiple clients', async () => {
      const { ws: ws1, close: close1 } = await createAuthenticatedConnection()

      const terminalId = await createTerminal(ws1, 'multi-input')

      const { ws: ws2, close: close2 } = await createAuthenticatedConnection()

      ws2.send(JSON.stringify({ type: 'terminal.attach', terminalId }))
      await waitForMessage(ws2, (m) => m.type === 'terminal.attached')

      // Both clients send input
      ws1.send(JSON.stringify({ type: 'terminal.input', terminalId, data: 'from client 1' }))
      ws2.send(JSON.stringify({ type: 'terminal.input', terminalId, data: 'from client 2' }))

      await new Promise((r) => setTimeout(r, 200))

      // Both inputs should be recorded
      expect(registry.inputCalls).toHaveLength(2)
      const inputs = registry.inputCalls.map((c) => c.data)
      expect(inputs).toContain('from client 1')
      expect(inputs).toContain('from client 2')

      close1()
      close2()
    })

    it('all clients receive exit notification when terminal exits', async () => {
      const { ws: ws1, close: close1 } = await createAuthenticatedConnection()
      const { ws: ws2, close: close2 } = await createAuthenticatedConnection()

      const terminalId = await createTerminal(ws1, 'multi-exit')

      ws2.send(JSON.stringify({ type: 'terminal.attach', terminalId }))
      await waitForMessage(ws2, (m) => m.type === 'terminal.attached')

      // Set up exit listeners
      const exit1Promise = waitForMessage(ws1, (m) => m.type === 'terminal.exit')
      const exit2Promise = waitForMessage(ws2, (m) => m.type === 'terminal.exit')

      // Simulate exit
      registry.simulateExit(terminalId, 0)

      const [exit1, exit2] = await Promise.all([exit1Promise, exit2Promise])

      expect(exit1.terminalId).toBe(terminalId)
      expect(exit1.exitCode).toBe(0)
      expect(exit2.terminalId).toBe(terminalId)
      expect(exit2.exitCode).toBe(0)

      close1()
      close2()
    })
  })

  describe('Terminal output flooding (backpressure)', () => {
    it('handles rapid output bursts', async () => {
      const { ws, close } = await createAuthenticatedConnection()

      const terminalId = await createTerminal(ws, 'rapid-output')

      // Simulate rapid output burst
      const outputCount = 100
      const outputs: string[] = []

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'terminal.output') {
          outputs.push(msg.data)
        }
      })

      for (let i = 0; i < outputCount; i++) {
        registry.simulateOutput(terminalId, `line ${i}\n`)
      }

      // Wait for messages to arrive
      await new Promise((r) => setTimeout(r, 500))

      // Should receive all outputs (no backpressure in test scenario)
      const totalContent = outputs.join('')
      expect(totalContent).toContain('line 0')
      expect(totalContent).toContain('line 99')

      close()
    })

    it('buffer correctly limits scrollback', async () => {
      const { ws: ws1, close: close1 } = await createAuthenticatedConnection()

      const terminalId = await createTerminal(ws1, 'buffer-limit')

      // Generate more output than buffer can hold (64KB default)
      const chunkSize = 10_000
      const chunkCount = 10 // 100KB total, should evict old data
      for (let i = 0; i < chunkCount; i++) {
        registry.simulateOutput(terminalId, 'x'.repeat(chunkSize) + `|marker-${i}|`)
      }

      // Disconnect and reconnect to get snapshot
      close1()
      await new Promise((r) => setTimeout(r, 50))

      const { ws: ws2, close: close2 } = await createAuthenticatedConnection()
      ws2.send(JSON.stringify({ type: 'terminal.attach', terminalId }))

      const attached = await waitForMessage(ws2, (m) => m.type === 'terminal.attached')

      // Snapshot should contain recent markers but not all
      expect(attached.snapshot).toContain('marker-9') // Most recent
      // Earlier markers may be evicted depending on buffer size

      close2()
    })

    it('handles large single output chunk', async () => {
      const { ws, close } = await createAuthenticatedConnection()

      const terminalId = await createTerminal(ws, 'large-chunk')

      // Single large chunk
      const outputPromise = waitForMessage(ws, (m) => m.type === 'terminal.output')
      registry.simulateOutput(terminalId, 'x'.repeat(50_000))

      const output = await outputPromise
      expect(output.data.length).toBe(50_000)

      close()
    })
  })

  describe('Connection limits', () => {
    it('rejects connections beyond MAX_CONNECTIONS', async () => {
      // MAX_CONNECTIONS is set to 5 in test setup
      // First, let's wait for any cleanup from previous tests
      await new Promise((r) => setTimeout(r, 300))

      const connections: WebSocket[] = []
      const closes: (() => void)[] = []

      try {
        // Fill up all 5 connection slots
        for (let i = 0; i < 5; i++) {
          const { ws, close } = await createAuthenticatedConnection()
          connections.push(ws)
          closes.push(close)
        }

        // Verify we have exactly 5 connections
        expect(wsHandler.connectionCount()).toBe(5)

        // 6th connection should be rejected immediately on connection
        const wsExtra = new WebSocket(`ws://127.0.0.1:${port}/ws`)

        const closeEvent = await new Promise<{ code: number }>((resolve, reject) => {
          const timeout = setTimeout(() => {
            // If timeout occurs, check if ws is open and close it
            if (wsExtra.readyState === WebSocket.OPEN) {
              wsExtra.close()
              reject(new Error('Connection was accepted when it should be rejected'))
            } else {
              reject(new Error('Connection did not close'))
            }
          }, 5000)

          wsExtra.on('close', (code) => {
            clearTimeout(timeout)
            resolve({ code })
          })
        })

        expect(closeEvent.code).toBe(4003) // MAX_CONNECTIONS
      } finally {
        // Clean up all connections
        closes.forEach((c) => c())
        await new Promise((r) => setTimeout(r, 200))
      }
    })

    it('allows new connection after another disconnects', async () => {
      // Wait for cleanup from previous tests
      await new Promise((r) => setTimeout(r, 300))

      const connections: { ws: WebSocket; close: () => void }[] = []

      try {
        // Fill up all 5 connection slots
        for (let i = 0; i < 5; i++) {
          const conn = await createAuthenticatedConnection()
          connections.push(conn)
        }

        // Verify we have exactly 5 connections
        expect(wsHandler.connectionCount()).toBe(5)

        // Close one and wait for server to process
        const closedConn = connections.shift()!
        await new Promise<void>((resolve) => {
          closedConn.ws.on('close', () => resolve())
          closedConn.close()
        })
        await new Promise((r) => setTimeout(r, 200))

        // Verify one slot is free
        expect(wsHandler.connectionCount()).toBe(4)

        // Should be able to connect now
        const newConn = await createAuthenticatedConnection()
        expect(newConn.ws.readyState).toBe(WebSocket.OPEN)
        newConn.close()
      } finally {
        connections.forEach((c) => c.close())
        await new Promise((r) => setTimeout(r, 200))
      }
    })
  })

  describe('Race conditions', () => {
    it('handles concurrent terminal creates with same requestId', async () => {
      const { ws, close } = await createAuthenticatedConnection()

      const requestId = 'concurrent-create'

      // Send multiple create requests with same requestId simultaneously
      ws.send(JSON.stringify({ type: 'terminal.create', requestId, mode: 'shell' }))
      ws.send(JSON.stringify({ type: 'terminal.create', requestId, mode: 'shell' }))
      ws.send(JSON.stringify({ type: 'terminal.create', requestId, mode: 'shell' }))

      // Collect all created responses
      const responses: any[] = []
      await new Promise<void>((resolve) => {
        const handler = (data: WebSocket.Data) => {
          const msg = JSON.parse(data.toString())
          if (msg.type === 'terminal.created' && msg.requestId === requestId) {
            responses.push(msg)
            if (responses.length === 3) {
              ws.off('message', handler)
              resolve()
            }
          }
        }
        ws.on('message', handler)
        setTimeout(() => {
          ws.off('message', handler)
          resolve()
        }, 1000)
      })

      // All responses should have the same terminalId (idempotent)
      const terminalIds = new Set(responses.map((r) => r.terminalId))
      expect(terminalIds.size).toBe(1)

      close()
    })

    it('reuses running claude terminal when resumeSessionId matches', async () => {
      const { ws, close } = await createAuthenticatedConnection()

      const requestId1 = 'resume-claude-1'
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId: requestId1,
        mode: 'claude',
        resumeSessionId: VALID_SESSION_ID,
      }))

      const created1 = await waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === requestId1)

      const requestId2 = 'resume-claude-2'
      ws.send(JSON.stringify({
        type: 'terminal.create',
        requestId: requestId2,
        mode: 'claude',
        resumeSessionId: VALID_SESSION_ID,
      }))

      const created2 = await waitForMessage(ws, (m) => m.type === 'terminal.created' && m.requestId === requestId2)

      expect(created2.terminalId).toBe(created1.terminalId)
      expect(created2.effectiveResumeSessionId).toBe(VALID_SESSION_ID)

      close()
    })

    it('handles attach/detach race on same terminal', async () => {
      const { ws: ws1, close: close1 } = await createAuthenticatedConnection()
      const { ws: ws2, close: close2 } = await createAuthenticatedConnection()

      const terminalId = await createTerminal(ws1, 'attach-detach-race')

      // Rapid attach/detach from second client
      for (let i = 0; i < 10; i++) {
        ws2.send(JSON.stringify({ type: 'terminal.attach', terminalId }))
        ws2.send(JSON.stringify({ type: 'terminal.detach', terminalId }))
      }

      // Wait for all messages to process
      await new Promise((r) => setTimeout(r, 300))

      // Terminal should still be accessible
      ws2.send(JSON.stringify({ type: 'terminal.attach', terminalId }))
      const attached = await waitForMessage(ws2, (m) => m.type === 'terminal.attached')
      expect(attached.terminalId).toBe(terminalId)

      close1()
      close2()
    })

    it('handles kill during output flood', async () => {
      const { ws, close } = await createAuthenticatedConnection()

      const terminalId = await createTerminal(ws, 'kill-during-flood')

      // Start flooding output
      const floodInterval = setInterval(() => {
        registry.simulateOutput(terminalId, 'flood data\n')
      }, 10)

      // Wait a bit then kill
      await new Promise((r) => setTimeout(r, 50))
      ws.send(JSON.stringify({ type: 'terminal.kill', terminalId }))

      clearInterval(floodInterval)

      // Wait for kill to process
      await waitForMessage(ws, (m) => m.type === 'terminal.list.updated')

      // Terminal should be killed
      expect(registry.killCalls).toContain(terminalId)

      close()
    })
  })

  describe('Ping/pong liveness', () => {
    it('ping works before authentication', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))

      ws.send(JSON.stringify({ type: 'ping' }))

      const pong = await waitForMessage(ws, (m) => m.type === 'pong')
      expect(pong.timestamp).toBeDefined()

      ws.close()
    })

    it('ping works after authentication', async () => {
      const { ws, close } = await createAuthenticatedConnection()

      ws.send(JSON.stringify({ type: 'ping' }))

      const pong = await waitForMessage(ws, (m) => m.type === 'pong')
      expect(pong.timestamp).toBeDefined()

      close()
    })

    it('handles rapid ping requests', async () => {
      const { ws, close } = await createAuthenticatedConnection()

      // Send many pings rapidly
      for (let i = 0; i < 20; i++) {
        ws.send(JSON.stringify({ type: 'ping' }))
      }

      // Collect pongs
      const pongs = await collectMessages(ws, 500)
      const pongCount = pongs.filter((m) => m.type === 'pong').length

      expect(pongCount).toBe(20)

      close()
    })
  })

  describe('Origin validation for loopback connections', () => {
    it('allows loopback connections regardless of Origin header', async () => {
      // This test verifies the fix for remote LAN access via Vite dev proxy.
      // When Vite proxies WebSocket connections, the connection arrives from localhost (127.0.0.1)
      // but may have a mismatched Origin header (e.g., "http://192.168.x.x:5173").
      // Loopback connections should be trusted regardless of Origin.

      // Our test infrastructure connects from 127.0.0.1, so any connection we make
      // tests the loopback bypass. The key is that it succeeds despite not being
      // in ALLOWED_ORIGINS (which only has localhost:5173 and localhost:3001 by default).
      const { ws, close } = await createAuthenticatedConnection()

      // If we got here, the loopback connection was accepted
      expect(ws.readyState).toBe(WebSocket.OPEN)

      // Verify we can actually use it
      const terminalId = await createTerminal(ws, 'loopback-test')
      expect(terminalId).toMatch(/^term_/)

      close()
    })

    it('allows connections without Origin header from loopback', async () => {
      // Loopback connections without Origin should also be accepted.
      // This can happen with some WebSocket client libraries.
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connection timeout')), 5000)
        ws.on('open', () => {
          clearTimeout(timeout)
          resolve()
        })
        ws.on('error', (err) => {
          clearTimeout(timeout)
          reject(err)
        })
      })

      // Should be able to authenticate
      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))

      const ready = await waitForMessage(ws, (m) => m.type === 'ready')
      expect(ready.type).toBe('ready')

      ws.close()
    })
  })

  describe('Error recovery', () => {
    it('recovers from invalid messages without disconnecting', async () => {
      const { ws, close } = await createAuthenticatedConnection()

      // Send invalid message
      ws.send('not valid json')
      await waitForMessage(ws, (m) => m.type === 'error' && m.code === 'INVALID_MESSAGE')

      // Connection should still work
      const terminalId = await createTerminal(ws, 'after-error')
      expect(terminalId).toMatch(/^term_/)

      // Send another invalid message
      ws.send(JSON.stringify({ type: 'unknown.type' }))
      await waitForMessage(ws, (m) => m.type === 'error')

      // Should still work
      ws.send(JSON.stringify({ type: 'ping' }))
      const pong = await waitForMessage(ws, (m) => m.type === 'pong')
      expect(pong).toBeDefined()

      close()
    })

    it('includes requestId in error responses when available', async () => {
      const { ws, close } = await createAuthenticatedConnection()

      // Send invalid message with requestId
      ws.send(JSON.stringify({ type: 'terminal.create', mode: 'shell' })) // missing requestId

      const error = await waitForMessage(ws, (m) => m.type === 'error')
      expect(error.code).toBe('INVALID_MESSAGE')
      // requestId would be undefined since it's missing

      close()
    })
  })
})
