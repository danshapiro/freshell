import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { TerminalRegistry } from '../../../server/terminal-registry.js'
import { TerminalStreamBroker } from '../../../server/terminal-stream/broker.js'
import type { CodexThreadLifecycleEvent } from '../../../server/coding-cli/codex-app-server/client.js'

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
  return { logger }
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

async function lastPty(): Promise<MockPty> {
  const pty = await import('node-pty')
  return vi.mocked(pty.spawn).mock.results.at(-1)?.value as MockPty
}

async function spawnedPtys(): Promise<MockPty[]> {
  const pty = await import('node-pty')
  return vi.mocked(pty.spawn).mock.results.map((result) => result.value as MockPty)
}

async function loggerWarnCalls(): Promise<Array<[Record<string, any>, string]>> {
  const { logger } = await import('../../../server/logger.js')
  return vi.mocked(logger.warn).mock.calls as Array<[Record<string, any>, string]>
}

function createMockWs(connectionId: string) {
  return {
    bufferedAmount: 0,
    readyState: WebSocket.OPEN,
    send: vi.fn(),
    close: vi.fn(),
    connectionId,
  }
}

function sentPayloads(ws: ReturnType<typeof createMockWs>) {
  return ws.send.mock.calls
    .map(([raw]) => (typeof raw === 'string' ? JSON.parse(raw) : raw))
    .filter((payload): payload is Record<string, any> => !!payload && typeof payload === 'object')
}

type MockSidecarAttachment = {
  terminalId: string
  onDurableSession: (sessionId: string) => void
  onThreadLifecycle: (event: CodexThreadLifecycleEvent) => void
  onFatal: (error: Error, source?: 'sidecar_fatal' | 'app_server_exit' | 'app_server_client_disconnect') => void
}

function createMockSidecar(options: { onAttach?: (attachment: MockSidecarAttachment) => void } = {}) {
  let attachment: MockSidecarAttachment | undefined
  return {
    api: {
      attachTerminal: vi.fn((next: MockSidecarAttachment) => {
        attachment = next
        options.onAttach?.(next)
      }),
      shutdown: vi.fn().mockResolvedValue(undefined),
    },
    emitDurableSession(sessionId: string) {
      attachment?.onDurableSession(sessionId)
    },
    emitLifecycle(event: CodexThreadLifecycleEvent) {
      attachment?.onThreadLifecycle(event)
    },
    emitFatal(
      error = new Error('fake sidecar fatal'),
      source: 'sidecar_fatal' | 'app_server_exit' | 'app_server_client_disconnect' = 'sidecar_fatal',
    ) {
      attachment?.onFatal(error, source)
    },
  }
}

describe('TerminalRegistry Codex recovery generation guards', () => {
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

  it('ignores stale generation PTY data and exit without mutating stable output or final state', async () => {
    const record = registry.create({ mode: 'codex', cwd: '/repo' })
    const mockPty = await lastPty()
    const onData = mockPty.onData.mock.calls[0][0]
    const onExit = mockPty.onExit.mock.calls[0][0]
    record.codex!.workerGeneration = 2

    onData('stale output')
    onExit({ exitCode: 9, signal: 0 })

    expect(record.buffer.snapshot()).toBe('')
    expect(record.status).toBe('running')
  })

  it('ignores recovery-retire generation output and exit', async () => {
    const record = registry.create({ mode: 'codex', cwd: '/repo' })
    const mockPty = await lastPty()
    const onData = mockPty.onData.mock.calls[0][0]
    const onExit = mockPty.onExit.mock.calls[0][0]
    record.codex!.retiringGenerations.add(1)
    record.codex!.closeReasonByGeneration.set(1, 'recovery_retire')

    onData('retired output')
    onExit({ exitCode: 9, signal: 0 })

    expect(record.buffer.snapshot()).toBe('')
    expect(record.status).toBe('running')
  })

  it('treats explicit user final close as final and emits terminal.exit', async () => {
    const exited = vi.fn()
    registry.on('terminal.exit', exited)
    const record = registry.create({ mode: 'codex', cwd: '/repo' })

    registry.kill(record.terminalId)

    expect(record.codex!.closeReasonByGeneration.get(1)).toBe('user_final_close')
    expect(record.status).toBe('exited')
    expect(exited).toHaveBeenCalledWith({ terminalId: record.terminalId, exitCode: 0 })
  })

  it('treats in-TUI PTY exit for a durable Codex session as recoverable, not final', async () => {
    const exited = vi.fn()
    registry.on('terminal.exit', exited)
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      resumeSessionId: 'thread-durable-1',
    })
    const mockPty = await lastPty()
    const onExit = mockPty.onExit.mock.calls[0][0]

    onExit({ exitCode: 0, signal: 0 })

    expect(record.status).toBe('running')
    expect(record.codex!.recoveryState).toBe('recovering_durable')
    expect(record.codex!.durableSessionId).toBe('thread-durable-1')
    expect(exited).not.toHaveBeenCalled()
  })

  it('initializes durable Codex state from an explicit resume session id', () => {
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      resumeSessionId: 'thread-durable-1',
    })

    expect(record.codex?.durableSessionId).toBe('thread-durable-1')
    expect(record.codex?.recoveryState).toBe('running_durable')
    expect(record.resumeSessionId).toBe('thread-durable-1')
  })

  it('keeps non-Codex PTY exit final', async () => {
    const exited = vi.fn()
    registry.on('terminal.exit', exited)
    const record = registry.create({ mode: 'shell', cwd: '/repo' })
    const mockPty = await lastPty()
    const onExit = mockPty.onExit.mock.calls[0][0]

    onExit({ exitCode: 3, signal: 0 })

    expect(record.status).toBe('exited')
    expect(exited).toHaveBeenCalledWith({ terminalId: record.terminalId, exitCode: 3 })
  })

  it('replaces a durable Codex worker bundle after PTY exit without finalizing the terminal', async () => {
    const exited = vi.fn()
    const status = vi.fn()
    registry.on('terminal.exit', exited)
    registry.on('terminal.status', status)
    const initialSidecar = createMockSidecar()
    const replacementSidecar = createMockSidecar()
    const launchFactory = vi.fn().mockResolvedValue({
      sessionId: 'thread-durable-1',
      remote: { wsUrl: 'ws://127.0.0.1:46002/' },
      sidecar: replacementSidecar.api,
    })
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      resumeSessionId: 'thread-durable-1',
      providerSettings: {
        codexAppServer: { wsUrl: 'ws://127.0.0.1:46001/' },
        model: 'codex-test',
      },
      codexSidecar: initialSidecar.api,
      codexLaunchFactory: launchFactory,
      envContext: { tabId: 'tab-1', paneId: 'pane-1' },
    })
    const oldPty = await lastPty()
    const onExit = oldPty.onExit.mock.calls[0][0]

    onExit({ exitCode: 0, signal: 0 })

    await vi.waitFor(() => expect(launchFactory).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(record.codex?.workerGeneration).toBe(2))
    const allPtys = await spawnedPtys()
    const replacementPty = allPtys.at(-1)!
    const replacementSpawnArgs = (await import('node-pty')).spawn.mock.calls.at(-1)?.[1] as string[]

    expect(record.status).toBe('running')
    expect(record.terminalId).toBeDefined()
    expect(record.codex?.durableSessionId).toBe('thread-durable-1')
    expect(record.codex?.recoveryState).toBe('recovering_durable')
    expect(record.codex?.retiringGenerations.has(1)).toBe(true)
    expect(initialSidecar.api.shutdown).toHaveBeenCalledTimes(1)
    expect(oldPty.kill).toHaveBeenCalledTimes(1)
    expect(record.pty).toBe(replacementPty)
    expect(launchFactory).toHaveBeenCalledWith(expect.objectContaining({
      terminalId: record.terminalId,
      cwd: '/repo',
      resumeSessionId: 'thread-durable-1',
      envContext: { tabId: 'tab-1', paneId: 'pane-1' },
      providerSettings: expect.objectContaining({ model: 'codex-test' }),
    }))
    expect(replacementSpawnArgs).toEqual(expect.arrayContaining([
      '--remote',
      'ws://127.0.0.1:46002/',
      'resume',
      'thread-durable-1',
    ]))
    expect(status).toHaveBeenCalledWith(expect.objectContaining({
      terminalId: record.terminalId,
      status: 'recovering',
      attempt: 1,
    }))
    expect(exited).not.toHaveBeenCalled()
  })

  it('coalesces duplicate current-generation failure signals into one replacement attempt', async () => {
    const initialSidecar = createMockSidecar()
    const replacementSidecar = createMockSidecar()
    const launchFactory = vi.fn().mockResolvedValue({
      sessionId: 'thread-durable-1',
      remote: { wsUrl: 'ws://127.0.0.1:46003/' },
      sidecar: replacementSidecar.api,
    })
    registry.create({
      mode: 'codex',
      cwd: '/repo',
      resumeSessionId: 'thread-durable-1',
      codexSidecar: initialSidecar.api,
      codexLaunchFactory: launchFactory,
    })
    const oldPty = await lastPty()

    initialSidecar.emitFatal()
    oldPty.onExit.mock.calls[0][0]({ exitCode: 1, signal: 0 })
    oldPty.onData.mock.calls[0][0]('late retired output')

    await vi.waitFor(() => expect(launchFactory).toHaveBeenCalledTimes(1))
  })

  it('flushes recovery-buffered input only after current-generation durable readiness proof', async () => {
    const initialSidecar = createMockSidecar()
    const replacementSidecar = createMockSidecar()
    const launchFactory = vi.fn().mockResolvedValue({
      sessionId: 'thread-durable-1',
      remote: { wsUrl: 'ws://127.0.0.1:46004/' },
      sidecar: replacementSidecar.api,
    })
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      resumeSessionId: 'thread-durable-1',
      codexSidecar: initialSidecar.api,
      codexLaunchFactory: launchFactory,
    })
    const oldPty = await lastPty()
    oldPty.onExit.mock.calls[0][0]({ exitCode: 1, signal: 0 })
    await vi.waitFor(() => expect(record.codex?.workerGeneration).toBe(2))
    const replacementPty = await lastPty()
    expect(record.pty).toBe(replacementPty)
    expect(record.codex?.recoveryState).toBe('recovering_durable')

    expect(registry.input(record.terminalId, 'abc')).toBe(true)
    replacementPty.onData.mock.calls[0][0]('process output before proof')
    expect(oldPty.write).not.toHaveBeenCalledWith('abc')
    expect(replacementPty.write).not.toHaveBeenCalledWith('abc')

    replacementSidecar.emitLifecycle({
      kind: 'thread_started',
      thread: {
        id: 'thread-durable-1',
        path: '/tmp/rollout-thread-durable-1.jsonl',
        ephemeral: false,
      },
    })

    await vi.waitFor(() => expect(record.codex?.recoveryState).toBe('running_durable'))
    expect(replacementPty.write).toHaveBeenCalledWith('abc')
  })

  it('logs recovery transition context with websocket URLs and process identifiers when known', async () => {
    const initialSidecar = createMockSidecar()
    const replacementSidecar = createMockSidecar()
    const launchFactory = vi.fn().mockResolvedValue({
      sessionId: 'thread-durable-1',
      remote: { wsUrl: 'ws://127.0.0.1:46028/', processPid: 45678 },
      sidecar: replacementSidecar.api,
    })
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      resumeSessionId: 'thread-durable-1',
      providerSettings: {
        codexAppServer: { wsUrl: 'ws://127.0.0.1:46027/' },
      },
      codexSidecar: initialSidecar.api,
      codexLaunchFactory: launchFactory,
    })
    const oldPty = await lastPty()

    oldPty.onExit.mock.calls[0][0]({ exitCode: 1, signal: 0 })
    await vi.waitFor(() => expect(record.codex?.workerGeneration).toBe(2))
    replacementSidecar.emitLifecycle({
      kind: 'thread_started',
      thread: {
        id: 'thread-durable-1',
        path: '/tmp/rollout-thread-durable-1.jsonl',
        ephemeral: false,
      },
    })
    await vi.waitFor(() => expect(record.codex?.recoveryState).toBe('running_durable'))

    const warns = await loggerWarnCalls()
    const started = warns.find(([, message]) => message === 'codex_recovery_started')?.[0]
    const ready = warns.find(([, message]) => message === 'codex_recovery_ready')?.[0]

    expect(started).toEqual(expect.objectContaining({
      terminalId: record.terminalId,
      oldWsUrl: 'ws://127.0.0.1:46027/',
      oldPtyPid: 12345,
      source: 'pty_exit',
      generation: 1,
      candidateGeneration: 2,
      attempt: 1,
      hasDurableSession: true,
    }))
    expect(ready).toEqual(expect.objectContaining({
      terminalId: record.terminalId,
      oldWsUrl: 'ws://127.0.0.1:46027/',
      newWsUrl: 'ws://127.0.0.1:46028/',
      oldPtyPid: 12345,
      newPtyPid: 12345,
      newAppServerPid: 45678,
      generation: 2,
      attempt: 1,
      hasDurableSession: true,
    }))
  })

  it('applies latest resize to durable replacement PTY before flushing buffered input', async () => {
    const initialSidecar = createMockSidecar()
    const replacementSidecar = createMockSidecar()
    const launchFactory = vi.fn().mockResolvedValue({
      sessionId: 'thread-durable-1',
      remote: { wsUrl: 'ws://127.0.0.1:46026/' },
      sidecar: replacementSidecar.api,
    })
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      cols: 80,
      rows: 24,
      resumeSessionId: 'thread-durable-1',
      codexSidecar: initialSidecar.api,
      codexLaunchFactory: launchFactory,
    })
    const oldPty = await lastPty()
    oldPty.onExit.mock.calls[0][0]({ exitCode: 1, signal: 0 })
    await vi.waitFor(() => expect(record.codex?.workerGeneration).toBe(2))
    const replacementPty = await lastPty()

    expect(registry.input(record.terminalId, 'abc')).toBe(true)
    expect(registry.resize(record.terminalId, 132, 41)).toBe(true)
    expect(record.cols).toBe(132)
    expect(record.rows).toBe(41)
    expect(replacementPty.write).not.toHaveBeenCalledWith('abc')

    replacementSidecar.emitLifecycle({
      kind: 'thread_started',
      thread: {
        id: 'thread-durable-1',
        path: '/tmp/rollout-thread-durable-1.jsonl',
        ephemeral: false,
      },
    })

    await vi.waitFor(() => expect(record.codex?.recoveryState).toBe('running_durable'))
    expect(replacementPty.resize).toHaveBeenCalledWith(132, 41)
    expect(replacementPty.write).toHaveBeenCalledWith('abc')
    expect(replacementPty.resize.mock.invocationCallOrder[0])
      .toBeLessThan(replacementPty.write.mock.invocationCallOrder[0])
  })

  it('fails a published durable replacement candidate immediately when its PTY exits before readiness', async () => {
    const initialSidecar = createMockSidecar()
    const firstReplacementSidecar = createMockSidecar()
    const secondReplacementSidecar = createMockSidecar()
    const launchFactory = vi.fn()
      .mockResolvedValueOnce({
        sessionId: 'thread-durable-1',
        remote: { wsUrl: 'ws://127.0.0.1:46020/' },
        sidecar: firstReplacementSidecar.api,
      })
      .mockResolvedValueOnce({
        sessionId: 'thread-durable-1',
        remote: { wsUrl: 'ws://127.0.0.1:46021/' },
        sidecar: secondReplacementSidecar.api,
      })
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      resumeSessionId: 'thread-durable-1',
      codexSidecar: initialSidecar.api,
      codexLaunchFactory: launchFactory,
    })
    const oldPty = await lastPty()
    oldPty.onExit.mock.calls[0][0]({ exitCode: 1, signal: 0 })
    await vi.waitFor(() => expect(record.codex?.workerGeneration).toBe(2))
    const firstReplacementPty = await lastPty()

    firstReplacementPty.onExit.mock.calls[0][0]({ exitCode: 2, signal: 0 })

    await vi.waitFor(() => expect(record.codex?.activeReplacement?.attempt).toBe(2), 600)
    await vi.waitFor(() => expect(launchFactory).toHaveBeenCalledTimes(2), 600)
    expect(record.codex?.recoveryState).toBe('recovering_durable')
    expect(firstReplacementSidecar.api.shutdown).toHaveBeenCalledTimes(1)
    expect(firstReplacementPty.kill).toHaveBeenCalledTimes(1)
  })

  it('fails a published durable replacement candidate immediately when fatal PTY output arrives before readiness', async () => {
    const initialSidecar = createMockSidecar()
    const firstReplacementSidecar = createMockSidecar()
    const secondReplacementSidecar = createMockSidecar()
    const launchFactory = vi.fn()
      .mockResolvedValueOnce({
        sessionId: 'thread-durable-1',
        remote: { wsUrl: 'ws://127.0.0.1:46022/' },
        sidecar: firstReplacementSidecar.api,
      })
      .mockResolvedValueOnce({
        sessionId: 'thread-durable-1',
        remote: { wsUrl: 'ws://127.0.0.1:46023/' },
        sidecar: secondReplacementSidecar.api,
      })
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      resumeSessionId: 'thread-durable-1',
      codexSidecar: initialSidecar.api,
      codexLaunchFactory: launchFactory,
    })
    const oldPty = await lastPty()
    oldPty.onExit.mock.calls[0][0]({ exitCode: 1, signal: 0 })
    await vi.waitFor(() => expect(record.codex?.workerGeneration).toBe(2))
    const firstReplacementPty = await lastPty()

    firstReplacementPty.onData.mock.calls[0][0](
      'ERROR: remote app server at `ws://127.0.0.1:46022/` transport failed: WebSocket protocol error: Connection reset without closing handshake',
    )

    await vi.waitFor(() => expect(record.codex?.activeReplacement?.attempt).toBe(2), 600)
    await vi.waitFor(() => expect(launchFactory).toHaveBeenCalledTimes(2), 600)
    expect(record.codex?.recoveryState).toBe('recovering_durable')
    expect(record.buffer.snapshot()).toContain('Connection reset without closing handshake')
    expect(firstReplacementSidecar.api.shutdown).toHaveBeenCalledTimes(1)
  })

  it('does not let a dead pre-durable replacement candidate pass the stability window', async () => {
    const initialSidecar = createMockSidecar()
    const firstReplacementSidecar = createMockSidecar()
    const secondReplacementSidecar = createMockSidecar()
    const launchFactory = vi.fn()
      .mockResolvedValueOnce({
        remote: { wsUrl: 'ws://127.0.0.1:46024/' },
        sidecar: firstReplacementSidecar.api,
      })
      .mockResolvedValueOnce({
        remote: { wsUrl: 'ws://127.0.0.1:46025/' },
        sidecar: secondReplacementSidecar.api,
      })
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      codexSidecar: initialSidecar.api,
      codexLaunchFactory: launchFactory,
    })
    const oldPty = await lastPty()
    oldPty.onExit.mock.calls[0][0]({ exitCode: 1, signal: 0 })
    await vi.waitFor(() => expect(record.codex?.workerGeneration).toBe(2))
    const firstReplacementPty = await lastPty()
    expect(registry.input(record.terminalId, 'pre-dead')).toBe(true)

    firstReplacementPty.onExit.mock.calls[0][0]({ exitCode: 2, signal: 0 })

    await new Promise((resolve) => setTimeout(resolve, 1_650))
    expect(record.codex?.recoveryState).toBe('recovering_pre_durable')
    expect(firstReplacementPty.write).not.toHaveBeenCalledWith('pre-dead')
    expect(launchFactory).toHaveBeenCalledTimes(2)
  })

  it('does not accept a current-generation non-ready durable status change as recovery readiness proof', async () => {
    const initialSidecar = createMockSidecar()
    const replacementSidecar = createMockSidecar()
    const launchFactory = vi.fn().mockResolvedValue({
      sessionId: 'thread-durable-1',
      remote: { wsUrl: 'ws://127.0.0.1:46014/' },
      sidecar: replacementSidecar.api,
    })
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      resumeSessionId: 'thread-durable-1',
      codexSidecar: initialSidecar.api,
      codexLaunchFactory: launchFactory,
    })
    const oldPty = await lastPty()
    oldPty.onExit.mock.calls[0][0]({ exitCode: 1, signal: 0 })
    await vi.waitFor(() => expect(record.codex?.workerGeneration).toBe(2))
    const replacementPty = await lastPty()

    expect(registry.input(record.terminalId, 'abc')).toBe(true)
    replacementSidecar.emitLifecycle({
      kind: 'thread_status_changed',
      threadId: 'thread-durable-1',
      status: { type: 'active' },
    })

    await Promise.resolve()
    expect(record.codex?.recoveryState).toBe('recovering_durable')
    expect(replacementPty.write).not.toHaveBeenCalledWith('abc')
  })

  it('accepts current-generation durable idle status as recovery readiness proof', async () => {
    const initialSidecar = createMockSidecar()
    const replacementSidecar = createMockSidecar()
    const launchFactory = vi.fn().mockResolvedValue({
      sessionId: 'thread-durable-1',
      remote: { wsUrl: 'ws://127.0.0.1:46016/' },
      sidecar: replacementSidecar.api,
    })
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      resumeSessionId: 'thread-durable-1',
      codexSidecar: initialSidecar.api,
      codexLaunchFactory: launchFactory,
    })
    const oldPty = await lastPty()
    oldPty.onExit.mock.calls[0][0]({ exitCode: 1, signal: 0 })
    await vi.waitFor(() => expect(record.codex?.workerGeneration).toBe(2))
    const replacementPty = await lastPty()

    expect(registry.input(record.terminalId, 'abc')).toBe(true)
    replacementSidecar.emitLifecycle({
      kind: 'thread_status_changed',
      threadId: 'thread-durable-1',
      status: { type: 'idle' },
    })

    await vi.waitFor(() => expect(record.codex?.recoveryState).toBe('running_durable'))
    expect(replacementPty.write).toHaveBeenCalledWith('abc')
  })

  it('still accepts current-generation durable thread-started as recovery readiness proof', async () => {
    const initialSidecar = createMockSidecar()
    const replacementSidecar = createMockSidecar()
    const launchFactory = vi.fn().mockResolvedValue({
      sessionId: 'thread-durable-1',
      remote: { wsUrl: 'ws://127.0.0.1:46017/' },
      sidecar: replacementSidecar.api,
    })
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      resumeSessionId: 'thread-durable-1',
      codexSidecar: initialSidecar.api,
      codexLaunchFactory: launchFactory,
    })
    const oldPty = await lastPty()
    oldPty.onExit.mock.calls[0][0]({ exitCode: 1, signal: 0 })
    await vi.waitFor(() => expect(record.codex?.workerGeneration).toBe(2))
    const replacementPty = await lastPty()

    expect(registry.input(record.terminalId, 'abc')).toBe(true)

    replacementSidecar.emitLifecycle({
      kind: 'thread_started',
      thread: {
        id: 'thread-durable-1',
        path: '/tmp/rollout-thread-durable-1.jsonl',
        ephemeral: false,
      },
    })

    await vi.waitFor(() => expect(record.codex?.recoveryState).toBe('running_durable'))
    expect(replacementPty.write).toHaveBeenCalledWith('abc')
  })

  it('handles recovery_failed input locally instead of reporting a missing terminal', async () => {
    const output = vi.fn()
    registry.on('terminal.output.raw', output)
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      resumeSessionId: 'thread-durable-1',
    })
    record.codex!.recoveryState = 'recovery_failed'

    expect(registry.input(record.terminalId, 'abc')).toBe(true)

    expect(record.buffer.snapshot()).toContain('Codex recovery failed')
    expect(output).toHaveBeenCalledWith(expect.objectContaining({
      terminalId: record.terminalId,
      data: expect.stringContaining('Codex recovery failed'),
    }))
  })

  it('handles recovery input overflow locally so ws-handler does not see an invalid terminal', async () => {
    const output = vi.fn()
    registry.on('terminal.output.raw', output)
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      resumeSessionId: 'thread-durable-1',
    })
    const pty = await lastPty()
    record.codex!.recoveryState = 'recovering_durable'

    expect(registry.input(record.terminalId, 'x'.repeat(8 * 1024))).toBe(true)
    expect(registry.input(record.terminalId, 'y')).toBe(true)

    expect(pty.write).not.toHaveBeenCalled()
    expect(record.buffer.snapshot()).toContain('Codex is reconnecting; input was not sent')
    expect(output).toHaveBeenCalledWith(expect.objectContaining({
      terminalId: record.terminalId,
      data: expect.stringContaining('Codex is reconnecting; input was not sent'),
    }))
  })

  it('queues local recovery diagnostics behind a pending attach snapshot', async () => {
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      resumeSessionId: 'thread-durable-1',
    })
    record.codex!.recoveryState = 'recovering_durable'
    const client = createMockWs('pending-local-diagnostic')

    expect(registry.attach(record.terminalId, client as any, { pendingSnapshot: true })).toBe(record)
    expect(registry.input(record.terminalId, 'x'.repeat(8 * 1024))).toBe(true)
    expect(registry.input(record.terminalId, 'y')).toBe(true)

    expect(sentPayloads(client).some((payload) =>
      payload.type === 'terminal.output'
      && payload.terminalId === record.terminalId
      && String(payload.data).includes('Codex is reconnecting; input was not sent'),
    )).toBe(false)

    registry.finishAttachSnapshot(record.terminalId, client as any)

    expect(sentPayloads(client).some((payload) =>
      payload.type === 'terminal.output'
      && payload.terminalId === record.terminalId
      && String(payload.data).includes('Codex is reconnecting; input was not sent'),
    )).toBe(true)
  })

  it('handles recovery input expiry locally so ws-handler does not see an invalid terminal', async () => {
    vi.useFakeTimers()
    const output = vi.fn()
    registry.on('terminal.output.raw', output)
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      resumeSessionId: 'thread-durable-1',
    })
    const pty = await lastPty()
    record.codex!.recoveryState = 'recovering_durable'

    expect(registry.input(record.terminalId, 'first')).toBe(true)
    vi.advanceTimersByTime(10_001)
    expect(registry.input(record.terminalId, 'second')).toBe(true)

    expect(pty.write).not.toHaveBeenCalled()
    expect(record.buffer.snapshot()).toContain('Codex is reconnecting; input was not sent')
    expect(output).toHaveBeenCalledWith(expect.objectContaining({
      terminalId: record.terminalId,
      data: expect.stringContaining('Codex is reconnecting; input was not sent'),
    }))
  })

  it('expires recovery-buffered input on the ttl even when no later input or readiness arrives', async () => {
    vi.useFakeTimers()
    const output = vi.fn()
    registry.on('terminal.output.raw', output)
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      resumeSessionId: 'thread-durable-1',
    })
    const pty = await lastPty()
    record.codex!.recoveryState = 'recovering_durable'

    expect(registry.input(record.terminalId, 'first')).toBe(true)
    vi.advanceTimersByTime(10_001)

    expect(pty.write).not.toHaveBeenCalled()
    expect(record.buffer.snapshot()).toContain('Codex is reconnecting; input was not sent')
    expect(output).toHaveBeenCalledWith(expect.objectContaining({
      terminalId: record.terminalId,
      data: expect.stringContaining('Codex is reconnecting; input was not sent'),
    }))
  })

  it('reports expired buffered input through local output when durable recovery becomes ready', async () => {
    vi.useFakeTimers()
    const output = vi.fn()
    registry.on('terminal.output.raw', output)
    const initialSidecar = createMockSidecar()
    const replacementSidecar = createMockSidecar()
    const launchFactory = vi.fn().mockResolvedValue({
      sessionId: 'thread-durable-1',
      remote: { wsUrl: 'ws://127.0.0.1:46027/' },
      sidecar: replacementSidecar.api,
    })
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      resumeSessionId: 'thread-durable-1',
      codexSidecar: initialSidecar.api,
      codexLaunchFactory: launchFactory,
    })
    const oldPty = await lastPty()
    oldPty.onExit.mock.calls[0][0]({ exitCode: 1, signal: 0 })
    await vi.waitFor(() => expect(record.codex?.workerGeneration).toBe(2))
    const replacementPty = await lastPty()

    expect(registry.input(record.terminalId, 'too-late')).toBe(true)
    vi.advanceTimersByTime(10_001)
    replacementSidecar.emitLifecycle({
      kind: 'thread_started',
      thread: {
        id: 'thread-durable-1',
        path: '/tmp/rollout-thread-durable-1.jsonl',
        ephemeral: false,
      },
    })

    await vi.waitFor(() => expect(record.codex?.recoveryState).toBe('running_durable'))
    expect(replacementPty.write).not.toHaveBeenCalledWith('too-late')
    expect(record.buffer.snapshot()).toContain('Codex is reconnecting; input was not sent')
    expect(output).toHaveBeenCalledWith(expect.objectContaining({
      terminalId: record.terminalId,
      data: expect.stringContaining('Codex is reconnecting; input was not sent'),
    }))
  })

  it('replays local recovery diagnostics through the terminal stream broker after detach and reattach', async () => {
    const broker = new TerminalStreamBroker(registry, vi.fn())
    try {
      const record = registry.create({
        mode: 'codex',
        cwd: '/repo',
        resumeSessionId: 'thread-durable-1',
      })
      record.codex!.recoveryState = 'recovering_durable'

      const liveWs = createMockWs('live-recovery-diagnostic')
      await broker.attach(liveWs as any, record.terminalId, 'viewport_hydrate', 120, 40, 0, 'live-attach')
      expect(registry.input(record.terminalId, 'x'.repeat(8 * 1024))).toBe(true)
      expect(registry.input(record.terminalId, 'y')).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 5))

      expect(sentPayloads(liveWs).some((payload) =>
        payload.type === 'terminal.output'
        && payload.terminalId === record.terminalId
        && String(payload.data).includes('Codex is reconnecting; input was not sent'),
      )).toBe(true)

      broker.detach(record.terminalId, liveWs as any)
      const replayWs = createMockWs('replay-recovery-diagnostic')
      await broker.attach(replayWs as any, record.terminalId, 'transport_reconnect', 120, 40, 0, 'replay-attach')

      const replayed = sentPayloads(replayWs)
      expect(replayed.some((payload) =>
        payload.type === 'terminal.attach.ready'
        && payload.terminalId === record.terminalId
        && payload.attachRequestId === 'replay-attach',
      )).toBe(true)
      expect(replayed.some((payload) =>
        payload.type === 'terminal.output'
        && payload.terminalId === record.terminalId
        && payload.attachRequestId === 'replay-attach'
        && String(payload.data).includes('Codex is reconnecting; input was not sent'),
      )).toBe(true)
    } finally {
      broker.close()
    }
  })

  it('makes pre-durable recovery live only after the attach-stability window and then flushes input', async () => {
    const initialSidecar = createMockSidecar()
    const replacementSidecar = createMockSidecar()
    const status = vi.fn()
    registry.on('terminal.status', status)
    const launchFactory = vi.fn().mockResolvedValue({
      remote: { wsUrl: 'ws://127.0.0.1:46005/' },
      sidecar: replacementSidecar.api,
    })
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      codexSidecar: initialSidecar.api,
      codexLaunchFactory: launchFactory,
    })
    const oldPty = await lastPty()
    oldPty.onExit.mock.calls[0][0]({ exitCode: 1, signal: 0 })

    await vi.waitFor(() => expect(record.codex?.workerGeneration).toBe(2))
    const replacementPty = await lastPty()
    expect(record.codex?.recoveryState).toBe('recovering_pre_durable')
    expect(registry.input(record.terminalId, 'pre')).toBe(true)
    expect(replacementPty.write).not.toHaveBeenCalledWith('pre')

    await vi.waitFor(() => expect(record.codex?.recoveryState).toBe('running_live_only'), 2_000)
    expect(replacementPty.write).toHaveBeenCalledWith('pre')
    expect(status).toHaveBeenCalledWith(expect.objectContaining({
      terminalId: record.terminalId,
      status: 'running',
    }))
  })

  it('cancels pre-durable stability when durable promotion arrives before the window elapses', async () => {
    const initialSidecar = createMockSidecar()
    const replacementSidecar = createMockSidecar()
    const launchFactory = vi.fn().mockResolvedValue({
      remote: { wsUrl: 'ws://127.0.0.1:46015/' },
      sidecar: replacementSidecar.api,
    })
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      codexSidecar: initialSidecar.api,
      codexLaunchFactory: launchFactory,
    })
    const oldPty = await lastPty()
    oldPty.onExit.mock.calls[0][0]({ exitCode: 1, signal: 0 })
    await vi.waitFor(() => expect(record.codex?.workerGeneration).toBe(2))
    const replacementPty = await lastPty()
    expect(registry.input(record.terminalId, 'late-durable')).toBe(true)

    replacementSidecar.emitDurableSession('thread-durable-late')
    await vi.waitFor(() => expect(record.codex?.recoveryState).toBe('recovering_durable'))

    await new Promise((resolve) => setTimeout(resolve, 1_600))
    expect(record.codex?.recoveryState).toBe('recovering_durable')
    expect(replacementPty.write).not.toHaveBeenCalledWith('late-durable')

    replacementSidecar.emitLifecycle({
      kind: 'thread_started',
      thread: {
        id: 'thread-durable-late',
        path: '/tmp/rollout-thread-durable-late.jsonl',
        ephemeral: false,
      },
    })

    await vi.waitFor(() => expect(record.codex?.recoveryState).toBe('running_durable'))
    expect(replacementPty.write).toHaveBeenCalledWith('late-durable')
  })

  it('latches fast candidate readiness before unpublished durable identity is replayed', async () => {
    const initialSidecar = createMockSidecar()
    const replacementSidecar = createMockSidecar({
      onAttach: (attachment) => {
        attachment.onThreadLifecycle({
          kind: 'thread_started',
          thread: {
            id: 'thread-fast-candidate',
            path: '/tmp/rollout-thread-fast-candidate.jsonl',
            ephemeral: false,
          },
        })
        attachment.onDurableSession('thread-fast-candidate')
      },
    })
    const launchFactory = vi.fn().mockResolvedValue({
      remote: { wsUrl: 'ws://127.0.0.1:46029/' },
      sidecar: replacementSidecar.api,
    })
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      codexSidecar: initialSidecar.api,
      codexLaunchFactory: launchFactory,
    })
    const oldPty = await lastPty()

    oldPty.onExit.mock.calls[0][0]({ exitCode: 1, signal: 0 })
    expect(registry.input(record.terminalId, 'fast')).toBe(true)

    await vi.waitFor(() => expect(record.codex?.recoveryState).toBe('running_durable'), 600)
    const replacementPty = await lastPty()
    expect(record.codex?.durableSessionId).toBe('thread-fast-candidate')
    expect(replacementPty.write).toHaveBeenCalledWith('fast')
  })

  it('enters recovery_failed after bounded replacement launch failures without emitting terminal.exit', async () => {
    vi.useFakeTimers()
    const exited = vi.fn()
    const status = vi.fn()
    registry.on('terminal.exit', exited)
    registry.on('terminal.status', status)
    const launchFactory = vi.fn().mockRejectedValue(new Error('replacement launch unavailable'))
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      resumeSessionId: 'thread-durable-1',
      codexLaunchFactory: launchFactory,
    })
    const oldPty = await lastPty()
    oldPty.onExit.mock.calls[0][0]({ exitCode: 1, signal: 0 })

    for (let i = 0; i < 12; i += 1) {
      await vi.runOnlyPendingTimersAsync()
      await Promise.resolve()
    }

    await vi.waitFor(() => expect(record.codex?.recoveryState).toBe('recovery_failed'))
    expect(launchFactory).toHaveBeenCalledTimes(5)
    expect(exited).not.toHaveBeenCalled()
    expect(status).toHaveBeenCalledWith(expect.objectContaining({
      terminalId: record.terminalId,
      status: 'recovery_failed',
    }))
  })

  it('retires the current failed Codex worker when retry budget is already exhausted', async () => {
    const sidecar = createMockSidecar()
    const output = vi.fn()
    const status = vi.fn()
    registry.on('terminal.output.raw', output)
    registry.on('terminal.status', status)
    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      resumeSessionId: 'thread-durable-1',
      codexSidecar: sidecar.api,
    })
    const failedPty = await lastPty()
    for (let index = 0; index < 5; index += 1) {
      expect(record.codex!.recoveryPolicy.nextAttempt().ok).toBe(true)
    }

    failedPty.onExit.mock.calls[0][0]({ exitCode: 1, signal: 0 })

    await vi.waitFor(() => expect(record.codex?.recoveryState).toBe('recovery_failed'))
    expect(record.codex?.retiringGenerations.has(1)).toBe(true)
    expect(record.codex?.closeReasonByGeneration.get(1)).toBe('recovery_retire')
    expect(sidecar.api.shutdown).toHaveBeenCalledTimes(1)
    expect(failedPty.kill).toHaveBeenCalledTimes(1)
    expect(status).toHaveBeenCalledWith(expect.objectContaining({
      terminalId: record.terminalId,
      status: 'recovery_failed',
    }))

    failedPty.onData.mock.calls[0][0]('late failed worker output')
    expect(record.buffer.snapshot()).not.toContain('late failed worker output')
    expect(output).not.toHaveBeenCalledWith(expect.objectContaining({
      terminalId: record.terminalId,
      data: expect.stringContaining('late failed worker output'),
    }))
  })

  it('does not commit durable identity from a failed unpublished replacement candidate', async () => {
    const status = vi.fn()
    registry.on('terminal.status', status)
    const pty = await import('node-pty')
    let spawnCount = 0
    vi.mocked(pty.spawn).mockImplementation(() => {
      spawnCount += 1
      if (spawnCount === 2) {
        throw new Error('candidate spawn failed')
      }
      return createMockPty() as any
    })

    const firstReplacementSidecar = createMockSidecar({
      onAttach: (attachment) => {
        attachment.onDurableSession('failed-unpublished-session')
      },
    })
    const secondReplacementSidecar = createMockSidecar()
    const launchFactory = vi.fn()
      .mockResolvedValueOnce({
        remote: { wsUrl: 'ws://127.0.0.1:46018/' },
        sidecar: firstReplacementSidecar.api,
      })
      .mockResolvedValueOnce({
        remote: { wsUrl: 'ws://127.0.0.1:46019/' },
        sidecar: secondReplacementSidecar.api,
      })

    const record = registry.create({
      mode: 'codex',
      cwd: '/repo',
      codexLaunchFactory: launchFactory,
    })
    const oldPty = await lastPty()
    oldPty.onExit.mock.calls[0][0]({ exitCode: 1, signal: 0 })

    await vi.waitFor(() => expect(launchFactory).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(record.codex?.activeReplacement?.attempt).toBe(2))
    expect(status).toHaveBeenCalledWith(expect.objectContaining({
      terminalId: record.terminalId,
      status: 'recovering',
      reason: 'replacement_spawn_failure',
      attempt: 2,
    }))

    expect(record.codex?.durableSessionId).toBeUndefined()
    expect(launchFactory.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      resumeSessionId: undefined,
    }))

    await new Promise((resolve) => setTimeout(resolve, 300))
    await vi.waitFor(() => expect(launchFactory).toHaveBeenCalledTimes(2))

    expect(launchFactory.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      resumeSessionId: undefined,
    }))
  })

  it('does not idle-kill detached Codex recovery states but still kills ordinary detached terminals', async () => {
    const settings = {
      safety: { autoKillIdleMinutes: 1 },
      terminal: {},
    } as any
    registry.shutdown()
    registry = new TerminalRegistry(settings, 10)

    const recovering = registry.create({ mode: 'codex', cwd: '/repo' })
    recovering.codex!.recoveryState = 'recovering_pre_durable'
    recovering.lastActivityAt = Date.now() - 120_000

    const failed = registry.create({ mode: 'codex', cwd: '/repo' })
    failed.codex!.recoveryState = 'recovery_failed'
    failed.lastActivityAt = Date.now() - 120_000

    const shell = registry.create({ mode: 'shell', cwd: '/repo' })
    shell.lastActivityAt = Date.now() - 120_000

    await registry.enforceIdleKillsForTest()

    expect(recovering.status).toBe('running')
    expect(failed.status).toBe('running')
    expect(shell.status).toBe('exited')
  })
})
