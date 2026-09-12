import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough, Writable } from 'node:stream'

const mockSpawn = vi.fn()
vi.mock('child_process', () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
}))

const mockHttpGet = vi.fn()
vi.mock('http', () => ({
  default: { get: (...args: any[]) => mockHttpGet(...args) },
  get: (...args: any[]) => mockHttpGet(...args),
}))

const mockCreateWriteStream = vi.fn()
vi.mock('fs', () => ({
  default: {
    createWriteStream: (...args: any[]) => mockCreateWriteStream(...args),
    mkdirSync: vi.fn(),
  },
  createWriteStream: (...args: any[]) => mockCreateWriteStream(...args),
  mkdirSync: vi.fn(),
}))

import {
  createServerSpawner,
  type ServerSpawnResources,
} from '../../../electron/server-spawner.js'

function createMockProcess(pid = 1234) {
  const proc = new EventEmitter() as EventEmitter & {
    pid: number
    stdout: PassThrough
    stderr: PassThrough
    kill: ReturnType<typeof vi.fn>
  }
  proc.pid = pid
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  proc.kill = vi.fn().mockReturnValue(true)
  return proc
}

function resources(): ServerSpawnResources {
  return {
    serverBinary: '/app/resources/bin/freshell-server',
    clientDir: '/app/resources/client with spaces',
    claudeNodeBinary: '/app/resources/node/bin/node',
    claudeSidecarEntry: '/app/resources/claude-sidecar/index.mjs',
    mcpNodeBinary: '/app/resources/node/bin/node',
    mcpEntry: '/app/resources/mcp/server.js',
    homeDir: '/home/user',
    configDir: '/home/user/.freshell with spaces',
    logDir: '/home/user/.freshell with spaces/logs',
  }
}

function response(statusCode: number, body: unknown): EventEmitter & { statusCode: number } {
  const result = new EventEmitter() as EventEmitter & { statusCode: number }
  result.statusCode = statusCode
  queueMicrotask(() => {
    result.emit('data', JSON.stringify(body))
    result.emit('end')
  })
  return result
}

function setupRustReadiness(info: Record<string, unknown> = { runtime: 'rust', commit: 'abc123', buildDirty: false }) {
  mockHttpGet.mockImplementation((url: string, ...args: any[]) => {
    const callback = (typeof args[0] === 'function' ? args[0] : args[1]) as
      (res: EventEmitter & { statusCode: number }) => void
    const req = new EventEmitter() as EventEmitter & { setTimeout: (ms: number, cb: () => void) => void; destroy: () => void }
    req.setTimeout = vi.fn()
    req.destroy = vi.fn()
    queueMicrotask(() => callback(response(200, url.endsWith('/server-info') ? info : { ok: true })))
    return req
  })
}

describe('ServerSpawner', () => {
  let spawner: ReturnType<typeof createServerSpawner>

  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateWriteStream.mockReturnValue(new PassThrough())
    vi.useFakeTimers({ shouldAdvanceTime: true })
    spawner = createServerSpawner()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('spawns the Rust binary with no server script and the explicit runtime env contract', async () => {
    const proc = createMockProcess()
    mockSpawn.mockReturnValue(proc)
    setupRustReadiness()

    await spawner.start({ resources: resources(), port: 4311, authToken: 'secret-token' })

    expect(mockSpawn).toHaveBeenCalledTimes(1)
    const [command, args, options] = mockSpawn.mock.calls[0]
    expect(command).toBe('/app/resources/bin/freshell-server')
    expect(args).toEqual([])
    expect(options.cwd).toBe('/home/user/.freshell with spaces')
    const expectedEnvironment = {
      PORT: '4311',
      FRESHELL_HOME: '/home/user',
      FRESHELL_CLIENT_DIR: '/app/resources/client with spaces',
      FRESHELL_CLAUDE_NODE: '/app/resources/node/bin/node',
      FRESHELL_CLAUDE_SIDECAR: '/app/resources/claude-sidecar/index.mjs',
      FRESHELL_MCP_NODE: '/app/resources/node/bin/node',
      FRESHELL_MCP_ENTRY: '/app/resources/mcp/server.js',
    }
    expect(Object.fromEntries(Object.keys(expectedEnvironment).map((key) => [key, options.env[key]]))).toEqual(expectedEnvironment)
    expect(options.env.NODE_PATH).toBeUndefined()
    expect(spawner.pid()).toBe(1234)
    expect(spawner.isRunning()).toBe(true)

    const infoRequest = mockHttpGet.mock.calls.find(([url]: [string]) => url.endsWith('/api/server-info'))
    expect(infoRequest?.[1]?.headers).toEqual({ 'x-auth-token': 'secret-token' })
  })

  it('requires authenticated Rust server-info provenance before start resolves', async () => {
    const proc = createMockProcess()
    mockSpawn.mockReturnValue(proc)
    setupRustReadiness({ runtime: 'node', commit: 'legacy' })
    proc.kill.mockImplementation(() => {
      queueMicrotask(() => proc.emit('close', 0))
      return true
    })

    await expect(spawner.start({
      resources: resources(),
      port: 4312,
      authToken: 'secret-token',
      healthCheckTimeoutMs: 250,
    })).rejects.toThrow(/runtime.*rust/i)

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
    expect(spawner.isRunning()).toBe(false)
    expect(spawner.pid()).toBeUndefined()
  })

  it('stops a spawned server when readiness times out', async () => {
    const proc = createMockProcess()
    mockSpawn.mockReturnValue(proc)
    mockHttpGet.mockImplementation(() => {
      const request = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: vi.fn() })
      queueMicrotask(() => request.emit('error', new Error('ECONNREFUSED')))
      return request
    })
    proc.kill.mockImplementation(() => {
      queueMicrotask(() => proc.emit('close', 0))
      return true
    })

    const starting = spawner.start({ resources: resources(), port: 4312, authToken: 'secret-token', healthCheckTimeoutMs: 10 })
    const rejection = expect(starting).rejects.toThrow(/health check timed out/i)
    await vi.advanceTimersByTimeAsync(101)
    await rejection

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')
    expect(spawner.pid()).toBeUndefined()
  })

  it('keeps stderr logging after stdout ends and closes the log with the child', async () => {
    const proc = createMockProcess()
    const log = new PassThrough()
    const chunks: string[] = []
    log.on('data', (chunk) => chunks.push(chunk.toString()))
    mockSpawn.mockReturnValue(proc)
    mockCreateWriteStream.mockReturnValue(log)
    setupRustReadiness()
    await spawner.start({ resources: resources(), port: 4312, authToken: 'secret-token' })

    proc.stdout.end('stdout completed\n')
    await vi.advanceTimersByTimeAsync(1)
    expect(log.writableEnded).toBe(false)
    proc.stderr.end('final shutdown error\n')
    await vi.advanceTimersByTimeAsync(1)
    proc.emit('close', 0)

    expect(chunks.join('')).toBe('stdout completed\nfinal shutdown error\n')
    expect(log.writableEnded).toBe(true)
  })

  it('reports an asynchronous log-file error without crashing or stopping the server', async () => {
    const proc = createMockProcess()
    const log = new PassThrough()
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockSpawn.mockReturnValue(proc)
    mockCreateWriteStream.mockReturnValue(log)
    setupRustReadiness()
    try {
      await spawner.start({ resources: resources(), port: 4312, authToken: 'secret-token' })

      expect(() => log.emit('error', new Error('EACCES opening server.log'))).not.toThrow()
      expect(spawner.isRunning()).toBe(true)
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('server_log_failed'))
    } finally {
      errorLog.mockRestore()
    }
  })

  it.each([
    { completion: 'finish', exitedBeforeStop: false },
    { completion: 'error', exitedBeforeStop: false },
    { completion: 'finish', exitedBeforeStop: true },
  ])('waits for delayed log $completion before stop resolves (already exited: $exitedBeforeStop)', async ({ completion, exitedBeforeStop }) => {
    const proc = createMockProcess()
    let completeLog!: (error?: Error) => void
    const log = new Writable({
      write(_chunk, _encoding, callback) { callback() },
      final(callback) { completeLog = callback },
    })
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockSpawn.mockReturnValue(proc)
    mockCreateWriteStream.mockReturnValue(log)
    setupRustReadiness()
    try {
      await spawner.start({ resources: resources(), port: 4312, authToken: 'secret-token' })
      proc.kill.mockImplementation(() => {
        queueMicrotask(() => proc.emit('close', 0))
        return true
      })
      if (exitedBeforeStop) proc.emit('close', 0)
      let stopped = false
      const stopping = spawner.stop().then(() => { stopped = true })
      await vi.advanceTimersByTimeAsync(1)

      expect(completeLog).toBeTypeOf('function')
      expect(stopped).toBe(false)
      completeLog(completion === 'error' ? new Error('disk write failed') : undefined)
      await stopping
      expect(stopped).toBe(true)
      if (completion === 'finish') expect(log.writableFinished).toBe(true)
      else expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('server_log_failed'))
    } finally {
      errorLog.mockRestore()
    }
  })

  it('bounds the wait for a log stream that never finishes', async () => {
    const proc = createMockProcess()
    const log = new Writable({
      write(_chunk, _encoding, callback) { callback() },
      final() {},
    })
    mockSpawn.mockReturnValue(proc)
    mockCreateWriteStream.mockReturnValue(log)
    setupRustReadiness()
    await spawner.start({ resources: resources(), port: 4312, authToken: 'secret-token' })
    proc.kill.mockImplementation(() => {
      queueMicrotask(() => proc.emit('close', 0))
      return true
    })

    const stopping = spawner.stop({ logFlushTimeoutMs: 10 })
    const result = stopping.then(() => null, (error: Error) => error)
    await vi.advanceTimersByTimeAsync(11)

    expect(await result).toMatchObject({ message: expect.stringMatching(/log.*finish/i) })
    expect(spawner.pid()).toBeUndefined()
    log.destroy()
  })

  it('clears ownership when the captured child closes', async () => {
    const proc = createMockProcess()
    mockSpawn.mockReturnValue(proc)
    setupRustReadiness()
    await spawner.start({ resources: resources(), port: 4313, authToken: 'secret-token' })

    proc.emit('close', 0)
    expect(spawner.isRunning()).toBe(false)
    expect(spawner.pid()).toBeUndefined()
  })

  it('clears ownership after a spawn failure that never created a process', async () => {
    const proc = createMockProcess()
    delete (proc as { pid?: number }).pid
    mockSpawn.mockImplementation(() => {
      queueMicrotask(() => {
        proc.emit('error', new Error('spawn failed'))
        proc.emit('close', -1)
      })
      return proc
    })
    setupRustReadiness()

    await expect(spawner.start({ resources: resources(), port: 4314, authToken: 'secret-token' })).rejects.toThrow(/exited/)
    expect(spawner.isRunning()).toBe(false)
    expect(spawner.pid()).toBeUndefined()
    expect(proc.kill).not.toHaveBeenCalled()
  })

  it('keeps ownership when signaling a live child emits an error', async () => {
    const proc = createMockProcess(5678)
    mockSpawn.mockReturnValue(proc)
    setupRustReadiness()
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await spawner.start({ resources: resources(), port: 4314, authToken: 'secret-token' })
      proc.kill.mockImplementation(() => {
        queueMicrotask(() => proc.emit('error', new Error('kill EPERM')))
        return false
      })
      const stopping = spawner.stop({ gracefulTimeoutMs: 10, forceTimeoutMs: 20 })
      const rejection = expect(stopping).rejects.toThrow(/did not exit/i)
      await vi.advanceTimersByTimeAsync(31)
      await rejection

      expect(spawner.isRunning()).toBe(true)
      expect(spawner.pid()).toBe(5678)
      expect(proc.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
    } finally {
      errorLog.mockRestore()
    }
  })

  it('stops only the exact captured child and resolves after graceful close', async () => {
    const owned = createMockProcess(7001)
    const foreign = createMockProcess(7002)
    mockSpawn.mockReturnValue(owned)
    setupRustReadiness()
    await spawner.start({ resources: resources(), port: 4315, authToken: 'secret-token' })

    owned.kill.mockImplementation((signal: string) => {
      if (signal === 'SIGTERM') queueMicrotask(() => owned.emit('close', 0))
      return true
    })
    await spawner.stop()

    expect(owned.kill).toHaveBeenCalledWith('SIGTERM')
    expect(owned.kill).not.toHaveBeenCalledWith('SIGKILL')
    expect(foreign.kill).not.toHaveBeenCalled()
    expect(spawner.pid()).toBeUndefined()
  })

  it('escalates the exact child and waits for its close after SIGKILL', async () => {
    const owned = createMockProcess(7101)
    mockSpawn.mockReturnValue(owned)
    setupRustReadiness()
    await spawner.start({ resources: resources(), port: 4316, authToken: 'secret-token' })

    owned.kill.mockImplementation((signal: string) => {
      if (signal === 'SIGKILL') queueMicrotask(() => owned.emit('close', 0))
      return true
    })
    const stopping = spawner.stop({ gracefulTimeoutMs: 10, forceTimeoutMs: 20 })
    await vi.advanceTimersByTimeAsync(11)
    expect(owned.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(owned.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
    await stopping
    expect(spawner.pid()).toBeUndefined()
  })

  it('reports a bounded failure when the exact child ignores both signals', async () => {
    const owned = createMockProcess(7201)
    mockSpawn.mockReturnValue(owned)
    setupRustReadiness()
    await spawner.start({ resources: resources(), port: 4317, authToken: 'secret-token' })

    const stopping = spawner.stop({ gracefulTimeoutMs: 10, forceTimeoutMs: 20 })
    const rejection = expect(stopping).rejects.toThrow(/did not exit/i)
    await vi.advanceTimersByTimeAsync(31)
    await rejection
    expect(owned.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(owned.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
    expect(spawner.pid()).toBe(7201)
    expect(spawner.isRunning()).toBe(true)
  })

  it('stops an existing exact child before a double-start', async () => {
    const first = createMockProcess(7301)
    const second = createMockProcess(7302)
    mockSpawn.mockReturnValueOnce(first).mockReturnValueOnce(second)
    setupRustReadiness()
    await spawner.start({ resources: resources(), port: 4318, authToken: 'secret-token' })
    first.kill.mockImplementation(() => {
      queueMicrotask(() => first.emit('close', 0))
      return true
    })
    setupRustReadiness()
    await spawner.start({ resources: resources(), port: 4319, authToken: 'secret-token' })

    expect(first.kill).toHaveBeenCalledWith('SIGTERM')
    expect(second.kill).not.toHaveBeenCalled()
    expect(spawner.pid()).toBe(7302)
  })
})
