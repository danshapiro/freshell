import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const mockPtyProcess = vi.hoisted(() => {
  const createMockPty = () => {
    const emitter = new EventEmitter()
    const pty = {
      pid: Math.floor(Math.random() * 100000) + 1000,
      cols: 120,
      rows: 30,
      process: 'mock-shell',
      handleFlowControl: false,
      autoExitOnKill: true,
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
      kill: vi.fn(() => {
        if (pty.autoExitOnKill) {
          emitter.emit('exit', { exitCode: 0 })
        }
      }),
      _emitExit: (exitCode: number, signal?: number) => emitter.emit('exit', { exitCode, signal }),
    }
    return pty
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

vi.mock('../../../server/logger', () => {
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
  return { logger }
})

import { TerminalRegistry } from '../../../server/terminal-registry.js'
import { logger } from '../../../server/logger.js'

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
  waitForLoadedThread?: () => Promise<void>
  shutdown?: () => Promise<void>
} = {}) {
  const lifecycleLossHandlers = new Set<(event: unknown) => void>()
  return {
    adopt: vi.fn(async () => undefined),
    listLoadedThreads: vi.fn(async () => ['thread-1']),
    waitForLoadedThread: vi.fn(options.waitForLoadedThread ?? (async () => undefined)),
    shutdown: vi.fn(options.shutdown ?? (async () => undefined)),
    onLifecycleLoss: vi.fn((handler: (event: unknown) => void) => {
      lifecycleLossHandlers.add(handler)
      return () => lifecycleLossHandlers.delete(handler)
    }),
    emitLifecycleLoss(event: unknown) {
      for (const handler of lifecycleLossHandlers) {
        handler(event)
      }
    },
  }
}

describe('TerminalRegistry Codex sidecar ownership', () => {
  beforeEach(() => {
    mockPtyProcess.instances = []
    vi.clearAllMocks()
  })

  it('awaits Codex sidecar teardown when killing a terminal', async () => {
    const registry = new TerminalRegistry()
    const shutdown = vi.fn(async () => undefined)
    const term = registry.create({
      mode: 'codex',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:43123',
          sidecar: { shutdown },
        },
      },
    })

    await expect(registry.killAndWait(term.terminalId)).resolves.toBe(true)

    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  it('joins current sidecar shutdown before reporting a recovery-attempt failure on final close', async () => {
    const registry = new TerminalRegistry()
    const recoveryAttempt = deferred()
    const currentShutdown = deferred()
    const currentSidecar = createFakeSidecar({
      shutdown: () => currentShutdown.promise,
    })
    const term = registry.create({
      mode: 'codex',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:43123',
          sidecar: currentSidecar,
        },
      } as any,
    })
    term.codexRecoveryAttempt = recoveryAttempt.promise

    const close = registry.killAndWait(term.terminalId)
    let closeSettled = false
    void close.then(
      () => { closeSettled = true },
      () => { closeSettled = true },
    )
    await vi.waitFor(() => expect(currentSidecar.shutdown).toHaveBeenCalledTimes(1))

    recoveryAttempt.reject(new Error('durable recovery failed during close'))
    await new Promise((resolve) => setImmediate(resolve))
    expect(closeSettled).toBe(false)

    currentShutdown.resolve()
    await expect(close).rejects.toThrow('durable recovery failed during close')
  })

  it('recovers a durable Codex terminal when its sidecar reports lifecycle loss', async () => {
    const registry = new TerminalRegistry()
    const currentSidecar = createFakeSidecar()
    const replacementSidecar = createFakeSidecar()
    const planCreate = vi.fn(async () => ({
      sessionId: 'thread-1',
      remote: { wsUrl: 'ws://127.0.0.1:43124' },
      sidecar: replacementSidecar,
    }))
    const term = registry.create({
      mode: 'codex',
      resumeSessionId: 'thread-1',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:43123',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
        },
      } as any,
    })

    expect(currentSidecar.onLifecycleLoss).toHaveBeenCalledTimes(1)
    currentSidecar.emitLifecycleLoss({ method: 'thread/status/changed', threadId: 'thread-1', status: 'notLoaded' })
    await vi.waitFor(() => expect(replacementSidecar.waitForLoadedThread).toHaveBeenCalledWith('thread-1', expect.any(Object)))

    expect(registry.get(term.terminalId)?.status).toBe('running')
    expect(planCreate).toHaveBeenCalledWith(expect.objectContaining({
      terminalId: term.terminalId,
      resumeSessionId: 'thread-1',
    }))
    expect(replacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: term.terminalId, generation: 1 })
    expect(currentSidecar.shutdown).toHaveBeenCalledTimes(1)
    expect(mockPtyProcess.instances[0].kill).toHaveBeenCalled()
    expect(mockPtyProcess.instances[1].write).toBeDefined()

    expect(registry.input(term.terminalId, 'after recovery')).toBe(true)
    expect(mockPtyProcess.instances[0].write).not.toHaveBeenCalled()
    expect(mockPtyProcess.instances[1].write).toHaveBeenCalledWith('after recovery')
  })

  it('treats lifecycle loss before initial Codex publication as a create failure instead of recovery', async () => {
    const registry = new TerminalRegistry()
    const currentSidecar = createFakeSidecar()
    const planCreate = vi.fn(async () => ({
      sessionId: 'thread-1',
      remote: { wsUrl: 'ws://127.0.0.1:43124' },
      sidecar: createFakeSidecar(),
    }))
    const term = registry.create({
      mode: 'codex',
      resumeSessionId: 'thread-1',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:43123',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
          deferLifecycleUntilPublished: true,
        },
      } as any,
    })

    currentSidecar.emitLifecycleLoss({ method: 'thread/closed', threadId: 'thread-1' })
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(planCreate).not.toHaveBeenCalled()
    expect(() => registry.publishCodexSidecar(term.terminalId)).toThrow(
      'Codex app-server reported lifecycle loss before terminal create completed.',
    )
    await expect(registry.killAndWait(term.terminalId)).resolves.toBe(true)
    expect(currentSidecar.shutdown).toHaveBeenCalledTimes(1)
  })

  it('starts durable recovery only after deferred initial Codex publication succeeds', async () => {
    const registry = new TerminalRegistry()
    const currentSidecar = createFakeSidecar()
    const replacementSidecar = createFakeSidecar()
    const planCreate = vi.fn(async () => ({
      sessionId: 'thread-1',
      remote: { wsUrl: 'ws://127.0.0.1:43124' },
      sidecar: replacementSidecar,
    }))
    const term = registry.create({
      mode: 'codex',
      resumeSessionId: 'thread-1',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:43123',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
          deferLifecycleUntilPublished: true,
        },
      } as any,
    })

    registry.publishCodexSidecar(term.terminalId)
    currentSidecar.emitLifecycleLoss({ method: 'thread/closed', threadId: 'thread-1' })
    await vi.waitFor(() => expect(replacementSidecar.waitForLoadedThread).toHaveBeenCalledWith('thread-1', expect.any(Object)))

    expect(planCreate).toHaveBeenCalledTimes(1)
  })

  it('keeps the old Codex generation current when retiring sidecar teardown fails', async () => {
    const registry = new TerminalRegistry()
    const currentSidecar = createFakeSidecar({
      shutdown: async () => {
        throw new Error('retiring sidecar teardown failed')
      },
    })
    const replacementSidecar = createFakeSidecar()
    const planCreate = vi.fn(async () => ({
      sessionId: 'thread-1',
      remote: { wsUrl: 'ws://127.0.0.1:43124' },
      sidecar: replacementSidecar,
    }))
    const term = registry.create({
      mode: 'codex',
      resumeSessionId: 'thread-1',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:43123',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
        },
      } as any,
    })

    currentSidecar.emitLifecycleLoss({ method: 'thread/closed', threadId: 'thread-1' })
    await vi.waitFor(() => expect(currentSidecar.shutdown).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(replacementSidecar.shutdown).toHaveBeenCalledTimes(1))

    expect(planCreate).toHaveBeenCalledTimes(1)
    expect(registry.input(term.terminalId, 'still old generation')).toBe(true)
    expect(mockPtyProcess.instances[0].write).toHaveBeenCalledWith('still old generation')
    expect(mockPtyProcess.instances[1].write).not.toHaveBeenCalled()
  })

  it('blocks repeated lifecycle-loss recovery after retiring sidecar teardown fails', async () => {
    const registry = new TerminalRegistry()
    const currentSidecar = createFakeSidecar({
      shutdown: async () => {
        throw new Error('retiring sidecar teardown failed')
      },
    })
    const replacementSidecar = createFakeSidecar()
    const planCreate = vi.fn(async () => ({
      sessionId: 'thread-1',
      remote: { wsUrl: 'ws://127.0.0.1:43124' },
      sidecar: replacementSidecar,
    }))
    registry.create({
      mode: 'codex',
      resumeSessionId: 'thread-1',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:43123',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
        },
      } as any,
    })

    currentSidecar.emitLifecycleLoss({ method: 'thread/closed', threadId: 'thread-1' })
    await vi.waitFor(() => expect(currentSidecar.shutdown).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(replacementSidecar.shutdown).toHaveBeenCalledTimes(1))

    currentSidecar.emitLifecycleLoss({ method: 'thread/closed', threadId: 'thread-1' })
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(planCreate).toHaveBeenCalledTimes(1)
    expect(replacementSidecar.shutdown).toHaveBeenCalledTimes(1)
  })

  it('blocks repeated lifecycle-loss recovery after candidate sidecar teardown fails', async () => {
    const registry = new TerminalRegistry()
    const currentSidecar = createFakeSidecar()
    const replacementSidecar = createFakeSidecar({
      waitForLoadedThread: async () => {
        throw new Error('candidate never became ready')
      },
      shutdown: async () => {
        throw new Error('candidate sidecar teardown failed')
      },
    })
    const planCreate = vi.fn(async () => ({
      sessionId: 'thread-1',
      remote: { wsUrl: 'ws://127.0.0.1:43124' },
      sidecar: replacementSidecar,
    }))
    registry.create({
      mode: 'codex',
      resumeSessionId: 'thread-1',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:43123',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
        },
      } as any,
    })

    currentSidecar.emitLifecycleLoss({ method: 'thread/closed', threadId: 'thread-1' })
    await vi.waitFor(() => expect(replacementSidecar.shutdown).toHaveBeenCalledTimes(1))

    currentSidecar.emitLifecycleLoss({ method: 'thread/closed', threadId: 'thread-1' })
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(planCreate).toHaveBeenCalledTimes(1)
    expect(replacementSidecar.shutdown).toHaveBeenCalledTimes(1)
  })

  it('blocks durable recovery when candidate planning fails from sidecar teardown', async () => {
    const registry = new TerminalRegistry()
    const currentSidecar = createFakeSidecar()
    const teardownError = new Error('planner-owned sidecar teardown failed') as Error & {
      codexSidecarTeardownFailed?: boolean
    }
    teardownError.codexSidecarTeardownFailed = true
    const planCreate = vi.fn(async () => {
      throw teardownError
    })
    const term = registry.create({
      mode: 'codex',
      resumeSessionId: 'thread-1',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:43123',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
        },
      } as any,
    })

    try {
      currentSidecar.emitLifecycleLoss({ method: 'thread/closed', threadId: 'thread-1' })
      await vi.waitFor(() => expect(planCreate).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(registry.get(term.terminalId)?.codexRecoveryBlockedError).toBe(teardownError))

      currentSidecar.emitLifecycleLoss({ method: 'thread/closed', threadId: 'thread-1' })
      await new Promise((resolve) => setTimeout(resolve, 25))

      expect(planCreate).toHaveBeenCalledTimes(1)
    } finally {
      await registry.killAndWait(term.terminalId).catch(() => undefined)
    }
  })

  it('keeps unpublished candidate teardown failure retryable for final close', async () => {
    const registry = new TerminalRegistry()
    const currentSidecar = createFakeSidecar()
    const candidateShutdown = vi.fn()
      .mockRejectedValueOnce(new Error('candidate verified teardown failed'))
      .mockResolvedValueOnce(undefined)
    const replacementSidecar = createFakeSidecar({
      waitForLoadedThread: async () => {
        throw new Error('candidate never became ready')
      },
      shutdown: candidateShutdown,
    })
    const planCreate = vi.fn(async () => ({
      sessionId: 'thread-1',
      remote: { wsUrl: 'ws://127.0.0.1:43124' },
      sidecar: replacementSidecar,
    }))
    const term = registry.create({
      mode: 'codex',
      resumeSessionId: 'thread-1',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:43123',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
        },
      } as any,
    })

    currentSidecar.emitLifecycleLoss({ method: 'thread/closed', threadId: 'thread-1' })
    await vi.waitFor(() => expect(replacementSidecar.shutdown).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect((registry.get(term.terminalId) as any)?.codexRecoveryAttempt).toBeUndefined())

    await expect(registry.killAndWait(term.terminalId)).resolves.toBe(true)
    await expect(registry.shutdownGracefully(1_000)).resolves.toBeUndefined()
    expect(replacementSidecar.shutdown).toHaveBeenCalledTimes(2)
  })

  it('keeps unpublished candidate teardown failure retryable for graceful shutdown', async () => {
    const registry = new TerminalRegistry()
    const currentSidecar = createFakeSidecar()
    const candidateShutdown = vi.fn()
      .mockRejectedValueOnce(new Error('candidate verified teardown failed'))
      .mockResolvedValueOnce(undefined)
    const replacementSidecar = createFakeSidecar({
      waitForLoadedThread: async () => {
        throw new Error('candidate never became ready')
      },
      shutdown: candidateShutdown,
    })
    const planCreate = vi.fn(async () => ({
      sessionId: 'thread-1',
      remote: { wsUrl: 'ws://127.0.0.1:43124' },
      sidecar: replacementSidecar,
    }))
    registry.create({
      mode: 'codex',
      resumeSessionId: 'thread-1',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:43123',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
        },
      } as any,
    })

    currentSidecar.emitLifecycleLoss({ method: 'thread/closed', threadId: 'thread-1' })
    await vi.waitFor(() => expect(replacementSidecar.shutdown).toHaveBeenCalledTimes(1))

    await expect(registry.shutdownGracefully(1_000)).resolves.toBeUndefined()
    expect(replacementSidecar.shutdown).toHaveBeenCalledTimes(2)
  })

  it('does not publish a recovery candidate whose PTY exited before readiness completed', async () => {
    const registry = new TerminalRegistry()
    const currentSidecar = createFakeSidecar()
    const readiness = deferred()
    const firstCandidate = createFakeSidecar({
      waitForLoadedThread: () => readiness.promise,
    })
    const secondCandidate = createFakeSidecar()
    const planCreate = vi.fn()
      .mockResolvedValueOnce({
        sessionId: 'thread-1',
        remote: { wsUrl: 'ws://127.0.0.1:43124' },
        sidecar: firstCandidate,
      })
      .mockResolvedValueOnce({
        sessionId: 'thread-1',
        remote: { wsUrl: 'ws://127.0.0.1:43125' },
        sidecar: secondCandidate,
      })
    const term = registry.create({
      mode: 'codex',
      resumeSessionId: 'thread-1',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:43123',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
        },
      } as any,
    })

    currentSidecar.emitLifecycleLoss({ method: 'thread/closed', threadId: 'thread-1' })
    await vi.waitFor(() => expect(firstCandidate.waitForLoadedThread).toHaveBeenCalledTimes(1))
    mockPtyProcess.instances[1]._emitExit(42)
    readiness.resolve()

    await vi.waitFor(() => expect(firstCandidate.shutdown).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(secondCandidate.adopt).toHaveBeenCalledTimes(1))

    expect(registry.get(term.terminalId)?.status).toBe('running')
    expect(planCreate).toHaveBeenCalledTimes(2)
    expect(currentSidecar.shutdown).toHaveBeenCalledTimes(1)
    expect(firstCandidate.shutdown).toHaveBeenCalledTimes(1)
    expect(registry.input(term.terminalId, 'after retry')).toBe(true)
    expect(mockPtyProcess.instances[1].write).not.toHaveBeenCalled()
    expect(mockPtyProcess.instances[2].write).toHaveBeenCalledWith('after retry')
  })

  it('publishes a ready recovery candidate even if the old PTY exits during retiring sidecar teardown', async () => {
    const registry = new TerminalRegistry()
    let oldPtyExitedDuringShutdown = false
    const currentSidecar = createFakeSidecar({
      shutdown: async () => {
        mockPtyProcess.instances[0]._emitExit(0)
        oldPtyExitedDuringShutdown = true
      },
    })
    const replacementSidecar = createFakeSidecar()
    const planCreate = vi.fn(async () => ({
      sessionId: 'thread-1',
      remote: { wsUrl: 'ws://127.0.0.1:43124' },
      sidecar: replacementSidecar,
    }))
    const term = registry.create({
      mode: 'codex',
      resumeSessionId: 'thread-1',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:43123',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
        },
      } as any,
    })

    currentSidecar.emitLifecycleLoss({ method: 'thread/closed', threadId: 'thread-1' })

    await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledTimes(1))
    expect(oldPtyExitedDuringShutdown).toBe(true)
    expect(registry.get(term.terminalId)?.status).toBe('running')
    expect(replacementSidecar.shutdown).not.toHaveBeenCalled()
    expect(registry.input(term.terminalId, 'after atomic handoff')).toBe(true)
    expect(mockPtyProcess.instances[0].write).not.toHaveBeenCalled()
    expect(mockPtyProcess.instances[1].write).toHaveBeenCalledWith('after atomic handoff')
  })

  it('waits for a failed recovery candidate to shut down before retrying', async () => {
    const registry = new TerminalRegistry()
    const currentSidecar = createFakeSidecar()
    const firstShutdown = deferred()
    const firstCandidate = createFakeSidecar({
      waitForLoadedThread: async () => {
        throw new Error('candidate not ready')
      },
      shutdown: () => firstShutdown.promise,
    })
    const secondCandidate = createFakeSidecar()
    const planCreate = vi.fn()
      .mockResolvedValueOnce({
        sessionId: 'thread-1',
        remote: { wsUrl: 'ws://127.0.0.1:43124' },
        sidecar: firstCandidate,
      })
      .mockResolvedValueOnce({
        sessionId: 'thread-1',
        remote: { wsUrl: 'ws://127.0.0.1:43125' },
        sidecar: secondCandidate,
      })
    registry.create({
      mode: 'codex',
      resumeSessionId: 'thread-1',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:43123',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
        },
      } as any,
    })

    currentSidecar.emitLifecycleLoss({ method: 'thread/closed', threadId: 'thread-1' })
    await vi.waitFor(() => expect(firstCandidate.shutdown).toHaveBeenCalledTimes(1))
    await Promise.resolve()

    expect(planCreate).toHaveBeenCalledTimes(1)
    firstShutdown.resolve()
    await vi.waitFor(() => expect(planCreate).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(secondCandidate.adopt).toHaveBeenCalled())
  })

  it('does not grow active recovery candidates across repeated readiness failures', async () => {
    const registry = new TerminalRegistry()
    const currentSidecar = createFakeSidecar()
    let activeCandidates = 0
    let maxActiveCandidates = 0
    const planCreate = vi.fn(async () => {
      const attempt = planCreate.mock.calls.length
      activeCandidates += 1
      maxActiveCandidates = Math.max(maxActiveCandidates, activeCandidates)
      return {
        sessionId: 'thread-1',
        remote: { wsUrl: `ws://127.0.0.1:${43124 + attempt}` },
        sidecar: createFakeSidecar({
          waitForLoadedThread: async () => {
            if (attempt >= 3) return
            throw new Error('candidate not ready')
          },
          shutdown: async () => {
            activeCandidates -= 1
          },
        }),
      }
    })
    const term = registry.create({
      mode: 'codex',
      resumeSessionId: 'thread-1',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:43123',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 1 },
        },
      } as any,
    })

    currentSidecar.emitLifecycleLoss({ method: 'thread/closed', threadId: 'thread-1' })
    await vi.waitFor(() => expect(planCreate.mock.calls.length).toBeGreaterThanOrEqual(3))

    expect(maxActiveCandidates).toBe(1)
    await registry.killAndWait(term.terminalId)
  })

  it('final close during a pending recovery launch prevents later recovery', async () => {
    const registry = new TerminalRegistry()
    const currentSidecar = createFakeSidecar()
    const launch = deferred<any>()
    const replacementSidecar = createFakeSidecar()
    const planCreate = vi.fn(() => launch.promise)
    const term = registry.create({
      mode: 'codex',
      resumeSessionId: 'thread-1',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:43123',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
        },
      } as any,
    })

    currentSidecar.emitLifecycleLoss({ method: 'thread/closed', threadId: 'thread-1' })
    await vi.waitFor(() => expect(planCreate).toHaveBeenCalledTimes(1))
    const close = registry.killAndWait(term.terminalId)
    launch.resolve({
      sessionId: 'thread-1',
      remote: { wsUrl: 'ws://127.0.0.1:43124' },
      sidecar: replacementSidecar,
    })
    await close

    expect(registry.get(term.terminalId)?.status).toBe('exited')
    expect(replacementSidecar.shutdown).toHaveBeenCalledTimes(1)
    expect(replacementSidecar.adopt).not.toHaveBeenCalled()
  })

  it('final close with an unpublished recovery candidate awaits candidate shutdown', async () => {
    const registry = new TerminalRegistry()
    const currentSidecar = createFakeSidecar()
    const readiness = deferred()
    const shutdown = deferred()
    const replacementSidecar = createFakeSidecar({
      waitForLoadedThread: () => readiness.promise,
      shutdown: () => shutdown.promise,
    })
    const planCreate = vi.fn(async () => ({
      sessionId: 'thread-1',
      remote: { wsUrl: 'ws://127.0.0.1:43124' },
      sidecar: replacementSidecar,
    }))
    const term = registry.create({
      mode: 'codex',
      resumeSessionId: 'thread-1',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:43123',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
        },
      } as any,
    })

    currentSidecar.emitLifecycleLoss({ method: 'thread/closed', threadId: 'thread-1' })
    await vi.waitFor(() => expect(replacementSidecar.waitForLoadedThread).toHaveBeenCalledTimes(1))
    const close = registry.killAndWait(term.terminalId)
    readiness.resolve()
    await vi.waitFor(() => expect(replacementSidecar.shutdown).toHaveBeenCalledTimes(1))

    let closed = false
    void close.then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    shutdown.resolve()
    await close
    expect(closed).toBe(true)
  })

  it('final close with a published recovery candidate awaits replacement shutdown', async () => {
    const registry = new TerminalRegistry()
    const currentSidecar = createFakeSidecar()
    const replacementShutdown = deferred()
    const replacementSidecar = createFakeSidecar({
      shutdown: () => replacementShutdown.promise,
    })
    const planCreate = vi.fn(async () => ({
      sessionId: 'thread-1',
      remote: { wsUrl: 'ws://127.0.0.1:43124' },
      sidecar: replacementSidecar,
    }))
    const term = registry.create({
      mode: 'codex',
      resumeSessionId: 'thread-1',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:43123',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
        },
      } as any,
    })

    currentSidecar.emitLifecycleLoss({ method: 'thread/closed', threadId: 'thread-1' })
    await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledTimes(1))
    const close = registry.killAndWait(term.terminalId)
    await vi.waitFor(() => expect(replacementSidecar.shutdown).toHaveBeenCalledTimes(1))

    let closed = false
    void close.then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    replacementShutdown.resolve()
    await close
    expect(closed).toBe(true)
  })

  it('awaits Codex sidecar teardown after natural PTY exit during graceful shutdown', async () => {
    const registry = new TerminalRegistry()
    let releaseShutdown: (() => void) | undefined
    const shutdownStarted = vi.fn()
    const shutdown = vi.fn(async () => {
      shutdownStarted()
      await new Promise<void>((resolve) => {
        releaseShutdown = resolve
      })
    })
    registry.create({
      mode: 'codex',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:43123',
          sidecar: { shutdown },
        },
      },
    })

    const graceful = registry.shutdownGracefully(1_000)
    mockPtyProcess.instances[0]._emitExit(0)
    await vi.waitFor(() => expect(shutdownStarted).toHaveBeenCalledTimes(1))

    let finished = false
    void graceful.then(() => {
      finished = true
    })
    await Promise.resolve()
    expect(finished).toBe(false)

    releaseShutdown?.()
    await graceful
    expect(finished).toBe(true)
  })

  it('prevents Codex lifecycle-loss recovery from starting during graceful shutdown', async () => {
    const registry = new TerminalRegistry()
    const currentSidecar = createFakeSidecar()
    const replacementSidecar = createFakeSidecar()
    const planCreate = vi.fn(async () => ({
      sessionId: 'thread-1',
      remote: { wsUrl: 'ws://127.0.0.1:43124' },
      sidecar: replacementSidecar,
    }))
    const term = registry.create({
      mode: 'codex',
      resumeSessionId: 'thread-1',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:43123',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
        },
      } as any,
    })
    mockPtyProcess.instances[0].autoExitOnKill = false

    const graceful = registry.shutdownGracefully(1_000)
    await vi.waitFor(() => expect(mockPtyProcess.instances[0].kill).toHaveBeenCalledTimes(1))
    currentSidecar.emitLifecycleLoss({ method: 'thread/status/changed', threadId: 'thread-1', status: 'notLoaded' })
    await Promise.resolve()

    expect(planCreate).not.toHaveBeenCalled()
    mockPtyProcess.instances[0]._emitExit(0)
    await graceful
    expect(registry.get(term.terminalId)?.status).toBe('exited')
  })

  it('awaits in-flight Codex sidecar teardown when no terminals are still running', async () => {
    const registry = new TerminalRegistry()
    let releaseShutdown: (() => void) | undefined
    const shutdownStarted = vi.fn()
    const shutdown = vi.fn(async () => {
      shutdownStarted()
      await new Promise<void>((resolve) => {
        releaseShutdown = resolve
      })
    })
    registry.create({
      mode: 'codex',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:43123',
          sidecar: { shutdown },
        },
      },
    })
    mockPtyProcess.instances[0]._emitExit(0)
    await vi.waitFor(() => expect(shutdownStarted).toHaveBeenCalledTimes(1))

    const graceful = registry.shutdownGracefully(1_000)
    let finished = false
    void graceful.then(() => {
      finished = true
    })
    await Promise.resolve()

    expect(finished).toBe(false)
    releaseShutdown?.()
    await graceful
    expect(finished).toBe(true)
  })

  it('awaits recovery candidate teardown for exited Codex terminals while shutting down other running terminals', async () => {
    const registry = new TerminalRegistry()
    const currentSidecar = createFakeSidecar()
    const readiness = deferred()
    const candidateShutdown = deferred()
    const replacementSidecar = createFakeSidecar({
      waitForLoadedThread: () => readiness.promise,
      shutdown: () => candidateShutdown.promise,
    })
    const planCreate = vi.fn(async () => ({
      sessionId: 'thread-1',
      remote: { wsUrl: 'ws://127.0.0.1:43124' },
      sidecar: replacementSidecar,
    }))
    const codexTerm = registry.create({
      mode: 'codex',
      resumeSessionId: 'thread-1',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:43123',
          sidecar: currentSidecar,
          recovery: { planCreate, retryDelayMs: 0 },
        },
      } as any,
    })

    currentSidecar.emitLifecycleLoss({ method: 'thread/closed', threadId: 'thread-1' })
    await vi.waitFor(() => expect(replacementSidecar.waitForLoadedThread).toHaveBeenCalledTimes(1))
    registry.kill(codexTerm.terminalId)
    readiness.resolve()
    await vi.waitFor(() => expect(replacementSidecar.shutdown).toHaveBeenCalledTimes(1))

    registry.create({ mode: 'shell' })
    const runningPty = mockPtyProcess.instances[2]
    runningPty.autoExitOnKill = false

    const graceful = registry.shutdownGracefully(1_000)
    let finished = false
    void graceful.then(() => {
      finished = true
    })
    await vi.waitFor(() => expect(runningPty.kill).toHaveBeenCalledTimes(1))
    runningPty._emitExit(0)
    await new Promise((resolve) => setImmediate(resolve))

    expect(finished).toBe(false)
    candidateShutdown.resolve()
    await graceful
    expect(finished).toBe(true)
  })

  it('observes Codex sidecar shutdown rejection after natural PTY exit and keeps it joinable for shutdown', async () => {
    const registry = new TerminalRegistry()
    const shutdownError = new Error('verified sidecar teardown failed')
    const unhandledRejection = vi.fn()
    process.once('unhandledRejection', unhandledRejection)

    const term = registry.create({
      mode: 'codex',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:43123',
          sidecar: {
            shutdown: vi.fn(async () => {
              throw shutdownError
            }),
          },
        },
      },
    })

    try {
      mockPtyProcess.instances[0]._emitExit(0)
      await vi.waitFor(() => expect(logger.error).toHaveBeenCalledWith(
        { err: shutdownError, terminalId: term.terminalId },
        'Codex sidecar shutdown failed',
      ))
      await new Promise((resolve) => setImmediate(resolve))
      expect(unhandledRejection).not.toHaveBeenCalled()
      await expect(registry.shutdownGracefully(1_000)).rejects.toThrow('verified sidecar teardown failed')
    } finally {
      process.off('unhandledRejection', unhandledRejection)
    }
  })

  it('retries a failed current sidecar shutdown on later terminal close joins', async () => {
    const registry = new TerminalRegistry()
    const shutdown = vi.fn()
      .mockRejectedValueOnce(new Error('verified sidecar teardown failed'))
      .mockResolvedValueOnce(undefined)
    const term = registry.create({
      mode: 'codex',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:43123',
          sidecar: { shutdown },
        },
      },
    })

    await expect(registry.killAndWait(term.terminalId)).rejects.toThrow('verified sidecar teardown failed')
    await expect(registry.killAndWait(term.terminalId)).resolves.toBe(true)

    expect(shutdown).toHaveBeenCalledTimes(2)
  })

  it('retries a failed natural-exit sidecar shutdown during graceful shutdown', async () => {
    const registry = new TerminalRegistry()
    const shutdown = vi.fn()
      .mockRejectedValueOnce(new Error('verified sidecar teardown failed'))
      .mockResolvedValueOnce(undefined)
    registry.create({
      mode: 'codex',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:43123',
          sidecar: { shutdown },
        },
      },
    })

    mockPtyProcess.instances[0]._emitExit(0)
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledTimes(1))

    await expect(registry.shutdownGracefully(1_000)).resolves.toBeUndefined()
    expect(shutdown).toHaveBeenCalledTimes(2)
  })

  it('exposes the inserted terminal id when terminal.created listeners throw', async () => {
    const registry = new TerminalRegistry()
    const sidecar = createFakeSidecar()
    registry.on('terminal.created', () => {
      throw new Error('terminal.created listener failed')
    })

    let createdTerminalId: string | undefined
    try {
      registry.create({
        mode: 'codex',
        providerSettings: {
          codexAppServer: {
            wsUrl: 'ws://127.0.0.1:43123',
            sidecar,
          },
        } as any,
      })
    } catch (err) {
      createdTerminalId = (err as { terminalId?: string }).terminalId
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toBe('terminal.created listener failed')
    }

    expect(createdTerminalId).toEqual(expect.any(String))
    expect(registry.get(createdTerminalId!)).not.toBeNull()
    await expect(registry.killAndWait(createdTerminalId!)).resolves.toBe(true)
    expect(sidecar.shutdown).toHaveBeenCalledTimes(1)
  })

  it('waits for every tracked Codex sidecar shutdown before reporting a graceful-shutdown failure', async () => {
    const registry = new TerminalRegistry()
    const fastFailure = new Error('fast verified sidecar teardown failed')
    const slowShutdown = deferred()
    const fastSidecar = createFakeSidecar({
      shutdown: async () => {
        throw fastFailure
      },
    })
    const slowSidecar = createFakeSidecar({
      shutdown: () => slowShutdown.promise,
    })

    registry.create({
      mode: 'codex',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:43123',
          sidecar: fastSidecar,
        },
      } as any,
    })
    registry.create({
      mode: 'codex',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:43124',
          sidecar: slowSidecar,
        },
      } as any,
    })
    mockPtyProcess.instances[0]._emitExit(0)
    mockPtyProcess.instances[1]._emitExit(0)
    await vi.waitFor(() => expect(fastSidecar.shutdown).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(slowSidecar.shutdown).toHaveBeenCalledTimes(1))

    const graceful = registry.shutdownGracefully(1_000)
    let settled = false
    void graceful.then(
      () => { settled = true },
      () => { settled = true },
    )
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)

    slowShutdown.resolve()
    await expect(graceful).rejects.toThrow('fast verified sidecar teardown failed')
  })
})
