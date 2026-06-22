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
  shutdown?: CodexLaunchSidecar['shutdown']
  readThreadTurn?: CodexLaunchSidecar['readThreadTurn']
  listThreadTurns?: CodexLaunchSidecar['listThreadTurns']
} = {}): CodexLaunchSidecar & { emitLifecycleLoss(event: unknown): void; emitRepairTrigger(event: { kind: string; error?: Error }): void } {
  const lifecycleLossHandlers = new Set<(event: unknown) => void>()
  const repairHandlers = new Set<(event: { kind: string; error?: Error }) => void>()
  return {
    adopt: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn(options.shutdown ?? (async () => undefined)),
    onLifecycleLoss: vi.fn((handler: (event: unknown) => void) => {
      lifecycleLossHandlers.add(handler)
      return () => lifecycleLossHandlers.delete(handler)
    }),
    onRepairTrigger: vi.fn((handler: (event: { kind: string; error?: Error }) => void) => {
      repairHandlers.add(handler)
      return () => repairHandlers.delete(handler)
    }),
    readThreadTurn: options.readThreadTurn ? vi.fn(options.readThreadTurn) : undefined,
    listThreadTurns: options.listThreadTurns ? vi.fn(options.listThreadTurns) : undefined,
    emitLifecycleLoss(event: unknown) {
      for (const handler of lifecycleLossHandlers) handler(event)
    },
    emitRepairTrigger(event: { kind: string; error?: Error }) {
      for (const handler of repairHandlers) handler(event)
    },
  }
}

describe.sequential('TerminalRegistry Codex durable recovery', () => {
  let registry: TerminalRegistry

  beforeEach(async () => {
    vi.clearAllMocks()
    const pty = await import('node-pty')
    vi.mocked(pty.spawn).mockImplementation(() => createMockPty() as any)
    registry = new TerminalRegistry()
  })

  afterEach(async () => {
    try {
      await vi.waitFor(() => {
        for (const terminal of registry.list()) {
          const record = registry.get(terminal.terminalId)
          expect(record?.codexRecoveryAttempt).toBeUndefined()
          expect(record?.codexCleanExitDecisionPending).toBeUndefined()
          expect(record?.codexPendingCleanExitFinalizer).toBeUndefined()
          expect(record?.codexLifecycleLossProofPending).not.toBe(true)
        }
      })
    } finally {
      registry.shutdown()
      vi.useRealTimers()
    }
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

    await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: record.terminalId, generation: 1 }))
    await vi.waitFor(() => expect(currentSidecar.shutdown).toHaveBeenCalledTimes(1))
    const [, replacementPty] = await spawnedPtys()

    await vi.waitFor(() => {
      expect(record.status).toBe('running')
      expect(registry.get(record.terminalId)?.pty).toBe(replacementPty)
    })
    expect(planCreate).toHaveBeenCalledWith(expect.objectContaining({
      terminalId: record.terminalId,
      resumeSessionId: 'thread-durable-1',
      generation: 1,
    }))
    expect(replacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: record.terminalId, generation: 1 })
    expect(oldPty.kill).toHaveBeenCalledTimes(1)
    expect(exited).not.toHaveBeenCalled()
  })

  it('clears the retiring PTY marker when recovery aborts before planning', async () => {
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

    currentSidecar.emitLifecycleLoss({
      method: 'thread/status/changed',
      threadId: 'thread-durable-1',
      status: 'notLoaded',
    })
    expect(record.codexRecoveryRetiringPty).toBe(oldPty)

    ;(record as any).status = 'exited'

    await vi.waitFor(() => expect(record.codexRecoveryAttempt).toBeUndefined())
    expect(record.codexRecoveryRetiringPty).toBeUndefined()
    expect(planCreate).not.toHaveBeenCalled()
  })

  it('keeps a durable Codex PTY exit final when the visible process exits cleanly', async () => {
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
    const [pty] = await spawnedPtys()

    pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: 0 })

    expect(planCreate).not.toHaveBeenCalled()
    expect(replacementSidecar.adopt).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(record.status).toBe('exited'), { timeout: 3000 })
    expect(registry.get(record.terminalId)?.exitCode).toBe(0)
    expect(exited).toHaveBeenCalledWith({
      terminalId: record.terminalId,
      exitCode: 0,
      recoverableForRestore: true,
    })
  })

  it('recovers a durable Codex terminal when the visible PTY exits cleanly during an active turn', async () => {
    const exited = vi.fn()
    registry.on('terminal.exit', exited)
    const currentSidecar = createFakeSidecar({
      readThreadTurn: vi.fn(async () => ({
        id: 'turn-1',
        turnId: 'turn-1',
        revision: 1,
        status: 'inProgress',
        items: [],
        error: null,
        startedAt: Date.now(),
        completedAt: null,
        durationMs: null,
      })),
    })
    const replacementSidecar = createFakeSidecar({
      readThreadTurn: vi.fn(async () => ({
        id: 'turn-1',
        turnId: 'turn-1',
        revision: 1,
        status: 'completed',
        items: [],
        error: null,
        startedAt: null,
        completedAt: Date.now(),
        durationMs: 1000,
      })),
    })
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

    await (registry as any).handleCodexTurnStarted(record.terminalId, {
      threadId: 'thread-durable-1',
      turnId: 'turn-1',
      params: {},
    })
    oldPty.onExit.mock.calls[0][0]({ exitCode: 0, signal: 0 })

    await vi.waitFor(() => expect(currentSidecar.readThreadTurn).toHaveBeenCalledWith({
      threadId: 'thread-durable-1',
      turnId: 'turn-1',
    }))
    await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: record.terminalId, generation: 1 }))
    expect(planCreate).toHaveBeenCalledWith(expect.objectContaining({
      terminalId: record.terminalId,
      resumeSessionId: 'thread-durable-1',
      generation: 1,
    }))
    const [, replacementPty] = await spawnedPtys()
    expect(registry.get(record.terminalId)?.pty).toBe(replacementPty)
    expect(exited).not.toHaveBeenCalled()
    replacementPty.onExit.mock.calls[0][0]({ exitCode: 0, signal: 0 })

    await vi.waitFor(() => expect(replacementSidecar.readThreadTurn).toHaveBeenCalledWith({
      threadId: 'thread-durable-1',
      turnId: 'turn-1',
    }))
    expect(planCreate).toHaveBeenCalled()
    await vi.waitFor(() => expect(record.status).toBe('exited'), { timeout: 3000 })
    expect(registry.get(record.terminalId)?.exitCode).toBe(0)
    expect(exited).toHaveBeenCalledWith({
      terminalId: record.terminalId,
      exitCode: 0,
      recoverableForRestore: true,
    })
  })

  it('keeps recovering clean PTY exits after handoff while the active turn remains in progress', async () => {
    const exited = vi.fn()
    registry.on('terminal.exit', exited)
    const currentSidecar = createFakeSidecar()
    const replacementSidecar = createFakeSidecar({
      readThreadTurn: vi.fn(async () => ({
        id: 'turn-1',
        turnId: 'turn-1',
        revision: 1,
        status: 'inProgress',
        items: [],
        error: null,
        startedAt: Date.now(),
        completedAt: null,
        durationMs: null,
      })),
    })
    const secondReplacementSidecar = createFakeSidecar()
    const planCreate = vi.fn()
      .mockResolvedValueOnce({
        sessionId: 'thread-durable-1',
        remote: { wsUrl: 'ws://127.0.0.1:46002/' },
        sidecar: replacementSidecar,
      })
      .mockResolvedValueOnce({
        sessionId: 'thread-durable-1',
        remote: { wsUrl: 'ws://127.0.0.1:46003/' },
        sidecar: secondReplacementSidecar,
      })
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

    await (registry as any).handleCodexTurnStarted(record.terminalId, {
      threadId: 'thread-durable-1',
      turnId: 'turn-1',
      params: {},
    })
    oldPty.onExit.mock.calls[0][0]({ exitCode: 0, signal: 0 })
    await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: record.terminalId, generation: 1 }))

    const [, replacementPty] = await spawnedPtys()
    replacementPty.onExit.mock.calls[0][0]({ exitCode: 0, signal: 0 })

    await vi.waitFor(() => expect(replacementSidecar.readThreadTurn).toHaveBeenCalledWith({
      threadId: 'thread-durable-1',
      turnId: 'turn-1',
    }))
    await vi.waitFor(() => expect(secondReplacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: record.terminalId, generation: 2 }))
    expect(planCreate).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(record.status).toBe('running'))
    expect(exited).not.toHaveBeenCalled()
  })

  it('keeps a durable Codex clean exit final when a lost turn-completed notification has a completed turn state', async () => {
    const exited = vi.fn()
    registry.on('terminal.exit', exited)
    const currentSidecar = createFakeSidecar({
      readThreadTurn: vi.fn(async () => ({
        id: 'turn-1',
        turnId: 'turn-1',
        revision: 1,
        status: 'completed',
        items: [],
        error: null,
        startedAt: null,
        completedAt: Date.now(),
        durationMs: 1000,
      })),
    })
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
    const [pty] = await spawnedPtys()

    await (registry as any).handleCodexTurnStarted(record.terminalId, {
      threadId: 'thread-durable-1',
      turnId: 'turn-1',
    })

    pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: 0 })

    await vi.waitFor(() => expect(currentSidecar.readThreadTurn).toHaveBeenCalledWith({
      threadId: 'thread-durable-1',
      turnId: 'turn-1',
    }))
    expect(planCreate).not.toHaveBeenCalled()
    expect(replacementSidecar.adopt).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(record.status).toBe('exited'), { timeout: 3000 })
    expect(registry.get(record.terminalId)?.exitCode).toBe(0)
    expect(exited).toHaveBeenCalledWith({
      terminalId: record.terminalId,
      exitCode: 0,
      recoverableForRestore: true,
    })
  })

  it('does not let an unidentified turn-completed event clear a different active turn before clean exit', async () => {
    const exited = vi.fn()
    registry.on('terminal.exit', exited)
    const currentSidecar = createFakeSidecar({
      readThreadTurn: vi.fn(async () => ({
        id: 'turn-1',
        turnId: 'turn-1',
        revision: 1,
        status: 'inProgress',
        items: [],
        error: null,
        startedAt: Date.now(),
        completedAt: null,
        durationMs: null,
      })),
    })
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
    const [pty] = await spawnedPtys()

    await (registry as any).handleCodexTurnStarted(record.terminalId, {
      threadId: 'thread-durable-1',
      turnId: 'turn-1',
      params: {},
    })
    await (registry as any).handleCodexTurnCompleted(record.terminalId, {
      threadId: 'thread-durable-1',
      params: {},
    })

    pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: 0 })

    await vi.waitFor(() => expect(currentSidecar.readThreadTurn).toHaveBeenCalledWith({
      threadId: 'thread-durable-1',
      turnId: 'turn-1',
    }))
    await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: record.terminalId, generation: 1 }))
    expect(planCreate).toHaveBeenCalled()
    await vi.waitFor(() => expect(record.status).toBe('running'))
    expect(exited).not.toHaveBeenCalled()
  })

  it('keeps a fresh clean PTY exit final without polling turns when no activity was observed', async () => {
    const exited = vi.fn()
    registry.on('terminal.exit', exited)
    const currentSidecar = createFakeSidecar({
      listThreadTurns: vi.fn(async () => ({
        revision: 1,
        nextCursor: null,
        backwardsCursor: null,
        turns: [{
          id: 'turn-1',
          status: 'inProgress',
          items: [],
          error: null,
          startedAt: Date.now(),
          completedAt: null,
          durationMs: null,
        }],
        bodies: {},
      })),
      readThreadTurn: vi.fn(async () => ({
        id: 'turn-1',
        turnId: 'turn-1',
        revision: 1,
        status: 'inProgress',
        items: [],
        error: null,
        startedAt: Date.now(),
        completedAt: null,
        durationMs: null,
      })),
    })
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
      sessionBindingReason: 'start',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:46001/',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
        },
      } as any,
    })
    const [pty] = await spawnedPtys()

    pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: 0 })

    await vi.waitFor(() => expect(record.status).toBe('exited'), { timeout: 3000 })
    expect(currentSidecar.listThreadTurns).not.toHaveBeenCalled()
    expect(currentSidecar.readThreadTurn).not.toHaveBeenCalled()
    expect(planCreate).not.toHaveBeenCalled()
    expect(replacementSidecar.adopt).not.toHaveBeenCalled()
    expect(exited).toHaveBeenCalledWith({
      terminalId: record.terminalId,
      exitCode: 0,
      recoverableForRestore: true,
    })
  })

  it('recovers a clean PTY exit when a restored thread has an in-progress turn snapshot', async () => {
    const exited = vi.fn()
    registry.on('terminal.exit', exited)
    const currentSidecar = createFakeSidecar({
      listThreadTurns: vi.fn(async () => ({
        revision: 1,
        nextCursor: null,
        backwardsCursor: null,
        turns: [{
          id: 'turn-1',
          status: 'inProgress',
          items: [],
          error: null,
          startedAt: Date.now(),
          completedAt: null,
          durationMs: null,
        }],
        bodies: {},
      })),
      readThreadTurn: vi.fn(async () => ({
        id: 'turn-1',
        turnId: 'turn-1',
        revision: 1,
        status: 'inProgress',
        items: [],
        error: null,
        startedAt: Date.now(),
        completedAt: null,
        durationMs: null,
      })),
    })
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
      sessionBindingReason: 'resume',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:46001/',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
        },
      } as any,
    })
    const [pty] = await spawnedPtys()

    pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: 0 })

    await vi.waitFor(() => expect(currentSidecar.listThreadTurns).toHaveBeenCalledWith({
      threadId: 'thread-durable-1',
      limit: 50,
      sortDirection: 'desc',
      itemsView: 'notLoaded',
    }))
    await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: record.terminalId, generation: 1 }))
    expect(currentSidecar.readThreadTurn).not.toHaveBeenCalled()
    expect(planCreate).toHaveBeenCalled()
    await vi.waitFor(() => expect(record.status).toBe('running'))
    expect(exited).not.toHaveBeenCalled()
  })

  it('recovers a clean PTY exit when recent input has an in-progress turn snapshot despite a missed turn-start event', async () => {
    const exited = vi.fn()
    registry.on('terminal.exit', exited)
    const currentSidecar = createFakeSidecar({
      listThreadTurns: vi.fn(async () => ({
        revision: 1,
        nextCursor: null,
        backwardsCursor: null,
        turns: [{
          id: 'turn-1',
          status: 'inProgress',
          items: [],
          error: null,
          startedAt: Date.now(),
          completedAt: null,
          durationMs: null,
        }],
        bodies: {},
      })),
      readThreadTurn: vi.fn(async () => ({
        id: 'turn-1',
        turnId: 'turn-1',
        revision: 1,
        status: 'inProgress',
        items: [],
        error: null,
        startedAt: Date.now(),
        completedAt: null,
        durationMs: null,
      })),
    })
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
    const [pty] = await spawnedPtys()

    await (registry as any).handleCodexTurnStarted(record.terminalId, {
      threadId: 'thread-durable-1',
      params: {},
    })
    pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: 0 })

    await vi.waitFor(() => expect(currentSidecar.listThreadTurns).toHaveBeenCalledWith({
      threadId: 'thread-durable-1',
      limit: 50,
      sortDirection: 'desc',
      itemsView: 'notLoaded',
    }))
    await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: record.terminalId, generation: 1 }))
    expect(currentSidecar.readThreadTurn).not.toHaveBeenCalled()
    expect(planCreate).toHaveBeenCalled()
    await vi.waitFor(() => expect(record.status).toBe('running'))
    expect(exited).not.toHaveBeenCalled()
  })

  it('keeps ordinary clean exits final when user input never becomes turn evidence', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const exited = vi.fn()
    registry.on('terminal.exit', exited)
    const currentSidecar = createFakeSidecar({
      listThreadTurns: vi.fn(async () => ({
        revision: 1,
        nextCursor: null,
        backwardsCursor: null,
        turns: [],
        bodies: {},
      })),
    })
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
    const [pty] = await spawnedPtys()

    expect(registry.input(record.terminalId, 'exit\n')).toEqual({ status: 'written' })
    pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: 0 })
    expect(planCreate).not.toHaveBeenCalled()
    expect(exited).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(3000)

    await vi.waitFor(() => expect(record.status).toBe('exited'))
    expect(currentSidecar.listThreadTurns).toHaveBeenCalledWith({
      threadId: 'thread-durable-1',
      limit: 50,
      sortDirection: 'desc',
      itemsView: 'notLoaded',
    })
    expect(replacementSidecar.adopt).not.toHaveBeenCalled()
    expect(planCreate).not.toHaveBeenCalled()
    expect(exited).toHaveBeenCalledWith({
      terminalId: record.terminalId,
      exitCode: 0,
      recoverableForRestore: true,
    })
  })

  it('recovers when a resumed clean exit sees a turn appear after recent user input', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const exited = vi.fn()
    registry.on('terminal.exit', exited)
    const currentSidecar = createFakeSidecar({
      listThreadTurns: vi.fn()
        .mockResolvedValueOnce({
          revision: 1,
          nextCursor: null,
          backwardsCursor: null,
          turns: [],
          bodies: {},
        })
        .mockResolvedValueOnce({
          revision: 2,
          nextCursor: null,
          backwardsCursor: null,
          turns: [{
            id: 'turn-1',
            status: 'inProgress',
            items: [],
            error: null,
            startedAt: Date.now(),
            completedAt: null,
            durationMs: null,
          }],
          bodies: {},
        })
        .mockResolvedValueOnce({
          revision: 3,
          nextCursor: null,
          backwardsCursor: null,
          turns: [{
            id: 'turn-1',
            status: 'inProgress',
            items: [],
            error: null,
            startedAt: Date.now(),
            completedAt: null,
            durationMs: null,
          }],
          bodies: {},
        }),
    })
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
    const [pty] = await spawnedPtys()

    await vi.advanceTimersByTimeAsync(1000)
    expect(registry.input(record.terminalId, 'start active turn\n')).toEqual({ status: 'written' })
    pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: 0 })
    await vi.waitFor(() => expect(currentSidecar.listThreadTurns).toHaveBeenCalledTimes(1))
    expect(planCreate).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(800)

    await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: record.terminalId, generation: 1 }))
    await vi.waitFor(() => expect(record.status).toBe('running'))
    expect(exited).not.toHaveBeenCalled()
  })

  it('recovers when a freshly-promoted durable clean exit sees a turn appear after recent user input', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const exited = vi.fn()
    registry.on('terminal.exit', exited)
    const currentSidecar = createFakeSidecar({
      listThreadTurns: vi.fn()
        .mockResolvedValueOnce({
          revision: 1,
          nextCursor: null,
          backwardsCursor: null,
          turns: [],
          bodies: {},
        })
        .mockResolvedValueOnce({
          revision: 2,
          nextCursor: null,
          backwardsCursor: null,
          turns: [{
            id: 'turn-1',
            status: 'inProgress',
            items: [],
            error: null,
            startedAt: Date.now(),
            completedAt: null,
            durationMs: null,
          }],
          bodies: {},
        })
        .mockResolvedValueOnce({
          revision: 3,
          nextCursor: null,
          backwardsCursor: null,
          turns: [{
            id: 'turn-1',
            status: 'inProgress',
            items: [],
            error: null,
            startedAt: Date.now(),
            completedAt: null,
            durationMs: null,
          }],
          bodies: {},
        }),
    })
    const replacementSidecar = createFakeSidecar()
    const planCreate = vi.fn(async () => ({
      sessionId: 'thread-durable-1',
      remote: { wsUrl: 'ws://127.0.0.1:46002/' },
      sidecar: replacementSidecar,
    }))
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:46001/',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
        },
      } as any,
    })
    const latest = registry.get(record.terminalId)!
    latest.resumeSessionId = 'thread-durable-1'
    latest.codexDurability = {
      state: 'durable',
      durableThreadId: 'thread-durable-1',
    } as any
    registry.releaseCodexInputGateForTest(record.terminalId)
    const [pty] = await spawnedPtys()

    expect(registry.input(record.terminalId, 'start active turn\n')).toEqual({ status: 'written' })
    pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: 0 })
    await vi.waitFor(() => expect(currentSidecar.listThreadTurns).toHaveBeenCalledTimes(1))
    expect(planCreate).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(800)

    await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: record.terminalId, generation: 1 }))
    await vi.waitFor(() => expect(record.status).toBe('running'))
    expect(exited).not.toHaveBeenCalled()
  })

  it('keeps a clean PTY exit final when recent user input is still not visible after the grace window', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const exited = vi.fn()
    registry.on('terminal.exit', exited)
    const currentSidecar = createFakeSidecar({
      listThreadTurns: vi.fn(async () => ({
        revision: 1,
        nextCursor: null,
        backwardsCursor: null,
        turns: [],
        bodies: {},
      })),
    })
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
    const [pty] = await spawnedPtys()

    expect(registry.input(record.terminalId, 'start slow turn\n')).toEqual({ status: 'written' })
    pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: 0 })

    await vi.advanceTimersByTimeAsync(3000)

    await vi.waitFor(() => expect(record.status).toBe('exited'))
    expect(currentSidecar.listThreadTurns).toHaveBeenCalledWith({
      threadId: 'thread-durable-1',
      limit: 50,
      sortDirection: 'desc',
      itemsView: 'notLoaded',
    })
    expect(replacementSidecar.adopt).not.toHaveBeenCalled()
    expect(planCreate).not.toHaveBeenCalled()
    expect(exited).toHaveBeenCalledWith({
      terminalId: record.terminalId,
      exitCode: 0,
      recoverableForRestore: true,
    })
  })

  it('blocks input while a clean-exit active-turn decision is in flight', async () => {
    const turnRead = deferred<Awaited<ReturnType<NonNullable<CodexLaunchSidecar['readThreadTurn']>>>>()
    const currentSidecar = createFakeSidecar({
      readThreadTurn: vi.fn(() => turnRead.promise),
    })
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
    const [pty] = await spawnedPtys()

    await (registry as any).handleCodexTurnStarted(record.terminalId, {
      threadId: 'thread-durable-1',
      turnId: 'turn-1',
      params: {},
    })
    pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: 0 })
    await vi.waitFor(() => expect(currentSidecar.readThreadTurn).toHaveBeenCalled())

    expect(registry.input(record.terminalId, 'during decision')).toEqual({
      status: 'blocked_codex_clean_exit_decision_pending',
      terminalId: record.terminalId,
    })
    expect(pty.write).not.toHaveBeenCalledWith('during decision')

    turnRead.resolve({
      id: 'turn-1',
      turnId: 'turn-1',
      revision: 1,
      status: 'inProgress',
      items: [],
      error: null,
      startedAt: Date.now(),
      completedAt: null,
      durationMs: null,
    })
    await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: record.terminalId, generation: 1 }))
  })

  it('keeps a clean exit final when an active-turn event omitted turnId and the snapshot is idle', async () => {
    const exited = vi.fn()
    registry.on('terminal.exit', exited)
    const currentSidecar = createFakeSidecar({
      listThreadTurns: vi.fn(async () => ({
        revision: 1,
        nextCursor: null,
        backwardsCursor: null,
        turns: [{
          id: 'turn-1',
          status: 'completed',
          items: [],
          error: null,
          startedAt: Date.now() - 1000,
          completedAt: Date.now(),
          durationMs: 1000,
        }],
        bodies: {},
      })),
    })
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
    const [pty] = await spawnedPtys()

    await (registry as any).handleCodexTurnStarted(record.terminalId, {
      threadId: 'thread-durable-1',
      params: {},
    })
    pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: 0 })

    await vi.waitFor(() => expect(currentSidecar.listThreadTurns).toHaveBeenCalledWith({
      threadId: 'thread-durable-1',
      limit: 50,
      sortDirection: 'desc',
      itemsView: 'notLoaded',
    }))
    expect(planCreate).not.toHaveBeenCalled()
    expect(replacementSidecar.adopt).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(record.status).toBe('exited'), { timeout: 3000 })
    expect(exited).toHaveBeenCalledWith({
      terminalId: record.terminalId,
      exitCode: 0,
      recoverableForRestore: true,
    })
  })

  it('matches active turns by the promoted durable thread when a stale candidate remains', async () => {
    const exited = vi.fn()
    registry.on('terminal.exit', exited)
    const currentSidecar = createFakeSidecar({
      readThreadTurn: vi.fn(async () => ({
        id: 'turn-1',
        turnId: 'turn-1',
        revision: 1,
        status: 'inProgress',
        items: [],
        error: null,
        startedAt: Date.now(),
        completedAt: null,
        durationMs: null,
      })),
    })
    const replacementSidecar = createFakeSidecar()
    const planCreate = vi.fn(async () => ({
      sessionId: 'thread-create-durable',
      remote: { wsUrl: 'ws://127.0.0.1:46002/' },
      sidecar: replacementSidecar,
    }))
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      resumeSessionId: 'thread-create-durable',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:46001/',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
        },
      } as any,
    })
    const latest = registry.get(record.terminalId)!
    latest.codexDurability = {
      state: 'durable',
      durableThreadId: 'thread-create-durable',
      candidate: {
        candidateThreadId: 'thread-create-candidate',
        rolloutPath: '/repo/.codex/sessions/rollout.jsonl',
      },
    } as any
    const [pty] = await spawnedPtys()

    await (registry as any).handleCodexTurnStarted(record.terminalId, {
      threadId: 'thread-create-candidate',
      turnId: 'turn-1',
      params: {},
    })
    pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: 0 })

    await vi.waitFor(() => expect(currentSidecar.readThreadTurn).toHaveBeenCalledWith({
      threadId: 'thread-create-candidate',
      turnId: 'turn-1',
    }))
    await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: record.terminalId, generation: 1 }))
    await vi.waitFor(() => expect(record.status).toBe('running'))
    expect(exited).not.toHaveBeenCalled()
  })

  it('polls the promoted durable thread instead of a stale candidate when clean exit has no active-turn event', async () => {
    const exited = vi.fn()
    registry.on('terminal.exit', exited)
    const currentSidecar = createFakeSidecar({
      listThreadTurns: vi.fn(async (params) => ({
        revision: 1,
        nextCursor: null,
        backwardsCursor: null,
        turns: params.threadId === 'thread-create-durable'
          ? [{
            id: 'turn-1',
            status: 'inProgress',
            items: [],
            error: null,
            startedAt: Date.now(),
            completedAt: null,
            durationMs: null,
          }]
          : [],
        bodies: {},
      })),
    })
    const replacementSidecar = createFakeSidecar()
    const planCreate = vi.fn(async () => ({
      sessionId: 'thread-create-durable',
      remote: { wsUrl: 'ws://127.0.0.1:46002/' },
      sidecar: replacementSidecar,
    }))
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      resumeSessionId: 'thread-create-durable',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:46001/',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
        },
      } as any,
    })
    const latest = registry.get(record.terminalId)!
    latest.codexDurability = {
      state: 'durable',
      durableThreadId: 'thread-create-durable',
      candidate: {
        candidateThreadId: 'thread-create-candidate',
        rolloutPath: '/repo/.codex/sessions/rollout.jsonl',
      },
    } as any
    ;(latest as any).codexUnconfirmedInputAt = Date.now() - 1000
    const [pty] = await spawnedPtys()

    pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: 0 })

    await vi.waitFor(() => expect(currentSidecar.listThreadTurns).toHaveBeenCalledWith({
      threadId: 'thread-create-durable',
      limit: 50,
      sortDirection: 'desc',
      itemsView: 'notLoaded',
    }))
    await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: record.terminalId, generation: 1 }))
    expect(currentSidecar.listThreadTurns).not.toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-create-candidate',
    }))
    await vi.waitFor(() => expect(record.status).toBe('running'))
    expect(exited).not.toHaveBeenCalled()
  })

  it('recovers a clean PTY exit when a completed cached turn is followed by a newer in-progress turn', async () => {
    const exited = vi.fn()
    registry.on('terminal.exit', exited)
    const currentSidecar = createFakeSidecar({
      readThreadTurn: vi.fn(async () => ({
        id: 'turn-1',
        turnId: 'turn-1',
        revision: 1,
        status: 'completed',
        items: [],
        error: null,
        startedAt: null,
        completedAt: Date.now(),
        durationMs: 1000,
      })),
      listThreadTurns: vi.fn(async () => ({
        revision: 2,
        nextCursor: null,
        backwardsCursor: null,
        turns: [{
          id: 'turn-2',
          status: 'inProgress',
          items: [],
          error: null,
          startedAt: Date.now(),
          completedAt: null,
          durationMs: null,
        }],
        bodies: {},
      })),
    })
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
    const [pty] = await spawnedPtys()

    await (registry as any).handleCodexTurnStarted(record.terminalId, {
      threadId: 'thread-durable-1',
      turnId: 'turn-1',
      params: {},
    })
    pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: 0 })

    await vi.waitFor(() => expect(currentSidecar.listThreadTurns).toHaveBeenCalledWith({
      threadId: 'thread-durable-1',
      limit: 50,
      sortDirection: 'desc',
      itemsView: 'notLoaded',
    }))
    await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: record.terminalId, generation: 1 }))
    expect(currentSidecar.readThreadTurn).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(record.status).toBe('running'))
    expect(exited).not.toHaveBeenCalled()
  })

  it('recovers a clean PTY exit when an observed active-turn snapshot cannot be read', async () => {
    const exited = vi.fn()
    registry.on('terminal.exit', exited)
    const currentSidecar = createFakeSidecar({
      listThreadTurns: vi.fn(async () => {
        throw new Error('thread read failed')
      }),
    })
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
    const [pty] = await spawnedPtys()

    await (registry as any).handleCodexTurnStarted(record.terminalId, {
      threadId: 'thread-durable-1',
      params: {},
    })
    pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: 0 })

    await vi.waitFor(() => expect(currentSidecar.listThreadTurns).toHaveBeenCalled())
    await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: record.terminalId, generation: 1 }))
    await vi.waitFor(() => expect(record.status).toBe('running'))
    expect(exited).not.toHaveBeenCalled()
  })

  it('does not finalize a clean PTY exit when lifecycle-loss recovery starts during the active-turn read', async () => {
    const exited = vi.fn()
    registry.on('terminal.exit', exited)
    const turnRead = deferred<Awaited<ReturnType<NonNullable<CodexLaunchSidecar['readThreadTurn']>>>>()
    const currentSidecar = createFakeSidecar({
      readThreadTurn: vi.fn(() => turnRead.promise),
    })
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
    const [pty] = await spawnedPtys()

    await (registry as any).handleCodexTurnStarted(record.terminalId, {
      threadId: 'thread-durable-1',
      turnId: 'turn-1',
      params: {},
    })
    pty.onExit.mock.calls[0][0]({ exitCode: 0, signal: 0 })
    await vi.waitFor(() => expect(currentSidecar.readThreadTurn).toHaveBeenCalled())

    currentSidecar.emitLifecycleLoss({
      method: 'thread/status/changed',
      threadId: 'thread-durable-1',
      status: 'notLoaded',
    })
    await vi.waitFor(() => expect(planCreate).toHaveBeenCalled())
    turnRead.resolve({
      id: 'turn-1',
      turnId: 'turn-1',
      revision: 1,
      status: 'completed',
      items: [],
      error: null,
      startedAt: Date.now() - 1000,
      completedAt: Date.now(),
      durationMs: 1000,
    })

    await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: record.terminalId, generation: 1 }))
    await vi.waitFor(() => expect(record.status).toBe('running'))
    expect(exited).not.toHaveBeenCalled()
  })

  it('recovers lifecycle loss reported for a promoted live candidate thread id', async () => {
    const currentSidecar = createFakeSidecar()
    const replacementSidecar = createFakeSidecar()
    const planCreate = vi.fn(async () => ({
      sessionId: 'thread-create-durable',
      remote: { wsUrl: 'ws://127.0.0.1:46002/' },
      sidecar: replacementSidecar,
    }))
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      resumeSessionId: 'thread-create-durable',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:46001/',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
        },
      } as any,
    })
    const latest = registry.get(record.terminalId)!
    latest.codexDurability = {
      state: 'durable',
      durableThreadId: 'thread-create-durable',
      candidate: {
        candidateThreadId: 'thread-create-candidate',
        rolloutPath: '/repo/.codex/sessions/rollout.jsonl',
      },
    } as any

    currentSidecar.emitLifecycleLoss({
      method: 'thread/status/changed',
      threadId: 'thread-create-candidate',
      status: 'notLoaded',
    })

    await vi.waitFor(() => expect(planCreate).toHaveBeenCalled())
    await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: record.terminalId, generation: 1 }))
    await vi.waitFor(() => expect(record.status).toBe('running'))
  })

  it('keeps a recovered durable Codex PTY exit final when the replacement process exits cleanly', async () => {
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

    await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: record.terminalId, generation: 1 }))
    const [, replacementPty] = await spawnedPtys()

    replacementPty.onExit.mock.calls[0][0]({ exitCode: 0, signal: 0 })

    expect(planCreate).toHaveBeenCalled()
    await vi.waitFor(() => expect(record.status).toBe('exited'), { timeout: 3000 })
    expect(registry.get(record.terminalId)?.exitCode).toBe(0)
    expect(exited).toHaveBeenCalledWith({
      terminalId: record.terminalId,
      exitCode: 0,
      recoverableForRestore: true,
    })
  })

  it('keeps a recovered Codex clean exit final when it happens before recovery bookkeeping settles', async () => {
    const exited = vi.fn()
    registry.on('terminal.exit', exited)
    const ptyModule = await import('node-pty')
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
    oldPty.kill.mockImplementation(() => {
      const replacementPty = vi.mocked(ptyModule.spawn).mock.results[1]?.value as MockPty | undefined
      replacementPty?.onExit.mock.calls[0][0]({ exitCode: 0, signal: 0 })
    })

    oldPty.onExit.mock.calls[0][0]({ exitCode: 1, signal: 0 })

    await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: record.terminalId, generation: 1 }))
    expect(planCreate).toHaveBeenCalled()
    await vi.waitFor(() => expect(record.status).toBe('exited'), { timeout: 3000 })
    expect(registry.get(record.terminalId)?.exitCode).toBe(0)
    expect(exited).toHaveBeenCalledWith({
      terminalId: record.terminalId,
      exitCode: 0,
      recoverableForRestore: true,
    })
  })

  it('keeps lifecycle-loss recovery running when the current PTY exits cleanly', async () => {
    const exited = vi.fn()
    registry.on('terminal.exit', exited)
    const planReady = deferred()
    const currentSidecar = createFakeSidecar()
    const replacementSidecar = createFakeSidecar()
    const planCreate = vi.fn(async () => {
      await planReady.promise
      return {
        sessionId: 'thread-durable-1',
        remote: { wsUrl: 'ws://127.0.0.1:46002/' },
        sidecar: replacementSidecar,
      }
    })
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

    currentSidecar.emitLifecycleLoss({
      method: 'thread/status/changed',
      threadId: 'thread-durable-1',
      status: 'notLoaded',
    })
    await vi.waitFor(() => expect(planCreate).toHaveBeenCalled())

    oldPty.onExit.mock.calls[0][0]({ exitCode: 0, signal: 0 })

    await vi.waitFor(() => expect(record.status).toBe('running'))
    expect(registry.input(record.terminalId, 'during recovery')).toEqual({
      status: 'blocked_codex_recovery_pending',
      terminalId: record.terminalId,
    })
    expect(exited).not.toHaveBeenCalled()

    planReady.resolve()
    await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: record.terminalId, generation: 1 }))
    expect(exited).not.toHaveBeenCalled()
  })

  it('recovers lifecycle loss that arrives immediately after a durable clean PTY exit', async () => {
    const exited = vi.fn()
    registry.on('terminal.exit', exited)
    const planReady = deferred()
    const currentSidecar = createFakeSidecar()
    const replacementSidecar = createFakeSidecar()
    const planCreate = vi.fn(async () => {
      await planReady.promise
      return {
        sessionId: 'thread-durable-1',
        remote: { wsUrl: 'ws://127.0.0.1:46002/' },
        sidecar: replacementSidecar,
      }
    })
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      resumeSessionId: 'thread-durable-1',
      sessionBindingReason: 'association',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:46001/',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
        },
      } as any,
    })
    const [oldPty] = await spawnedPtys()

    oldPty.onExit.mock.calls[0][0]({ exitCode: 0, signal: 0 })
    expect(registry.input(record.terminalId, 'during clean exit grace')).toEqual({
      status: 'blocked_codex_clean_exit_decision_pending',
      terminalId: record.terminalId,
    })

    currentSidecar.emitLifecycleLoss({
      method: 'thread/status/changed',
      threadId: 'thread-durable-1',
      status: 'notLoaded',
    })

    await vi.waitFor(() => expect(planCreate).toHaveBeenCalled())
    expect(registry.input(record.terminalId, 'during recovery')).toEqual({
      status: 'blocked_codex_recovery_pending',
      terminalId: record.terminalId,
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(record.status).toBe('running')
    expect(exited).not.toHaveBeenCalled()

    planReady.resolve()
    await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: record.terminalId, generation: 1 }))
    expect(exited).not.toHaveBeenCalled()
  })

  it('keeps the clean-exit finalizer when an unrelated lifecycle-loss event arrives during the grace window', async () => {
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
      sessionBindingReason: 'association',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:46001/',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
        },
      } as any,
    })
    const [oldPty] = await spawnedPtys()

    oldPty.onExit.mock.calls[0][0]({ exitCode: 0, signal: 0 })
    currentSidecar.emitLifecycleLoss({
      method: 'thread/status/changed',
      threadId: 'unrelated-thread',
      status: 'notLoaded',
    })

    expect(registry.input(record.terminalId, 'during clean exit grace')).toEqual({
      status: 'blocked_codex_clean_exit_decision_pending',
      terminalId: record.terminalId,
    })
    expect(planCreate).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(record.status).toBe('exited'), { timeout: 3000 })
    expect(exited).toHaveBeenCalledWith({
      terminalId: record.terminalId,
      exitCode: 0,
      recoverableForRestore: true,
    })
    expect(planCreate).not.toHaveBeenCalled()
  })

  it('recovers proxy repair triggers that arrive during a durable clean PTY exit grace window', async () => {
    const exited = vi.fn()
    registry.on('terminal.exit', exited)
    const planReady = deferred()
    const currentSidecar = createFakeSidecar()
    const replacementSidecar = createFakeSidecar()
    const planCreate = vi.fn(async () => {
      await planReady.promise
      return {
        sessionId: 'thread-durable-1',
        remote: { wsUrl: 'ws://127.0.0.1:46002/' },
        sidecar: replacementSidecar,
      }
    })
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      resumeSessionId: 'thread-durable-1',
      sessionBindingReason: 'association',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:46001/',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
        },
      } as any,
    })
    const [oldPty] = await spawnedPtys()

    oldPty.onExit.mock.calls[0][0]({ exitCode: 0, signal: 0 })
    currentSidecar.emitRepairTrigger({ kind: 'proxy_close' })

    await vi.waitFor(() => expect(planCreate).toHaveBeenCalled())
    expect(registry.input(record.terminalId, 'during recovery')).toEqual({
      status: 'blocked_codex_recovery_pending',
      terminalId: record.terminalId,
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(record.status).toBe('running')
    expect(exited).not.toHaveBeenCalled()

    planReady.resolve()
    await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: record.terminalId, generation: 1 }))
    expect(exited).not.toHaveBeenCalled()
  })

  it('keeps pre-durable lifecycle-loss proof running when the current PTY exits cleanly', async () => {
    const exited = vi.fn()
    registry.on('terminal.exit', exited)
    const proofReady = deferred()
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
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:46001/',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
        },
      } as any,
    })
    const latest = registry.get(record.terminalId)!
    latest.codexDurability = {
      state: 'captured_pre_turn',
      candidate: {
        candidateThreadId: 'thread-durable-1',
        rolloutPath: '/repo/.codex/sessions/rollout.jsonl',
      },
    } as any
    const proof = vi.spyOn(registry as any, 'runCodexDurabilityProof')
      .mockImplementation(async () => {
        await proofReady.promise
        const proved = registry.get(record.terminalId)
        if (!proved || proved.status !== 'running') return
        proved.resumeSessionId = 'thread-durable-1'
        proved.codexDurability = {
          ...proved.codexDurability,
          state: 'durable',
        } as any
      })
    const [oldPty] = await spawnedPtys()

    currentSidecar.emitLifecycleLoss({
      method: 'thread/status/changed',
      threadId: 'thread-durable-1',
      status: 'notLoaded',
    })
    await vi.waitFor(() => expect(proof).toHaveBeenCalledWith(record.terminalId, 'lifecycle_loss'))

    oldPty.onExit.mock.calls[0][0]({ exitCode: 0, signal: 0 })
    expect(proof).not.toHaveBeenCalledWith(record.terminalId, 'pty_exit')
    await vi.waitFor(() => expect(record.status).toBe('running'))
    expect(registry.input(record.terminalId, 'during proof')).toEqual({
      status: 'blocked_codex_lifecycle_loss_pending',
      terminalId: record.terminalId,
    })
    expect(oldPty.write).not.toHaveBeenCalledWith('during proof')
    expect(exited).not.toHaveBeenCalled()

    proofReady.resolve()
    await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: record.terminalId, generation: 1 }))
    expect(planCreate).toHaveBeenCalled()
    await vi.waitFor(() => expect(record.status).toBe('running'))
    expect(exited).not.toHaveBeenCalled()
  })

  it('coalesces duplicate pre-durable lifecycle-loss events while proof is pending', async () => {
    const proofReady = deferred()
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
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:46001/',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
        },
      } as any,
    })
    const latest = registry.get(record.terminalId)!
    latest.codexDurability = {
      state: 'captured_pre_turn',
      candidate: {
        candidateThreadId: 'thread-durable-1',
        rolloutPath: '/repo/.codex/sessions/rollout.jsonl',
      },
    } as any
    const proof = vi.spyOn(registry as any, 'runCodexDurabilityProof')
      .mockImplementation(async () => {
        await proofReady.promise
        const proved = registry.get(record.terminalId)
        if (!proved || proved.status !== 'running') return
        proved.resumeSessionId = 'thread-durable-1'
        proved.codexDurability = {
          ...proved.codexDurability,
          state: 'durable',
        } as any
      })

    currentSidecar.emitLifecycleLoss({
      method: 'thread/status/changed',
      threadId: 'thread-durable-1',
      status: 'notLoaded',
    })
    currentSidecar.emitLifecycleLoss({
      method: 'thread/status/changed',
      threadId: 'thread-durable-1',
      status: 'notLoaded',
    })

    await vi.waitFor(() => expect(proof).toHaveBeenCalledTimes(1))
    expect(registry.input(record.terminalId, 'during duplicate proof')).toEqual({
      status: 'blocked_codex_lifecycle_loss_pending',
      terminalId: record.terminalId,
    })

    proofReady.resolve()
    await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: record.terminalId, generation: 1 }))
    expect(planCreate).toHaveBeenCalled()
  })

  it('recovers a durable Codex terminal when the visible PTY exits from a signal', async () => {
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

    oldPty.onExit.mock.calls[0][0]({ exitCode: 0, signal: 15 })

    await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: record.terminalId, generation: 1 }))
    expect(planCreate).toHaveBeenCalledWith(expect.objectContaining({
      terminalId: record.terminalId,
      resumeSessionId: 'thread-durable-1',
      generation: 1,
    }))
    await vi.waitFor(() => expect(record.status).toBe('running'))
    expect(exited).not.toHaveBeenCalled()
  })

  it('blocks input during durable recovery and sends later input only to the replacement PTY', async () => {
    const planReady = deferred()
    const currentSidecar = createFakeSidecar()
    const replacementSidecar = createFakeSidecar()
    const planCreate = vi.fn(async () => {
      await planReady.promise
      return {
        sessionId: 'thread-durable-1',
        remote: { wsUrl: 'ws://127.0.0.1:46003/' },
        sidecar: replacementSidecar,
      }
    })
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
    await vi.waitFor(() => expect(planCreate).toHaveBeenCalled())

    expect(registry.input(record.terminalId, 'during recovery')).toEqual({
      status: 'blocked_codex_recovery_pending',
      terminalId: record.terminalId,
    })
    expect(oldPty.write).not.toHaveBeenCalledWith('during recovery')

    planReady.resolve()
    await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: record.terminalId, generation: 1 }))
    const [, replacementPty] = await spawnedPtys()
    await vi.waitFor(() => expect(record.status).toBe('running'))

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

    expect(record.status).toBe('exited')
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
    expect(record.status).toBe('exited')
    await vi.waitFor(() => expect(currentSidecar.shutdown).toHaveBeenCalledTimes(1))
  })

  it('runs normal PTY-exit cleanup when durable recovery is already blocked', async () => {
    const exited = vi.fn()
    registry.on('terminal.exit', exited)
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
    const [pty] = await spawnedPtys()
    record.codexRecoveryBlockedError = new Error('previous teardown failed')

    pty.onExit.mock.calls[0][0]({ exitCode: 9, signal: 0 })

    expect(planCreate).not.toHaveBeenCalled()
    expect(record.status).toBe('exited')
    expect(exited).toHaveBeenCalledWith({
      terminalId: record.terminalId,
      exitCode: 9,
      recoverableForRestore: true,
    })
  })
})
