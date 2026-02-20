// @vitest-environment node
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import http from 'http'
import WebSocket from 'ws'
import { WsHandler, chunkProjects } from '../../../server/ws-handler'
import { TerminalRegistry } from '../../../server/terminal-registry'
import type { ProjectGroup } from '../../../server/coding-cli/types'

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

describe('WsHandler integration: handshake completes under backpressure', () => {
  it('sends all chunked sessions without backpressure close on a real WS connection', async () => {
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
      ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))

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
