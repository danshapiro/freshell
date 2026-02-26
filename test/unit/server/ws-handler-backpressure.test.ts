// @vitest-environment node
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import http from 'http'
import WebSocket from 'ws'
import { WsHandler } from '../../../server/ws-handler'
import { TerminalRegistry } from '../../../server/terminal-registry'
import { TerminalStreamBroker } from '../../../server/terminal-stream/broker'
import { chunkProjects } from '../../../server/ws-chunking'
import type { ProjectGroup } from '../../../server/coding-cli/types'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol'

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}))

/** Create a mock WebSocket that extends EventEmitter (like real ws WebSockets) */
function createMockWs(overrides: Record<string, unknown> = {}) {
  const ws = new EventEmitter() as EventEmitter & {
    bufferedAmount: number
    readyState: number
    send: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    connectionId?: string
    sessionUpdateGeneration?: number
  }
  ws.bufferedAmount = 0
  ws.readyState = WebSocket.OPEN
  ws.send = vi.fn()
  ws.close = vi.fn()
  Object.assign(ws, overrides)
  return ws
}

class FakeBrokerRegistry extends EventEmitter {
  private records = new Map<string, { terminalId: string; mode: string; buffer: { snapshot: () => string } }>()
  private replayRingMaxChars: number | undefined

  createTerminal(terminalId: string, mode = 'shell') {
    this.records.set(terminalId, {
      terminalId,
      mode,
      buffer: { snapshot: () => '' },
    })
  }

  attach(terminalId: string) {
    return this.records.get(terminalId) ?? null
  }

  detach(_terminalId: string) {
    return true
  }

  setReplayRingMaxBytes(next: number | undefined) {
    this.replayRingMaxChars = next
  }

  getReplayRingMaxChars() {
    return this.replayRingMaxChars
  }

  get(terminalId: string) {
    return this.records.get(terminalId)
  }
}

describe('WsHandler backpressure', () => {
  let server: http.Server
  let handler: WsHandler
  let registry: TerminalRegistry

  beforeEach(async () => {
    server = http.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    registry = new TerminalRegistry()
    handler = new WsHandler(server, registry)
  })

  afterEach(async () => {
    handler.close()
    registry.shutdown()
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('closes the socket when bufferedAmount exceeds the limit', () => {
    const ws = {
      bufferedAmount: 10_000_000,
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    } as any

    ;(handler as any).send(ws, { type: 'test' })

    expect(ws.close).toHaveBeenCalled()
    expect(ws.send).not.toHaveBeenCalled()
  })
})

describe('WsHandler.waitForDrain', () => {
  let server: http.Server
  let handler: WsHandler
  let registry: TerminalRegistry

  beforeEach(async () => {
    server = http.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    registry = new TerminalRegistry()
    handler = new WsHandler(server, registry)
  })

  afterEach(async () => {
    handler.close()
    registry.shutdown()
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('resolves true immediately when bufferedAmount is below threshold', async () => {
    const ws = createMockWs({ bufferedAmount: 100 })
    const result = await (handler as any).waitForDrain(ws, 512 * 1024, 5000)
    expect(result).toBe(true)
  })

  it('resolves true when bufferedAmount drops below threshold via polling', async () => {
    const ws = createMockWs({ bufferedAmount: 1_000_000 })

    // Simulate buffer draining after ~100ms
    setTimeout(() => {
      ws.bufferedAmount = 0
    }, 100)

    const result = await (handler as any).waitForDrain(ws, 512 * 1024, 5000)
    expect(result).toBe(true)
  })

  it('resolves false when timeout expires and bufferedAmount stays high', async () => {
    const ws = createMockWs({ bufferedAmount: 1_000_000 })

    const result = await (handler as any).waitForDrain(ws, 512 * 1024, 100)
    expect(result).toBe(false)
  })

  it('resolves false when connection closes while waiting', async () => {
    const ws = createMockWs({ bufferedAmount: 1_000_000 })

    // Simulate connection close after 50ms
    setTimeout(() => {
      ws.readyState = WebSocket.CLOSED
      ws.emit('close')
    }, 50)

    const result = await (handler as any).waitForDrain(ws, 512 * 1024, 5000)
    expect(result).toBe(false)
  })

  it('resolves false immediately when readyState is not OPEN', async () => {
    const ws = createMockWs({ readyState: WebSocket.CLOSED, bufferedAmount: 1_000_000 })
    const result = await (handler as any).waitForDrain(ws, 512 * 1024, 5000)
    expect(result).toBe(false)
  })

  it('cleans up timer and poller after resolving', async () => {
    const ws = createMockWs({ bufferedAmount: 100 })
    await (handler as any).waitForDrain(ws, 512 * 1024, 5000)
    // After resolving, no close listener should remain from waitForDrain
    expect(ws.listenerCount('close')).toBe(0)
  })

  it('resolves false immediately when shouldCancel returns true', async () => {
    const ws = createMockWs({ bufferedAmount: 1_000_000 })
    const result = await (handler as any).waitForDrain(ws, 512 * 1024, 5000, () => true)
    expect(result).toBe(false)
  })

  it('resolves false when shouldCancel becomes true during polling', async () => {
    const ws = createMockWs({ bufferedAmount: 1_000_000 })
    let cancelled = false

    // Cancel after 100ms (before the 5s timeout)
    setTimeout(() => { cancelled = true }, 100)

    const result = await (handler as any).waitForDrain(ws, 512 * 1024, 5000, () => cancelled)
    expect(result).toBe(false)
  })
})

describe('WsHandler.sendChunkedSessions drain-aware sending', () => {
  let server: http.Server
  let handler: WsHandler
  let registry: TerminalRegistry

  // Create projects that will produce multiple chunks at default MAX_CHUNK_BYTES (500KB).
  // Each project has sessions with large summaries to ensure we exceed the chunk threshold.
  function createLargeProjects(count: number): ProjectGroup[] {
    return Array.from({ length: count }, (_, i) => ({
      projectPath: `/tmp/project-${i}/${'path-segment'.repeat(10)}`,
      sessions: Array.from({ length: 10 }, (_, j) => ({
        provider: 'claude' as const,
        sessionId: `sess-${i}-${j}-${'x'.repeat(500)}`,
        projectPath: `/tmp/project-${i}/${'path-segment'.repeat(10)}`,
        updatedAt: Date.now(),
        summary: `Summary text for session ${j} ${'lorem ipsum dolor sit amet '.repeat(20)}`,
      })),
    }))
  }

  beforeEach(async () => {
    server = http.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    registry = new TerminalRegistry()
    handler = new WsHandler(server, registry)
  })

  afterEach(async () => {
    handler.close()
    registry.shutdown()
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('calls waitForDrain when bufferedAmount exceeds threshold after sending a chunk', async () => {
    // Create enough data for multiple chunks
    const projects = createLargeProjects(100)
    const chunks = chunkProjects(projects, 500 * 1024)
    // Verify we actually have multiple chunks
    expect(chunks.length).toBeGreaterThanOrEqual(2)

    const sentMessages: unknown[] = []
    const ws = createMockWs()
    // Simulate high bufferedAmount after first send
    ws.send = vi.fn().mockImplementation(() => {
      sentMessages.push('sent')
      // After first chunk, simulate high buffer
      if (sentMessages.length === 1) {
        ws.bufferedAmount = 1_000_000 // above 512KB threshold
      }
    })

    // Spy on waitForDrain to verify it's called
    const waitForDrainSpy = vi.spyOn(handler as any, 'waitForDrain')
    // Make waitForDrain resolve true (buffer drained)
    waitForDrainSpy.mockResolvedValue(true)

    const result = await (handler as any).sendChunkedSessions(ws, projects)

    expect(waitForDrainSpy).toHaveBeenCalled()
    // All chunks should still be sent since drain resolves true
    expect(ws.send).toHaveBeenCalledTimes(chunks.length)
    expect(result).toBe(true)
  })

  it('stops sending and returns false when waitForDrain times out', async () => {
    const projects = createLargeProjects(100)
    const chunks = chunkProjects(projects, 500 * 1024)
    expect(chunks.length).toBeGreaterThanOrEqual(2)

    const ws = createMockWs()
    ws.send = vi.fn().mockImplementation(() => {
      // Always report high buffer after send
      ws.bufferedAmount = 1_000_000
    })

    // Make waitForDrain return false (timed out)
    const waitForDrainSpy = vi.spyOn(handler as any, 'waitForDrain')
    waitForDrainSpy.mockResolvedValue(false)

    const result = await (handler as any).sendChunkedSessions(ws, projects)

    // Should have sent only the first chunk, then stopped
    expect(ws.send).toHaveBeenCalledTimes(1)
    // Must return false so caller knows snapshot is incomplete
    expect(result).toBe(false)
  })

  it('uses setImmediate yield and returns true when bufferedAmount is low (fast client path)', async () => {
    const projects = createLargeProjects(100)
    const chunks = chunkProjects(projects, 500 * 1024)
    expect(chunks.length).toBeGreaterThanOrEqual(2)

    const ws = createMockWs({ bufferedAmount: 0 })
    // Keep bufferedAmount low for all sends
    ws.send = vi.fn()

    const waitForDrainSpy = vi.spyOn(handler as any, 'waitForDrain')

    const result = await (handler as any).sendChunkedSessions(ws, projects)

    // waitForDrain should NOT have been called since buffer is always low
    expect(waitForDrainSpy).not.toHaveBeenCalled()
    // All chunks should be sent
    expect(ws.send).toHaveBeenCalledTimes(chunks.length)
    expect(result).toBe(true)
  })

  it('returns false when connection closes mid-send', async () => {
    const projects = createLargeProjects(100)
    const chunks = chunkProjects(projects, 500 * 1024)
    expect(chunks.length).toBeGreaterThanOrEqual(2)

    const ws = createMockWs()
    let sendCount = 0
    ws.send = vi.fn().mockImplementation(() => {
      sendCount++
      if (sendCount >= 1) {
        // Simulate connection closing after first send
        ws.readyState = WebSocket.CLOSED
      }
    })

    const result = await (handler as any).sendChunkedSessions(ws, projects)

    expect(result).toBe(false)
    expect(ws.send).toHaveBeenCalledTimes(1)
  })

  it('returns false when connection closes on final chunk send (backpressure kill)', async () => {
    // Single-chunk scenario: safeSend triggers backpressure close on the only chunk
    const projects = [{ projectPath: '/tmp/p', sessions: [{ provider: 'claude' as const, sessionId: 's1', projectPath: '/tmp/p', updatedAt: Date.now() }] }]

    const ws = createMockWs()
    ws.send = vi.fn().mockImplementation(() => {
      // Simulate backpressure close triggered by send()
      ws.readyState = WebSocket.CLOSING
    })

    const result = await (handler as any).sendChunkedSessions(ws, projects)

    // Should return false because connection died during final send
    expect(result).toBe(false)
  })

  it('returns false when generation is superseded during drain wait', async () => {
    const projects = createLargeProjects(100)
    const chunks = chunkProjects(projects, 500 * 1024)
    expect(chunks.length).toBeGreaterThanOrEqual(2)

    const ws = createMockWs()
    ws.send = vi.fn().mockImplementation(() => {
      ws.bufferedAmount = 1_000_000
    })

    // Let waitForDrain use the real implementation (with shouldCancel)
    // but simulate a generation change during the wait
    const origWaitForDrain = (handler as any).waitForDrain.bind(handler)
    vi.spyOn(handler as any, 'waitForDrain').mockImplementation(
      async (wsArg: any, threshold: number, timeout: number, shouldCancel?: () => boolean) => {
        // Simulate a new sendChunkedSessions call superseding this one
        wsArg.sessionUpdateGeneration = (wsArg.sessionUpdateGeneration || 0) + 1
        // The shouldCancel predicate should detect the generation change
        return origWaitForDrain(wsArg, threshold, timeout, shouldCancel)
      }
    )

    const result = await (handler as any).sendChunkedSessions(ws, projects)
    expect(result).toBe(false)
  })
})

describe('WsHandler.broadcastSessionsUpdatedToLegacy patch-mode transition', () => {
  let server: http.Server
  let handler: WsHandler
  let registry: TerminalRegistry

  beforeEach(async () => {
    server = http.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    registry = new TerminalRegistry()
    handler = new WsHandler(server, registry)
  })

  afterEach(async () => {
    handler.close()
    registry.shutdown()
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('sets sessionsSnapshotSent after successful broadcast for patch-capable clients', async () => {
    const ws = createMockWs()
    ws.send = vi.fn()

    // Register the connection and create client state (simulating a post-handshake client)
    const connections = (handler as any).connections as Set<any>
    const clientStates = (handler as any).clientStates as Map<any, any>
    connections.add(ws)
    clientStates.set(ws, {
      authenticated: true,
      supportsSessionsPatchV1: true,
      sessionsSnapshotSent: false, // handshake failed, flag not set
      attachedTerminalIds: new Set(),
      createdByRequestId: new Map(),
      terminalCreateTimestamps: [],
      codingCliSubscriptions: new Map(),
    })

    const projects = [{ projectPath: '/tmp/p', sessions: [] }]
    handler.broadcastSessionsUpdatedToLegacy(projects)

    // Wait for the async .then() to execute
    await new Promise<void>((resolve) => setImmediate(resolve))

    const state = clientStates.get(ws)
    expect(state.sessionsSnapshotSent).toBe(true)
  })
})

describe('WsHandler integration: chunked handshake snapshot delivery', () => {
  it('delivers all session chunks over a real WS connection', async () => {
    // Use small chunk size to force multiple chunks
    process.env.MAX_WS_CHUNK_BYTES = '500'
    process.env.AUTH_TOKEN = 'testtoken-testtoken'
    process.env.HELLO_TIMEOUT_MS = '100'

    // Re-import to pick up new env vars
    vi.resetModules()
    const { WsHandler: FreshWsHandler } = await import('../../../server/ws-handler')
    const { TerminalRegistry: FreshTerminalRegistry } = await import('../../../server/terminal-registry')

    const projects = Array.from({ length: 20 }, (_, i) => ({
      projectPath: `/tmp/project-${i}`,
      sessions: Array.from({ length: 5 }, (_, j) => ({
        provider: 'claude' as const,
        sessionId: `sess-${i}-${j}`,
        projectPath: `/tmp/project-${i}`,
        updatedAt: Date.now(),
      })),
    }))

    const server = http.createServer()
    const registry = new FreshTerminalRegistry()
    new (FreshWsHandler as any)(
      server,
      registry,
      undefined,
      undefined,
      undefined,
      async () => ({
        settings: { theme: 'dark' },
        projects,
      }),
    )

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address() as { port: number }

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`)
      await new Promise<void>((resolve) => ws.on('open', () => resolve()))

      const messages: any[] = []
      let closeCode: number | undefined

      ws.on('message', (data) => {
        messages.push(JSON.parse(data.toString()))
      })
      ws.on('close', (code) => {
        closeCode = code
      })

      // Start handshake
      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken', protocolVersion: WS_PROTOCOL_VERSION }))

      // Wait for all messages to arrive (with idle timeout)
      await new Promise<void>((resolve) => {
        let idleTimer: ReturnType<typeof setTimeout>
        const resetIdle = () => {
          clearTimeout(idleTimer)
          idleTimer = setTimeout(resolve, 1000)
        }
        ws.on('message', resetIdle)
        resetIdle()
      })

      // Connection should NOT have been closed with backpressure code
      expect(closeCode).not.toBe(4008)

      // Should have received ready + settings + at least 1 sessions.updated
      const types = messages.map((m) => m.type)
      expect(types).toContain('ready')
      expect(types).toContain('settings.updated')
      expect(types).toContain('sessions.updated')

      // All session projects should have arrived across all chunks
      const sessionMsgs = messages.filter((m) => m.type === 'sessions.updated')
      const allProjects = sessionMsgs.flatMap((m) => m.projects)
      expect(allProjects.length).toBe(20)

      ws.terminate()
    } finally {
      registry.shutdown()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      delete process.env.MAX_WS_CHUNK_BYTES
      delete process.env.AUTH_TOKEN
      delete process.env.HELLO_TIMEOUT_MS
    }
  })
})

describe('TerminalStreamBroker catastrophic bufferedAmount handling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('does not close the socket for short-lived catastrophic bufferedAmount spikes', async () => {
    const registry = new FakeBrokerRegistry()
    const perfSpy = vi.fn()
    const broker = new TerminalStreamBroker(registry as any, perfSpy)
    registry.createTerminal('term-spike')

    const ws = createMockWs({
      bufferedAmount: 17 * 1024 * 1024, // Above catastrophic threshold
    })
    const closeSpy = vi.spyOn(ws, 'close')

    const attached = await broker.attach(ws as any, 'term-spike', 0)
    expect(attached).toBe(true)

    registry.emit('terminal.output.raw', { terminalId: 'term-spike', data: 'first', at: Date.now() })

    // Stay above threshold for less than the sustained stall window.
    vi.advanceTimersByTime(9_000)
    expect(closeSpy).not.toHaveBeenCalled()

    // Recover below threshold and allow queued frame to flush.
    ws.bufferedAmount = 0
    vi.advanceTimersByTime(100)
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining('"type":"terminal.output"'))
    expect(perfSpy).not.toHaveBeenCalledWith('terminal_stream_catastrophic_close', expect.any(Object), expect.anything())

    broker.close()
  })

  it('closes the socket with 4008 after sustained catastrophic bufferedAmount', async () => {
    const registry = new FakeBrokerRegistry()
    const perfSpy = vi.fn()
    const broker = new TerminalStreamBroker(registry as any, perfSpy)
    registry.createTerminal('term-stalled')

    const ws = createMockWs({
      bufferedAmount: 17 * 1024 * 1024, // Above catastrophic threshold
    })
    const closeSpy = vi.spyOn(ws, 'close')

    const attached = await broker.attach(ws as any, 'term-stalled', 0)
    expect(attached).toBe(true)

    registry.emit('terminal.output.raw', { terminalId: 'term-stalled', data: 'blocked', at: Date.now() })

    // Exceed the sustained stall threshold (10s default) so broker must hard-close.
    vi.advanceTimersByTime(11_000)

    expect(closeSpy).toHaveBeenCalledWith(4008, 'Catastrophic backpressure')
    expect(closeSpy).toHaveBeenCalledTimes(1)
    expect(perfSpy).toHaveBeenCalledWith(
      'terminal_stream_catastrophic_close',
      expect.objectContaining({ terminalId: 'term-stalled' }),
      'warn',
    )

    broker.close()
  })

  it('emits terminal_stream_replay_miss and terminal_stream_gap events when replay window is exceeded', async () => {
    const originalRingMax = process.env.TERMINAL_REPLAY_RING_MAX_BYTES
    process.env.TERMINAL_REPLAY_RING_MAX_BYTES = '8'
    try {
      const registry = new FakeBrokerRegistry()
      const perfSpy = vi.fn()
      const broker = new TerminalStreamBroker(registry as any, perfSpy)
      registry.createTerminal('term-replay')

      const wsSeed = createMockWs()
      await broker.attach(wsSeed as any, 'term-replay', 0)

      registry.emit('terminal.output.raw', { terminalId: 'term-replay', data: 'aaaa', at: Date.now() })
      registry.emit('terminal.output.raw', { terminalId: 'term-replay', data: 'bbbb', at: Date.now() })
      registry.emit('terminal.output.raw', { terminalId: 'term-replay', data: 'cccc', at: Date.now() })

      const wsReplay = createMockWs()
      await broker.attach(wsReplay as any, 'term-replay', 0)

      expect(perfSpy.mock.calls.some(([event, payload, level]) =>
        event === 'terminal_stream_replay_miss' &&
        payload?.terminalId === 'term-replay' &&
        level === 'warn',
      )).toBe(true)
      expect(perfSpy.mock.calls.some(([event, payload, level]) =>
        event === 'terminal_stream_gap' &&
        payload?.terminalId === 'term-replay' &&
        payload?.reason === 'replay_window_exceeded' &&
        level === 'warn',
      )).toBe(true)

      broker.close()
    } finally {
      if (originalRingMax === undefined) delete process.env.TERMINAL_REPLAY_RING_MAX_BYTES
      else process.env.TERMINAL_REPLAY_RING_MAX_BYTES = originalRingMax
    }
  })

  it('echoes attachRequestId on attach.ready, output, and output.gap for a client attachment', async () => {
    const registry = new FakeBrokerRegistry()
    const broker = new TerminalStreamBroker(registry as any, vi.fn())
    registry.createTerminal('term-attach-id')

    const ws = createMockWs()
    const attached = await broker.attach(ws as any, 'term-attach-id', 0, 'attach-1')
    expect(attached).toBe(true)

    registry.emit('terminal.output.raw', { terminalId: 'term-attach-id', data: 'seed', at: Date.now() })
    for (let i = 0; i < 240; i += 1) {
      registry.emit('terminal.output.raw', { terminalId: 'term-attach-id', data: 'x'.repeat(1024), at: Date.now() })
    }
    vi.advanceTimersByTime(5)

    const payloads = ws.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
      .filter((payload): payload is Record<string, any> => !!payload && typeof payload === 'object')

    expect(payloads.some((m) => m.type === 'terminal.attach.ready' && m.attachRequestId === 'attach-1')).toBe(true)
    expect(payloads.some((m) => m.type === 'terminal.output' && m.attachRequestId === 'attach-1')).toBe(true)
    expect(payloads.some((m) => m.type === 'terminal.output.gap' && m.attachRequestId === 'attach-1')).toBe(true)

    broker.close()
  })

  it('superseding attach on same socket clears stale queued frames and avoids duplicate old-frame delivery', async () => {
    const registry = new FakeBrokerRegistry()
    const broker = new TerminalStreamBroker(registry as any, vi.fn())
    registry.createTerminal('term-supersede')

    const ws = createMockWs()
    await broker.attach(ws as any, 'term-supersede', 0, 'attach-old')
    registry.emit('terminal.output.raw', { terminalId: 'term-supersede', data: 'old-frame', at: Date.now() })

    await broker.attach(ws as any, 'term-supersede', 1, 'attach-new')
    registry.emit('terminal.output.raw', { terminalId: 'term-supersede', data: 'new-frame', at: Date.now() })
    vi.advanceTimersByTime(5)

    const outputs = ws.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
      .filter((m) => m?.type === 'terminal.output')

    expect(outputs.some((m) => String(m.data).includes('new-frame') && m.attachRequestId === 'attach-new')).toBe(true)
    expect(outputs.some((m) => String(m.data).includes('old-frame'))).toBe(false)

    broker.close()
  })

  it('emits terminal_stream_replay_hit, terminal_stream_queue_pressure, and terminal_stream_gap on overflow', async () => {
    const registry = new FakeBrokerRegistry()
    const perfSpy = vi.fn()
    const broker = new TerminalStreamBroker(registry as any, perfSpy)
    registry.createTerminal('term-overflow')

    const wsSeed = createMockWs()
    await broker.attach(wsSeed as any, 'term-overflow', 0)
    registry.emit('terminal.output.raw', { terminalId: 'term-overflow', data: 'seed-1', at: Date.now() })
    registry.emit('terminal.output.raw', { terminalId: 'term-overflow', data: 'seed-2', at: Date.now() })

    const wsReplay = createMockWs()
    await broker.attach(wsReplay as any, 'term-overflow', 1)
    expect(perfSpy.mock.calls.some(([event, payload]) =>
      event === 'terminal_stream_replay_hit' &&
      payload?.terminalId === 'term-overflow' &&
      payload?.sinceSeq === 1,
    )).toBe(true)

    const wsOverflow = createMockWs()
    await broker.attach(wsOverflow as any, 'term-overflow', 0)

    for (let i = 0; i < 220; i += 1) {
      registry.emit('terminal.output.raw', { terminalId: 'term-overflow', data: 'x'.repeat(1024), at: Date.now() })
    }
    vi.advanceTimersByTime(5)

    expect(perfSpy.mock.calls.some(([event, payload, level]) =>
      event === 'terminal_stream_queue_pressure' &&
      payload?.terminalId === 'term-overflow' &&
      level === 'warn',
    )).toBe(true)
    expect(perfSpy.mock.calls.some(([event, payload, level]) =>
      event === 'terminal_stream_gap' &&
      payload?.terminalId === 'term-overflow' &&
      payload?.reason === 'queue_overflow' &&
      level === 'warn',
    )).toBe(true)

    broker.close()
  })

  it('uses registry replay budget to avoid replay-window gaps for moderate retained history', async () => {
    const registry = new FakeBrokerRegistry()
    registry.setReplayRingMaxBytes(1_000_000)
    const perfSpy = vi.fn()
    const broker = new TerminalStreamBroker(registry as any, perfSpy)
    registry.createTerminal('term-replay-budget')

    const wsSeed = createMockWs()
    await broker.attach(wsSeed as any, 'term-replay-budget', 0)
    registry.emit('terminal.output.raw', {
      terminalId: 'term-replay-budget',
      data: 'a'.repeat(400 * 1024),
      at: Date.now(),
    })

    const wsReplay = createMockWs()
    await broker.attach(wsReplay as any, 'term-replay-budget', 0)

    const payloads = wsReplay.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
      .filter((payload): payload is Record<string, any> => !!payload && typeof payload === 'object')

    expect(payloads.some((payload) =>
      payload.type === 'terminal.output.gap' &&
      payload.reason === 'replay_window_exceeded'
    )).toBe(false)
    expect(payloads.some((payload) => payload.type === 'terminal.output')).toBe(true)

    broker.close()
  })

  it('enforces a larger replay floor for coding-cli terminals to reduce history loss on attach', async () => {
    const registry = new FakeBrokerRegistry()
    registry.setReplayRingMaxBytes(8)
    const perfSpy = vi.fn()
    const broker = new TerminalStreamBroker(registry as any, perfSpy)
    registry.createTerminal('term-coding-floor', 'codex')

    const wsSeed = createMockWs()
    await broker.attach(wsSeed as any, 'term-coding-floor', 0)
    registry.emit('terminal.output.raw', {
      terminalId: 'term-coding-floor',
      data: 'x'.repeat(96 * 1024),
      at: Date.now(),
    })

    const wsReplay = createMockWs()
    await broker.attach(wsReplay as any, 'term-coding-floor', 0)

    const payloads = wsReplay.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
      .filter((payload): payload is Record<string, any> => !!payload && typeof payload === 'object')

    expect(payloads.some((payload) =>
      payload.type === 'terminal.output.gap' &&
      payload.reason === 'replay_window_exceeded'
    )).toBe(false)
    expect(payloads.some((payload) => payload.type === 'terminal.output')).toBe(true)

    broker.close()
  })

  it('replays a truncated frame tail for single oversized output without replay-window gaps', async () => {
    const registry = new FakeBrokerRegistry()
    registry.setReplayRingMaxBytes(8)
    const perfSpy = vi.fn()
    const broker = new TerminalStreamBroker(registry as any, perfSpy)
    registry.createTerminal('term-oversized-tail')

    const wsSeed = createMockWs()
    await broker.attach(wsSeed as any, 'term-oversized-tail', 0)
    registry.emit('terminal.output.raw', {
      terminalId: 'term-oversized-tail',
      data: '0123456789',
      at: Date.now(),
    })

    const wsReplay = createMockWs()
    await broker.attach(wsReplay as any, 'term-oversized-tail', 0)

    const payloads = wsReplay.send.mock.calls
      .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
      .filter((payload): payload is Record<string, any> => !!payload && typeof payload === 'object')

    const replayOutput = payloads.find((payload) => payload.type === 'terminal.output')
    expect(replayOutput).toBeDefined()
    expect(Buffer.byteLength(replayOutput?.data ?? '', 'utf8')).toBeLessThanOrEqual(8)
    expect(payloads.some((payload) =>
      payload.type === 'terminal.output.gap' &&
      payload.reason === 'replay_window_exceeded'
    )).toBe(false)

    broker.close()
  })
})
