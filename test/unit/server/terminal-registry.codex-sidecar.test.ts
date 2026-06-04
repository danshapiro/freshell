import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

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
  return { logger, sessionLifecycleLogger: logger }
})

import { TerminalRegistry } from '../../../server/terminal-registry.js'
import { CodexDurabilityStore } from '../../../server/coding-cli/codex-app-server/durability-store.js'
import { logger } from '../../../server/logger.js'
import { CODEX_DURABILITY_SCHEMA_VERSION } from '../../../shared/codex-durability.js'

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
  adopt?: () => Promise<void>
  shutdown?: () => Promise<void>
} = {}) {
  const lifecycleLossHandlers = new Set<(event: unknown) => void>()
  const candidateHandlers = new Set<(event: any) => void>()
  const turnStartedHandlers = new Set<(event: any) => void>()
  const turnCompletedHandlers = new Set<(event: any) => void>()
  const repairHandlers = new Set<(event: any) => void>()
  const fsChangedHandlers = new Set<(event: any) => void>()
  return {
    adopt: vi.fn(options.adopt ?? (async () => undefined)),
    shutdown: vi.fn(options.shutdown ?? (async () => undefined)),
    markCandidatePersisted: vi.fn(),
    watchPath: vi.fn(async (targetPath: string) => ({ path: targetPath })),
    unwatchPath: vi.fn(async () => undefined),
    onCandidate: vi.fn((handler: (event: any) => void) => {
      candidateHandlers.add(handler)
      return () => candidateHandlers.delete(handler)
    }),
    onTurnStarted: vi.fn((handler: (event: any) => void) => {
      turnStartedHandlers.add(handler)
      return () => turnStartedHandlers.delete(handler)
    }),
    onTurnCompleted: vi.fn((handler: (event: any) => void) => {
      turnCompletedHandlers.add(handler)
      return () => turnCompletedHandlers.delete(handler)
    }),
    onRepairTrigger: vi.fn((handler: (event: any) => void) => {
      repairHandlers.add(handler)
      return () => repairHandlers.delete(handler)
    }),
    onFsChanged: vi.fn((handler: (event: any) => void) => {
      fsChangedHandlers.add(handler)
      return () => fsChangedHandlers.delete(handler)
    }),
    onLifecycleLoss: vi.fn((handler: (event: unknown) => void) => {
      lifecycleLossHandlers.add(handler)
      return () => lifecycleLossHandlers.delete(handler)
    }),
    emitCandidate(event: any) {
      for (const handler of candidateHandlers) {
        handler(event)
      }
    },
    emitTurnStarted(event: any) {
      for (const handler of turnStartedHandlers) {
        handler(event)
      }
    },
    emitTurnCompleted(event: any) {
      for (const handler of turnCompletedHandlers) {
        handler(event)
      }
    },
    emitRepairTrigger(event: any) {
      for (const handler of repairHandlers) {
        handler(event)
      }
    },
    emitFsChanged(event: any) {
      for (const handler of fsChangedHandlers) {
        handler(event)
      }
    },
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

  it('persists Codex restore identity server-side before releasing fresh terminal input', async () => {
    const durabilityDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-durability-'))
    try {
      const registry = new TerminalRegistry(undefined, undefined, undefined, {
        codexDurabilityStore: new CodexDurabilityStore({ dir: durabilityDir }),
        serverInstanceId: 'srv-test',
      })
      const sidecar = createFakeSidecar()
      const term = registry.create({
        mode: 'codex',
        envContext: { tabId: 'tab-1', paneId: 'pane-1' },
        providerSettings: {
          codexAppServer: {
            wsUrl: 'ws://127.0.0.1:43123',
            sidecar,
          },
        } as any,
      })

      expect(registry.input(term.terminalId, 'hello\r')).toEqual({
        status: 'blocked_codex_identity_pending',
        terminalId: term.terminalId,
      })
      expect(mockPtyProcess.instances[0].write).not.toHaveBeenCalled()

      const sent: unknown[] = []
      const client = {
        readyState: 1,
        bufferedAmount: 0,
        send: vi.fn((message: string) => sent.push(JSON.parse(message))),
      }
      registry.attach(term.terminalId, client as any)

      sidecar.emitCandidate({
        source: 'thread_started_notification',
        thread: {
          id: '019e2a0c-7cef-7281-94df-d0d05d7b9ac3',
          path: '/home/user/.codex/sessions/2026/05/14/rollout.jsonl',
          ephemeral: false,
        },
      })

      await vi.waitFor(() => expect(sidecar.markCandidatePersisted).toHaveBeenCalledTimes(1))
      const record = registry.get(term.terminalId)!
      expect(record.codexInputGate).toBeUndefined()
      expect(record.codexDurability).toMatchObject({
        state: 'captured_pre_turn',
        candidate: {
          candidateThreadId: '019e2a0c-7cef-7281-94df-d0d05d7b9ac3',
          rolloutPath: '/home/user/.codex/sessions/2026/05/14/rollout.jsonl',
          source: 'thread_started_notification',
        },
      })

      const stored = await new CodexDurabilityStore({ dir: durabilityDir }).read(term.terminalId)
      expect(stored).toMatchObject({
        terminalId: term.terminalId,
        tabId: 'tab-1',
        paneId: 'pane-1',
        serverInstanceId: 'srv-test',
        state: 'captured_pre_turn',
        candidate: {
          candidateThreadId: '019e2a0c-7cef-7281-94df-d0d05d7b9ac3',
          rolloutPath: '/home/user/.codex/sessions/2026/05/14/rollout.jsonl',
        },
      })
      expect(sent).toContainEqual(expect.objectContaining({
        type: 'terminal.codex.durability.updated',
        terminalId: term.terminalId,
        durability: expect.objectContaining({
          state: 'captured_pre_turn',
        }),
      }))

      expect(registry.input(term.terminalId, 'hello\r')).toEqual({ status: 'written' })
      expect(mockPtyProcess.instances[0].write).toHaveBeenCalledWith('hello\r')
    } finally {
      await fsp.rm(durabilityDir, { recursive: true, force: true })
    }
  })

  it('allows only terminal startup control replies while Codex restore identity is pending', () => {
    const registry = new TerminalRegistry()
    const term = registry.create({
      mode: 'codex',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:43123',
          sidecar: createFakeSidecar(),
        },
      } as any,
    })

    for (const data of [
      '\x1b[1;1R',
      '\x1b[I',
      '\x1b[?1;2c',
      '\x1b]10;rgb:2424/2929/2f2f\x1b\\',
      '\x1b]11;rgb:ffff/ffff/ffff\x1b\\',
    ]) {
      expect(registry.input(term.terminalId, data)).toEqual({ status: 'written' })
      expect(mockPtyProcess.instances[0].write).toHaveBeenLastCalledWith(data)
    }

    expect(registry.input(term.terminalId, 'hello\r')).toEqual({
      status: 'blocked_codex_identity_pending',
      terminalId: term.terminalId,
    })
    expect(registry.input(term.terminalId, '\x1b[A')).toEqual({
      status: 'blocked_codex_identity_pending',
      terminalId: term.terminalId,
    })
  })

  it('keeps reporting the Codex identity capture timeout after closing the failed terminal', async () => {
    const registry = new TerminalRegistry()
    const sidecar = createFakeSidecar()
    const term = registry.create({
      mode: 'codex',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:43123',
          sidecar,
        },
      } as any,
    })

    sidecar.emitRepairTrigger({ kind: 'candidate_capture_timeout' })

    await vi.waitFor(() => {
      expect(registry.get(term.terminalId)?.status).toBe('exited')
    })
    expect(registry.input(term.terminalId, 'hello\r')).toEqual({
      status: 'blocked_codex_identity_capture_timeout',
      terminalId: term.terminalId,
    })
  })

  it('does not release fresh Codex input from a browser persistence acknowledgement alone', () => {
    const registry = new TerminalRegistry()
    const term = registry.create({
      mode: 'codex',
      providerSettings: {
        codexAppServer: {
          wsUrl: 'ws://127.0.0.1:43123',
          sidecar: createFakeSidecar(),
        },
      } as any,
    })

    expect(registry.acknowledgeCodexCandidatePersisted({
      terminalId: term.terminalId,
      candidateThreadId: 'thread-1',
      rolloutPath: '/home/user/.codex/sessions/rollout.jsonl',
    })).toBe('no_candidate')
    expect(registry.input(term.terminalId, 'hello\r')).toEqual({
      status: 'blocked_codex_identity_pending',
      terminalId: term.terminalId,
    })
  })

  it('emits Codex turn activity events before durability early returns', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(4_200)
    try {
      const registry = new TerminalRegistry()
      const sidecar = createFakeSidecar()
      const term = registry.create({
        mode: 'codex',
        providerSettings: {
          codexAppServer: {
            wsUrl: 'ws://127.0.0.1:43123',
            sidecar,
          },
        } as any,
      })
      const record = registry.get(term.terminalId)!
      record.resumeSessionId = 'thread-durable'
      record.codexDurability = {
        schemaVersion: CODEX_DURABILITY_SCHEMA_VERSION,
        state: 'durable',
        durableThreadId: 'thread-durable',
      }

      const turnEvents: unknown[] = []
      registry.on('codex.turn.started', (event) => turnEvents.push({ type: 'started', event }))
      registry.on('codex.turn.completed', (event) => turnEvents.push({ type: 'completed', event }))

      sidecar.emitTurnStarted({ threadId: 'thread-durable', turnId: 'turn-1', params: {} })
      sidecar.emitTurnCompleted({ threadId: 'thread-durable', turnId: 'turn-1', params: {} })

      expect(turnEvents).toEqual([
        { type: 'started', event: { terminalId: term.terminalId, at: 4_200 } },
        { type: 'completed', event: { terminalId: term.terminalId, at: 4_200 } },
      ])
      expect(record.codexDurability).toMatchObject({
        state: 'durable',
        durableThreadId: 'thread-durable',
      })
    } finally {
      now.mockRestore()
    }
  })

  it('deletes the transient Codex durability store record when the terminal is killed', async () => {
    const durabilityDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-durability-'))
    try {
      const store = new CodexDurabilityStore({ dir: durabilityDir })
      const registry = new TerminalRegistry(undefined, undefined, undefined, {
        codexDurabilityStore: store,
        serverInstanceId: 'srv-test',
      })
      const sidecar = createFakeSidecar()
      const term = registry.create({
        mode: 'codex',
        providerSettings: {
          codexAppServer: {
            wsUrl: 'ws://127.0.0.1:43123',
            sidecar,
          },
        } as any,
      })

      sidecar.emitCandidate({
        source: 'thread_start_response',
        thread: {
          id: 'thread-delete-store',
          path: path.join(durabilityDir, 'rollout.jsonl'),
          ephemeral: false,
        },
      })
      await vi.waitFor(() => expect(registry.get(term.terminalId)?.codexDurability?.state).toBe('captured_pre_turn'))
      await expect(store.read(term.terminalId)).resolves.toMatchObject({
        terminalId: term.terminalId,
        state: 'captured_pre_turn',
      })

      await registry.killAndWait(term.terminalId)

      await vi.waitFor(async () => {
        await expect(store.read(term.terminalId)).resolves.toBeUndefined()
      })
    } finally {
      await fsp.rm(durabilityDir, { recursive: true, force: true })
    }
  })

  it('marks fresh Codex non-restorable and closes it when candidate capture times out', async () => {
    const durabilityDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-durability-'))
    try {
      const registry = new TerminalRegistry(undefined, undefined, undefined, {
        codexDurabilityStore: new CodexDurabilityStore({ dir: durabilityDir }),
        serverInstanceId: 'srv-test',
      })
      const sidecar = createFakeSidecar()
      const term = registry.create({
        mode: 'codex',
        providerSettings: {
          codexAppServer: {
            wsUrl: 'ws://127.0.0.1:43123',
            sidecar,
          },
        } as any,
      })

      sidecar.emitRepairTrigger({ kind: 'candidate_capture_timeout' })

      await vi.waitFor(() => expect(registry.get(term.terminalId)?.status).toBe('exited'))
      expect(registry.get(term.terminalId)?.codexDurability).toMatchObject({
        state: 'non_restorable',
        nonRestorableReason: 'candidate_capture_timeout',
      })
      expect(registry.input(term.terminalId, 'hello\r')).toEqual({
        status: 'blocked_codex_identity_capture_timeout',
        terminalId: term.terminalId,
      })
      expect(mockPtyProcess.instances[0].kill).toHaveBeenCalledTimes(1)
    } finally {
      await fsp.rm(durabilityDir, { recursive: true, force: true })
    }
  })

  it('discards a delayed candidate write after candidate capture already timed out', async () => {
    const durabilityDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-durability-'))
    const firstCandidateWriteStarted = deferred()
    const releaseFirstCandidateWrite = deferred()
    let writeCount = 0
    const fsImpl = {
      mkdir: fsp.mkdir,
      readdir: fsp.readdir,
      readFile: fsp.readFile,
      rename: fsp.rename,
      unlink: fsp.unlink,
      writeFile: vi.fn(async (...args: Parameters<typeof fsp.writeFile>) => {
        writeCount += 1
        if (writeCount === 1) {
          firstCandidateWriteStarted.resolve()
          await releaseFirstCandidateWrite.promise
        }
        return fsp.writeFile(...args)
      }),
    }
    try {
      const store = new CodexDurabilityStore({ dir: durabilityDir, fsImpl })
      const registry = new TerminalRegistry(undefined, undefined, undefined, {
        codexDurabilityStore: store,
        serverInstanceId: 'srv-test',
      })
      const sidecar = createFakeSidecar()
      const term = registry.create({
        mode: 'codex',
        providerSettings: {
          codexAppServer: {
            wsUrl: 'ws://127.0.0.1:43123',
            sidecar,
          },
        } as any,
      })

      sidecar.emitCandidate({
        source: 'thread_start_response',
        thread: {
          id: 'thread-late-candidate',
          path: path.join(durabilityDir, 'rollout.jsonl'),
          ephemeral: false,
        },
      })
      await firstCandidateWriteStarted.promise

      sidecar.emitRepairTrigger({ kind: 'candidate_capture_timeout' })
      await vi.waitFor(() => expect(registry.get(term.terminalId)?.status).toBe('exited'))
      expect(registry.get(term.terminalId)?.codexDurability).toMatchObject({
        state: 'non_restorable',
        nonRestorableReason: 'candidate_capture_timeout',
      })

      releaseFirstCandidateWrite.resolve()

      await vi.waitFor(() => {
        expect(registry.get(term.terminalId)?.codexDurability).toMatchObject({
          state: 'non_restorable',
          nonRestorableReason: 'candidate_capture_timeout',
        })
      })
      await vi.waitFor(async () => {
        await expect(store.read(term.terminalId)).resolves.toBeUndefined()
      })
      expect(sidecar.markCandidatePersisted).not.toHaveBeenCalled()
    } finally {
      releaseFirstCandidateWrite.resolve()
      await fsp.rm(durabilityDir, { recursive: true, force: true })
    }
  })

  it('serializes per-terminal Codex candidate persistence so the first deterministic candidate wins', async () => {
    const durabilityDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-durability-'))
    const firstCandidateWriteStarted = deferred()
    const releaseFirstCandidateWrite = deferred()
    class StoreWithDelayedFirstCandidateWrite extends CodexDurabilityStore {
      readonly writeThreadIds: string[] = []

      override async write(...args: Parameters<CodexDurabilityStore['write']>) {
        const threadId = args[0].candidate?.candidateThreadId
        if (threadId) this.writeThreadIds.push(threadId)
        if (threadId === 'thread-first') {
          firstCandidateWriteStarted.resolve()
          await releaseFirstCandidateWrite.promise
        }
        return super.write(...args)
      }
    }

    try {
      const store = new StoreWithDelayedFirstCandidateWrite({ dir: durabilityDir })
      const registry = new TerminalRegistry(undefined, undefined, undefined, {
        codexDurabilityStore: store,
        serverInstanceId: 'srv-test',
      })
      const sidecar = createFakeSidecar()
      const term = registry.create({
        mode: 'codex',
        providerSettings: {
          codexAppServer: {
            wsUrl: 'ws://127.0.0.1:43123',
            sidecar,
          },
        } as any,
      })

      sidecar.emitCandidate({
        source: 'thread_start_response',
        thread: {
          id: 'thread-first',
          path: path.join(durabilityDir, 'first-rollout.jsonl'),
          ephemeral: false,
        },
      })
      await firstCandidateWriteStarted.promise

      sidecar.emitCandidate({
        source: 'thread_start_response',
        thread: {
          id: 'thread-second',
          path: path.join(durabilityDir, 'second-rollout.jsonl'),
          ephemeral: false,
        },
      })
      await Promise.resolve()
      expect(store.writeThreadIds).toEqual(['thread-first'])

      releaseFirstCandidateWrite.resolve()

      await vi.waitFor(() => expect(registry.get(term.terminalId)?.codexDurability?.candidate?.candidateThreadId).toBe('thread-first'))
      await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          terminalId: term.terminalId,
          existingThreadId: 'thread-first',
          candidateThreadId: 'thread-second',
        }),
        'Ignoring mismatched Codex restore identity candidate after one was already persisted',
      ))
      await expect(store.read(term.terminalId)).resolves.toMatchObject({
        candidate: {
          candidateThreadId: 'thread-first',
          rolloutPath: path.join(durabilityDir, 'first-rollout.jsonl'),
        },
      })
      expect(store.writeThreadIds).toEqual(['thread-first'])
      expect(sidecar.markCandidatePersisted).toHaveBeenCalledTimes(1)
    } finally {
      releaseFirstCandidateWrite.resolve()
      await fsp.rm(durabilityDir, { recursive: true, force: true })
    }
  })

  it('closes the terminal when candidate persistence fails before user input', async () => {
    const durabilityDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-durability-'))
    class StoreWithFirstWriteFailure extends CodexDurabilityStore {
      private writeCount = 0

      override async write(...args: Parameters<CodexDurabilityStore['write']>) {
        this.writeCount += 1
        if (this.writeCount === 1) {
          throw new Error('candidate write failed')
        }
        return super.write(...args)
      }
    }

    try {
      const registry = new TerminalRegistry(undefined, undefined, undefined, {
        codexDurabilityStore: new StoreWithFirstWriteFailure({ dir: durabilityDir }),
        serverInstanceId: 'srv-test',
      })
      const sidecar = createFakeSidecar()
      const term = registry.create({
        mode: 'codex',
        providerSettings: {
          codexAppServer: {
            wsUrl: 'ws://127.0.0.1:43123',
            sidecar,
          },
        } as any,
      })

      sidecar.emitCandidate({
        source: 'thread_start_response',
        thread: {
          id: 'thread-write-failed',
          path: path.join(durabilityDir, 'rollout.jsonl'),
          ephemeral: false,
        },
      })

      await vi.waitFor(() => expect(registry.get(term.terminalId)?.codexDurability).toMatchObject({
        state: 'non_restorable',
        nonRestorableReason: 'candidate_persist_failed',
      }))
      await vi.waitFor(() => expect(registry.get(term.terminalId)?.status).toBe('exited'))
      expect(registry.input(term.terminalId, 'hello\r')).toEqual({
        status: 'blocked_codex_identity_unavailable',
        terminalId: term.terminalId,
        reason: 'candidate_persist_failed',
      })
      expect(mockPtyProcess.instances[0].write).not.toHaveBeenCalled()
    } finally {
      await fsp.rm(durabilityDir, { recursive: true, force: true })
    }
  })

  it('promotes Codex to canonical session identity after turn completion rollout proof succeeds', async () => {
    const durabilityDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-durability-'))
    try {
      const rolloutPath = path.join(durabilityDir, 'rollout.jsonl')
      const registry = new TerminalRegistry(undefined, undefined, undefined, {
        codexDurabilityStore: new CodexDurabilityStore({ dir: durabilityDir }),
        serverInstanceId: 'srv-test',
      })
      const sidecar = createFakeSidecar()
      const term = registry.create({
        mode: 'codex',
        providerSettings: {
          codexAppServer: {
            wsUrl: 'ws://127.0.0.1:43123',
            sidecar,
          },
        } as any,
      })
      const sent: unknown[] = []
      const client = {
        readyState: 1,
        bufferedAmount: 0,
        send: vi.fn((message: string) => sent.push(JSON.parse(message))),
      }
      registry.attach(term.terminalId, client as any)

      sidecar.emitCandidate({
        source: 'thread_start_response',
        thread: {
          id: 'thread-proof-ok',
          path: rolloutPath,
          ephemeral: false,
        },
      })
      await vi.waitFor(() => expect(registry.get(term.terminalId)?.codexDurability?.state).toBe('captured_pre_turn'))
      await fsp.writeFile(
        rolloutPath,
        '{"type":"session_meta","payload":{"id":"thread-proof-ok"}}\n',
        'utf8',
      )
      sidecar.emitTurnStarted({ threadId: 'thread-proof-ok', turnId: 'turn-1', params: {} })
      await vi.waitFor(() => expect(registry.get(term.terminalId)?.codexDurability?.state).toBe('turn_in_progress_unproven'))
      sidecar.emitTurnCompleted({ threadId: 'thread-proof-ok', turnId: 'turn-1', params: {} })

      await vi.waitFor(() => expect(registry.get(term.terminalId)?.resumeSessionId).toBe('thread-proof-ok'))
      expect(registry.get(term.terminalId)?.codexDurability).toMatchObject({
        state: 'durable',
        durableThreadId: 'thread-proof-ok',
      })
      expect(sent).toContainEqual(expect.objectContaining({
        type: 'terminal.session.associated',
        terminalId: term.terminalId,
        sessionRef: {
          provider: 'codex',
          sessionId: 'thread-proof-ok',
        },
      }))
    } finally {
      await fsp.rm(durabilityDir, { recursive: true, force: true })
    }
  })

  it('persists and broadcasts durable Codex identity promoted from create-time proof', async () => {
    const durabilityDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-durability-'))
    try {
      const rolloutPath = path.join(durabilityDir, 'rollout.jsonl')
      const store = new CodexDurabilityStore({ dir: durabilityDir })
      const registry = new TerminalRegistry(undefined, undefined, undefined, {
        codexDurabilityStore: store,
        serverInstanceId: 'srv-test',
      })
      const sidecar = createFakeSidecar()
      const term = registry.create({
        mode: 'codex',
        envContext: { tabId: 'tab-create-proof', paneId: 'pane-create-proof' },
        providerSettings: {
          codexAppServer: {
            wsUrl: 'ws://127.0.0.1:43123',
            sidecar,
          },
        } as any,
      })
      const sent: unknown[] = []
      const client = {
        readyState: 1,
        bufferedAmount: 0,
        send: vi.fn((message: string) => sent.push(JSON.parse(message))),
      }
      registry.attach(term.terminalId, client as any)

      sidecar.emitCandidate({
        source: 'thread_start_response',
        thread: {
          id: 'thread-create-candidate',
          path: rolloutPath,
          ephemeral: false,
        },
      })
      await vi.waitFor(() => expect(registry.get(term.terminalId)?.codexDurability?.state).toBe('captured_pre_turn'))

      await expect(registry.promoteCodexDurabilityFromCreateProof(
        term.terminalId,
        'thread-create-durable',
        12345,
      )).resolves.toEqual({
        ok: true,
        terminalId: term.terminalId,
        sessionId: 'thread-create-durable',
      })

      expect(registry.get(term.terminalId)?.resumeSessionId).toBe('thread-create-durable')
      expect(registry.get(term.terminalId)?.codexDurability).toMatchObject({
        state: 'durable',
        durableThreadId: 'thread-create-durable',
        candidate: {
          candidateThreadId: 'thread-create-candidate',
          rolloutPath,
        },
      })
      await expect(store.read(term.terminalId)).resolves.toMatchObject({
        terminalId: term.terminalId,
        tabId: 'tab-create-proof',
        paneId: 'pane-create-proof',
        serverInstanceId: 'srv-test',
        state: 'durable',
        durableThreadId: 'thread-create-durable',
        candidate: {
          candidateThreadId: 'thread-create-candidate',
          rolloutPath,
        },
        updatedAt: 12345,
      })
      expect(sent).toContainEqual(expect.objectContaining({
        type: 'terminal.codex.durability.updated',
        terminalId: term.terminalId,
        durability: expect.objectContaining({
          state: 'durable',
          durableThreadId: 'thread-create-durable',
        }),
      }))
    } finally {
      await fsp.rm(durabilityDir, { recursive: true, force: true })
    }
  })

  it('uses the bindSession result when promoting create-time Codex durability', async () => {
    const durabilityDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-durability-'))
    try {
      const store = new CodexDurabilityStore({ dir: durabilityDir })
      const registry = new TerminalRegistry(undefined, undefined, undefined, {
        codexDurabilityStore: store,
        serverInstanceId: 'srv-test',
      })
      const term = registry.create({
        mode: 'codex',
        providerSettings: {
          codexAppServer: {
            wsUrl: 'ws://127.0.0.1:43123',
            sidecar: createFakeSidecar(),
          },
        } as any,
      })
      vi.spyOn(registry, 'bindSession').mockImplementation((terminalId) => {
        registry.get(terminalId)!.resumeSessionId = 'stale-side-effect'
        return { ok: true, terminalId, sessionId: 'thread-create-durable' }
      })

      await expect(registry.promoteCodexDurabilityFromCreateProof(
        term.terminalId,
        'thread-create-durable',
        67890,
      )).resolves.toEqual({
        ok: true,
        terminalId: term.terminalId,
        sessionId: 'thread-create-durable',
      })

      expect(registry.get(term.terminalId)?.codexDurability).toMatchObject({
        state: 'durable',
        durableThreadId: 'thread-create-durable',
      })
      expect(registry.get(term.terminalId)?.resumeSessionId).toBe('thread-create-durable')
      await expect(store.read(term.terminalId)).resolves.toMatchObject({
        state: 'durable',
        durableThreadId: 'thread-create-durable',
        updatedAt: 67890,
      })
    } finally {
      await fsp.rm(durabilityDir, { recursive: true, force: true })
    }
  })

  it('does not broadcast a durable Codex session when rollout proof cannot bind canonical ownership', async () => {
    const durabilityDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-durability-'))
    try {
      const rolloutPath = path.join(durabilityDir, 'rollout.jsonl')
      const registry = new TerminalRegistry(undefined, undefined, undefined, {
        codexDurabilityStore: new CodexDurabilityStore({ dir: durabilityDir }),
        serverInstanceId: 'srv-test',
      })
      const owner = registry.create({
        mode: 'codex',
        resumeSessionId: 'thread-binding-owner',
      })
      const sidecar = createFakeSidecar()
      const term = registry.create({
        mode: 'codex',
        providerSettings: {
          codexAppServer: {
            wsUrl: 'ws://127.0.0.1:43123',
            sidecar,
          },
        } as any,
      })
      const sent: unknown[] = []
      const client = {
        readyState: 1,
        bufferedAmount: 0,
        send: vi.fn((message: string) => sent.push(JSON.parse(message))),
      }
      registry.attach(term.terminalId, client as any)

      sidecar.emitCandidate({
        source: 'thread_start_response',
        thread: {
          id: 'thread-binding-owner',
          path: rolloutPath,
          ephemeral: false,
        },
      })
      await vi.waitFor(() => expect(registry.get(term.terminalId)?.codexDurability?.state).toBe('captured_pre_turn'))
      await fsp.writeFile(
        rolloutPath,
        '{"type":"session_meta","payload":{"id":"thread-binding-owner"}}\n',
        'utf8',
      )
      sidecar.emitTurnCompleted({ threadId: 'thread-binding-owner', turnId: 'turn-1', params: {} })

      await vi.waitFor(() => expect(registry.get(term.terminalId)?.codexDurability).toMatchObject({
        state: 'non_restorable',
        nonRestorableReason: 'session_binding_failed:session_already_owned',
      }))
      await vi.waitFor(() => expect(registry.get(term.terminalId)?.status).toBe('exited'))
      expect(registry.get(term.terminalId)?.resumeSessionId).toBeUndefined()
      expect(registry.findRunningTerminalBySession('codex', 'thread-binding-owner')?.terminalId).toBe(owner.terminalId)
      expect(registry.input(term.terminalId, 'hello\r')).toEqual({
        status: 'blocked_codex_identity_unavailable',
        terminalId: term.terminalId,
        reason: 'session_binding_failed:session_already_owned',
      })
      expect(sent).not.toContainEqual(expect.objectContaining({
        type: 'terminal.session.associated',
      }))
      expect(mockPtyProcess.instances.at(-1)?.kill).toHaveBeenCalledTimes(1)
    } finally {
      await fsp.rm(durabilityDir, { recursive: true, force: true })
    }
  })

  it('does not promote Codex from repair triggers before a turn completes', async () => {
    const durabilityDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-durability-'))
    try {
      const rolloutPath = path.join(durabilityDir, 'rollout.jsonl')
      const registry = new TerminalRegistry(undefined, undefined, undefined, {
        codexDurabilityStore: new CodexDurabilityStore({ dir: durabilityDir }),
        serverInstanceId: 'srv-test',
      })
      const sidecar = createFakeSidecar()
      const term = registry.create({
        mode: 'codex',
        providerSettings: {
          codexAppServer: {
            wsUrl: 'ws://127.0.0.1:43123',
            sidecar,
          },
        } as any,
      })
      const sent: unknown[] = []
      const client = {
        readyState: 1,
        bufferedAmount: 0,
        send: vi.fn((message: string) => sent.push(JSON.parse(message))),
      }
      registry.attach(term.terminalId, client as any)

      sidecar.emitCandidate({
        source: 'thread_start_response',
        thread: {
          id: 'thread-repair-pre-turn',
          path: rolloutPath,
          ephemeral: false,
        },
      })
      await vi.waitFor(() => expect(registry.get(term.terminalId)?.codexDurability?.state).toBe('captured_pre_turn'))
      await fsp.writeFile(
        rolloutPath,
        '{"type":"session_meta","payload":{"id":"thread-repair-pre-turn"}}\n',
        'utf8',
      )

      sidecar.emitRepairTrigger({ kind: 'fs_changed' })
      await new Promise((resolve) => setImmediate(resolve))

      expect(registry.get(term.terminalId)?.resumeSessionId).toBeUndefined()
      expect(registry.get(term.terminalId)?.codexDurability).toMatchObject({
        state: 'captured_pre_turn',
        candidate: {
          candidateThreadId: 'thread-repair-pre-turn',
        },
      })
      expect(sent).not.toContainEqual(expect.objectContaining({
        type: 'terminal.session.associated',
      }))

      sidecar.emitTurnCompleted({ threadId: 'thread-repair-pre-turn', turnId: 'turn-1', params: {} })
      await vi.waitFor(() => expect(registry.get(term.terminalId)?.resumeSessionId).toBe('thread-repair-pre-turn'))
    } finally {
      await fsp.rm(durabilityDir, { recursive: true, force: true })
    }
  })

  it('runs a final rollout proof before marking a fresh Codex PTY exit non-restorable', async () => {
    const durabilityDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-durability-'))
    try {
      const rolloutPath = path.join(durabilityDir, 'rollout.jsonl')
      const registry = new TerminalRegistry(undefined, undefined, undefined, {
        codexDurabilityStore: new CodexDurabilityStore({ dir: durabilityDir }),
        serverInstanceId: 'srv-test',
      })
      const sidecar = createFakeSidecar()
      const term = registry.create({
        mode: 'codex',
        providerSettings: {
          codexAppServer: {
            wsUrl: 'ws://127.0.0.1:43123',
            sidecar,
          },
        } as any,
      })
      const sent: unknown[] = []
      const client = {
        readyState: 1,
        bufferedAmount: 0,
        send: vi.fn((message: string) => sent.push(JSON.parse(message))),
      }
      registry.attach(term.terminalId, client as any)

      sidecar.emitCandidate({
        source: 'thread_start_response',
        thread: {
          id: 'thread-final-proof',
          path: rolloutPath,
          ephemeral: false,
        },
      })
      await vi.waitFor(() => expect(registry.get(term.terminalId)?.codexDurability?.state).toBe('captured_pre_turn'))
      await fsp.writeFile(
        rolloutPath,
        '{"type":"session_meta","payload":{"id":"thread-final-proof"}}\n',
        'utf8',
      )

      mockPtyProcess.instances[0]._emitExit(137)

      await vi.waitFor(() => expect(registry.get(term.terminalId)?.status).toBe('exited'))
      expect(registry.get(term.terminalId)?.codexDurability).toMatchObject({
        state: 'durable',
        durableThreadId: 'thread-final-proof',
      })
      expect(sent).toContainEqual(expect.objectContaining({
        type: 'terminal.session.associated',
        terminalId: term.terminalId,
        sessionRef: {
          provider: 'codex',
          sessionId: 'thread-final-proof',
        },
      }))
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'terminal_exit_without_durable_session',
          terminalId: term.terminalId,
        }),
        'terminal_exit_without_durable_session',
      )
    } finally {
      await fsp.rm(durabilityDir, { recursive: true, force: true })
    }
  })

  it('runs a final rollout proof before deciding lifecycle loss cannot recover a fresh Codex terminal', async () => {
    const durabilityDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-durability-'))
    try {
      const rolloutPath = path.join(durabilityDir, 'rollout.jsonl')
      const replacementSidecar = createFakeSidecar()
      const planCreate = vi.fn(async () => ({
        sessionId: 'thread-final-recovery',
        remote: { wsUrl: 'ws://127.0.0.1:43124' },
        sidecar: replacementSidecar,
      }))
      const registry = new TerminalRegistry(undefined, undefined, undefined, {
        codexDurabilityStore: new CodexDurabilityStore({ dir: durabilityDir }),
        serverInstanceId: 'srv-test',
      })
      const currentSidecar = createFakeSidecar()
      const term = registry.create({
        mode: 'codex',
        providerSettings: {
          codexAppServer: {
            wsUrl: 'ws://127.0.0.1:43123',
            sidecar: currentSidecar,
            recovery: { planCreate, retryDelayMs: 0 },
          },
        } as any,
      })

      currentSidecar.emitCandidate({
        source: 'thread_start_response',
        thread: {
          id: 'thread-final-recovery',
          path: rolloutPath,
          ephemeral: false,
        },
      })
      await vi.waitFor(() => expect(registry.get(term.terminalId)?.codexDurability?.state).toBe('captured_pre_turn'))
      await fsp.writeFile(
        rolloutPath,
        '{"type":"session_meta","payload":{"id":"thread-final-recovery"}}\n',
        'utf8',
      )

      currentSidecar.emitLifecycleLoss({ method: 'thread/closed' })

      await vi.waitFor(() => expect(planCreate).toHaveBeenCalledWith(expect.objectContaining({
        terminalId: term.terminalId,
        resumeSessionId: 'thread-final-recovery',
      })))
      await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: term.terminalId, generation: 1 }))
      expect(registry.get(term.terminalId)?.codexDurability).toMatchObject({
        state: 'durable',
        durableThreadId: 'thread-final-recovery',
      })
    } finally {
      await fsp.rm(durabilityDir, { recursive: true, force: true })
    }
  })

  it('marks Codex degraded after turn completion rollout proof fails', async () => {
    const durabilityDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-durability-'))
    try {
      const rolloutPath = path.join(durabilityDir, 'missing-rollout.jsonl')
      const registry = new TerminalRegistry(undefined, undefined, undefined, {
        codexDurabilityStore: new CodexDurabilityStore({ dir: durabilityDir }),
        serverInstanceId: 'srv-test',
      })
      const sidecar = createFakeSidecar()
      const term = registry.create({
        mode: 'codex',
        providerSettings: {
          codexAppServer: {
            wsUrl: 'ws://127.0.0.1:43123',
            sidecar,
          },
        } as any,
      })
      const sent: unknown[] = []
      const client = {
        readyState: 1,
        bufferedAmount: 0,
        send: vi.fn((message: string) => sent.push(JSON.parse(message))),
      }
      registry.attach(term.terminalId, client as any)

      sidecar.emitCandidate({
        source: 'thread_start_response',
        thread: {
          id: 'thread-proof-missing',
          path: rolloutPath,
          ephemeral: false,
        },
      })
      await vi.waitFor(() => expect(registry.get(term.terminalId)?.codexDurability?.state).toBe('captured_pre_turn'))
      sidecar.emitTurnCompleted({ threadId: 'thread-proof-missing', turnId: 'turn-1', params: {} })

      await vi.waitFor(() => expect(registry.get(term.terminalId)?.codexDurability?.state).toBe('durability_unproven_after_completion'))
      expect(registry.get(term.terminalId)?.resumeSessionId).toBeUndefined()
      expect(registry.get(term.terminalId)?.codexDurability?.lastProofFailure).toMatchObject({
        reason: 'missing',
      })
      expect(sent).not.toContainEqual(expect.objectContaining({
        type: 'terminal.session.associated',
      }))
    } finally {
      await fsp.rm(durabilityDir, { recursive: true, force: true })
    }
  })

  it('uses exact rollout watch changes as a one-shot repair trigger after proof failure', async () => {
    const durabilityDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-durability-'))
    try {
      const rolloutPath = path.join(durabilityDir, 'late-rollout.jsonl')
      const registry = new TerminalRegistry(undefined, undefined, undefined, {
        codexDurabilityStore: new CodexDurabilityStore({ dir: durabilityDir }),
        serverInstanceId: 'srv-test',
      })
      const sidecar = createFakeSidecar()
      const term = registry.create({
        mode: 'codex',
        providerSettings: {
          codexAppServer: {
            wsUrl: 'ws://127.0.0.1:43123',
            sidecar,
          },
        } as any,
      })

      sidecar.emitCandidate({
        source: 'thread_start_response',
        thread: {
          id: 'thread-late-proof',
          path: rolloutPath,
          ephemeral: false,
        },
      })
      await vi.waitFor(() => expect(registry.get(term.terminalId)?.codexDurability?.state).toBe('captured_pre_turn'))
      await vi.waitFor(() => expect(sidecar.watchPath).toHaveBeenCalledWith(rolloutPath, expect.any(String)))
      const watchId = sidecar.watchPath.mock.calls[0][1]

      sidecar.emitTurnCompleted({ threadId: 'thread-late-proof', turnId: 'turn-1', params: {} })
      await vi.waitFor(() => expect(registry.get(term.terminalId)?.codexDurability?.state).toBe('durability_unproven_after_completion'))

      await fsp.writeFile(
        rolloutPath,
        '{"type":"session_meta","payload":{"id":"thread-late-proof"}}\n',
        'utf8',
      )
      sidecar.emitFsChanged({ watchId, changedPaths: [rolloutPath] })

      await vi.waitFor(() => expect(registry.get(term.terminalId)?.codexDurability).toMatchObject({
        state: 'durable',
        durableThreadId: 'thread-late-proof',
      }))
      expect(sidecar.unwatchPath).toHaveBeenCalledWith(watchId)
    } finally {
      await fsp.rm(durabilityDir, { recursive: true, force: true })
    }
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
    await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: term.terminalId, generation: 1 }))

    expect(registry.get(term.terminalId)?.status).toBe('running')
    expect(planCreate).toHaveBeenCalledWith(expect.objectContaining({
      terminalId: term.terminalId,
      resumeSessionId: 'thread-1',
    }))
    expect(replacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: term.terminalId, generation: 1 })
    expect(currentSidecar.shutdown).toHaveBeenCalledTimes(1)
    expect(mockPtyProcess.instances[0].kill).toHaveBeenCalledWith('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(mockPtyProcess.instances[0].kill).toHaveBeenCalledTimes(1)
    expect(mockPtyProcess.instances[1].write).toBeDefined()

    expect(registry.input(term.terminalId, 'after recovery')).toEqual({ status: 'written' })
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

  it('treats proxy repair triggers before initial Codex publication as a create failure instead of recovery', async () => {
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

    currentSidecar.emitRepairTrigger({ kind: 'proxy_close' })
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(planCreate).not.toHaveBeenCalled()
    expect(() => registry.publishCodexSidecar(term.terminalId)).toThrow(
      'Codex app-server reported lifecycle loss before terminal create completed.',
    )
    await expect(registry.killAndWait(term.terminalId)).resolves.toBe(true)
    expect(currentSidecar.shutdown).toHaveBeenCalledTimes(1)
  })

  it('treats a clean PTY exit before initial Codex publication as a create failure instead of recovery', async () => {
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

    mockPtyProcess.instances[0]._emitExit(0)
    await vi.waitFor(() => expect(registry.get(term.terminalId)?.status).toBe('exited'))

    expect(planCreate).not.toHaveBeenCalled()
    expect(() => registry.publishCodexSidecar(term.terminalId)).toThrow(
      'Codex terminal PTY exited before create completed.',
    )
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
    await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledWith({ terminalId: term.terminalId, generation: 1 }))

    expect(planCreate).toHaveBeenCalledTimes(1)
  })

  it('closes the Codex terminal when retiring sidecar teardown blocks recovery', async () => {
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
    await vi.waitFor(() => expect(currentSidecar.shutdown).toHaveBeenCalled())
    await vi.waitFor(() => expect(replacementSidecar.shutdown).toHaveBeenCalledTimes(1))

    expect(planCreate).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(registry.get(term.terminalId)?.status).toBe('exited'))
    expect(registry.input(term.terminalId, 'still old generation')).toEqual({ status: 'not_running' })
    expect(mockPtyProcess.instances[0].write).not.toHaveBeenCalledWith('still old generation')
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
    await vi.waitFor(() => expect(currentSidecar.shutdown).toHaveBeenCalled())
    await vi.waitFor(() => expect(replacementSidecar.shutdown).toHaveBeenCalledTimes(1))
    const currentShutdownCalls = currentSidecar.shutdown.mock.calls.length

    currentSidecar.emitLifecycleLoss({ method: 'thread/closed', threadId: 'thread-1' })
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(planCreate).toHaveBeenCalledTimes(1)
    expect(currentSidecar.shutdown).toHaveBeenCalledTimes(currentShutdownCalls)
    expect(replacementSidecar.shutdown).toHaveBeenCalledTimes(1)
  })

  it('blocks repeated lifecycle-loss recovery after candidate sidecar teardown fails', async () => {
    const registry = new TerminalRegistry()
    const currentSidecar = createFakeSidecar()
    const replacementSidecar = createFakeSidecar({
      adopt: async () => {
        mockPtyProcess.instances[1]._emitExit(42)
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

  it('closes a Codex terminal when lifecycle-loss durable recovery becomes blocked', async () => {
    const registry = new TerminalRegistry()
    const exited = vi.fn()
    registry.on('terminal.exit', exited)
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
    mockPtyProcess.instances[0].autoExitOnKill = false

    currentSidecar.emitLifecycleLoss({ method: 'thread/closed', threadId: 'thread-1' })

    await vi.waitFor(() => expect(registry.get(term.terminalId)?.codexRecoveryBlockedError).toBe(teardownError))
    await vi.waitFor(() => expect(registry.get(term.terminalId)?.status).toBe('exited'))
    expect(planCreate).toHaveBeenCalledTimes(1)
    expect(exited).toHaveBeenCalledWith({ terminalId: term.terminalId, exitCode: 0 })
  })

  it('keeps unpublished candidate teardown failure retryable for final close', async () => {
    const registry = new TerminalRegistry()
    const currentSidecar = createFakeSidecar()
    const candidateShutdown = vi.fn()
      .mockRejectedValueOnce(new Error('candidate verified teardown failed'))
      .mockResolvedValueOnce(undefined)
    const replacementSidecar = createFakeSidecar({
      adopt: async () => {
        mockPtyProcess.instances[1]._emitExit(42)
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
      adopt: async () => {
        mockPtyProcess.instances[1]._emitExit(42)
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

  it('does not publish a recovery candidate whose PTY exited before publication', async () => {
    const registry = new TerminalRegistry()
    const currentSidecar = createFakeSidecar()
    const firstCandidate = createFakeSidecar({
      adopt: async () => {
        mockPtyProcess.instances[1]._emitExit(42)
      },
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

    await vi.waitFor(() => expect(firstCandidate.shutdown).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(secondCandidate.adopt).toHaveBeenCalledTimes(1))

    expect(registry.get(term.terminalId)?.status).toBe('running')
    expect(planCreate).toHaveBeenCalledTimes(2)
    expect(currentSidecar.shutdown).toHaveBeenCalledTimes(1)
    expect(firstCandidate.shutdown).toHaveBeenCalledTimes(1)
    expect(registry.input(term.terminalId, 'after retry')).toEqual({ status: 'written' })
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
    expect(registry.input(term.terminalId, 'after atomic handoff')).toEqual({ status: 'written' })
    expect(mockPtyProcess.instances[0].write).not.toHaveBeenCalled()
    expect(mockPtyProcess.instances[1].write).toHaveBeenCalledWith('after atomic handoff')
  })

  it('deletes Codex durability store records when a published recovery PTY exits finally', async () => {
    const durabilityDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-durability-'))
    try {
      const store = new CodexDurabilityStore({ dir: durabilityDir })
      const registry = new TerminalRegistry(undefined, undefined, undefined, {
        codexDurabilityStore: store,
        serverInstanceId: 'srv-test',
      })
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
      await store.write({
        schemaVersion: CODEX_DURABILITY_SCHEMA_VERSION,
        terminalId: term.terminalId,
        serverInstanceId: 'srv-test',
        state: 'durable',
        durableThreadId: 'thread-1',
        updatedAt: 123,
      })

      currentSidecar.emitLifecycleLoss({ method: 'thread/closed', threadId: 'thread-1' })
      await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledTimes(1))
      const replacementPty = mockPtyProcess.instances[1]
      expect(registry.get(term.terminalId)?.pty).toBe(replacementPty)

      registry.get(term.terminalId)!.codexRecovery = undefined
      replacementPty._emitExit(17)

      await vi.waitFor(() => expect(registry.get(term.terminalId)?.status).toBe('exited'))
      await vi.waitFor(async () => {
        await expect(store.read(term.terminalId)).resolves.toBeUndefined()
      })
    } finally {
      await fsp.rm(durabilityDir, { recursive: true, force: true })
    }
  })

  it('waits for a failed recovery candidate to shut down before retrying', async () => {
    const registry = new TerminalRegistry()
    const currentSidecar = createFakeSidecar()
    const firstShutdown = deferred()
    const firstCandidate = createFakeSidecar({
      adopt: async () => {
        mockPtyProcess.instances[1]._emitExit(42)
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

  it('does not grow active recovery candidates across repeated recovery candidate exits', async () => {
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
          adopt: async () => {
            if (attempt < 3) {
              mockPtyProcess.instances[attempt]._emitExit(42)
            }
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
    const adopt = deferred()
    const shutdown = deferred()
    const replacementSidecar = createFakeSidecar({
      adopt: () => adopt.promise,
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
    await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledTimes(1))
    const close = registry.killAndWait(term.terminalId)
    adopt.resolve()
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
    const adopt = deferred()
    const candidateShutdown = deferred()
    const replacementSidecar = createFakeSidecar({
      adopt: () => adopt.promise,
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
    await vi.waitFor(() => expect(replacementSidecar.adopt).toHaveBeenCalledTimes(1))
    registry.kill(codexTerm.terminalId)
    adopt.resolve()
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
