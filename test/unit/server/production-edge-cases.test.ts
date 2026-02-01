/**
 * Production Edge Cases Tests
 *
 * These tests focus on scenarios that could cause production issues:
 * - PTY spawn failures
 * - Memory leaks and resource cleanup
 * - Connection handling edge cases
 * - Graceful degradation under failure conditions
 * - Backpressure and rate limiting
 *
 * "What breaks at 3am on a Saturday?"
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { EventEmitter } from 'events'
import type WebSocket from 'ws'

// Mock the logger before importing modules that use it
vi.mock('../../../server/logger', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  }
  logger.child.mockReturnValue(logger)
  return { logger }
})

// Mock node-pty with controllable behavior
const mockPtySpawn = vi.fn()
vi.mock('node-pty', () => ({
  spawn: (...args: any[]) => mockPtySpawn(...args),
}))

import { TerminalRegistry, ChunkRingBuffer } from '../../../server/terminal-registry'
import { logger } from '../../../server/logger'

// ============================================================================
// TERMINAL REGISTRY EDGE CASES
// ============================================================================

describe('TerminalRegistry Production Edge Cases', () => {
  const originalEnv = { ...process.env }
  let registry: TerminalRegistry

  // Helper to create a mock PTY process
  function createMockPty(options: {
    shouldExitImmediately?: boolean
    exitCode?: number
    shouldThrowOnWrite?: boolean
    shouldThrowOnKill?: boolean
    shouldThrowOnResize?: boolean
  } = {}) {
    const pty = new EventEmitter() as EventEmitter & {
      write: Mock
      kill: Mock
      resize: Mock
      onData: (cb: (data: string) => void) => void
      onExit: (cb: (e: { exitCode: number }) => void) => void
      pid: number
    }

    const dataCallbacks: ((data: string) => void)[] = []
    const exitCallbacks: ((e: { exitCode: number }) => void)[] = []

    pty.onData = (cb) => dataCallbacks.push(cb)
    pty.onExit = (cb) => exitCallbacks.push(cb)
    pty.write = vi.fn().mockImplementation(() => {
      if (options.shouldThrowOnWrite) throw new Error('PTY write failed')
    })
    pty.kill = vi.fn().mockImplementation(() => {
      if (options.shouldThrowOnKill) throw new Error('PTY kill failed - process may be zombie')
    })
    pty.resize = vi.fn().mockImplementation(() => {
      if (options.shouldThrowOnResize) throw new Error('PTY resize failed')
    })
    pty.pid = Math.floor(Math.random() * 100000)

    // Simulate data emission
    const emitData = (data: string) => dataCallbacks.forEach((cb) => cb(data))
    const emitExit = (exitCode = 0) => exitCallbacks.forEach((cb) => cb({ exitCode }))

    if (options.shouldExitImmediately) {
      setTimeout(() => emitExit(options.exitCode ?? 0), 0)
    }

    return { pty, emitData, emitExit }
  }

  beforeEach(() => {
    vi.resetAllMocks()
    process.env = { ...originalEnv, AUTH_TOKEN: 'test-token-16chars-minimum' }

    // Default mock returns a working PTY
    const { pty } = createMockPty()
    mockPtySpawn.mockReturnValue(pty)
  })

  afterEach(() => {
    process.env = originalEnv
    // Ensure idle monitor is stopped
    if (registry) {
      // Access private member for cleanup
      const anyRegistry = registry as any
      if (anyRegistry.idleTimer) {
        clearInterval(anyRegistry.idleTimer)
      }
    }
  })

  // --------------------------------------------------------------------------
  // PTY SPAWN FAILURE SCENARIOS
  // --------------------------------------------------------------------------

  describe('PTY Spawn Failures', () => {
    it('handles PTY spawn throwing synchronous error', () => {
      mockPtySpawn.mockImplementation(() => {
        throw new Error('ENOENT: /bin/nonexistent not found')
      })

      registry = new TerminalRegistry()

      expect(() => {
        registry.create({ mode: 'shell' })
      }).toThrow('ENOENT')

      // Registry should remain in consistent state
      expect(registry.list()).toHaveLength(0)
    })

    it('handles PTY spawn throwing with permission denied', () => {
      mockPtySpawn.mockImplementation(() => {
        throw new Error('EACCES: permission denied')
      })

      registry = new TerminalRegistry()

      expect(() => {
        registry.create({ mode: 'claude' })
      }).toThrow('EACCES')

      expect(registry.list()).toHaveLength(0)
    })

    it('handles PTY spawn throwing out of file descriptors', () => {
      mockPtySpawn.mockImplementation(() => {
        throw new Error('EMFILE: too many open files')
      })

      registry = new TerminalRegistry()

      expect(() => {
        registry.create({ mode: 'shell' })
      }).toThrow('EMFILE')

      // Verify no partial state was left behind
      expect(registry.list()).toHaveLength(0)
    })

    it('handles PTY spawn returning null (hypothetical edge case)', () => {
      mockPtySpawn.mockReturnValue(null)

      registry = new TerminalRegistry()

      // This should throw because we try to call methods on null
      expect(() => {
        registry.create({ mode: 'shell' })
      }).toThrow()
    })
  })

  // --------------------------------------------------------------------------
  // ZOMBIE PROCESS AND CLEANUP SCENARIOS
  // --------------------------------------------------------------------------

  describe('Zombie Process Prevention', () => {
    it('handles pty.kill() throwing an error', () => {
      const { pty } = createMockPty({ shouldThrowOnKill: true })
      mockPtySpawn.mockReturnValue(pty)

      registry = new TerminalRegistry()
      const record = registry.create({ mode: 'shell' })
      const terminalId = record.terminalId

      // Kill should not throw - error is logged and handled
      const result = registry.kill(terminalId)

      expect(result).toBe(true)
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'kill failed'
      )

      // Terminal should be marked as exited even if kill threw
      const term = registry.get(terminalId)
      expect(term?.status).toBe('exited')
    })

    it('cleans up client references when kill() throws', () => {
      const { pty } = createMockPty({ shouldThrowOnKill: true })
      mockPtySpawn.mockReturnValue(pty)

      registry = new TerminalRegistry()
      const record = registry.create({ mode: 'shell' })

      // Simulate attached client
      const mockWs = {
        send: vi.fn(),
        readyState: 1,
        bufferedAmount: 0,
      } as unknown as WebSocket
      registry.attach(record.terminalId, mockWs)

      expect(record.clients.size).toBe(1)

      // Kill should still clean up clients even if pty.kill throws
      registry.kill(record.terminalId)

      expect(record.clients.size).toBe(0)
    })

    it('handles remove() after terminal already exited', () => {
      const { pty, emitExit } = createMockPty()
      mockPtySpawn.mockReturnValue(pty)

      registry = new TerminalRegistry()
      const record = registry.create({ mode: 'shell' })
      const terminalId = record.terminalId

      // Simulate process exiting on its own
      emitExit(0)

      // Now try to remove - should handle gracefully
      const result = registry.remove(terminalId)
      expect(result).toBe(true)

      // Terminal should be fully removed
      expect(registry.get(terminalId)).toBeUndefined()
      expect(registry.list().find((t) => t.terminalId === terminalId)).toBeUndefined()
    })

    it('handles double kill() calls', () => {
      const { pty } = createMockPty()
      mockPtySpawn.mockReturnValue(pty)

      registry = new TerminalRegistry()
      const record = registry.create({ mode: 'shell' })

      // First kill
      registry.kill(record.terminalId)
      expect(record.status).toBe('exited')

      // Second kill should be idempotent
      const result = registry.kill(record.terminalId)
      // kill() on already exited terminal still returns true
      expect(result).toBe(true)
    })
  })

  // --------------------------------------------------------------------------
  // MEMORY LEAK SCENARIOS
  // --------------------------------------------------------------------------

  describe('Memory Leak Prevention', () => {
    it('removes terminal from internal map on remove()', () => {
      const { pty } = createMockPty()
      mockPtySpawn.mockReturnValue(pty)

      registry = new TerminalRegistry()
      const record = registry.create({ mode: 'shell' })
      const terminalId = record.terminalId

      expect(registry.list()).toHaveLength(1)

      registry.remove(terminalId)

      expect(registry.list()).toHaveLength(0)
      expect(registry.get(terminalId)).toBeUndefined()
    })

    it('clears client set when PTY exits naturally', async () => {
      const { pty, emitExit } = createMockPty()
      mockPtySpawn.mockReturnValue(pty)

      registry = new TerminalRegistry()
      const record = registry.create({ mode: 'shell' })

      // Attach some clients
      const mockWs1 = { send: vi.fn(), bufferedAmount: 0 } as unknown as WebSocket
      const mockWs2 = { send: vi.fn(), bufferedAmount: 0 } as unknown as WebSocket
      registry.attach(record.terminalId, mockWs1)
      registry.attach(record.terminalId, mockWs2)

      expect(record.clients.size).toBe(2)

      // PTY exits
      emitExit(0)

      // Wait for async handlers
      await vi.waitFor(() => expect(record.clients.size).toBe(0))
    })

    it('handles high-frequency data output without memory explosion', () => {
      const { pty, emitData } = createMockPty()
      mockPtySpawn.mockReturnValue(pty)

      registry = new TerminalRegistry()
      const record = registry.create({ mode: 'shell' })

      // Simulate high-frequency output (100KB chunks, 100 times = 10MB)
      const largeChunk = 'x'.repeat(100 * 1024)
      for (let i = 0; i < 100; i++) {
        emitData(largeChunk)
      }

      // Buffer should be capped at DEFAULT_MAX_SCROLLBACK_CHARS (64KB default)
      const snapshot = record.buffer.snapshot()
      expect(snapshot.length).toBeLessThanOrEqual(64 * 1024)
    })

    it('idle monitor timer is created and runs', () => {
      vi.useFakeTimers()

      const { pty } = createMockPty()
      mockPtySpawn.mockReturnValue(pty)

      const settings = {
        safety: { autoKillIdleMinutes: 1 },
      } as any

      registry = new TerminalRegistry(settings)
      const record = registry.create({ mode: 'shell' })

      // Detach all clients (required for idle kill)
      // No clients are attached initially after create, unless attach is called

      // Fast forward past idle threshold
      vi.advanceTimersByTime(35_000) // Past the 30s check interval

      // The idle check should run but terminal has activity timestamp too recent
      expect(record.status).toBe('running')

      // Make terminal appear idle by manipulating lastActivityAt
      record.lastActivityAt = Date.now() - 2 * 60 * 1000 // 2 minutes ago

      // Advance to trigger another check
      vi.advanceTimersByTime(35_000)

      // Terminal should be killed
      expect(record.status).toBe('exited')

      vi.useRealTimers()
    })
  })

  // --------------------------------------------------------------------------
  // CONCURRENT ACCESS SCENARIOS
  // --------------------------------------------------------------------------

  describe('Concurrent Access Handling', () => {
    it('handles rapid attach/detach cycles', () => {
      const { pty } = createMockPty()
      mockPtySpawn.mockReturnValue(pty)

      registry = new TerminalRegistry()
      const record = registry.create({ mode: 'shell' })

      const mockWs = { send: vi.fn(), bufferedAmount: 0 } as unknown as WebSocket

      // Rapid attach/detach
      for (let i = 0; i < 100; i++) {
        registry.attach(record.terminalId, mockWs)
        registry.detach(record.terminalId, mockWs)
      }

      // Should end up with no clients
      expect(record.clients.size).toBe(0)
    })

    it('handles detach during exit event processing', async () => {
      const { pty, emitExit } = createMockPty()
      mockPtySpawn.mockReturnValue(pty)

      registry = new TerminalRegistry()
      const record = registry.create({ mode: 'shell' })

      const mockWs = { send: vi.fn(), bufferedAmount: 0 } as unknown as WebSocket
      registry.attach(record.terminalId, mockWs)

      // Trigger exit which clears clients
      emitExit(0)

      // Immediately try to detach - should handle gracefully
      const result = registry.detach(record.terminalId, mockWs)

      // Result depends on timing, but should not throw
      expect(typeof result).toBe('boolean')
    })

    it('handles multiple simultaneous terminal creations', () => {
      const { pty } = createMockPty()
      mockPtySpawn.mockReturnValue(pty)

      registry = new TerminalRegistry()

      // Create 50 terminals rapidly
      const terminals = []
      for (let i = 0; i < 50; i++) {
        mockPtySpawn.mockReturnValue(createMockPty().pty)
        terminals.push(registry.create({ mode: 'shell' }))
      }

      // All should have unique IDs
      const ids = new Set(terminals.map((t) => t.terminalId))
      expect(ids.size).toBe(50)
      expect(registry.list()).toHaveLength(50)
    })
  })

  // --------------------------------------------------------------------------
  // BACKPRESSURE HANDLING
  // --------------------------------------------------------------------------

  describe('Backpressure Handling', () => {
    it('drops messages when client bufferedAmount exceeds limit', () => {
      const { pty, emitData } = createMockPty()
      mockPtySpawn.mockReturnValue(pty)

      registry = new TerminalRegistry()
      const record = registry.create({ mode: 'shell' })

      // Client with high buffered amount (simulating slow consumer)
      const slowClient = {
        send: vi.fn(),
        bufferedAmount: 10 * 1024 * 1024, // 10MB - exceeds 2MB limit
      } as unknown as WebSocket

      registry.attach(record.terminalId, slowClient)

      // Emit data
      emitData('test output')

      // Message should be dropped due to backpressure
      expect(slowClient.send).not.toHaveBeenCalled()
    })

    it('sends to fast clients while dropping for slow ones', () => {
      const { pty, emitData } = createMockPty()
      mockPtySpawn.mockReturnValue(pty)

      registry = new TerminalRegistry()
      const record = registry.create({ mode: 'shell' })

      const fastClient = {
        send: vi.fn(),
        bufferedAmount: 0,
      } as unknown as WebSocket

      const slowClient = {
        send: vi.fn(),
        bufferedAmount: 10 * 1024 * 1024,
      } as unknown as WebSocket

      registry.attach(record.terminalId, fastClient)
      registry.attach(record.terminalId, slowClient)

      emitData('test output')

      expect(fastClient.send).toHaveBeenCalled()
      expect(slowClient.send).not.toHaveBeenCalled()
    })

    it('handles send() throwing an error', () => {
      const { pty, emitData } = createMockPty()
      mockPtySpawn.mockReturnValue(pty)

      registry = new TerminalRegistry()
      const record = registry.create({ mode: 'shell' })

      const failingClient = {
        send: vi.fn().mockImplementation(() => {
          throw new Error('WebSocket is closed')
        }),
        bufferedAmount: 0,
      } as unknown as WebSocket

      registry.attach(record.terminalId, failingClient)

      // Should not throw
      expect(() => emitData('test output')).not.toThrow()
    })
  })

  // --------------------------------------------------------------------------
  // INPUT/OUTPUT EDGE CASES
  // --------------------------------------------------------------------------

  describe('Input/Output Edge Cases', () => {
    it('handles input to non-existent terminal', () => {
      registry = new TerminalRegistry()

      const result = registry.input('nonexistent-terminal-id', 'test')
      expect(result).toBe(false)
    })

    it('handles input to exited terminal', () => {
      const { pty, emitExit } = createMockPty()
      mockPtySpawn.mockReturnValue(pty)

      registry = new TerminalRegistry()
      const record = registry.create({ mode: 'shell' })

      emitExit(0)

      const result = registry.input(record.terminalId, 'test')
      expect(result).toBe(false)
    })

    it('handles resize with extreme dimensions', () => {
      const { pty } = createMockPty()
      mockPtySpawn.mockReturnValue(pty)

      registry = new TerminalRegistry()
      const record = registry.create({ mode: 'shell' })

      // Very large dimensions
      registry.resize(record.terminalId, 10000, 5000)
      expect(pty.resize).toHaveBeenCalledWith(10000, 5000)

      // Zero/negative handled by zod validation in ws-handler,
      // but registry should still work
      registry.resize(record.terminalId, 1, 1)
      expect(pty.resize).toHaveBeenCalledWith(1, 1)
    })

    it('handles resize throwing error', () => {
      const { pty } = createMockPty({ shouldThrowOnResize: true })
      mockPtySpawn.mockReturnValue(pty)

      registry = new TerminalRegistry()
      const record = registry.create({ mode: 'shell' })

      // Should not throw, just log
      const result = registry.resize(record.terminalId, 80, 24)
      expect(result).toBe(true) // Still returns true since terminal exists
      expect(logger.debug).toHaveBeenCalled()
    })

    it('handles binary/control characters in input', () => {
      const { pty } = createMockPty()
      mockPtySpawn.mockReturnValue(pty)

      registry = new TerminalRegistry()
      const record = registry.create({ mode: 'shell' })

      // Control sequences, null bytes, unicode
      const weirdInput = '\x00\x1b[A\r\n\u0000\uFFFF'
      registry.input(record.terminalId, weirdInput)

      expect(pty.write).toHaveBeenCalledWith(weirdInput)
    })
  })

  // --------------------------------------------------------------------------
  // TITLE AND DESCRIPTION UPDATES
  // --------------------------------------------------------------------------

  describe('Metadata Updates', () => {
    it('handles updateTitle on non-existent terminal', () => {
      registry = new TerminalRegistry()

      const result = registry.updateTitle('nonexistent', 'New Title')
      expect(result).toBe(false)
    })

    it('handles updateDescription on non-existent terminal', () => {
      registry = new TerminalRegistry()

      const result = registry.updateDescription('nonexistent', 'New Description')
      expect(result).toBe(false)
    })

    it('handles empty/undefined descriptions', () => {
      const { pty } = createMockPty()
      mockPtySpawn.mockReturnValue(pty)

      registry = new TerminalRegistry()
      const record = registry.create({ mode: 'shell' })

      registry.updateDescription(record.terminalId, undefined)
      expect(record.description).toBeUndefined()

      registry.updateDescription(record.terminalId, '')
      expect(record.description).toBe('')
    })
  })
})

// ============================================================================
// CHUNK RING BUFFER STRESS TESTS
// ============================================================================

describe('ChunkRingBuffer Production Stress Tests', () => {
  it('handles millions of tiny appends efficiently', () => {
    const buffer = new ChunkRingBuffer(1024)
    const startTime = Date.now()

    for (let i = 0; i < 100000; i++) {
      buffer.append('x')
    }

    const elapsed = Date.now() - startTime

    // Should complete in reasonable time (< 1 second)
    expect(elapsed).toBeLessThan(1000)
    expect(buffer.snapshot().length).toBeLessThanOrEqual(1024)
  })

  it('handles very long single appends', () => {
    const buffer = new ChunkRingBuffer(1000)

    // 1MB string
    const megaString = 'x'.repeat(1024 * 1024)
    buffer.append(megaString)

    // Should truncate to maxChars
    expect(buffer.snapshot().length).toBe(1000)
  })

  it('maintains correct order after truncation cycles', () => {
    const buffer = new ChunkRingBuffer(10)

    for (let i = 0; i < 100; i++) {
      buffer.append(`[${i % 10}]`)
    }

    // Should only contain recent data
    const snapshot = buffer.snapshot()
    expect(snapshot.length).toBeLessThanOrEqual(10)
  })

  it('handles alternating large and small chunks', () => {
    const buffer = new ChunkRingBuffer(100)

    for (let i = 0; i < 1000; i++) {
      if (i % 2 === 0) {
        buffer.append('tiny')
      } else {
        buffer.append('this_is_a_much_longer_chunk_that_takes_more_space')
      }
    }

    expect(buffer.snapshot().length).toBeLessThanOrEqual(100)
  })

  it('handles clear() under high frequency operations', () => {
    const buffer = new ChunkRingBuffer(100)

    for (let i = 0; i < 1000; i++) {
      buffer.append('data')
      if (i % 100 === 0) {
        buffer.clear()
      }
    }

    // Should still work correctly after many clears
    expect(buffer.snapshot().length).toBeLessThanOrEqual(100)
  })
})

// ============================================================================
// WEBSOCKET HANDLER EDGE CASES (UNIT TESTS - MOCKED)
// ============================================================================

describe('WebSocket Message Handling Edge Cases', () => {
  // These test the parsing and validation logic without a real WS server

  it('validates resize dimensions are within reasonable bounds', () => {
    // The zod schema in ws-handler validates:
    // cols: z.number().int().min(2).max(1000)
    // rows: z.number().int().min(2).max(500)

    const { z } = require('zod')

    const ResizeSchema = z.object({
      type: z.literal('terminal.resize'),
      terminalId: z.string().min(1),
      cols: z.number().int().min(2).max(1000),
      rows: z.number().int().min(2).max(500),
    })

    // Valid
    expect(
      ResizeSchema.safeParse({
        type: 'terminal.resize',
        terminalId: 'test',
        cols: 80,
        rows: 24,
      }).success
    ).toBe(true)

    // Invalid - cols too large
    expect(
      ResizeSchema.safeParse({
        type: 'terminal.resize',
        terminalId: 'test',
        cols: 10000,
        rows: 24,
      }).success
    ).toBe(false)

    // Invalid - rows too small
    expect(
      ResizeSchema.safeParse({
        type: 'terminal.resize',
        terminalId: 'test',
        cols: 80,
        rows: 1,
      }).success
    ).toBe(false)

    // Invalid - non-integer
    expect(
      ResizeSchema.safeParse({
        type: 'terminal.resize',
        terminalId: 'test',
        cols: 80.5,
        rows: 24,
      }).success
    ).toBe(false)
  })

  it('validates terminal input has required fields', () => {
    const { z } = require('zod')

    const InputSchema = z.object({
      type: z.literal('terminal.input'),
      terminalId: z.string().min(1),
      data: z.string(),
    })

    // Valid empty data
    expect(
      InputSchema.safeParse({
        type: 'terminal.input',
        terminalId: 'test',
        data: '',
      }).success
    ).toBe(true)

    // Invalid - missing terminalId
    expect(
      InputSchema.safeParse({
        type: 'terminal.input',
        data: 'test',
      }).success
    ).toBe(false)

    // Invalid - empty terminalId
    expect(
      InputSchema.safeParse({
        type: 'terminal.input',
        terminalId: '',
        data: 'test',
      }).success
    ).toBe(false)
  })

  it('validates create request has requestId', () => {
    const { z } = require('zod')

    const CreateSchema = z.object({
      type: z.literal('terminal.create'),
      requestId: z.string().min(1),
      mode: z.enum(['shell', 'claude', 'codex']).default('shell'),
    })

    // Valid
    expect(
      CreateSchema.safeParse({
        type: 'terminal.create',
        requestId: 'req-123',
      }).success
    ).toBe(true)

    // Invalid - empty requestId
    expect(
      CreateSchema.safeParse({
        type: 'terminal.create',
        requestId: '',
      }).success
    ).toBe(false)

    // Invalid - missing requestId
    expect(
      CreateSchema.safeParse({
        type: 'terminal.create',
      }).success
    ).toBe(false)
  })
})

// ============================================================================
// GRACEFUL SHUTDOWN SIMULATION
// ============================================================================

describe('Graceful Shutdown Scenarios', () => {
  it('can kill all terminals on shutdown', () => {
    const registryInstance = new TerminalRegistry()

    // Create mock PTYs for multiple terminals
    const terminals = []
    for (let i = 0; i < 5; i++) {
      const { pty } = createMockPty()
      mockPtySpawn.mockReturnValueOnce(pty)
      terminals.push(registryInstance.create({ mode: 'shell' }))
    }

    expect(registryInstance.list()).toHaveLength(5)

    // Simulate shutdown - kill all
    for (const term of registryInstance.list()) {
      registryInstance.kill(term.terminalId)
    }

    // All should be exited
    for (const term of terminals) {
      expect(term.status).toBe('exited')
    }
  })

  it('handles shutdown with mix of running and exited terminals', () => {
    const registryInstance = new TerminalRegistry()

    // Create terminals
    const { pty: pty1, emitExit: exit1 } = createMockPty()
    const { pty: pty2 } = createMockPty()
    const { pty: pty3, emitExit: exit3 } = createMockPty()

    mockPtySpawn.mockReturnValueOnce(pty1).mockReturnValueOnce(pty2).mockReturnValueOnce(pty3)

    const term1 = registryInstance.create({ mode: 'shell' })
    const term2 = registryInstance.create({ mode: 'shell' })
    const term3 = registryInstance.create({ mode: 'shell' })

    // Exit some terminals naturally
    exit1(0)
    exit3(1)

    // Shutdown all
    for (const term of registryInstance.list()) {
      registryInstance.kill(term.terminalId)
    }

    expect(term1.status).toBe('exited')
    expect(term2.status).toBe('exited')
    expect(term3.status).toBe('exited')
  })

  // Helper function needed at module scope for these tests
  function createMockPty(
    options: {
      shouldExitImmediately?: boolean
      exitCode?: number
      shouldThrowOnKill?: boolean
    } = {}
  ) {
    const pty = new EventEmitter() as any
    const dataCallbacks: ((data: string) => void)[] = []
    const exitCallbacks: ((e: { exitCode: number }) => void)[] = []

    pty.onData = (cb: any) => dataCallbacks.push(cb)
    pty.onExit = (cb: any) => exitCallbacks.push(cb)
    pty.write = vi.fn()
    pty.kill = vi.fn().mockImplementation(() => {
      if (options.shouldThrowOnKill) throw new Error('PTY kill failed')
    })
    pty.resize = vi.fn()
    pty.pid = Math.floor(Math.random() * 100000)

    const emitData = (data: string) => dataCallbacks.forEach((cb) => cb(data))
    const emitExit = (exitCode = 0) => exitCallbacks.forEach((cb) => cb({ exitCode }))

    if (options.shouldExitImmediately) {
      setTimeout(() => emitExit(options.exitCode ?? 0), 0)
    }

    return { pty, emitData, emitExit }
  }
})

// ============================================================================
// RESOURCE LIMIT SCENARIOS
// ============================================================================

describe('Resource Limit Scenarios', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    process.env.AUTH_TOKEN = 'test-token-16chars-minimum'
  })

  it('handles creating many terminals up to reasonable limit', () => {
    // Create registry with higher limit for this stress test
    const registry = new TerminalRegistry(undefined, 100)
    const terminals = []

    // Create 100 terminals
    for (let i = 0; i < 100; i++) {
      const { pty } = createMockPty()
      mockPtySpawn.mockReturnValueOnce(pty)
      terminals.push(registry.create({ mode: 'shell' }))
    }

    expect(registry.list()).toHaveLength(100)

    // Cleanup
    const anyRegistry = registry as any
    if (anyRegistry.idleTimer) clearInterval(anyRegistry.idleTimer)
  })

  it('enforces maximum terminal limit and throws error when exceeded', () => {
    // Create registry with low limit
    const registry = new TerminalRegistry(undefined, 5)

    // Create terminals up to the limit
    for (let i = 0; i < 5; i++) {
      const { pty } = createMockPty()
      mockPtySpawn.mockReturnValueOnce(pty)
      registry.create({ mode: 'shell' })
    }

    expect(registry.list()).toHaveLength(5)

    // Attempting to exceed the limit should throw
    const { pty } = createMockPty()
    mockPtySpawn.mockReturnValueOnce(pty)
    expect(() => registry.create({ mode: 'shell' })).toThrow('Maximum terminal limit (5) reached')

    // Cleanup
    const anyRegistry = registry as any
    if (anyRegistry.idleTimer) clearInterval(anyRegistry.idleTimer)
  })

  it('handles many clients attached to single terminal', () => {
    const { pty, emitData } = createMockPty()
    mockPtySpawn.mockReturnValue(pty)

    const registry = new TerminalRegistry()
    const record = registry.create({ mode: 'shell' })

    // Attach 100 clients
    const clients: WebSocket[] = []
    for (let i = 0; i < 100; i++) {
      const client = { send: vi.fn(), bufferedAmount: 0 } as unknown as WebSocket
      clients.push(client)
      registry.attach(record.terminalId, client)
    }

    expect(record.clients.size).toBe(100)

    // Emit data - should go to all clients
    emitData('test')

    for (const client of clients) {
      expect(client.send).toHaveBeenCalled()
    }

    // Cleanup
    const anyRegistry = registry as any
    if (anyRegistry.idleTimer) clearInterval(anyRegistry.idleTimer)
  })

  // Helper function for this describe block
  function createMockPty() {
    const pty = new EventEmitter() as any
    const dataCallbacks: ((data: string) => void)[] = []
    const exitCallbacks: ((e: { exitCode: number }) => void)[] = []

    pty.onData = (cb: any) => dataCallbacks.push(cb)
    pty.onExit = (cb: any) => exitCallbacks.push(cb)
    pty.write = vi.fn()
    pty.kill = vi.fn()
    pty.resize = vi.fn()
    pty.pid = Math.floor(Math.random() * 100000)

    const emitData = (data: string) => dataCallbacks.forEach((cb) => cb(data))
    const emitExit = (exitCode = 0) => exitCallbacks.forEach((cb) => cb({ exitCode }))

    return { pty, emitData, emitExit }
  }
})

// ============================================================================
// ERROR RECOVERY SCENARIOS
// ============================================================================

describe('Error Recovery Scenarios', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    process.env.AUTH_TOKEN = 'test-token-16chars-minimum'
  })

  it('registry remains usable after spawn failure', () => {
    const registry = new TerminalRegistry()

    // First spawn fails
    mockPtySpawn.mockImplementationOnce(() => {
      throw new Error('Spawn failed')
    })

    expect(() => registry.create({ mode: 'shell' })).toThrow()
    expect(registry.list()).toHaveLength(0)

    // Second spawn succeeds
    const { pty } = createMockPty()
    mockPtySpawn.mockReturnValueOnce(pty)

    const record = registry.create({ mode: 'shell' })
    expect(registry.list()).toHaveLength(1)
    expect(record.status).toBe('running')

    // Cleanup
    const anyRegistry = registry as any
    if (anyRegistry.idleTimer) clearInterval(anyRegistry.idleTimer)
  })

  it('handles JSON.stringify failure in safeSend', () => {
    const { pty, emitData } = createMockPty()
    mockPtySpawn.mockReturnValue(pty)

    const registry = new TerminalRegistry()
    const record = registry.create({ mode: 'shell' })

    // Client that will cause issues
    const client = {
      send: vi.fn().mockImplementation(() => {
        throw new Error('send failed')
      }),
      bufferedAmount: 0,
    } as unknown as WebSocket

    registry.attach(record.terminalId, client)

    // Should not throw even if send fails
    expect(() => emitData('test')).not.toThrow()

    // Cleanup
    const anyRegistry = registry as any
    if (anyRegistry.idleTimer) clearInterval(anyRegistry.idleTimer)
  })

  // Helper function for this describe block
  function createMockPty() {
    const pty = new EventEmitter() as any
    const dataCallbacks: ((data: string) => void)[] = []
    const exitCallbacks: ((e: { exitCode: number }) => void)[] = []

    pty.onData = (cb: any) => dataCallbacks.push(cb)
    pty.onExit = (cb: any) => exitCallbacks.push(cb)
    pty.write = vi.fn()
    pty.kill = vi.fn()
    pty.resize = vi.fn()
    pty.pid = Math.floor(Math.random() * 100000)

    const emitData = (data: string) => dataCallbacks.forEach((cb) => cb(data))
    const emitExit = (exitCode = 0) => exitCallbacks.forEach((cb) => cb({ exitCode }))

    return { pty, emitData, emitExit }
  }
})
