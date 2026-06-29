import { describe, expect, it, vi } from 'vitest'
import { CodexLaunchPlanner } from '../../../../../server/coding-cli/codex-app-server/launch-planner.js'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

class FakeRuntime {
  shutdownCalls = 0
  ensureReadyCalls = 0
  ensureReadyCwdCalls: Array<string | undefined> = []
  startThreadCalls = 0
  adopted: Array<{ terminalId: string; generation: number }> = []
  loadedThreadListCalls = 0
  adoptError?: Error
  ensureReadyBlocker?: Promise<void>
  ensureReadyError?: Error
  startThreadBlocker?: Promise<void>
  shutdownBlocker?: Promise<void>
  shutdownError?: Error

  constructor(
    readonly wsUrl: string,
    private readonly threadId: string,
    private readonly startError?: Error,
    private readonly loadedThreadLists: string[][] = [],
  ) {}

  async ensureReady(cwd?: string) {
    this.ensureReadyCalls += 1
    this.ensureReadyCwdCalls.push(cwd)
    await this.ensureReadyBlocker
    if (this.ensureReadyError) throw this.ensureReadyError
    return {
      wsUrl: this.wsUrl,
      processPid: 100,
      ownershipId: `ownership-${this.threadId}`,
      processGroupId: 100,
      metadataPath: `/tmp/${this.threadId}.json`,
    }
  }

  async startThread() {
    this.startThreadCalls += 1
    await this.startThreadBlocker
    if (this.startError) throw this.startError
    return {
      threadId: this.threadId,
      wsUrl: this.wsUrl,
    }
  }

  async updateOwnershipMetadata(input: { terminalId?: string | null; generation?: number | null }) {
    if (this.adoptError) throw this.adoptError
    if (input.terminalId && typeof input.generation === 'number') {
      this.adopted.push({ terminalId: input.terminalId, generation: input.generation })
    }
  }

  async listLoadedThreads() {
    const index = Math.min(this.loadedThreadListCalls, Math.max(0, this.loadedThreadLists.length - 1))
    this.loadedThreadListCalls += 1
    return this.loadedThreadLists[index] ?? []
  }

  async shutdown() {
    this.shutdownCalls += 1
    await this.shutdownBlocker
    if (this.shutdownError) throw this.shutdownError
  }
}

type FakeProxyOptions = {
  upstreamWsUrl: string
  requireCandidatePersistence?: boolean
}

class FakeProxy {
  private static nextPort = 54000

  closeCalls = 0
  closeBlocker?: Promise<void>
  closeError?: Error
  readonly wsUrl: string
  readonly upstreamWsUrl: string
  readonly requireCandidatePersistence: boolean
  readonly pauseCandidateCapture = vi.fn()
  readonly resumeCandidateCapture = vi.fn()

  constructor(options: FakeProxyOptions) {
    this.upstreamWsUrl = options.upstreamWsUrl
    this.requireCandidatePersistence = options.requireCandidatePersistence ?? true
    this.wsUrl = `ws://127.0.0.1:${FakeProxy.nextPort++}`
  }

  async start() {
    return { wsUrl: this.wsUrl }
  }

  async close() {
    this.closeCalls += 1
    await this.closeBlocker
    if (this.closeError) throw this.closeError
  }

  markCandidatePersisted() {}
  onCandidate() { return () => undefined }
  onTurnStarted() { return () => undefined }
  onTurnCompleted() { return () => undefined }
  onRepairTrigger() { return () => undefined }
  onThreadLifecycle() { return () => undefined }
  onLifecycleLoss() { return () => undefined }
}

function createPlanner(
  runtimeOrFactory: ConstructorParameters<typeof CodexLaunchPlanner>[0],
  proxies: FakeProxy[] = [],
) {
  return new CodexLaunchPlanner(runtimeOrFactory, {
    proxyFactory: (options: FakeProxyOptions) => {
      const proxy = new FakeProxy(options)
      proxies.push(proxy)
      return proxy
    },
  })
}

describe('CodexLaunchPlanner', () => {
  it('creates a distinct owned sidecar for each launch plan', async () => {
    const runtimes: FakeRuntime[] = []
    const planner = createPlanner(() => {
      const index = runtimes.length + 1
      const runtime = new FakeRuntime(`ws://127.0.0.1:${43000 + index}`, `thread-${index}`)
      runtimes.push(runtime)
      return runtime as any
    })

    const first = await planner.planCreate({ cwd: '/repo/one' })
    const second = await planner.planCreate({ cwd: '/repo/two' })

    expect(runtimes).toHaveLength(2)
    expect(first.remote.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/)
    expect(second.remote.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/)
    expect(first.remote.wsUrl).not.toBe('ws://127.0.0.1:43001')
    expect(second.remote.wsUrl).not.toBe('ws://127.0.0.1:43002')
    expect(first.sessionId).toBeUndefined()
    expect(second.sessionId).toBeUndefined()
    expect(runtimes[0].startThreadCalls).toBe(0)
    expect(runtimes[1].startThreadCalls).toBe(0)
    expect(runtimes[0].ensureReadyCwdCalls).toEqual(['/repo/one'])
    expect(runtimes[1].ensureReadyCwdCalls).toEqual(['/repo/two'])

    await first.sidecar.adopt({ terminalId: 'term-one', generation: 1 })
    await second.sidecar.shutdown()

    expect(runtimes[0].adopted).toEqual([{ terminalId: 'term-one', generation: 1 }])
    expect(runtimes[0].shutdownCalls).toBe(0)
    expect(runtimes[1].shutdownCalls).toBe(1)
    await first.sidecar.shutdown()
  })

  it('shuts down the owned sidecar when planning fails before adoption', async () => {
    const runtime = new FakeRuntime('ws://127.0.0.1:43010', 'thread-fail')
    runtime.ensureReadyError = new Error('start failed')
    const planner = createPlanner(() => runtime as any)

    await expect(planner.planCreate({ cwd: '/repo/fail' })).rejects.toThrow('start failed')

    expect(runtime.shutdownCalls).toBe(1)
  })

  it('marks planning cleanup teardown failures as sidecar teardown failures', async () => {
    const runtime = new FakeRuntime('ws://127.0.0.1:43022', 'thread-fail')
    runtime.ensureReadyError = new Error('start failed')
    runtime.shutdownError = new Error('verified runtime teardown failed')
    const planner = createPlanner(() => runtime as any)

    let rejection: unknown
    try {
      await planner.planCreate({ cwd: '/repo/fail-teardown' })
    } catch (err) {
      rejection = err
    }

    expect(rejection).toBeInstanceOf(Error)
    expect((rejection as Error).message).toContain('verified runtime teardown failed')
    expect(rejection).toMatchObject({ codexSidecarTeardownFailed: true })
    expect(runtime.shutdownCalls).toBe(1)
  })

  it('transfers sidecar ownership to the registry on adoption so planner shutdown only cleans unadopted plans', async () => {
    const adoptedRuntime = new FakeRuntime('ws://127.0.0.1:43011', 'thread-adopted')
    const pendingRuntime = new FakeRuntime('ws://127.0.0.1:43012', 'thread-pending')
    const runtimes = [adoptedRuntime, pendingRuntime]
    const planner = createPlanner(() => runtimes.shift()! as any)

    const adopted = await planner.planCreate({ cwd: '/repo/adopted' })
    const pending = await planner.planCreate({ cwd: '/repo/pending' })
    await adopted.sidecar.adopt({ terminalId: 'term-adopted', generation: 1 })

    await planner.shutdown()

    expect(adoptedRuntime.adopted).toEqual([{ terminalId: 'term-adopted', generation: 1 }])
    expect(adoptedRuntime.shutdownCalls).toBe(0)
    expect(pendingRuntime.shutdownCalls).toBe(1)

    await pending.sidecar.shutdown()
    expect(pendingRuntime.shutdownCalls).toBe(1)
  })

  it('keeps a failed-adoption sidecar planner-owned so shutdown can clean it up', async () => {
    const runtime = new FakeRuntime('ws://127.0.0.1:43013', 'thread-adopt-fails')
    runtime.adoptError = new Error('no active owned Codex app-server sidecar')
    const planner = createPlanner(() => runtime as any)

    const plan = await planner.planCreate({ cwd: '/repo/adopt-fails' })
    await expect(plan.sidecar.adopt({ terminalId: 'term-adopt-fails', generation: 1 }))
      .rejects.toThrow('no active owned Codex app-server sidecar')

    await planner.shutdown()

    expect(runtime.adopted).toEqual([])
    expect(runtime.shutdownCalls).toBe(1)
  })

  it('rejects new plans after shutdown begins without creating another sidecar', async () => {
    const shutdownGate = deferred()
    const firstRuntime = new FakeRuntime('ws://127.0.0.1:43014', 'thread-before-shutdown')
    firstRuntime.shutdownBlocker = shutdownGate.promise
    const runtimes = [firstRuntime]
    const planner = createPlanner(() => {
      const runtime = runtimes.shift()
      if (!runtime) throw new Error('unexpected runtime allocation')
      return runtime as any
    })

    await planner.planCreate({ cwd: '/repo/before-shutdown' })
    const shutdown = planner.shutdown()
    await new Promise((resolve) => setImmediate(resolve))

    await expect(planner.planCreate({ cwd: '/repo/after-shutdown' })).rejects.toThrow(/shutting down/i)
    expect(runtimes).toHaveLength(0)

    shutdownGate.resolve()
    await shutdown
    await expect(planner.planCreate({ cwd: '/repo/after-shutdown-complete' })).rejects.toThrow(/shutting down/i)
  })

  it('rejects and cleans up an in-flight launch plan when shutdown starts before readiness returns', async () => {
    const runtime = new FakeRuntime('ws://127.0.0.1:43018', 'thread-after-shutdown')
    const readinessGate = deferred()
    runtime.ensureReadyBlocker = readinessGate.promise
    const planner = createPlanner(() => runtime as any)

    const plan = planner.planCreate({ cwd: '/repo/in-flight' })
    await vi.waitFor(() => expect(runtime.ensureReadyCalls).toBe(1))

    const shutdown = planner.shutdown()
    await vi.waitFor(() => expect(runtime.shutdownCalls).toBe(1))

    readinessGate.resolve()

    await expect(plan).rejects.toThrow(/shutting down/i)
    await expect(shutdown).resolves.toBeUndefined()
    expect(runtime.shutdownCalls).toBe(1)
  })

  it('rejects adoption after planner shutdown has started sidecar teardown', async () => {
    const runtime = new FakeRuntime('ws://127.0.0.1:43019', 'thread-adopt-after-shutdown')
    const shutdownGate = deferred()
    runtime.shutdownBlocker = shutdownGate.promise
    const planner = createPlanner(() => runtime as any)

    const plan = await planner.planCreate({ cwd: '/repo/adopt-after-shutdown' })
    const shutdown = planner.shutdown()
    await vi.waitFor(() => expect(runtime.shutdownCalls).toBe(1))

    await expect(plan.sidecar.adopt({ terminalId: 'term-after-shutdown', generation: 1 }))
      .rejects.toThrow(/shutting down/i)
    expect(runtime.adopted).toEqual([])

    shutdownGate.resolve()
    await shutdown
  })

  it('starts runtime teardown even when proxy close is still pending', async () => {
    const runtime = new FakeRuntime('ws://127.0.0.1:43025', 'thread-slow-proxy-close')
    const proxyCloseGate = deferred()
    const proxies: FakeProxy[] = []
    const planner = createPlanner(() => runtime as any, proxies)

    const plan = await planner.planCreate({ cwd: '/repo/slow-proxy-close' })
    proxies[0].closeBlocker = proxyCloseGate.promise

    const shutdown = planner.shutdown()

    await vi.waitFor(() => expect(proxies[0].closeCalls).toBe(1))
    await vi.waitFor(() => expect(runtime.shutdownCalls).toBe(1))
    await expect(plan.sidecar.adopt({ terminalId: 'term-slow-proxy-close', generation: 1 }))
      .rejects.toThrow(/shutting down/i)

    proxyCloseGate.resolve()
    await shutdown
  })

  it('keeps failed unadopted sidecar teardown planner-owned and joinable by planner shutdown', async () => {
    const runtime = new FakeRuntime('ws://127.0.0.1:43015', 'thread-teardown-fails')
    runtime.shutdownError = new Error('verified runtime teardown failed')
    const planner = createPlanner(() => runtime as any)

    const plan = await planner.planCreate({ cwd: '/repo/unadopted' })

    await expect(plan.sidecar.shutdown()).rejects.toThrow('verified runtime teardown failed')
    await expect(planner.shutdown()).rejects.toThrow('verified runtime teardown failed')
    expect(runtime.shutdownCalls).toBe(2)
  })

  it('retries a failed planner-owned sidecar teardown on a later shutdown join', async () => {
    const runtime = new FakeRuntime('ws://127.0.0.1:43023', 'thread-teardown-retry')
    runtime.shutdownError = new Error('transient metadata cleanup failure')
    const planner = createPlanner(() => runtime as any)

    const plan = await planner.planCreate({ cwd: '/repo/unadopted-retry' })

    await expect(plan.sidecar.shutdown()).rejects.toThrow('transient metadata cleanup failure')
    expect(runtime.shutdownCalls).toBe(1)

    runtime.shutdownError = undefined

    await expect(planner.shutdown()).resolves.toBeUndefined()
    expect(runtime.shutdownCalls).toBe(2)
  })

  it('blocks new plans behind a failed planner-owned sidecar teardown until retry succeeds', async () => {
    const runtimes: FakeRuntime[] = []
    const planner = createPlanner(() => {
      const index = runtimes.length + 1
      const runtime = new FakeRuntime(`ws://127.0.0.1:${43030 + index}`, `thread-${index}`)
      runtimes.push(runtime)
      return runtime as any
    })

    const first = await planner.planCreate({ cwd: '/repo/one' })
    runtimes[0].shutdownError = new Error('transient teardown failure')

    await expect(first.sidecar.shutdown()).rejects.toThrow('transient teardown failure')
    expect(runtimes[0].shutdownCalls).toBe(1)

    await expect(planner.planCreate({ cwd: '/repo/two' })).rejects.toThrow('transient teardown failure')
    expect(runtimes).toHaveLength(1)
    expect(runtimes[0].shutdownCalls).toBe(2)

    runtimes[0].shutdownError = undefined

    const second = await planner.planCreate({ cwd: '/repo/two' })

    expect(second.sessionId).toBeUndefined()
    expect(runtimes).toHaveLength(2)
    expect(runtimes[0].shutdownCalls).toBe(3)
    expect(runtimes[1].startThreadCalls).toBe(0)
  })

  it('waits for every planner-owned sidecar shutdown before reporting a teardown failure', async () => {
    const firstRuntime = new FakeRuntime('ws://127.0.0.1:43016', 'thread-fast-fails')
    firstRuntime.shutdownError = new Error('fast verified runtime teardown failed')
    const secondRuntime = new FakeRuntime('ws://127.0.0.1:43017', 'thread-slow-shutdown')
    const slowShutdown = deferred()
    secondRuntime.shutdownBlocker = slowShutdown.promise
    const runtimes = [firstRuntime, secondRuntime]
    const planner = createPlanner(() => runtimes.shift()! as any)

    await planner.planCreate({ cwd: '/repo/fast-fails' })
    await planner.planCreate({ cwd: '/repo/slow-shutdown' })

    const shutdown = planner.shutdown()
    let settled = false
    void shutdown.then(
      () => { settled = true },
      () => { settled = true },
    )

    await vi.waitFor(() => expect(firstRuntime.shutdownCalls).toBe(1))
    await vi.waitFor(() => expect(secondRuntime.shutdownCalls).toBe(1))
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)

    slowShutdown.resolve()
    await expect(shutdown).rejects.toThrow('fast verified runtime teardown failed')
  })

  it('does not poll loaded-thread state for resume plans', async () => {
    const runtime = new FakeRuntime(
      'ws://127.0.0.1:43020',
      'thread-ready',
      undefined,
      [[], ['other-thread'], ['thread-ready']],
    )
    const planner = createPlanner(() => runtime as any)

    const plan = await planner.planCreate({ resumeSessionId: 'thread-ready' })

    expect(plan.sessionId).toBe('thread-ready')
    expect(runtime.loadedThreadListCalls).toBe(0)
  })

  it('passes resume cwd to sidecar readiness', async () => {
    const runtime = new FakeRuntime('ws://127.0.0.1:43024', 'thread-ready', undefined, [['thread-ready']])
    const planner = createPlanner(() => runtime as any)

    await planner.planCreate({ resumeSessionId: 'thread-ready', cwd: '/repo/resume' })

    expect(runtime.ensureReadyCwdCalls).toEqual(['/repo/resume'])
  })

  it('forwards candidate capture pause and resume through the sidecar', async () => {
    const runtime = new FakeRuntime('ws://127.0.0.1:43026', 'thread-pause')
    const proxies: FakeProxy[] = []
    const planner = createPlanner(() => runtime as any, proxies)

    const plan = await planner.planCreate({ cwd: '/repo/pause' })

    plan.sidecar.pauseCandidateCapture!('startup_update_prompt')
    plan.sidecar.resumeCandidateCapture!('startup_update_prompt_skipped')

    expect(proxies[0].pauseCandidateCapture).toHaveBeenCalledWith('startup_update_prompt')
    expect(proxies[0].resumeCandidateCapture).toHaveBeenCalledWith('startup_update_prompt_skipped')

    await plan.sidecar.shutdown()
  })
})
