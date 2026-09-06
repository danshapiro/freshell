import { describe, expect, it, vi } from 'vitest'
import { CodexLaunchPlanner } from '../../../../../server/coding-cli/codex-app-server/launch-planner.js'
import type {
  CodexSurvivorAttachErrorCode,
  HeldCodexSidecarOwnership,
} from '../../../../../server/coding-cli/codex-app-server/runtime.js'

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
  updateOwnershipMetadataCalls: Array<{ terminalId?: string | null; generation?: number | null; sessionId?: string }> = []
  attachCalls: Array<{ ownershipId: string; sessionId: string }> = []
  loadedThreadListCalls = 0
  adoptError?: Error
  ensureReadyBlocker?: Promise<void>
  ensureReadyError?: Error
  startThreadBlocker?: Promise<void>
  shutdownBlocker?: Promise<void>
  shutdownError?: Error
  attachError?: Error

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

  async updateOwnershipMetadata(input: { terminalId?: string | null; generation?: number | null; sessionId?: string }) {
    if (this.adoptError) throw this.adoptError
    this.updateOwnershipMetadataCalls.push(input)
    if (input.terminalId && typeof input.generation === 'number') {
      this.adopted.push({ terminalId: input.terminalId, generation: input.generation })
    }
  }

  async attachToSurvivingSidecar(ownership: HeldCodexSidecarOwnership, options: { sessionId: string }) {
    this.attachCalls.push({ ownershipId: ownership.metadata.ownershipId, sessionId: options.sessionId })
    if (this.attachError) throw this.attachError
    return {
      wsUrl: this.wsUrl,
      processPid: 100,
      codexHome: `/tmp/${this.threadId}-codex-home`,
      ownershipId: ownership.metadata.ownershipId,
      processGroupId: 100,
      metadataPath: ownership.metadataPath,
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

function survivorCandidate(ownershipId: string, sessionId: string, wsUrl: string): HeldCodexSidecarOwnership {
  return {
    metadataDir: '/tmp/codex-sidecars',
    metadataPath: `/tmp/codex-sidecars/${ownershipId}.json`,
    metadata: {
      schemaVersion: 1,
      ownershipId,
      serverInstanceId: 'srv-previous-generation',
      ownerServerPid: 999999,
      terminalId: null,
      generation: null,
      wsUrl,
      wrapperPid: 424242,
      processGroupId: 424242,
      wrapperIdentity: { commandLine: ['codex', 'app-server'], cwd: null, startTimeTicks: null },
      createdAt: '2026-09-05T00:00:00.000Z',
      updatedAt: '2026-09-05T00:00:00.000Z',
      sessionId,
    },
  }
}

function survivorAttachError(code: CodexSurvivorAttachErrorCode, message: string): Error {
  const error = new Error(message) as Error & { code: CodexSurvivorAttachErrorCode }
  error.code = code
  return error
}

// Structural CodexSidecarClaimSource double: one-shot scripted candidate queue per claim call.
class FakeClaimSource {
  claimCalls: string[] = []
  dropCalls: string[] = []
  settleCalls: Array<{ ownershipId: string; code: CodexSurvivorAttachErrorCode }> = []
  private readonly queue: HeldCodexSidecarOwnership[]

  constructor(candidates: HeldCodexSidecarOwnership[]) {
    this.queue = [...candidates]
  }

  claimForSession(sessionId: string): HeldCodexSidecarOwnership | null {
    this.claimCalls.push(sessionId)
    return this.queue.shift() ?? null
  }

  dropClaim(ownershipId: string): void {
    this.dropCalls.push(ownershipId)
  }

  async settleFailedClaim(ownership: HeldCodexSidecarOwnership, code: CodexSurvivorAttachErrorCode): Promise<void> {
    this.settleCalls.push({ ownershipId: ownership.metadata.ownershipId, code })
  }
}

class FakeProxy {
  private static nextPort = 54000

  closeCalls = 0
  closeBlocker?: Promise<void>
  closeError?: Error
  startError?: Error
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
    if (this.startError) throw this.startError
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
  reconciler?: FakeClaimSource,
  proxyStartErrors: ReadonlyArray<Error | undefined> = [],
) {
  return new CodexLaunchPlanner(runtimeOrFactory, {
    proxyFactory: (options: FakeProxyOptions) => {
      const proxy = new FakeProxy(options)
      const startError = proxyStartErrors[proxies.length]
      if (startError) proxy.startError = startError
      proxies.push(proxy)
      return proxy
    },
    ...(reconciler ? { reconciler } : {}),
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

  it('stamps the resume sessionId onto the sidecar ownership record for resume plans', async () => {
    const runtime = new FakeRuntime('ws://127.0.0.1:43042', 'thr-resume')
    const planner = createPlanner(() => runtime as any)

    const plan = await planner.planCreate({ resumeSessionId: 'thr-resume' })

    expect(plan.sessionId).toBe('thr-resume')
    expect(runtime.updateOwnershipMetadataCalls).toContainEqual({ sessionId: 'thr-resume' })
  })

  it('never stamps a sessionId onto the sidecar ownership record for fresh plans', async () => {
    const runtime = new FakeRuntime('ws://127.0.0.1:43043', 'thread-fresh')
    const planner = createPlanner(() => runtime as any)

    await planner.planCreate({ cwd: '/repo/fresh' })

    expect(runtime.updateOwnershipMetadataCalls.filter((input) => input.sessionId !== undefined)).toEqual([])
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

describe('CodexLaunchPlanner restore-time survivor claims', () => {
  it('claims and attaches a surviving sidecar for a resume plan instead of spawning', async () => {
    const runtime = new FakeRuntime('ws://127.0.0.1:32101', 'thread-survivor')
    const candidate = survivorCandidate('ownership-survivor', 'thread-resume', 'ws://127.0.0.1:32101')
    const reconciler = new FakeClaimSource([candidate])
    const proxies: FakeProxy[] = []
    const planner = createPlanner(() => runtime as any, proxies, reconciler)

    const plan = await planner.planCreate({ resumeSessionId: 'thread-resume' })

    expect(plan.sessionId).toBe('thread-resume')
    expect(proxies).toHaveLength(1)
    expect(plan.remote.wsUrl).toBe(proxies[0].wsUrl)
    expect(proxies[0].requireCandidatePersistence).toBe(false)
    expect(proxies[0].upstreamWsUrl).toBe('ws://127.0.0.1:32101')
    // The survivor claim path never spawns: ensureReady is the spawn door.
    expect(runtime.ensureReadyCalls).toBe(0)
    expect(runtime.attachCalls).toEqual([{ ownershipId: 'ownership-survivor', sessionId: 'thread-resume' }])
    expect(reconciler.claimCalls).toEqual(['thread-resume'])
    expect(reconciler.dropCalls).toEqual(['ownership-survivor'])
    expect(reconciler.settleCalls).toEqual([])

    await plan.sidecar.shutdown()
  })

  it('falls through to the spawn path when no survivor is claimable for the resume session', async () => {
    const runtime = new FakeRuntime('ws://127.0.0.1:43050', 'thr-fallback')
    const reconciler = new FakeClaimSource([])
    const proxies: FakeProxy[] = []
    const planner = createPlanner(() => runtime as any, proxies, reconciler)

    const plan = await planner.planCreate({ resumeSessionId: 'thr-fallback' })

    expect(plan.sessionId).toBe('thr-fallback')
    expect(reconciler.claimCalls).toEqual(['thr-fallback'])
    expect(reconciler.dropCalls).toEqual([])
    expect(reconciler.settleCalls).toEqual([])
    expect(runtime.ensureReadyCalls).toBe(1)
    expect(runtime.attachCalls).toEqual([])
    // Task 1 stamping survives on the fallback spawn path: the fresh record carries the resume
    // session id so a later crash+restore can claim it.
    expect(runtime.updateOwnershipMetadataCalls).toContainEqual({ sessionId: 'thr-fallback' })

    await plan.sidecar.shutdown()
  })

  it('settles a coded survivor attach failure and claims the next candidate', async () => {
    const firstRuntime = new FakeRuntime('ws://127.0.0.1:32111', 'thread-first')
    firstRuntime.attachError = survivorAttachError('codex_survivor_not_writer', 'reachable but not the writer of thread-resume')
    const secondRuntime = new FakeRuntime('ws://127.0.0.1:32112', 'thread-second')
    const firstCandidate = survivorCandidate('ownership-first', 'thread-resume', 'ws://127.0.0.1:32111')
    const secondCandidate = survivorCandidate('ownership-second', 'thread-resume', 'ws://127.0.0.1:32112')
    const reconciler = new FakeClaimSource([firstCandidate, secondCandidate])
    const runtimes = [firstRuntime, secondRuntime]
    const proxies: FakeProxy[] = []
    const planner = createPlanner(() => runtimes.shift()! as any, proxies, reconciler)

    const plan = await planner.planCreate({ resumeSessionId: 'thread-resume' })

    expect(plan.sessionId).toBe('thread-resume')
    // Claims proceed one candidate at a time through claimForSession.
    expect(reconciler.claimCalls).toEqual(['thread-resume', 'thread-resume'])
    expect(reconciler.settleCalls).toEqual([{ ownershipId: 'ownership-first', code: 'codex_survivor_not_writer' }])
    expect(reconciler.dropCalls).toEqual(['ownership-second'])
    expect(firstRuntime.ensureReadyCalls).toBe(0)
    expect(secondRuntime.ensureReadyCalls).toBe(0)
    expect(firstRuntime.attachCalls).toEqual([{ ownershipId: 'ownership-first', sessionId: 'thread-resume' }])
    expect(secondRuntime.attachCalls).toEqual([{ ownershipId: 'ownership-second', sessionId: 'thread-resume' }])
    // The coded-failure candidate never built a proxy; only the attached survivor did.
    expect(proxies).toHaveLength(1)
    expect(proxies[0].upstreamWsUrl).toBe('ws://127.0.0.1:32112')
    expect(proxies[0].requireCandidatePersistence).toBe(false)
    expect(plan.sidecar).toBeDefined()

    // activeSidecars membership pin: a coded-failure candidate's runtime is provably inert
    // (attachToSurvivingSidecar throws before any retitle/ready-state mutation), so its sidecar
    // must never enter activeSidecars — otherwise a later planner shutdown() would silently tear
    // down a half-attached runtime. Only the second (attached) sidecar is planner-owned.
    await planner.shutdown()
    expect(firstRuntime.shutdownCalls).toBe(0)
    expect(secondRuntime.shutdownCalls).toBe(1)
  })

  it('drops the claim and runs sidecar teardown when the attach throws an uncoded error', async () => {
    const runtime = new FakeRuntime('ws://127.0.0.1:32121', 'thread-uncoded')
    runtime.attachError = new Error('proxy start exploded')
    const candidate = survivorCandidate('ownership-uncoded', 'thread-resume', 'ws://127.0.0.1:32121')
    const reconciler = new FakeClaimSource([candidate])
    const planner = createPlanner(() => runtime as any, [], reconciler)

    await expect(planner.planCreate({ resumeSessionId: 'thread-resume' })).rejects.toThrow('proxy start exploded')

    // Uncoded errors treat the candidate as consumed-then-unowned: the claim is dropped (never
    // settled) and the sidecar goes through the existing ownership-gated teardown catch path.
    // planCodexLaunchWithRetry owns the retry policy above planCreate; the rethrown original
    // error keeps the wrapper's fresh-spawn failure semantics byte-identical
    // (launch-retry.test.ts covers the wrapper level).
    expect(reconciler.claimCalls).toEqual(['thread-resume'])
    expect(reconciler.dropCalls).toEqual(['ownership-uncoded'])
    expect(reconciler.settleCalls).toEqual([])
    expect(runtime.shutdownCalls).toBe(1)
  })

  it('retries a failed uncoded-claim sidecar teardown on the next planCreate (review F1)', async () => {
    const firstRuntime = new FakeRuntime('ws://127.0.0.1:32141', 'thread-claim-teardown')
    const secondRuntime = new FakeRuntime('ws://127.0.0.1:32142', 'thread-after-retry')
    const runtimes = [firstRuntime, secondRuntime]
    firstRuntime.shutdownError = new Error('transient candidate teardown failure')
    const candidate = survivorCandidate('ownership-claim-teardown', 'thread-resume', 'ws://127.0.0.1:32141')
    const reconciler = new FakeClaimSource([candidate])
    const proxies: FakeProxy[] = []
    // The attach succeeds, then the FIRST proxy's start fails uncoded; the claim is dropped and
    // the candidate sidecar's teardown runs — and that teardown itself fails.
    const planner = createPlanner(
      () => runtimes.shift()! as any,
      proxies,
      reconciler,
      [new Error('proxy start exploded')],
    )

    const rejection = await planner.planCreate({ resumeSessionId: 'thread-resume' })
      .catch((caught: unknown) => caught)

    expect(rejection).toMatchObject({ codexSidecarTeardownFailed: true })
    expect((rejection as Error).message).toContain('transient candidate teardown failure')
    expect(reconciler.dropCalls).toEqual(['ownership-claim-teardown'])
    expect(firstRuntime.attachCalls).toEqual([{ ownershipId: 'ownership-claim-teardown', sessionId: 'thread-resume' }])
    expect(firstRuntime.shutdownCalls).toBe(1)

    firstRuntime.shutdownError = undefined

    // Review F1 parity with the spawn path: the candidate entered activeSidecars BEFORE its
    // teardown attempt, so the failed shutdown sits in failedSidecarShutdowns AND is reachable by
    // retryFailedSidecarShutdownsBeforePlan — the next planCreate retries (and now succeeds at)
    // the teardown before falling through to a fresh spawn.
    const plan = await planner.planCreate({ resumeSessionId: 'thread-resume' })

    expect(firstRuntime.shutdownCalls).toBe(2)
    expect(reconciler.claimCalls).toEqual(['thread-resume', 'thread-resume'])
    expect(plan.sessionId).toBe('thread-resume')
    expect(secondRuntime.ensureReadyCalls).toBe(1)

    await plan.sidecar.shutdown()
  })

  it('never consults the reconciler for fresh plans even when one is installed', async () => {
    const runtime = new FakeRuntime('ws://127.0.0.1:43060', 'thread-fresh-only')
    const candidate = survivorCandidate('ownership-unused', 'thread-x', 'ws://127.0.0.1:32131')
    const reconciler = new FakeClaimSource([candidate])
    const planner = createPlanner(() => runtime as any, [], reconciler)

    const plan = await planner.planCreate({ cwd: '/repo/fresh-claim' })

    expect(plan.sessionId).toBeUndefined()
    expect(reconciler.claimCalls).toEqual([])
    expect(reconciler.dropCalls).toEqual([])
    expect(runtime.attachCalls).toEqual([])
    expect(runtime.ensureReadyCalls).toBe(1)

    await plan.sidecar.shutdown()
  })

  it('keeps byte-identical legacy behavior when no reconciler is installed', async () => {
    const runtime = new FakeRuntime('ws://127.0.0.1:43061', 'thread-legacy')
    const planner = createPlanner(() => runtime as any)

    const plan = await planner.planCreate({ resumeSessionId: 'thread-legacy', cwd: '/repo/legacy' })

    expect(plan.sessionId).toBe('thread-legacy')
    expect(runtime.attachCalls).toEqual([])
    expect(runtime.ensureReadyCalls).toBe(1)
    expect(runtime.ensureReadyCwdCalls).toEqual(['/repo/legacy'])
    expect(runtime.updateOwnershipMetadataCalls).toContainEqual({ sessionId: 'thread-legacy' })

    await plan.sidecar.shutdown()
  })
})
