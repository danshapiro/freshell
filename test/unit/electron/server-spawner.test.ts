import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { EventEmitter } from 'events'

// Mock child_process.spawn
const mockSpawn = vi.fn()
vi.mock('child_process', () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
}))

// Mock http.get for health check
const mockHttpGet = vi.fn()
vi.mock('http', () => ({
  default: { get: (...args: any[]) => mockHttpGet(...args) },
  get: (...args: any[]) => mockHttpGet(...args),
}))

// Mock fs for log file
const mockCreateWriteStream = vi.fn().mockReturnValue({ write: vi.fn(), end: vi.fn() })
vi.mock('fs', () => ({
  default: {
    createWriteStream: (...args: any[]) => mockCreateWriteStream(...args),
    mkdirSync: vi.fn(),
  },
  createWriteStream: (...args: any[]) => mockCreateWriteStream(...args),
  mkdirSync: vi.fn(),
}))

import { createServerSpawner, type ServerSpawnMode } from '../../../electron/server-spawner.js'

function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    pid: number
    stdout: EventEmitter
    stderr: EventEmitter
    kill: ReturnType<typeof vi.fn>
  }
  proc.pid = 1234
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = vi.fn()
  return proc
}

function setupHealthCheckSuccess() {
  mockHttpGet.mockImplementation((_url: string, callback: Function) => {
    const response = new EventEmitter() as EventEmitter & { statusCode: number }
    response.statusCode = 200
    callback(response)
    response.emit('data', '{"ok":true}')
    response.emit('end')
    return { on: vi.fn() }
  })
}

function setupHealthCheckFailure() {
  mockHttpGet.mockImplementation((_url: string, _callback: Function) => {
    const req = { on: vi.fn() }
    // Simulate connection refused
    req.on.mockImplementation((event: string, cb: Function) => {
      if (event === 'error') {
        setTimeout(() => cb(new Error('ECONNREFUSED')), 5)
      }
    })
    return req
  })
}

describe('ServerSpawner', () => {
  let spawner: ReturnType<typeof createServerSpawner>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    spawner = createServerSpawner()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('production mode', () => {
    it('spawns nodeBinary with serverEntry and NODE_ENV=production', async () => {
      const proc = createMockProcess()
      mockSpawn.mockReturnValue(proc)
      setupHealthCheckSuccess()

      const promise = spawner.start({
        spawn: {
          mode: 'production',
          nodeBinary: '/app/bundled-node/bin/node',
          serverEntry: '/app/server/index.js',
          nativeModulesDir: '/app/resources/bundled-node/native-modules',
          serverNodeModulesDir: '/app/resources/server-node-modules',
        },
        port: 3001,
        envFile: '/home/user/.freshell/.env',
        configDir: '/home/user/.freshell',
      })

      await promise

      expect(mockSpawn).toHaveBeenCalledTimes(1)
      const [cmd, args, opts] = mockSpawn.mock.calls[0]
      expect(cmd).toBe('/app/bundled-node/bin/node')
      expect(args).toContain('/app/server/index.js')
      expect(opts.env.NODE_ENV).toBe('production')
    })

    it('sets NODE_PATH with nativeModulesDir before serverNodeModulesDir', async () => {
      const proc = createMockProcess()
      mockSpawn.mockReturnValue(proc)
      setupHealthCheckSuccess()

      await spawner.start({
        spawn: {
          mode: 'production',
          nodeBinary: '/app/bundled-node/bin/node',
          serverEntry: '/app/server/index.js',
          nativeModulesDir: '/app/resources/bundled-node/native-modules',
          serverNodeModulesDir: '/app/resources/server-node-modules',
        },
        port: 3001,
        envFile: '/home/user/.freshell/.env',
        configDir: '/home/user/.freshell',
      })

      const [, , opts] = mockSpawn.mock.calls[0]
      const nodePath = opts.env.NODE_PATH
      expect(nodePath).toBeDefined()
      // native-modules should come first so recompiled node-pty wins
      expect(nodePath.indexOf('/app/resources/bundled-node/native-modules'))
        .toBeLessThan(nodePath.indexOf('/app/resources/server-node-modules'))
    })
  })

  describe('dev mode', () => {
    it('spawns tsx with server source entry without NODE_ENV=production', async () => {
      const proc = createMockProcess()
      mockSpawn.mockReturnValue(proc)
      setupHealthCheckSuccess()

      await spawner.start({
        spawn: {
          mode: 'dev',
          tsxPath: 'npx',
          serverSourceEntry: 'server/index.ts',
        },
        port: 3001,
        envFile: '/home/user/.freshell/.env',
        configDir: '/home/user/.freshell',
      })

      expect(mockSpawn).toHaveBeenCalledTimes(1)
      const [cmd, args, opts] = mockSpawn.mock.calls[0]
      expect(cmd).toBe('npx')
      expect(args).toContain('tsx')
      expect(args).toContain('server/index.ts')
      expect(opts.env.NODE_ENV).toBeUndefined()
    })
  })

  describe('start', () => {
    it('polls health endpoint and resolves on success', async () => {
      const proc = createMockProcess()
      mockSpawn.mockReturnValue(proc)
      setupHealthCheckSuccess()

      await spawner.start({
        spawn: { mode: 'production', nodeBinary: '/node', serverEntry: '/server.js', nativeModulesDir: '/native', serverNodeModulesDir: '/modules' },
        port: 3001,
        envFile: '',
        configDir: '',
      })

      expect(mockHttpGet).toHaveBeenCalled()
      expect(spawner.isRunning()).toBe(true)
      expect(spawner.pid()).toBe(1234)
    })

    it('rejects if health check times out', async () => {
      const proc = createMockProcess()
      mockSpawn.mockReturnValue(proc)
      setupHealthCheckFailure()

      const promise = spawner.start({
        spawn: { mode: 'production', nodeBinary: '/node', serverEntry: '/server.js', nativeModulesDir: '/native', serverNodeModulesDir: '/modules' },
        port: 3001,
        envFile: '',
        configDir: '',
        healthCheckTimeoutMs: 500,
      })

      // Advance time to trigger timeout
      await vi.advanceTimersByTimeAsync(600)

      await expect(promise).rejects.toThrow()
    })

    it('rejects early if process exits before health check succeeds', async () => {
      const proc = createMockProcess()
      mockSpawn.mockReturnValue(proc)
      setupHealthCheckFailure()

      const promise = spawner.start({
        spawn: { mode: 'production', nodeBinary: '/node', serverEntry: '/server.js', nativeModulesDir: '/native', serverNodeModulesDir: '/modules' },
        port: 3001,
        envFile: '',
        configDir: '',
        healthCheckTimeoutMs: 30_000,
      })

      // Attach the rejection handler BEFORE advancing timers to avoid unhandled rejection
      const rejection = expect(promise).rejects.toThrow('Server process exited before health check succeeded')

      // Simulate the process crashing before health check succeeds
      proc.emit('close', 1)

      // Advance timers so the health check retry loop can re-check
      // and detect the process exit
      await vi.advanceTimersByTimeAsync(500)

      await rejection
      expect(spawner.isRunning()).toBe(false)
    })

    it('sets isRunning() to false when process exits during health check', async () => {
      const proc = createMockProcess()
      mockSpawn.mockReturnValue(proc)
      setupHealthCheckFailure()

      const promise = spawner.start({
        spawn: { mode: 'production', nodeBinary: '/node', serverEntry: '/server.js', nativeModulesDir: '/native', serverNodeModulesDir: '/modules' },
        port: 3001,
        envFile: '',
        configDir: '',
        healthCheckTimeoutMs: 30_000,
      })

      // Attach the rejection handler BEFORE advancing timers to avoid unhandled rejection
      const rejection = expect(promise).rejects.toThrow('Server process exited')

      // isRunning is initially true after spawn
      expect(spawner.isRunning()).toBe(true)

      // Process exits (error event)
      proc.emit('error', new Error('spawn ENOENT'))

      // isRunning should now be false even though start() hasn't resolved yet
      expect(spawner.isRunning()).toBe(false)

      // Let the health check loop detect the exit
      await vi.advanceTimersByTimeAsync(500)
      await rejection
    })
  })

  describe('stop', () => {
    it('sends SIGTERM to the process', async () => {
      const proc = createMockProcess()
      mockSpawn.mockReturnValue(proc)
      setupHealthCheckSuccess()

      await spawner.start({
        spawn: { mode: 'production', nodeBinary: '/node', serverEntry: '/server.js', nativeModulesDir: '/native', serverNodeModulesDir: '/modules' },
        port: 3001,
        envFile: '',
        configDir: '',
      })

      const stopPromise = spawner.stop()
      proc.emit('close', 0)
      await stopPromise

      expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
    })

    it('removes start() close listener and uses once() to avoid listener accumulation', async () => {
      const proc = createMockProcess()
      mockSpawn.mockReturnValue(proc)
      setupHealthCheckSuccess()

      await spawner.start({
        spawn: { mode: 'production', nodeBinary: '/node', serverEntry: '/server.js', nativeModulesDir: '/native', serverNodeModulesDir: '/modules' },
        port: 3001,
        envFile: '',
        configDir: '',
      })

      // After start(), there should be close listeners from start()
      const closeListenersBefore = proc.listenerCount('close')

      const stopPromise = spawner.stop()

      // After stop() is called (before close fires), the start() listeners
      // should have been removed and replaced with a single once() listener.
      // once() still counts as a listener until it fires.
      const closeListenersDuring = proc.listenerCount('close')
      // Should have exactly 1 close listener (the once() from stop())
      expect(closeListenersDuring).toBe(1)

      proc.emit('close', 0)
      await stopPromise

      // After close fires, the once() listener auto-removes
      const closeListenersAfter = proc.listenerCount('close')
      expect(closeListenersAfter).toBe(0)
    })
  })

  describe('isRunning', () => {
    it('reflects process state', () => {
      expect(spawner.isRunning()).toBe(false)
    })
  })

  describe('double-start', () => {
    it('kills old process first', async () => {
      const proc1 = createMockProcess()
      const proc2 = createMockProcess()
      proc2.pid = 5678
      mockSpawn.mockReturnValueOnce(proc1).mockReturnValueOnce(proc2)
      setupHealthCheckSuccess()

      await spawner.start({
        spawn: { mode: 'production', nodeBinary: '/node', serverEntry: '/server.js', nativeModulesDir: '/native', serverNodeModulesDir: '/modules' },
        port: 3001,
        envFile: '',
        configDir: '',
      })

      // Simulate process exit for the kill
      proc1.kill.mockImplementation(() => {
        proc1.emit('close', 0)
      })

      await spawner.start({
        spawn: { mode: 'production', nodeBinary: '/node', serverEntry: '/server.js', nativeModulesDir: '/native', serverNodeModulesDir: '/modules' },
        port: 3001,
        envFile: '',
        configDir: '',
      })

      expect(proc1.kill).toHaveBeenCalled()
      expect(spawner.pid()).toBe(5678)
    })
  })
})
