import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { EventEmitter } from 'events'

// Mock node-pty before importing TerminalRegistry
const mockPtyProcess = vi.hoisted(() => {
  const createMockPty = () => {
    const emitter = new EventEmitter()
    return {
      pid: Math.floor(Math.random() * 100000) + 1000,
      cols: 120,
      rows: 30,
      process: 'mock-shell',
      handleFlowControl: false,
      onData: vi.fn((handler: (data: string) => void) => {
        emitter.on('data', handler)
        return { dispose: () => emitter.off('data', handler) }
      }),
      onExit: vi.fn((handler: (e: { exitCode: number; signal?: number }) => void) => {
        emitter.on('exit', handler)
        return { dispose: () => emitter.off('exit', handler) }
      }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      clear: vi.fn(),
      // Expose emitter for test control
      _emitter: emitter,
      _emitData: (data: string) => emitter.emit('data', data),
      _emitExit: (exitCode: number, signal?: number) => emitter.emit('exit', { exitCode, signal }),
    }
  }
  return { createMockPty, instances: [] as ReturnType<typeof createMockPty>[] }
})

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    const pty = mockPtyProcess.createMockPty()
    mockPtyProcess.instances.push(pty)
    return pty
  }),
}))

vi.mock('../../../server/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}))

// Import after mocking
import { TerminalRegistry, type TerminalRecord, ChunkRingBuffer } from '../../../server/terminal-registry'
import type { AppSettings } from '../../../server/config-store'

// Mock WebSocket
function createMockWebSocket(): any {
  return {
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1, // OPEN
    bufferedAmount: 0,
  }
}

function createTestSettings(overrides?: Partial<AppSettings>): AppSettings {
  return {
    theme: 'system',
    uiScale: 1.0,
    terminal: {
      fontFamily: 'monospace',
      fontSize: 14,
      lineHeight: 1,
      cursorBlink: true,
      scrollback: 5000,
      theme: 'auto',
    },
    safety: {
      autoKillIdleMinutes: 30,
      warnBeforeKillMinutes: 5,
    },
    sidebar: {
      sortMode: 'hybrid',
      showProjectBadges: true,
      width: 288,
      collapsed: false,
    },
    codingCli: {
      enabledProviders: ['claude', 'codex'],
      providers: {
        claude: { permissionMode: 'default' },
        codex: {},
      },
    },
    ...overrides,
  }
}

describe('TerminalRegistry Lifecycle', () => {
  let registry: TerminalRegistry
  let settings: AppSettings

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockPtyProcess.instances = []
    settings = createTestSettings()
    registry = new TerminalRegistry(settings)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('Terminal created but never attached', () => {
    it('should track terminal in registry even without clients', () => {
      const term = registry.create({ mode: 'shell' })

      expect(term.clients.size).toBe(0)
      expect(registry.get(term.terminalId)).toBeDefined()
      expect(registry.list()).toHaveLength(1)
    })

    it('should accumulate output in buffer when no clients attached', () => {
      const term = registry.create({ mode: 'shell' })
      const pty = mockPtyProcess.instances[0]

      // Simulate output without any clients
      pty._emitData('line 1\n')
      pty._emitData('line 2\n')
      pty._emitData('line 3\n')

      expect(term.buffer.snapshot()).toBe('line 1\nline 2\nline 3\n')
    })

    it('should be subject to idle timeout when never attached', () => {
      registry.create({ mode: 'shell' })

      // Advance time past idle timeout (30 minutes)
      vi.advanceTimersByTime(31 * 60 * 1000)

      const terms = registry.list()
      expect(terms[0].status).toBe('exited')
    })

    it('should allow late attachment and receive buffered output', () => {
      const term = registry.create({ mode: 'shell' })
      const pty = mockPtyProcess.instances[0]

      // Output before client attaches
      pty._emitData('buffered output\n')

      const client = createMockWebSocket()
      const attached = registry.attach(term.terminalId, client)

      expect(attached).toBeDefined()
      expect(term.buffer.snapshot()).toBe('buffered output\n')
      expect(term.clients.size).toBe(1)
    })

    it('should properly clean up zombie terminal on remove', () => {
      const term = registry.create({ mode: 'shell' })
      const pty = mockPtyProcess.instances[0]

      // Never attach, just remove
      registry.remove(term.terminalId)

      expect(pty.kill).toHaveBeenCalled()
      expect(registry.get(term.terminalId)).toBeUndefined()
      expect(registry.list()).toHaveLength(0)
    })
  })

  describe('Terminal killed while output streaming', () => {
    it('should handle kill during rapid output', () => {
      const term = registry.create({ mode: 'shell' })
      const client = createMockWebSocket()
      const pty = mockPtyProcess.instances[0]

      registry.attach(term.terminalId, client)

      // Start rapid output
      pty._emitData('output 1\n')
      pty._emitData('output 2\n')

      // Kill mid-stream
      registry.kill(term.terminalId)

      // More output attempts after kill - should be ignored by the PTY
      // The onData handler should not crash
      expect(() => pty._emitData('output 3\n')).not.toThrow()

      expect(term.status).toBe('exited')
    })

    it('should notify clients of exit after kill during streaming', () => {
      const term = registry.create({ mode: 'shell' })
      const client = createMockWebSocket()
      const pty = mockPtyProcess.instances[0]

      registry.attach(term.terminalId, client)
      pty._emitData('streaming...')

      registry.kill(term.terminalId)

      // Should have received exit notification
      const exitCall = (client.send as Mock).mock.calls.find(
        (call) => JSON.parse(call[0]).type === 'terminal.exit'
      )
      expect(exitCall).toBeDefined()
    })

    it('should clear clients after kill during streaming', () => {
      const term = registry.create({ mode: 'shell' })
      const client1 = createMockWebSocket()
      const client2 = createMockWebSocket()
      const pty = mockPtyProcess.instances[0]

      registry.attach(term.terminalId, client1)
      registry.attach(term.terminalId, client2)

      pty._emitData('streaming to both clients...')

      registry.kill(term.terminalId)

      expect(term.clients.size).toBe(0)
    })
  })

  describe('Multiple kill calls on same terminal', () => {
    it('should handle double kill gracefully', () => {
      const term = registry.create({ mode: 'shell' })
      const pty = mockPtyProcess.instances[0]

      const result1 = registry.kill(term.terminalId)
      const result2 = registry.kill(term.terminalId)

      expect(result1).toBe(true)
      expect(result2).toBe(true) // Terminal still exists, kill succeeds
      expect(pty.kill).toHaveBeenCalledTimes(2)
    })

    it('should handle kill after PTY already exited', () => {
      const term = registry.create({ mode: 'shell' })
      const pty = mockPtyProcess.instances[0]

      // PTY exits naturally
      pty._emitExit(0)

      expect(term.status).toBe('exited')

      // Now try to kill
      const result = registry.kill(term.terminalId)
      expect(result).toBe(true)
      expect(term.status).toBe('exited')
    })

    it('should not duplicate exit notifications on multiple kills', () => {
      const term = registry.create({ mode: 'shell' })
      const client = createMockWebSocket()

      registry.attach(term.terminalId, client)

      registry.kill(term.terminalId)
      // Clients are cleared after first kill
      expect(term.clients.size).toBe(0)

      // Second kill should not try to notify (no clients)
      client.send.mockClear()
      registry.kill(term.terminalId)

      expect(client.send).not.toHaveBeenCalled()
    })

    it('should handle kill throwing exception', () => {
      const term = registry.create({ mode: 'shell' })
      const pty = mockPtyProcess.instances[0]

      pty.kill.mockImplementation(() => {
        throw new Error('Process already terminated')
      })

      // Should not throw
      expect(() => registry.kill(term.terminalId)).not.toThrow()
      expect(term.status).toBe('exited')
    })
  })

  describe('Resize on exited terminal', () => {
    it('should return false for resize on exited terminal', () => {
      const term = registry.create({ mode: 'shell' })
      const pty = mockPtyProcess.instances[0]

      pty._emitExit(0)
      expect(term.status).toBe('exited')

      const result = registry.resize(term.terminalId, 200, 50)
      expect(result).toBe(false)
    })

    it('should not call pty.resize on exited terminal', () => {
      const term = registry.create({ mode: 'shell' })
      const pty = mockPtyProcess.instances[0]

      pty._emitExit(0)
      registry.resize(term.terminalId, 200, 50)

      expect(pty.resize).not.toHaveBeenCalled()
    })

    it('should handle resize exception on running terminal gracefully', () => {
      const term = registry.create({ mode: 'shell' })
      const pty = mockPtyProcess.instances[0]

      pty.resize.mockImplementation(() => {
        throw new Error('Invalid size')
      })

      // Should not throw, but log warning
      expect(() => registry.resize(term.terminalId, 200, 50)).not.toThrow()
      expect(term.cols).toBe(200)
      expect(term.rows).toBe(50)
    })

    it('should return false for resize on non-existent terminal', () => {
      const result = registry.resize('non-existent-id', 200, 50)
      expect(result).toBe(false)
    })
  })

  describe('Input to exited terminal', () => {
    it('should return false for input to exited terminal', () => {
      const term = registry.create({ mode: 'shell' })
      const pty = mockPtyProcess.instances[0]

      pty._emitExit(0)

      const result = registry.input(term.terminalId, 'some input')
      expect(result).toBe(false)
    })

    it('should not call pty.write on exited terminal', () => {
      const term = registry.create({ mode: 'shell' })
      const pty = mockPtyProcess.instances[0]

      pty._emitExit(0)
      registry.input(term.terminalId, 'should not be written')

      expect(pty.write).not.toHaveBeenCalled()
    })

    it('should return false for input to non-existent terminal', () => {
      const result = registry.input('non-existent-id', 'some input')
      expect(result).toBe(false)
    })

    it('should update lastActivityAt on successful input', () => {
      const term = registry.create({ mode: 'shell' })
      const initialActivity = term.lastActivityAt

      vi.advanceTimersByTime(1000)

      registry.input(term.terminalId, 'test input')
      expect(term.lastActivityAt).toBeGreaterThan(initialActivity)
    })
  })

  describe('Terminal exit during client attachment', () => {
    it('should handle exit notification arriving before attach completes', () => {
      const term = registry.create({ mode: 'shell' })
      const pty = mockPtyProcess.instances[0]
      const client = createMockWebSocket()

      // Simulate race: exit happens while processing attach
      pty._emitExit(0)

      // Attach after exit
      const attached = registry.attach(term.terminalId, client)

      expect(attached).toBeDefined()
      expect(term.status).toBe('exited')
      // Client was added but terminal is exited
      expect(term.clients.size).toBe(1) // Attach still adds client
    })

    it('should handle multiple clients during exit event', () => {
      const term = registry.create({ mode: 'shell' })
      const pty = mockPtyProcess.instances[0]
      const client1 = createMockWebSocket()
      const client2 = createMockWebSocket()

      registry.attach(term.terminalId, client1)
      registry.attach(term.terminalId, client2)

      expect(term.clients.size).toBe(2)

      // Exit with multiple clients
      pty._emitExit(42)

      // Both should receive exit notification
      const exit1 = (client1.send as Mock).mock.calls.find(
        (call) => JSON.parse(call[0]).type === 'terminal.exit'
      )
      const exit2 = (client2.send as Mock).mock.calls.find(
        (call) => JSON.parse(call[0]).type === 'terminal.exit'
      )

      expect(exit1).toBeDefined()
      expect(exit2).toBeDefined()
      expect(JSON.parse(exit1![0]).exitCode).toBe(42)

      // Clients cleared after exit
      expect(term.clients.size).toBe(0)
    })

    it('should preserve exit code from PTY', () => {
      const term = registry.create({ mode: 'shell' })
      const pty = mockPtyProcess.instances[0]

      pty._emitExit(127)

      expect(term.exitCode).toBe(127)
      expect(term.status).toBe('exited')
    })
  })

  describe('Idle timeout edge cases', () => {
    it('should kill terminal exactly at threshold', () => {
      registry = new TerminalRegistry(createTestSettings({ safety: { autoKillIdleMinutes: 30, warnBeforeKillMinutes: 5 } }))
      registry.create({ mode: 'shell' })

      // Advance to exactly 30 minutes
      vi.advanceTimersByTime(30 * 60 * 1000)

      const terms = registry.list()
      expect(terms[0].status).toBe('exited')
    })

    it('should not kill terminal just before threshold', () => {
      registry = new TerminalRegistry(createTestSettings({ safety: { autoKillIdleMinutes: 30, warnBeforeKillMinutes: 5 } }))
      registry.create({ mode: 'shell' })

      // Advance to just under 30 minutes (29:59)
      vi.advanceTimersByTime(30 * 60 * 1000 - 1000)

      const terms = registry.list()
      expect(terms[0].status).toBe('running')
    })

    it('should not kill terminal with attached clients', () => {
      registry = new TerminalRegistry(createTestSettings({ safety: { autoKillIdleMinutes: 1, warnBeforeKillMinutes: 0 } }))
      const term = registry.create({ mode: 'shell' })
      const client = createMockWebSocket()

      registry.attach(term.terminalId, client)

      // Advance past idle timeout
      vi.advanceTimersByTime(2 * 60 * 1000)

      // Should still be running because client is attached
      expect(term.status).toBe('running')
    })

    it('should reset idle timer on activity', () => {
      registry = new TerminalRegistry(createTestSettings({ safety: { autoKillIdleMinutes: 1, warnBeforeKillMinutes: 0 } }))
      const term = registry.create({ mode: 'shell' })
      const pty = mockPtyProcess.instances[0]

      // Advance 30 seconds
      vi.advanceTimersByTime(30 * 1000)

      // Activity resets the timer
      pty._emitData('output')

      // Advance another 45 seconds (total 75 seconds, but only 45 since last activity)
      vi.advanceTimersByTime(45 * 1000)

      // Should still be running (only 45 seconds idle, threshold is 60)
      expect(term.status).toBe('running')
    })

    it('should handle zero idle timeout (disabled)', () => {
      registry = new TerminalRegistry(createTestSettings({ safety: { autoKillIdleMinutes: 0, warnBeforeKillMinutes: 0 } }))
      registry.create({ mode: 'shell' })

      // Advance a long time
      vi.advanceTimersByTime(24 * 60 * 60 * 1000) // 24 hours

      const terms = registry.list()
      expect(terms[0].status).toBe('running')
    })

    it('should handle negative idle timeout (disabled)', () => {
      registry = new TerminalRegistry(createTestSettings({ safety: { autoKillIdleMinutes: -1, warnBeforeKillMinutes: 0 } }))
      registry.create({ mode: 'shell' })

      vi.advanceTimersByTime(24 * 60 * 60 * 1000)

      const terms = registry.list()
      expect(terms[0].status).toBe('running')
    })

    it('should kill terminal after client detaches and goes idle', () => {
      registry = new TerminalRegistry(createTestSettings({ safety: { autoKillIdleMinutes: 1, warnBeforeKillMinutes: 0 } }))
      const term = registry.create({ mode: 'shell' })
      const client = createMockWebSocket()

      registry.attach(term.terminalId, client)

      // Advance 30 seconds while attached (should not kill)
      vi.advanceTimersByTime(30 * 1000)
      expect(term.status).toBe('running')

      // Detach
      registry.detach(term.terminalId, client)

      // Now advance past idle timeout
      vi.advanceTimersByTime(61 * 1000)

      expect(term.status).toBe('exited')
    })
  })

  describe('Buffer overflow with rapid output', () => {
    it('should handle rapid output without memory leak', () => {
      const term = registry.create({ mode: 'shell' })
      const pty = mockPtyProcess.instances[0]
      const client = createMockWebSocket()

      registry.attach(term.terminalId, client)

      // Simulate rapid output (100KB)
      const chunk = 'x'.repeat(1024)
      for (let i = 0; i < 100; i++) {
        pty._emitData(chunk)
      }

      // Buffer should be bounded (default 64KB)
      expect(term.buffer.snapshot().length).toBeLessThanOrEqual(64 * 1024)
    })

    it('should drop old data when buffer overflows', () => {
      const term = registry.create({ mode: 'shell' })
      const pty = mockPtyProcess.instances[0]

      // Fill buffer with identifiable data
      pty._emitData('FIRST_CHUNK_')
      pty._emitData('x'.repeat(64 * 1024)) // Overflow buffer
      pty._emitData('LAST_CHUNK')

      const snapshot = term.buffer.snapshot()
      expect(snapshot).not.toContain('FIRST_CHUNK_')
      expect(snapshot).toContain('LAST_CHUNK')
    })

    it('should handle WebSocket backpressure', () => {
      const term = registry.create({ mode: 'shell' })
      const pty = mockPtyProcess.instances[0]
      const client = createMockWebSocket()

      // Simulate slow client with high buffered amount
      Object.defineProperty(client, 'bufferedAmount', {
        get: () => 3 * 1024 * 1024, // 3MB buffered (over 2MB limit)
      })

      registry.attach(term.terminalId, client)

      // Output should be dropped due to backpressure
      pty._emitData('should be dropped')

      // safeSend should not have sent (due to backpressure check)
      expect(client.send).not.toHaveBeenCalled()
    })

    it('should send to healthy clients even if one has backpressure', () => {
      const term = registry.create({ mode: 'shell' })
      const pty = mockPtyProcess.instances[0]
      const slowClient = createMockWebSocket()
      const fastClient = createMockWebSocket()

      Object.defineProperty(slowClient, 'bufferedAmount', {
        get: () => 3 * 1024 * 1024,
      })
      Object.defineProperty(fastClient, 'bufferedAmount', {
        get: () => 0,
      })

      registry.attach(term.terminalId, slowClient)
      registry.attach(term.terminalId, fastClient)

      pty._emitData('test output')

      expect(slowClient.send).not.toHaveBeenCalled()
      expect(fastClient.send).toHaveBeenCalled()
    })
  })

  describe('Client disconnect during terminal creation', () => {
    it('should handle client send failure gracefully', () => {
      const term = registry.create({ mode: 'shell' })
      const pty = mockPtyProcess.instances[0]
      const client = createMockWebSocket()

      client.send.mockImplementation(() => {
        throw new Error('WebSocket is closed')
      })

      registry.attach(term.terminalId, client)

      // Should not throw when sending output
      expect(() => pty._emitData('test output')).not.toThrow()
    })

    it('should continue operating after client disconnects', () => {
      const term = registry.create({ mode: 'shell' })
      const pty = mockPtyProcess.instances[0]
      const client1 = createMockWebSocket()
      const client2 = createMockWebSocket()

      client1.send.mockImplementation(() => {
        throw new Error('Connection reset')
      })

      registry.attach(term.terminalId, client1)
      registry.attach(term.terminalId, client2)

      pty._emitData('test output')

      // client2 should still receive output
      expect(client2.send).toHaveBeenCalled()
    })

    it('should handle attach to non-existent terminal', () => {
      const client = createMockWebSocket()
      const result = registry.attach('non-existent', client)

      expect(result).toBeNull()
    })

    it('should handle detach from non-existent terminal', () => {
      const client = createMockWebSocket()
      const result = registry.detach('non-existent', client)

      expect(result).toBe(false)
    })
  })

  describe('Resource cleanup', () => {
    it('should clean up all resources on remove', () => {
      const term = registry.create({ mode: 'shell' })
      const pty = mockPtyProcess.instances[0]
      const client = createMockWebSocket()

      registry.attach(term.terminalId, client)

      registry.remove(term.terminalId)

      expect(pty.kill).toHaveBeenCalled()
      expect(registry.get(term.terminalId)).toBeUndefined()
      expect(term.clients.size).toBe(0)
    })

    it('should handle remove of non-existent terminal', () => {
      const result = registry.remove('non-existent')
      expect(result).toBe(false)
    })

    it('should handle double remove', () => {
      const term = registry.create({ mode: 'shell' })

      const result1 = registry.remove(term.terminalId)
      const result2 = registry.remove(term.terminalId)

      expect(result1).toBe(true)
      expect(result2).toBe(false)
    })

    it('should update lastActivityAt on PTY data output', () => {
      const term = registry.create({ mode: 'shell' })
      const pty = mockPtyProcess.instances[0]
      const initialActivity = term.lastActivityAt

      vi.advanceTimersByTime(1000)
      pty._emitData('output')

      expect(term.lastActivityAt).toBeGreaterThan(initialActivity)
    })

    it('should update lastActivityAt on PTY exit', () => {
      const term = registry.create({ mode: 'shell' })
      const pty = mockPtyProcess.instances[0]
      const initialActivity = term.lastActivityAt

      vi.advanceTimersByTime(1000)
      pty._emitExit(0)

      expect(term.lastActivityAt).toBeGreaterThan(initialActivity)
    })
  })

  describe('Concurrent operations', () => {
    it('should handle simultaneous attach and detach', () => {
      const term = registry.create({ mode: 'shell' })
      const client = createMockWebSocket()

      registry.attach(term.terminalId, client)
      registry.detach(term.terminalId, client)
      registry.attach(term.terminalId, client)

      expect(term.clients.size).toBe(1)
    })

    it('should handle same client attached multiple times', () => {
      const term = registry.create({ mode: 'shell' })
      const client = createMockWebSocket()

      registry.attach(term.terminalId, client)
      registry.attach(term.terminalId, client) // Same client again

      // Set only stores unique values
      expect(term.clients.size).toBe(1)
    })

    it('should handle detach of non-attached client', () => {
      const term = registry.create({ mode: 'shell' })
      const client = createMockWebSocket()

      const result = registry.detach(term.terminalId, client)
      expect(result).toBe(true) // Returns true even if client wasn't attached
    })
  })

  describe('Title and description updates', () => {
    it('should update title', () => {
      const term = registry.create({ mode: 'shell' })

      const result = registry.updateTitle(term.terminalId, 'New Title')

      expect(result).toBe(true)
      expect(term.title).toBe('New Title')
    })

    it('should update description', () => {
      const term = registry.create({ mode: 'shell' })

      const result = registry.updateDescription(term.terminalId, 'New Description')

      expect(result).toBe(true)
      expect(term.description).toBe('New Description')
    })

    it('should handle title update on non-existent terminal', () => {
      const result = registry.updateTitle('non-existent', 'Title')
      expect(result).toBe(false)
    })

    it('should handle description update on non-existent terminal', () => {
      const result = registry.updateDescription('non-existent', 'Desc')
      expect(result).toBe(false)
    })
  })

  describe('Broadcast functionality', () => {
    it('should broadcast to all clients across terminals', () => {
      const term1 = registry.create({ mode: 'shell' })
      const term2 = registry.create({ mode: 'shell' })
      const client1 = createMockWebSocket()
      const client2 = createMockWebSocket()

      registry.attach(term1.terminalId, client1)
      registry.attach(term2.terminalId, client2)

      registry.broadcast({ type: 'test', data: 'broadcast message' })

      expect(client1.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'test', data: 'broadcast message' })
      )
      expect(client2.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'test', data: 'broadcast message' })
      )
    })

    it('should handle broadcast with no clients', () => {
      registry.create({ mode: 'shell' })
      registry.create({ mode: 'shell' })

      // Should not throw
      expect(() => registry.broadcast({ type: 'test' })).not.toThrow()
    })

    it('should handle broadcast with failing client', () => {
      const term = registry.create({ mode: 'shell' })
      const failingClient = createMockWebSocket()
      const goodClient = createMockWebSocket()

      failingClient.send.mockImplementation(() => {
        throw new Error('Connection closed')
      })

      registry.attach(term.terminalId, failingClient)
      registry.attach(term.terminalId, goodClient)

      expect(() => registry.broadcast({ type: 'test' })).not.toThrow()
      expect(goodClient.send).toHaveBeenCalled()
    })
  })

  describe('List functionality', () => {
    it('should list all terminals with correct properties', () => {
      const term1 = registry.create({ mode: 'shell', cwd: '/home/user' })
      const term2 = registry.create({ mode: 'claude' })
      const client = createMockWebSocket()

      registry.attach(term1.terminalId, client)

      const list = registry.list()

      expect(list).toHaveLength(2)

      const shell = list.find((t) => t.mode === 'shell')
      const claude = list.find((t) => t.mode === 'claude')

      expect(shell?.hasClients).toBe(true)
      expect(shell?.cwd).toBe('/home/user')
      expect(claude?.hasClients).toBe(false)
    })

    it('should return empty array when no terminals', () => {
      const list = registry.list()
      expect(list).toEqual([])
    })
  })

  describe('Settings management', () => {
    it('should update settings', () => {
      const newSettings = createTestSettings({ theme: 'dark' })
      registry.setSettings(newSettings)

      // Settings are private, but affect idle timeout behavior
      // Create terminal and verify it uses new settings
      const term = registry.create({ mode: 'shell' })
      expect(term).toBeDefined()
    })

    it('should apply new idle timeout settings to existing terminals', () => {
      const term = registry.create({ mode: 'shell' })

      // Update settings to shorter timeout
      registry.setSettings(createTestSettings({ safety: { autoKillIdleMinutes: 1, warnBeforeKillMinutes: 0 } }))

      // Advance past new timeout
      vi.advanceTimersByTime(61 * 1000)

      expect(term.status).toBe('exited')
    })
  })

  describe('Exit code handling', () => {
    it('should preserve exit code from natural exit', () => {
      const term = registry.create({ mode: 'shell' })
      const pty = mockPtyProcess.instances[0]

      pty._emitExit(123)

      expect(term.exitCode).toBe(123)
    })

    it('should set exit code to 0 on kill if not set', () => {
      const term = registry.create({ mode: 'shell' })

      registry.kill(term.terminalId)

      expect(term.exitCode).toBe(0)
    })

    it('should preserve original exit code on kill after natural exit', () => {
      const term = registry.create({ mode: 'shell' })
      const pty = mockPtyProcess.instances[0]

      pty._emitExit(42)
      registry.kill(term.terminalId)

      expect(term.exitCode).toBe(42)
    })
  })
})

describe('Maximum terminal limit', () => {
  let registry: TerminalRegistry

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockPtyProcess.instances = []
    // Create registry with a low maxTerminals limit for testing
    registry = new TerminalRegistry(undefined, 3)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should throw error when maximum terminal limit is reached', () => {
    // Create terminals up to the limit (3)
    registry.create({ mode: 'shell' })
    registry.create({ mode: 'shell' })
    registry.create({ mode: 'shell' })

    expect(registry.list()).toHaveLength(3)

    // Attempting to create a 4th terminal should throw
    expect(() => registry.create({ mode: 'shell' })).toThrow(/Maximum terminal limit/)
  })

  it('should allow creating terminals after some are removed', () => {
    const term1 = registry.create({ mode: 'shell' })
    registry.create({ mode: 'shell' })
    registry.create({ mode: 'shell' })

    expect(registry.list()).toHaveLength(3)

    // Remove one terminal
    registry.remove(term1.terminalId)

    expect(registry.list()).toHaveLength(2)

    // Should now be able to create another
    const newTerm = registry.create({ mode: 'shell' })
    expect(newTerm).toBeDefined()
    expect(registry.list()).toHaveLength(3)
  })

  it('should include limit value in error message', () => {
    // Fill up to the limit
    for (let i = 0; i < 3; i++) {
      registry.create({ mode: 'shell' })
    }

    // Verify error message includes the limit
    expect(() => registry.create({ mode: 'shell' })).toThrow('Maximum terminal limit (3) reached')
  })
})

describe('Graceful shutdown', () => {
  let registry: TerminalRegistry

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockPtyProcess.instances = []
    registry = new TerminalRegistry(createTestSettings())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should kill all running terminals on shutdown', () => {
    const term1 = registry.create({ mode: 'shell' })
    const term2 = registry.create({ mode: 'claude' })
    const term3 = registry.create({ mode: 'shell' })

    expect(registry.list()).toHaveLength(3)
    expect(term1.status).toBe('running')
    expect(term2.status).toBe('running')
    expect(term3.status).toBe('running')

    registry.shutdown()

    expect(term1.status).toBe('exited')
    expect(term2.status).toBe('exited')
    expect(term3.status).toBe('exited')
  })

  it('should call pty.kill for all terminals', () => {
    registry.create({ mode: 'shell' })
    registry.create({ mode: 'shell' })

    expect(mockPtyProcess.instances).toHaveLength(2)

    registry.shutdown()

    for (const pty of mockPtyProcess.instances) {
      expect(pty.kill).toHaveBeenCalled()
    }
  })

  it('should clear idle monitor timer on shutdown', () => {
    registry.create({ mode: 'shell' })

    registry.shutdown()

    // Advance time past idle timeout - should not kill (timer cleared)
    vi.advanceTimersByTime(60 * 60 * 1000)

    // If timer was still running, it would have called enforceIdleKills
    // Since we already shut down, no further action should happen
    expect(mockPtyProcess.instances[0].kill).toHaveBeenCalledTimes(1)
  })

  it('should notify all attached clients of terminal exit', () => {
    const term = registry.create({ mode: 'shell' })
    const client1 = createMockWebSocket()
    const client2 = createMockWebSocket()

    registry.attach(term.terminalId, client1)
    registry.attach(term.terminalId, client2)

    registry.shutdown()

    // Both clients should have received exit notification
    const exit1 = (client1.send as Mock).mock.calls.find(
      (call) => JSON.parse(call[0]).type === 'terminal.exit'
    )
    const exit2 = (client2.send as Mock).mock.calls.find(
      (call) => JSON.parse(call[0]).type === 'terminal.exit'
    )

    expect(exit1).toBeDefined()
    expect(exit2).toBeDefined()
  })

  it('should clear all client connections after shutdown', () => {
    const term = registry.create({ mode: 'shell' })
    const client = createMockWebSocket()

    registry.attach(term.terminalId, client)
    expect(term.clients.size).toBe(1)

    registry.shutdown()

    expect(term.clients.size).toBe(0)
  })

  it('should handle shutdown with no terminals', () => {
    expect(registry.list()).toHaveLength(0)

    // Should not throw
    expect(() => registry.shutdown()).not.toThrow()
  })

  it('should handle shutdown with already exited terminals', () => {
    const term = registry.create({ mode: 'shell' })
    const pty = mockPtyProcess.instances[0]

    // Terminal exits naturally
    pty._emitExit(0)
    expect(term.status).toBe('exited')

    // Shutdown should still work
    expect(() => registry.shutdown()).not.toThrow()
  })

  it('should handle shutdown with mixed running and exited terminals', () => {
    const term1 = registry.create({ mode: 'shell' })
    const term2 = registry.create({ mode: 'shell' })
    const pty1 = mockPtyProcess.instances[0]

    // First terminal exits
    pty1._emitExit(0)
    expect(term1.status).toBe('exited')
    expect(term2.status).toBe('running')

    registry.shutdown()

    expect(term1.status).toBe('exited')
    expect(term2.status).toBe('exited')
  })

  it('should handle pty.kill throwing during shutdown', () => {
    registry.create({ mode: 'shell' })
    const pty = mockPtyProcess.instances[0]

    pty.kill.mockImplementation(() => {
      throw new Error('Process already terminated')
    })

    // Should not throw
    expect(() => registry.shutdown()).not.toThrow()
  })
})

describe('ChunkRingBuffer edge cases for lifecycle', () => {
  it('should handle concurrent appends correctly', () => {
    const buffer = new ChunkRingBuffer(100)

    // Simulate rapid appends
    for (let i = 0; i < 1000; i++) {
      buffer.append(`chunk${i}`)
    }

    expect(buffer.snapshot().length).toBeLessThanOrEqual(100)
  })

  it('should handle empty buffer snapshot', () => {
    const buffer = new ChunkRingBuffer(100)
    expect(buffer.snapshot()).toBe('')
  })

  it('should handle append after clear', () => {
    const buffer = new ChunkRingBuffer(100)
    buffer.append('data')
    buffer.clear()
    buffer.append('new data')

    expect(buffer.snapshot()).toBe('new data')
  })
})
