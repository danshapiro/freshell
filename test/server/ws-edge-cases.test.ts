import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest'
import http from 'http'
import WebSocket from 'ws'
import { EventEmitter } from 'events'
import { WS_PROTOCOL_VERSION } from '../../shared/ws-protocol'

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
class FakeRegistry extends EventEmitter {
  records = new Map<string, any>()
  inputCalls: { terminalId: string; data: string }[] = []
  resizeCalls: { terminalId: string; cols: number; rows: number }[] = []
  killCalls: string[] = []

  // Control hooks for testing edge cases
  onOutputListeners = new Map<string, (data: string) => void>()
  onExitListeners = new Map<string, (code: number) => void>()

  constructor() {
    super()
  }

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
      suppressedOutputClients: new Set<WebSocket>(),
    }
    this.records.set(terminalId, rec)
    return rec
  }

  get(terminalId: string) {
    return this.records.get(terminalId) || null
  }

  attach(terminalId: string, ws: WebSocket, opts?: { suppressOutput?: boolean }) {
    const rec = this.records.get(terminalId)
    if (!rec) return null
    rec.clients.add(ws)
    if (opts?.suppressOutput) rec.suppressedOutputClients.add(ws)
    return rec
  }

  detach(terminalId: string, ws: WebSocket) {
    const rec = this.records.get(terminalId)
    if (!rec) return false
    rec.clients.delete(ws)
    rec.suppressedOutputClients.delete(ws)
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

  // Simulate terminal output for testing
  simulateOutput(terminalId: string, data: string) {
    const rec = this.records.get(terminalId)
    if (!rec || rec.status !== 'running') return
    this.emit('terminal.output.raw', { terminalId, data, at: Date.now() })
    rec.buffer.append(data)
    for (const client of rec.clients) {
      if (rec.suppressedOutputClients.has(client)) continue
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
  }

  // Simulate backpressure by checking buffered amount
  safeSend(client: WebSocket, msg: unknown) {
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
  })

  afterEach(async () => {
    const activeConnections = Array.from((wsHandler as any).connections ?? []) as WebSocket[]
    for (const ws of activeConnections) {
      try {
        ws.close()
      } catch {
        // ignore teardown close failures
      }
    }
    await new Promise((r) => setTimeout(r, 25))
  })

  afterAll(async () => {
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }, HOOK_TIMEOUT_MS)

  // Helper: create authenticated connection
  async function createAuthenticatedConnection(opts?: {
    protocolVersion?: number
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
      protocolVersion: opts?.protocolVersion ?? WS_PROTOCOL_VERSION,
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

  function waitForMessages(
    ws: WebSocket,
    predicates: Array<(msg: any) => boolean>,
    timeoutMs = 2000,
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
    it('rejects hello without protocol version', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))

      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))

      const error = await waitForMessage(ws, (m) => m.type === 'error')
      expect(error.code).toBe('PROTOCOL_MISMATCH')
      expect(error.message).toContain('protocol version')

      const closeCode = await new Promise<number>((resolve) => {
        ws.on('close', (code) => resolve(code))
      })
      expect(closeCode).toBe(4010)
    })

    it('rejects hello with mismatched protocol version', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))

      ws.send(JSON.stringify({
        type: 'hello',
        token: 'testtoken-testtoken',
        protocolVersion: WS_PROTOCOL_VERSION - 1,
      }))

      const error = await waitForMessage(ws, (m) => m.type === 'error')
      expect(error.code).toBe('PROTOCOL_MISMATCH')
      expect(error.message).toContain('protocol version')

      const closeCode = await new Promise<number>((resolve) => {
        ws.on('close', (code) => resolve(code))
      })
      expect(closeCode).toBe(4010)
    })

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
      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
      await waitForMessage(ws, (m) => m.type === 'ready')

      // Second hello remains idempotent and should return another ready.
      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))
      const readyAgain = await waitForMessage(ws, (m) => m.type === 'ready')
      expect(readyAgain.type).toBe('ready')

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
      expect(created.snapshot).toBeUndefined()
      expect(created.snapshotChunked).toBeUndefined()

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

  describe('Terminal stream v2 replay and pressure handling', () => {
    it('sinceSeq replays only missing frames on terminal.attach', async () => {
      const { ws: ws1, close: close1 } = await createAuthenticatedConnection()
      const terminalId = await createTerminal(ws1, 'sinceSeq-replay')

      registry.simulateOutput(terminalId, 'one')
      const output1 = await waitForMessage(ws1, (m) => m.type === 'terminal.output' && m.terminalId === terminalId)

      registry.simulateOutput(terminalId, 'two')
      const output2 = await waitForMessage(
        ws1,
        (m) =>
          m.type === 'terminal.output'
          && m.terminalId === terminalId
          && typeof m.seqStart === 'number'
          && m.seqStart > output1.seqEnd,
      )
      const lastSeq = output2.seqEnd

      close1()
      await new Promise((resolve) => setTimeout(resolve, 25))

      const { ws: ws2, close: close2 } = await createAuthenticatedConnection()
      ws2.send(JSON.stringify({ type: 'terminal.attach', terminalId, sinceSeq: lastSeq }))

      const ready = await waitForMessage(
        ws2,
        (m) => m.type === 'terminal.attach.ready' && m.terminalId === terminalId,
      )
      expect(ready.replayFromSeq).toBe(lastSeq + 1)
      expect(ready.replayToSeq).toBe(lastSeq)

      registry.simulateOutput(terminalId, 'three')
      const output3 = await waitForMessage(
        ws2,
        (m) => m.type === 'terminal.output' && m.terminalId === terminalId,
      )
      expect(output3.seqStart).toBe(lastSeq + 1)
      expect(output3.seqEnd).toBeGreaterThanOrEqual(output3.seqStart)

      close2()
    })

    it('emits replay_window_exceeded gap before replay tail, then continues with live output', async () => {
      const previousReplayRingMaxBytes = process.env.TERMINAL_REPLAY_RING_MAX_BYTES
      process.env.TERMINAL_REPLAY_RING_MAX_BYTES = '48'
      try {
        const { ws: ws1, close: close1 } = await createAuthenticatedConnection()
        const terminalId = await createTerminal(ws1, 'replay-gap-order')

        for (let i = 1; i <= 12; i += 1) {
          registry.simulateOutput(terminalId, `frame-${i}-xxxxx|`)
        }
        await waitForMessage(
          ws1,
          (m) => m.type === 'terminal.output' && m.terminalId === terminalId && m.seqEnd >= 12,
        )

        close1()
        await new Promise((resolve) => setTimeout(resolve, 25))

        const { ws: ws2, close: close2 } = await createAuthenticatedConnection()
        const orderedEvents: Array<{ type: string; data?: string }> = []
        const eventListener = (data: WebSocket.Data) => {
          const msg = JSON.parse(data.toString())
          if (msg.terminalId !== terminalId) return
          if (
            msg.type === 'terminal.attach.ready'
            || msg.type === 'terminal.output.gap'
            || msg.type === 'terminal.output'
          ) {
            orderedEvents.push({ type: msg.type, data: msg.data })
          }
        }
        ws2.on('message', eventListener)

        const pending = waitForMessages(ws2, [
          (m) => m.type === 'terminal.attach.ready' && m.terminalId === terminalId,
          (m) => m.type === 'terminal.output.gap' && m.terminalId === terminalId && m.reason === 'replay_window_exceeded',
          (m) => m.type === 'terminal.output' && m.terminalId === terminalId,
        ], 5000)
        ws2.send(JSON.stringify({ type: 'terminal.attach', terminalId, sinceSeq: 1 }))
        const [ready, gap, replayTail] = await pending

        registry.simulateOutput(terminalId, 'live-after-gap-tail')
        const live = await waitForMessage(
          ws2,
          (m) => m.type === 'terminal.output' && m.terminalId === terminalId && String(m.data).includes('live-after-gap-tail'),
        )

        ws2.off('message', eventListener)

        expect(gap.fromSeq).toBe(2)
        expect(gap.toSeq).toBe(ready.replayFromSeq - 1)
        expect(gap.reason).toBe('replay_window_exceeded')
        expect(replayTail.seqStart).toBeGreaterThanOrEqual(ready.replayFromSeq)
        expect(replayTail.seqEnd).toBeLessThanOrEqual(ready.replayToSeq)
        expect(live.seqStart).toBeGreaterThan(ready.replayToSeq)

        const readyIndex = orderedEvents.findIndex((event) => event.type === 'terminal.attach.ready')
        const gapIndex = orderedEvents.findIndex((event) => event.type === 'terminal.output.gap')
        const replayIndex = orderedEvents.findIndex((event) => event.type === 'terminal.output')
        const liveIndex = orderedEvents.findIndex(
          (event) => event.type === 'terminal.output' && event.data?.includes('live-after-gap-tail'),
        )

        expect(readyIndex).toBeGreaterThanOrEqual(0)
        expect(gapIndex).toBeGreaterThan(readyIndex)
        expect(replayIndex).toBeGreaterThan(gapIndex)
        expect(liveIndex).toBeGreaterThan(replayIndex)

        close2()
      } finally {
        if (previousReplayRingMaxBytes === undefined) delete process.env.TERMINAL_REPLAY_RING_MAX_BYTES
        else process.env.TERMINAL_REPLAY_RING_MAX_BYTES = previousReplayRingMaxBytes
      }
    })

    it('emits terminal.output.gap on queue overflow instead of closing', async () => {
      const previousQueueMaxBytes = process.env.TERMINAL_CLIENT_QUEUE_MAX_BYTES
      process.env.TERMINAL_CLIENT_QUEUE_MAX_BYTES = '64'
      try {
        const { ws, close } = await createAuthenticatedConnection()
        const terminalId = await createTerminal(ws, 'output-gap-overflow')
        const received: any[] = []
        const handler = (data: WebSocket.Data) => {
          received.push(JSON.parse(data.toString()))
        }
        ws.on('message', handler)

        for (let i = 0; i < 40; i += 1) {
          registry.simulateOutput(terminalId, `chunk-${i}-${'x'.repeat(24)}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 200))

        ws.off('message', handler)
        const gap = received.find((m) => m.type === 'terminal.output.gap' && m.terminalId === terminalId)
        expect(gap).toBeDefined()
        expect(gap.reason).toBe('queue_overflow')

        close()
      } finally {
        if (previousQueueMaxBytes === undefined) delete process.env.TERMINAL_CLIENT_QUEUE_MAX_BYTES
        else process.env.TERMINAL_CLIENT_QUEUE_MAX_BYTES = previousQueueMaxBytes
      }
    })

    it('no routine 4008 close under slow consumer simulation', async () => {
      const { ws, close } = await createAuthenticatedConnection()
      const closeCodes: number[] = []
      ws.on('close', (code) => closeCodes.push(code))

      const terminalId = await createTerminal(ws, 'no-routine-4008')
      for (let i = 0; i < 200; i += 1) {
        registry.simulateOutput(terminalId, `burst-${i}`)
      }

      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(closeCodes).not.toContain(4008)

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
      const [ready, firstReplay] = await waitForMessages(ws2, [
        (m) => m.type === 'terminal.attach.ready' && m.terminalId === terminalId,
        (m) => m.type === 'terminal.output' && m.terminalId === terminalId,
      ], 5000)
      const replayFrames = await collectMessages(ws2, 150)
      const replayText = [firstReplay, ...replayFrames]
        .filter((m) => m.type === 'terminal.output' && m.terminalId === terminalId)
        .map((m) => m.data as string)
        .join('')
      expect(ready.headSeq).toBeGreaterThan(0)
      expect(replayText.length).toBeGreaterThan(0)
      expect(/line [123]/.test(replayText)).toBe(true)

      close2()
    })

    it('sends terminal.attach.ready before any replayed terminal.output after attach', async () => {
      const { ws: ws1, close: close1 } = await createAuthenticatedConnection()

      const terminalId = await createTerminal(ws1, 'attach-order')
      registry.simulateOutput(terminalId, 'replay me first\n')
      close1()
      await new Promise((r) => setTimeout(r, 50))

      const { ws: ws2, close: close2 } = await createAuthenticatedConnection()

      const received: Array<'ready' | 'output'> = []
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws2.off('message', handler)
          reject(new Error('Timeout waiting for attach-ready/output order'))
        }, 5000)

        const handler = (data: WebSocket.Data) => {
          const msg = JSON.parse(data.toString())
          if (msg.terminalId !== terminalId) return
          if (msg.type === 'terminal.attach.ready') received.push('ready')
          if (msg.type === 'terminal.output') received.push('output')
          if (received.includes('ready') && received.includes('output')) {
            clearTimeout(timeout)
            ws2.off('message', handler)
            resolve()
          }
        }

        ws2.on('message', handler)
        ws2.send(JSON.stringify({ type: 'terminal.attach', terminalId }))
      })

      expect(received[0]).toBe('ready')

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
      await waitForMessage(ws2, (m) => m.type === 'terminal.attach.ready' && m.terminalId === terminalId)

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

  describe('Attach replay protocol v2', () => {
    it('no legacy attach chunk messages are emitted during replay', async () => {
      const { ws: ws1, close: close1 } = await createAuthenticatedConnection()
      const terminalId = await createTerminal(ws1, 'attach-v2-replay')
      registry.simulateOutput(terminalId, 'x'.repeat(70_000))
      close1()
      await new Promise((r) => setTimeout(r, 50))

      const { ws: ws2, close: close2 } = await createAuthenticatedConnection()
      ws2.send(JSON.stringify({ type: 'terminal.attach', terminalId }))

      const [ready, replay] = await waitForMessages(ws2, [
        (m) => m.type === 'terminal.attach.ready' && m.terminalId === terminalId,
        (m) => m.type === 'terminal.output' && m.terminalId === terminalId,
      ], 5000)

      expect(ready.headSeq).toBeGreaterThanOrEqual(replay.seqEnd)
      expect(replay.data.length).toBeGreaterThan(60_000)

      const extras = await collectMessages(ws2, 150)
      const legacyFrames = extras.filter((m) => typeof m.type === 'string' && m.type.startsWith('terminal.attached'))
      expect(legacyFrames).toHaveLength(0)

      close2()
    })

    it('reused terminal.create returns snapshot-free terminal.created and attach.ready', async () => {
      const { ws, close } = await createAuthenticatedConnection()
      const requestId = 'attach-v2-create-reuse'
      const terminalId = await createTerminal(ws, requestId)
      registry.simulateOutput(terminalId, 'seed output')

      ws.send(JSON.stringify({ type: 'terminal.create', requestId, mode: 'shell' }))
      const [created, ready] = await waitForMessages(ws, [
        (m) => m.type === 'terminal.created' && m.requestId === requestId,
        (m) => m.type === 'terminal.attach.ready' && m.terminalId === terminalId,
      ], 5000)

      expect(created.terminalId).toBe(terminalId)
      expect(created.snapshot).toBeUndefined()
      expect(created.snapshotChunked).toBeUndefined()
      expect(ready.headSeq).toBeGreaterThanOrEqual(0)

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
      await waitForMessage(ws2, (m) => m.type === 'terminal.attach.ready' && m.terminalId === terminalId)

      ws3.send(JSON.stringify({ type: 'terminal.attach', terminalId }))
      await waitForMessage(ws3, (m) => m.type === 'terminal.attach.ready' && m.terminalId === terminalId)

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
      await waitForMessage(ws2, (m) => m.type === 'terminal.attach.ready' && m.terminalId === terminalId)

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

      const attachReady = waitForMessage(ws2, (m) => m.type === 'terminal.attach.ready' && m.terminalId === terminalId)
      ws2.send(JSON.stringify({ type: 'terminal.attach', terminalId }))
      await attachReady

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
      await waitForMessage(ws2, (m) => m.type === 'terminal.attach.ready' && m.terminalId === terminalId)

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

      await waitForMessage(ws2, (m) => m.type === 'terminal.attach.ready' && m.terminalId === terminalId)
      const replay = await waitForMessage(ws2, (m) => m.type === 'terminal.output' && m.terminalId === terminalId)

      // Snapshot should contain recent markers but not all
      expect(/marker-(6|7|8|9)\|/.test(replay.data)).toBe(true)
      expect(replay.data).not.toContain('marker-0')
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

    it('includes close code 4003 in the reason when max connections exceeded', async () => {
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

        // 6th connection gets rejected with close code and reason
        const wsExtra = new WebSocket(`ws://127.0.0.1:${port}/ws`)
        const closeEvent = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Timeout')), 5000)
          wsExtra.on('close', (code, reason) => {
            clearTimeout(timeout)
            resolve({ code, reason: reason.toString() })
          })
        })

        expect(closeEvent.code).toBe(4003)
        expect(closeEvent.reason).toBe('Too many connections')
      } finally {
        closes.forEach((c) => c())
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
      const ready = await waitForMessage(ws2, (m) => m.type === 'terminal.attach.ready' && m.terminalId === terminalId)
      expect(ready.terminalId).toBe(terminalId)

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
      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))

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
