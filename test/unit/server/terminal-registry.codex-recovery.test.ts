import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalRegistry } from '../../../server/terminal-registry.js'
import type { CodexLaunchSidecar } from '../../../server/coding-cli/codex-app-server/launch-planner.js'

type MockPty = {
  onData: ReturnType<typeof vi.fn>
  onExit: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  pid: number
}

vi.mock('fs', () => {
  const existsSync = vi.fn(() => true)
  const statSync = vi.fn(() => ({ isDirectory: () => true }))
  return {
    existsSync,
    statSync,
    default: { existsSync, statSync },
  }
})

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => createMockPty()),
}))

vi.mock('../../../server/logger.js', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  }
  logger.child.mockReturnValue(logger)
  return { logger, sessionLifecycleLogger: logger }
})

vi.mock('../../../server/mcp/config-writer.js', () => ({
  generateMcpInjection: vi.fn(() => ({ args: [], env: {} })),
  cleanupMcpConfig: vi.fn(),
}))

function createMockPty(): MockPty {
  return {
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pid: 12345,
  }
}

async function spawnedPtys(): Promise<MockPty[]> {
  const pty = await import('node-pty')
  return vi.mocked(pty.spawn).mock.results.map((result) => result.value as MockPty)
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createFakeSidecar(options: {
  waitForLoadedThread?: CodexLaunchSidecar['waitForLoadedThread']
  shutdown?: CodexLaunchSidecar['shutdown']
} = {}): CodexLaunchSidecar {
  return {
    adopt: vi.fn().mockResolvedValue(undefined),
    listLoadedThreads: vi.fn().mockResolvedValue([]),
    shutdown: vi.fn(options.shutdown ?? (async () => undefined)),
    waitForLoadedThread: vi.fn(options.waitForLoadedThread ?? (async () => undefined)),
    onLifecycleLoss: vi.fn(() => vi.fn()),
  }
}

describe('TerminalRegistry Codex durable recovery', () => {
  let registry: TerminalRegistry

  beforeEach(async () => {
    vi.clearAllMocks()
    const pty = await import('node-pty')
    vi.mocked(pty.spawn).mockImplementation(() => createMockPty() as any)
    registry = new TerminalRegistry(undefined, 10)
  })

  afterEach(() => {
    registry.shutdown()
    vi.useRealTimers()
  })

  it('recovers a durable Codex terminal when the visible PTY exits unexpectedly', async () => {
    const exited = vi.fn()
    registry.on('terminal.exit', exited)
    const currentSidecar = createFakeSidecar()
    const replacementSidecar = createFakeSidecar()
    const planCreate = vi.fn(async () => ({
      sessionId: 'thread-durable-1',
      remote: { wsUrl: 'ws://127.0.0.1:46002/' },
      sidecar: replacementSidecar,
    }))
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      resumeSessionId: 'thread-durable-1',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:46001/',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
        },
      } as any,
    })
    const [oldPty] = await spawnedPtys()

    oldPty.onExit.mock.calls[0][0]({ exitCode: 1, signal: 0 })

    await vi.waitFor(() => expect(replacementSidecar.waitForLoadedThread).toHaveBeenCalledWith('thread-durable-1', expect.any(Object)))
    await vi.waitFor(() => expect(currentSidecar.shutdown).toHaveBeenCalledTimes(1))
    const [, replacementPty] = await spawnedPtys()

    expect(registry.get(record.terminalId)?.status).toBe('running')
    expect(registry.get(record.terminalId)?.pty).toBe(replacementPty)
    expect(planCreate).toHaveBeenCalledWith(expect.objectContaining({
      terminalId: record.terminalId,
      resumeSessionId: 'thread-durable-1',
      generation: 1,
    }))
    expect(replacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: record.terminalId, generation: 1 })
    expect(oldPty.kill).toHaveBeenCalledTimes(1)
    expect(exited).not.toHaveBeenCalled()
  })

  it('blocks input during durable recovery and sends later input only to the replacement PTY', async () => {
    const readiness = deferred()
    const currentSidecar = createFakeSidecar()
    const replacementSidecar = createFakeSidecar({
      waitForLoadedThread: () => readiness.promise,
    })
    const planCreate = vi.fn(async () => ({
      sessionId: 'thread-durable-1',
      remote: { wsUrl: 'ws://127.0.0.1:46003/' },
      sidecar: replacementSidecar,
    }))
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      resumeSessionId: 'thread-durable-1',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:46001/',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
        },
      } as any,
    })
    const [oldPty] = await spawnedPtys()

    oldPty.onExit.mock.calls[0][0]({ exitCode: 1, signal: 0 })
    await vi.waitFor(() => expect(replacementSidecar.waitForLoadedThread).toHaveBeenCalledTimes(1))

    expect(registry.input(record.terminalId, 'during recovery')).toEqual({
      status: 'blocked_codex_recovery_pending',
      terminalId: record.terminalId,
    })
    expect(oldPty.write).not.toHaveBeenCalledWith('during recovery')

    readiness.resolve()
    await vi.waitFor(() => expect(currentSidecar.shutdown).toHaveBeenCalledTimes(1))
    const [, replacementPty] = await spawnedPtys()

    expect(registry.input(record.terminalId, 'after recovery')).toEqual({ status: 'written' })
    expect(oldPty.write).not.toHaveBeenCalledWith('after recovery')
    expect(replacementPty.write).toHaveBeenCalledWith('after recovery')
  })

  it('keeps non-durable Codex PTY exit final', async () => {
    const exited = vi.fn()
    registry.on('terminal.exit', exited)
    const record = registry.create({ mode: 'codex', cwd: '/repo' })
    const [pty] = await spawnedPtys()

    pty.onExit.mock.calls[0][0]({ exitCode: 2, signal: 0 })

    expect(registry.get(record.terminalId)?.status).toBe('exited')
    expect(exited).toHaveBeenCalledWith({ terminalId: record.terminalId, exitCode: 2 })
  })

  it('does not start durable recovery for an explicit user close', async () => {
    const currentSidecar = createFakeSidecar()
    const planCreate = vi.fn()
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      resumeSessionId: 'thread-durable-1',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:46001/',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
        },
      } as any,
    })

    registry.kill(record.terminalId)

    expect(planCreate).not.toHaveBeenCalled()
    expect(registry.get(record.terminalId)?.status).toBe('exited')
    await vi.waitFor(() => expect(currentSidecar.shutdown).toHaveBeenCalledTimes(1))
  })
})
