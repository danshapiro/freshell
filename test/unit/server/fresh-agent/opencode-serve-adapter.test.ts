import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const observabilityMocks = vi.hoisted(() => ({
  recordFreshAgentObservabilityEvent: vi.fn(),
}))

const loggerMocks = vi.hoisted(() => {
  const logger = {
    child: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }
  const freshAgentObservabilityLogger = {
    info: vi.fn(),
    warn: vi.fn(),
  }
  logger.child.mockReturnValue(logger)
  return { logger, freshAgentObservabilityLogger }
})

vi.mock('../../../../server/fresh-agent/observability.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../server/fresh-agent/observability.js')>()
  return { ...actual, recordFreshAgentObservabilityEvent: observabilityMocks.recordFreshAgentObservabilityEvent }
})

vi.mock('../../../../server/logger.js', () => ({ logger: loggerMocks.logger, freshAgentObservabilityLogger: loggerMocks.freshAgentObservabilityLogger }))

import { createOpencodeFreshAgentAdapter } from '../../../../server/fresh-agent/adapters/opencode/adapter.js'
import { OpencodeServeLostError } from '../../../../server/fresh-agent/adapters/opencode/serve-manager.js'
import { hashForLogs } from '../../../../server/fresh-agent/observability.js'
import { FreshAgentRecoveryStore } from '../../../../server/fresh-agent/recovery-store.js'

type FakeManager = ReturnType<typeof makeFakeManager>

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeFakeManager() {
  const sessionEmitters = new Map<string, EventEmitter>()
  const emitterFor = (id: string) => {
    let e = sessionEmitters.get(id)
    if (!e) { e = new EventEmitter(); sessionEmitters.set(id, e) }
    return e
  }
  return {
    createSession: vi.fn(async (input?: { directory?: string }) => ({
      id: 'ses_real_1',
      ...(input?.directory ? { directory: input.directory } : {}),
      title: 'T',
    })),
    promptAsync: vi.fn(async () => undefined),
    listMessages: vi.fn(async () => ({ messages: [], nextCursor: null })),
    getMessage: vi.fn(async () => null),
    getSession: vi.fn(async (id: string, route?: { cwd?: string }) => ({
      id,
      ...(route?.cwd ? { directory: route.cwd } : {}),
      title: 'T',
      time: { updated: 5 },
    })),
    getSessionStatus: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    compact: vi.fn(async () => undefined),
    fork: vi.fn(async (): Promise<{ id: string; directory?: string }> => ({ id: 'ses_child_1' })),
    onceIdle: vi.fn(async () => undefined),
    subscribe: vi.fn((id: string, listener: (e: unknown) => void) => {
      const e = emitterFor(id)
      const h = (ev: unknown) => listener(ev)
      e.on('event', h)
      return () => e.off('event', h)
    }),
    shutdown: vi.fn(async () => undefined),
    _emit: (id: string, ev: unknown) => emitterFor(id).emit('event', ev),
  }
}

/** Isolated recovery store on a fresh temp file — tests must never touch ~/.freshell. */
function makeTempRecoveryStore() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'freshell-recovery-test-'))
  return new FreshAgentRecoveryStore({ filePath: path.join(dir, 'r.json') })
}

/** Drain the fire-and-forget recovery chain (recovery-store fs I/O + send queue). */
async function flushRecovery() {
  for (let i = 0; i < 25; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function makeAdapter(manager: FakeManager, overrides: Partial<Parameters<typeof createOpencodeFreshAgentAdapter>[0]> = {}) {
  return createOpencodeFreshAgentAdapter({
    serveManager: manager as any,
    validateCwd: async () => undefined,
    canonicalizePath: async (value: string) => value,
    // Every test adapter gets an isolated recovery store by default so no test can
    // read or write the real user-level recovery file.
    recoveryStore: makeTempRecoveryStore(),
    // Transcript-settle polls (zrrj Task 15): default the injected sleep to a no-op so
    // tests using the never-settling default listMessages fixture exhaust the poll
    // budget in pure microtasks instead of ~1.5 s of real timers. The PRODUCTION
    // default stays the real setTimeout sleep; explicit per-test overrides still win.
    settleSleep: async () => {},
    ...overrides,
  })
}

describe('OpenCode serve adapter: create + send', () => {
  it('creates a placeholder, materializes on first send via POST /session, and awaits idle', async () => {
    const manager = makeFakeManager()
    const adapter = makeAdapter(manager)
    const created = await adapter.create({
      requestId: 'req-1', sessionType: 'freshopencode', provider: 'opencode',
      cwd: '/repo', model: 'provider/model', effort: 'high',
    })
    expect(created).toEqual({
      sessionId: 'freshopencode-req-1',
      sessionRef: { provider: 'opencode', sessionId: 'freshopencode-req-1' },
    })

    const result = await adapter.send?.('freshopencode-req-1', { text: 'reply ok' })
    expect(result).toEqual({ sessionId: 'ses_real_1', sessionRef: { provider: 'opencode', sessionId: 'ses_real_1' } })
    expect(manager.createSession).toHaveBeenCalledTimes(1)
    expect(manager.createSession).toHaveBeenLastCalledWith({ directory: '/repo' })
    expect(manager.promptAsync).toHaveBeenCalledWith('ses_real_1', {
      parts: [{ type: 'text', text: 'reply ok' }],
      model: { providerID: 'provider', modelID: 'model' },
      variant: 'high',
    }, { cwd: '/repo' })
    expect(manager.onceIdle).toHaveBeenCalledWith('ses_real_1', expect.any(Number), { cwd: '/repo' })
  })

  it('omits the model key when create omits an explicit model (opencode picks its own default)', async () => {
    const manager = makeFakeManager()
    const adapter = makeAdapter(manager)
    await adapter.create({
      requestId: 'req-default-model', sessionType: 'freshopencode', provider: 'opencode',
      cwd: '/repo',
    })

    await adapter.send?.('freshopencode-req-default-model', { text: 'reply ok' })

    expect(manager.promptAsync).toHaveBeenCalledWith('ses_real_1', {
      parts: [{ type: 'text', text: 'reply ok' }],
    }, { cwd: '/repo' })
  })

  it('attach during an in-flight send reuses the materialized state (no duplicate serve subscription)', async () => {
    const idle = createDeferred<void>()
    const manager = makeFakeManager()
    manager.onceIdle = vi.fn(() => idle.promise)
    const adapter = makeAdapter(manager)
    await adapter.create({ requestId: 'req-race', sessionType: 'freshopencode', provider: 'opencode', cwd: '/repo' })

    // Start the send: it materializes (remember + bindServeStream subscribes once),
    // emits freshAgent.session.materialized, then parks at `await idle`.
    const sendPromise = adapter.send?.('freshopencode-req-race', { text: 'go' })
    // Wait until materialization is done and the send is in-flight at await idle
    // (promptAsync called => past emitMaterialized, before onceIdle resolves).
    await vi.waitFor(() => expect(manager.promptAsync).toHaveBeenCalledWith('ses_real_1', expect.anything(), expect.anything()))

    // Concurrently attach the real id while the send is still in-flight. attach
    // MUST find the already-remembered state (existing-branch) and NOT bind a
    // second serve stream. This pins concurrent attach idempotency: exactly one
    // serve subscription for the real id, regardless of when attach arrives
    // during the send lifecycle.
    const attached = await adapter.attach?.({
      sessionId: 'ses_real_1', sessionType: 'freshopencode', provider: 'opencode', cwd: '/repo',
    })
    expect(attached).toEqual({ sessionId: 'ses_real_1', sessionRef: { provider: 'opencode', sessionId: 'ses_real_1' } })
    expect(manager.subscribe).toHaveBeenCalledTimes(1)
    // Third arg is the sidecar-loss handler (zrrj): serve stream binding registers
    // an onLost listener alongside the event listener.
    expect(manager.subscribe).toHaveBeenCalledWith('ses_real_1', expect.any(Function), expect.any(Function))

    // The in-flight send still completes with the correct result once idle resolves.
    idle.resolve()
    await expect(sendPromise).resolves.toEqual({ sessionId: 'ses_real_1', sessionRef: { provider: 'opencode', sessionId: 'ses_real_1' } })
  })

  it('continues a materialized session on later sends without re-creating it', async () => {
    const manager = makeFakeManager()
    const adapter = makeAdapter(manager)
    await adapter.create({ requestId: 'req-2', sessionType: 'freshopencode', provider: 'opencode', model: 'opencode-go/deepseek-v4-flash' })
    await adapter.send?.('freshopencode-req-2', { text: 'first' })
    await adapter.send?.('freshopencode-req-2', { text: 'second' })
    expect(manager.createSession).toHaveBeenCalledTimes(1)
    expect(manager.promptAsync).toHaveBeenNthCalledWith(2, 'ses_real_1', expect.objectContaining({ parts: [{ type: 'text', text: 'second' }] }))
  })

  it('subscribe relays mapped sdk events stamped with the subscribed id', async () => {
    const manager = makeFakeManager()
    const adapter = makeAdapter(manager)
    await adapter.create({ requestId: 'req-3', sessionType: 'freshopencode', provider: 'opencode' })
    const events: unknown[] = []
    adapter.subscribe?.('freshopencode-req-3', (e) => events.push(e))
    await adapter.send?.('freshopencode-req-3', { text: 'go' })
    // serve emits a part update + idle on the real session
    manager._emit('ses_real_1', { kind: 'message.part.updated', sessionId: 'ses_real_1', raw: { type: 'message.part.updated', properties: { sessionID: 'ses_real_1' } } })
    manager._emit('ses_real_1', { kind: 'session.idle', sessionId: 'ses_real_1', raw: { type: 'session.idle', properties: { sessionID: 'ses_real_1' } } })
    expect(events).toContainEqual({ type: 'sdk.session.snapshot', sessionId: 'freshopencode-req-3', status: 'running' })
    expect(events).toContainEqual({ type: 'sdk.session.snapshot', sessionId: 'freshopencode-req-3', status: 'idle' })
  })

  it('emits exactly one server-authoritative sdk.turn.complete on a successful send', async () => {
    const manager = makeFakeManager()
    const adapter = makeAdapter(manager)
    await adapter.create({ requestId: 'req-tc', sessionType: 'freshopencode', provider: 'opencode' })
    const events: unknown[] = []
    adapter.subscribe?.('freshopencode-req-tc', (e) => events.push(e))
    await adapter.send?.('freshopencode-req-tc', { text: 'go' })
    // A second idle snapshot relayed from the serve SSE must NOT produce a second completion.
    manager._emit('ses_real_1', { kind: 'session.idle', sessionId: 'ses_real_1', raw: { type: 'session.idle', properties: { sessionID: 'ses_real_1' } } })

    const completions = events.filter((e): e is { type: string; sessionId: string; at: number } =>
      !!e && typeof e === 'object' && (e as { type?: unknown }).type === 'sdk.turn.complete')
    expect(completions).toHaveLength(1)
    expect(completions[0].sessionId).toBe('freshopencode-req-tc')
    expect(typeof completions[0].at).toBe('number')
  })

  it('stamps a strictly-increasing at across successive completions even at the same wall-clock ms', async () => {
    const manager = makeFakeManager()
    const adapter = makeAdapter(manager)
    await adapter.create({ requestId: 'req-mono', sessionType: 'freshopencode', provider: 'opencode' })
    const events: unknown[] = []
    adapter.subscribe?.('freshopencode-req-mono', (e) => events.push(e))
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(5000)
    try {
      await adapter.send?.('freshopencode-req-mono', { text: 'one' })
      await adapter.send?.('freshopencode-req-mono', { text: 'two' })
    } finally {
      nowSpy.mockRestore()
    }
    const ats = events
      .filter((e): e is { type: string; at: number } => !!e && typeof e === 'object' && (e as { type?: unknown }).type === 'sdk.turn.complete')
      .map((e) => e.at)
    expect(ats).toHaveLength(2)
    expect(ats[1]).toBeGreaterThan(ats[0])
  })

  it('does NOT emit sdk.turn.complete when the in-flight turn is interrupted, even though onceIdle resolves on the abort-triggered idle', async () => {
    // interrupt() aborts the turn; the sidecar then emits session.idle, which RESOLVES
    // onceIdle (it does not reject). Without tracking the abort, the success path would
    // fire a false chime/green for an interrupted turn.
    const manager = makeFakeManager()
    let resolveIdle: (() => void) | undefined
    manager.onceIdle = vi.fn(() => new Promise<void>((resolve) => { resolveIdle = resolve }))
    const adapter = makeAdapter(manager)
    await adapter.create({ requestId: 'req-int', sessionType: 'freshopencode', provider: 'opencode' })
    const events: unknown[] = []
    adapter.subscribe?.('freshopencode-req-int', (e) => events.push(e))

    const sendPromise = adapter.send?.('freshopencode-req-int', { text: 'go' })
    await vi.waitFor(() => expect(manager.onceIdle).toHaveBeenCalled())

    await adapter.interrupt?.('freshopencode-req-int')
    resolveIdle?.()
    await sendPromise

    const completions = events.filter((e) => !!e && typeof e === 'object' && (e as { type?: unknown }).type === 'sdk.turn.complete')
    expect(completions).toHaveLength(0)
    // The interrupt still returns the pane to idle (clears blue) — it just must not chime.
    expect(events).toContainEqual({ type: 'sdk.session.snapshot', sessionId: 'freshopencode-req-int', status: 'idle' })
  })

  it('resumes chiming on the next completed turn after an interrupt', async () => {
    const manager = makeFakeManager()
    let resolveIdle: (() => void) | undefined
    manager.onceIdle = vi.fn(() => new Promise<void>((resolve) => { resolveIdle = resolve }))
    const adapter = makeAdapter(manager)
    await adapter.create({ requestId: 'req-int2', sessionType: 'freshopencode', provider: 'opencode' })
    const events: unknown[] = []
    adapter.subscribe?.('freshopencode-req-int2', (e) => events.push(e))

    const interrupted = adapter.send?.('freshopencode-req-int2', { text: 'one' })
    await vi.waitFor(() => expect(manager.onceIdle).toHaveBeenCalledTimes(1))
    await adapter.interrupt?.('freshopencode-req-int2')
    resolveIdle?.()
    await interrupted

    // A subsequent clean turn (no interrupt) must chime again — the abort flag must not stick.
    manager.onceIdle = vi.fn(async () => undefined)
    await adapter.send?.('freshopencode-req-int2', { text: 'two' })
    const completions = events.filter((e) => !!e && typeof e === 'object' && (e as { type?: unknown }).type === 'sdk.turn.complete')
    expect(completions).toHaveLength(1)
  })

  it('still chimes when an interrupt abort request fails and the turn then completes normally', async () => {
    // If the abort POST fails, the turn was NOT actually interrupted and may complete
    // normally. The abort flag must not stick, or a real completion gets no green/sound.
    const manager = makeFakeManager()
    let resolveIdle: (() => void) | undefined
    manager.onceIdle = vi.fn(() => new Promise<void>((resolve) => { resolveIdle = resolve }))
    manager.abort = vi.fn(async () => { throw new Error('abort failed') })
    const adapter = makeAdapter(manager)
    await adapter.create({ requestId: 'req-af', sessionType: 'freshopencode', provider: 'opencode' })
    const events: unknown[] = []
    adapter.subscribe?.('freshopencode-req-af', (e) => events.push(e))

    const sendPromise = adapter.send?.('freshopencode-req-af', { text: 'go' })
    await vi.waitFor(() => expect(manager.onceIdle).toHaveBeenCalled())

    await expect(adapter.interrupt?.('freshopencode-req-af')).rejects.toThrow('abort failed')
    // Abort failed → the turn proceeds and completes normally.
    resolveIdle?.()
    await sendPromise

    const completions = events.filter((e) => !!e && typeof e === 'object' && (e as { type?: unknown }).type === 'sdk.turn.complete')
    expect(completions).toHaveLength(1)
  })

  it('does NOT emit sdk.turn.complete when the turn reports session.error before going idle', async () => {
    // OpenCode surfaces a failed turn via an out-of-band `session.error` SSE event and
    // then lets the session go idle. onceIdle resolves on that idle (it never inspects the
    // error), so the success path must independently know the turn errored — otherwise a
    // failed turn falsely greens/chimes as a positive completion. This is the OpenCode
    // analogue of Claude's `subtype === 'success'` and Codex's `status === 'completed'`.
    const manager = makeFakeManager()
    let resolveIdle: (() => void) | undefined
    manager.onceIdle = vi.fn(() => new Promise<void>((resolve) => { resolveIdle = resolve }))
    const adapter = makeAdapter(manager)
    await adapter.create({ requestId: 'req-err', sessionType: 'freshopencode', provider: 'opencode' })
    const events: unknown[] = []
    adapter.subscribe?.('freshopencode-req-err', (e) => events.push(e))

    const sendPromise = adapter.send?.('freshopencode-req-err', { text: 'go' })
    await vi.waitFor(() => expect(manager.onceIdle).toHaveBeenCalled())

    // The turn errors (relayed as sdk.error) and then the session goes idle.
    manager._emit('ses_real_1', { kind: 'session.error', sessionId: 'ses_real_1', properties: { error: { message: 'provider boom' } } })
    resolveIdle?.()
    await sendPromise

    const completions = events.filter((e) => !!e && typeof e === 'object' && (e as { type?: unknown }).type === 'sdk.turn.complete')
    expect(completions).toHaveLength(0)
    // The error is still surfaced, and the pane still returns to idle (clears blue).
    expect(events.some((e) => !!e && typeof e === 'object' && (e as { type?: unknown }).type === 'sdk.error')).toBe(true)
    expect(events).toContainEqual({ type: 'sdk.session.snapshot', sessionId: 'freshopencode-req-err', status: 'idle' })
  })

  it('resumes chiming on the next clean turn after an errored turn', async () => {
    // The error flag must reset per turn, exactly like the abort flag — a single failed
    // turn must not permanently suppress completion chimes.
    const manager = makeFakeManager()
    let resolveIdle: (() => void) | undefined
    manager.onceIdle = vi.fn(() => new Promise<void>((resolve) => { resolveIdle = resolve }))
    const adapter = makeAdapter(manager)
    await adapter.create({ requestId: 'req-err2', sessionType: 'freshopencode', provider: 'opencode' })
    const events: unknown[] = []
    adapter.subscribe?.('freshopencode-req-err2', (e) => events.push(e))

    const errored = adapter.send?.('freshopencode-req-err2', { text: 'one' })
    await vi.waitFor(() => expect(manager.onceIdle).toHaveBeenCalledTimes(1))
    manager._emit('ses_real_1', { kind: 'session.error', sessionId: 'ses_real_1', properties: { error: { message: 'boom' } } })
    resolveIdle?.()
    await errored

    // A subsequent clean turn (no error) must chime again — the error flag must not stick.
    manager.onceIdle = vi.fn(async () => undefined)
    await adapter.send?.('freshopencode-req-err2', { text: 'two' })
    const completions = events.filter((e) => !!e && typeof e === 'object' && (e as { type?: unknown }).type === 'sdk.turn.complete')
    expect(completions).toHaveLength(1)
  })

  it('does NOT emit sdk.turn.complete when a send aborts (onceIdle rejects)', async () => {
    const manager = makeFakeManager()
    manager.onceIdle = vi.fn(() => Promise.reject(new Error('opencode serve sidecar was lost.')))
    const adapter = makeAdapter(manager)
    await adapter.create({ requestId: 'req-abort', sessionType: 'freshopencode', provider: 'opencode' })
    const events: unknown[] = []
    adapter.subscribe?.('freshopencode-req-abort', (e) => events.push(e))
    await expect(adapter.send?.('freshopencode-req-abort', { text: 'go' })).rejects.toThrow()

    // The catch path still returns the pane to idle (clearing blue) but must not chime.
    expect(events).toContainEqual({ type: 'sdk.session.snapshot', sessionId: 'freshopencode-req-abort', status: 'idle' })
    expect(events.find((e) => !!e && typeof e === 'object' && (e as { type?: unknown }).type === 'sdk.turn.complete')).toBeUndefined()
  })

  it('emits running before first-send session materialization resolves', async () => {
    const manager = makeFakeManager()
    const createSession = createDeferred<{ id: string; directory?: string; title?: string }>()
    const prompt = createDeferred<void>()
    manager.createSession.mockReturnValueOnce(createSession.promise)
    manager.promptAsync.mockReturnValueOnce(prompt.promise)
    const adapter = makeAdapter(manager)
    await adapter.create({ requestId: 'slow-create', sessionType: 'freshopencode', provider: 'opencode' })

    const events: unknown[] = []
    adapter.subscribe?.('freshopencode-slow-create', (e) => events.push(e))
    const send = adapter.send?.('freshopencode-slow-create', { text: 'go' })
    let sendSettled = false
    void send?.finally(() => { sendSettled = true })

    await Promise.resolve()
    expect(events).toContainEqual({
      type: 'sdk.session.snapshot',
      sessionId: 'freshopencode-slow-create',
      status: 'running',
    })
    expect(manager.promptAsync).not.toHaveBeenCalled()

    createSession.resolve({ id: 'ses_real_1', title: 'T' })
    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: 'freshAgent.session.materialized',
        previousSessionId: 'freshopencode-slow-create',
        sessionId: 'ses_real_1',
        sessionRef: { provider: 'opencode', sessionId: 'ses_real_1' },
      })
      expect(manager.promptAsync).toHaveBeenCalled()
    })
    expect(sendSettled).toBe(false)

    prompt.resolve()
    await expect(send).resolves.toEqual({
      sessionId: 'ses_real_1',
      sessionRef: { provider: 'opencode', sessionId: 'ses_real_1' },
    })
  })

  it('returns to idle when first-send session materialization fails', async () => {
    const manager = makeFakeManager()
    manager.createSession.mockRejectedValueOnce(new Error('session create timed out'))
    const adapter = makeAdapter(manager)
    await adapter.create({ requestId: 'create-fails', sessionType: 'freshopencode', provider: 'opencode' })

    const events: unknown[] = []
    adapter.subscribe?.('freshopencode-create-fails', (e) => events.push(e))

    await expect(adapter.send?.('freshopencode-create-fails', { text: 'go' })).rejects.toThrow('session create timed out')
    expect(events).toEqual(expect.arrayContaining([
      { type: 'sdk.session.snapshot', sessionId: 'freshopencode-create-fails', status: 'running' },
      { type: 'sdk.session.snapshot', sessionId: 'freshopencode-create-fails', status: 'idle' },
    ]))
  })

  it('passes the effective cwd to createSession on first materialization', async () => {
    const manager = makeFakeManager()
    const adapter = makeAdapter(manager)
    await adapter.create({ requestId: 'cwd-1', sessionType: 'freshopencode', provider: 'opencode', cwd: '/project-x' })
    await adapter.send?.('freshopencode-cwd-1', { text: 'hi' })
    expect(manager.createSession).toHaveBeenCalledTimes(1)
    expect(manager.createSession).toHaveBeenLastCalledWith({ directory: '/project-x' })
    expect(manager.promptAsync).toHaveBeenCalledWith(
      'ses_real_1',
      expect.objectContaining({ parts: [{ type: 'text', text: 'hi' }] }),
      { cwd: '/project-x' },
    )
    expect(manager.onceIdle).toHaveBeenCalledWith('ses_real_1', expect.any(Number), { cwd: '/project-x' })
  })

  it('rejects invalid selected cwd before creating an OpenCode session', async () => {
    const manager = makeFakeManager()
    const validateCwd = vi.fn(async () => { throw new Error('cwd is not a directory: /missing') })
    const adapter = makeAdapter(manager, { validateCwd } as any)
    await adapter.create({ requestId: 'bad-cwd', sessionType: 'freshopencode', provider: 'opencode', cwd: '/missing' })

    await expect(adapter.send?.('freshopencode-bad-cwd', { text: 'go' }))
      .rejects.toThrow('cwd is not a directory: /missing')
    expect(validateCwd).toHaveBeenCalledWith('/missing')
    expect(manager.createSession).not.toHaveBeenCalled()
  })

  it('validates send-time cwd overrides before materialization', async () => {
    const manager = makeFakeManager()
    const validateCwd = vi.fn(async () => undefined)
    const adapter = makeAdapter(manager, { validateCwd } as any)
    await adapter.create({ requestId: 'override-cwd', sessionType: 'freshopencode', provider: 'opencode', cwd: '/old' })
    await adapter.send?.('freshopencode-override-cwd', { text: 'go', settings: { cwd: '/new' } })

    expect(validateCwd).toHaveBeenCalledWith('/new')
    expect(manager.createSession).toHaveBeenCalledWith({ directory: '/new' })
    expect(manager.onceIdle).toHaveBeenCalledWith('ses_real_1', expect.any(Number), { cwd: '/new' })
  })

  it('passes restored cwd when sending to an attached durable session', async () => {
    const manager = makeFakeManager()
    const adapter = makeAdapter(manager)

    await adapter.attach?.({
      sessionType: 'freshopencode',
      provider: 'opencode',
      sessionId: 'ses_attached_send',
      cwd: '/repo/restored-worktree',
    })
    await adapter.send?.('ses_attached_send', { text: 'continue' })

    expect(manager.getSession).toHaveBeenCalledWith('ses_attached_send', { cwd: '/repo/restored-worktree' })
    expect(manager.promptAsync).toHaveBeenCalledWith(
      'ses_attached_send',
      { parts: [{ type: 'text', text: 'continue' }] },
      { cwd: '/repo/restored-worktree' },
    )
  })

  it('does not validate a placeholder attach before first materialization', async () => {
    const manager = makeFakeManager()
    const adapter = makeAdapter(manager)

    await adapter.create({ requestId: 'placeholder-attach', sessionType: 'freshopencode', provider: 'opencode', cwd: '/repo/placeholder' })
    await expect(adapter.attach?.({
      sessionType: 'freshopencode',
      provider: 'opencode',
      sessionId: 'freshopencode-placeholder-attach',
      cwd: '/repo/placeholder',
    })).resolves.toEqual({
      sessionId: 'freshopencode-placeholder-attach',
      sessionRef: { provider: 'opencode', sessionId: 'freshopencode-placeholder-attach' },
    })
    expect(manager.getSession).not.toHaveBeenCalled()

    await adapter.send?.('freshopencode-placeholder-attach', { text: 'materialize' })
    expect(manager.createSession).toHaveBeenCalledWith({ directory: '/repo/placeholder' })
  })

  it('keeps no-cwd recovered durable sessions readable but not sendable', async () => {
    const manager = makeFakeManager()
    manager.getSession.mockResolvedValueOnce({
      id: 'ses_no_cwd',
      time: { updated: 10 },
    })
    manager.listMessages.mockResolvedValueOnce({ messages: [], nextCursor: null })
    const adapter = makeAdapter(manager)

    await expect(adapter.attach?.({
      sessionType: 'freshopencode',
      provider: 'opencode',
      sessionId: 'ses_no_cwd',
    })).resolves.toEqual({
      sessionId: 'ses_no_cwd',
      sessionRef: { provider: 'opencode', sessionId: 'ses_no_cwd' },
    })

    await expect(adapter.getSnapshot?.({
      threadId: 'ses_no_cwd',
      sessionType: 'freshopencode',
      provider: 'opencode',
    })).resolves.toEqual(expect.objectContaining({ threadId: 'ses_no_cwd' }))

    await expect(adapter.send?.('ses_no_cwd', { text: 'must not send' })).rejects.toThrow(/cwd/i)
    expect(manager.promptAsync).not.toHaveBeenCalled()
  })

  it('validates a recovered durable session directory before mutating it', async () => {
    const manager = makeFakeManager()
    manager.getSession.mockResolvedValueOnce({
      id: 'ses_recovered',
      directory: '/repo/safe',
      time: { updated: 10 },
    })
    const adapter = makeAdapter(manager, { canonicalizePath: async (value: string) => value } as any)

    await expect(adapter.attach?.({
      sessionId: 'ses_recovered',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/safe',
    })).resolves.toEqual({
      sessionId: 'ses_recovered',
      sessionRef: { provider: 'opencode', sessionId: 'ses_recovered' },
    })

    await adapter.send?.('ses_recovered', { text: 'continue' })
    expect(manager.getSession).toHaveBeenCalledWith('ses_recovered', { cwd: '/repo/safe' })
    expect(manager.promptAsync).toHaveBeenCalledWith(
      'ses_recovered',
      expect.objectContaining({ parts: [{ type: 'text', text: 'continue' }] }),
      { cwd: '/repo/safe' },
    )
  })

  it('rejects recovered durable session attach when OpenCode reports a different directory', async () => {
    const manager = makeFakeManager()
    manager.getSession.mockResolvedValueOnce({
      id: 'ses_wrong',
      directory: '/repo/other',
      time: { updated: 10 },
    })
    const adapter = makeAdapter(manager, { canonicalizePath: async (value: string) => value } as any)

    await expect(adapter.attach?.({
      sessionId: 'ses_wrong',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/safe',
    })).rejects.toThrow(/belongs to|directory/i)
    expect(manager.promptAsync).not.toHaveBeenCalled()
  })

  it('rejects kill for no-cwd recovered durable sessions', async () => {
    const manager = makeFakeManager()
    const adapter = makeAdapter(manager)

    await adapter.attach?.({
      sessionId: 'ses_kill_no_cwd',
      sessionType: 'freshopencode',
      provider: 'opencode',
    })

    await expect(adapter.kill?.('ses_kill_no_cwd')).rejects.toThrow(/cwd/i)
  })

  it('marks recovered durable sessions running only when OpenCode status is busy or retry', async () => {
    const manager = makeFakeManager()
    manager.getSessionStatus = vi.fn(async () => ({ type: 'busy' }))
    // Keep the restore idle-recovery monitor (zrrj) pending so the session stays running.
    manager.onceIdle = vi.fn(() => new Promise<void>(() => {}))
    const adapter = makeAdapter(manager)

    await adapter.attach?.({
      sessionId: 'ses_busy',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/safe',
    })
    const snapshot = await adapter.getSnapshot?.({
      threadId: 'ses_busy',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/safe',
    }) as any

    expect(snapshot.status).toBe('running')
    expect(manager.getSessionStatus).toHaveBeenCalledWith('ses_busy', { cwd: '/repo/safe' })
  })

  it('resets an existing attached session back to idle when status reconciliation is malformed', async () => {
    loggerMocks.logger.warn.mockClear()
    const manager = makeFakeManager()
    manager.getSessionStatus = vi.fn()
      .mockResolvedValueOnce({ type: 'busy' })
      .mockResolvedValueOnce({ nope: 'bad' })
    // Keep the restore idle-recovery monitor (zrrj) pending so the first attach stays running.
    manager.onceIdle = vi.fn(() => new Promise<void>(() => {}))
    const adapter = makeAdapter(manager)

    await adapter.attach?.({
      sessionId: 'ses_cached',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/safe',
    })
    await expect(adapter.getSnapshot?.({
      threadId: 'ses_cached',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/safe',
    })).resolves.toMatchObject({ status: 'running' })

    await adapter.attach?.({
      sessionId: 'ses_cached',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/safe',
    })

    await expect(adapter.getSnapshot?.({
      threadId: 'ses_cached',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/safe',
    })).resolves.toMatchObject({ status: 'idle' })
    expect(loggerMocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'malformed_session_status' }),
      'opencode status reconciliation received malformed status',
    )
  })

  it('treats a session absent from the status map as idle (no malformed warning)', async () => {
    loggerMocks.logger.warn.mockClear()
    const manager = makeFakeManager()
    // The opencode /session/status map only reports active (busy/retry) sessions;
    // an idle session is absent (undefined). This must NOT be treated as malformed
    // (it matches the serve manager's onceIdle semantics).
    manager.getSessionStatus = vi.fn(async () => undefined)
    const adapter = makeAdapter(manager)

    await adapter.attach?.({
      sessionId: 'ses_idle_absent',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/safe',
    })

    await expect(adapter.getSnapshot?.({
      threadId: 'ses_idle_absent',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/safe',
    })).resolves.toMatchObject({ status: 'idle' })
    expect(manager.getSessionStatus).toHaveBeenCalledWith('ses_idle_absent', { cwd: '/repo/safe' })
    expect(loggerMocks.logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'malformed_session_status' }),
      expect.any(String),
    )
  })

  it('keeps recovered sessions idle and warns when getSessionStatus is missing', async () => {
    loggerMocks.logger.warn.mockClear()
    const manager = makeFakeManager()
    delete (manager as Partial<FakeManager>).getSessionStatus
    const adapter = makeAdapter(manager)

    await adapter.attach?.({
      sessionId: 'ses_no_helper',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/safe',
    })

    await expect(adapter.getSnapshot?.({
      threadId: 'ses_no_helper',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/safe',
    })).resolves.toMatchObject({ status: 'idle' })
    expect(loggerMocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'missing_get_session_status' }),
      'opencode status reconciliation skipped',
    )
  })

  it('keeps resumed sessions idle when getSessionStatus throws and still does not fail resume', async () => {
    loggerMocks.logger.warn.mockClear()
    const manager = makeFakeManager()
    manager.getSessionStatus = vi.fn(async () => { throw new Error('status failed') })
    const adapter = makeAdapter(manager)

    await expect(adapter.resume?.({
      resumeSessionId: 'ses_resume_throw',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/safe',
    })).resolves.toEqual({
      sessionId: 'ses_resume_throw',
      sessionRef: { provider: 'opencode', sessionId: 'ses_resume_throw' },
    })

    await expect(adapter.getSnapshot?.({
      threadId: 'ses_resume_throw',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/safe',
    })).resolves.toMatchObject({ status: 'idle' })
    expect(loggerMocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'get_session_status_failed' }),
      'opencode status reconciliation failed',
    )
  })

  it('marks resumed durable sessions running when OpenCode reports retry', async () => {
    const manager = makeFakeManager()
    manager.getSessionStatus = vi.fn(async () => ({ type: 'retry' }))
    // Keep the restore idle-recovery monitor (zrrj) pending so the session stays running.
    manager.onceIdle = vi.fn(() => new Promise<void>(() => {}))
    const adapter = makeAdapter(manager)

    await adapter.resume?.({
      resumeSessionId: 'ses_resume_retry',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/safe',
    })

    await expect(adapter.getSnapshot?.({
      threadId: 'ses_resume_retry',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/safe',
    })).resolves.toMatchObject({ status: 'running' })
    expect(manager.getSessionStatus).toHaveBeenCalledWith('ses_resume_retry', { cwd: '/repo/safe' })
  })

  it('recovers from a failed send and still processes later sends', async () => {
    const manager = makeFakeManager()
    const adapter = makeAdapter(manager)
    await adapter.create({ requestId: 'resilient-1', sessionType: 'freshopencode', provider: 'opencode' })

    let calls = 0
    manager.promptAsync.mockImplementation(async () => {
      calls += 1
      if (calls === 1) throw new Error('prompt failed')
    })

    const events: unknown[] = []
    adapter.subscribe?.('freshopencode-resilient-1', (e) => events.push(e))

    await expect(adapter.send?.('freshopencode-resilient-1', { text: 'first' })).rejects.toThrow('prompt failed')
    expect(events).toContainEqual({ type: 'sdk.session.snapshot', sessionId: 'freshopencode-resilient-1', status: 'idle' })

    const result = await adapter.send?.('freshopencode-resilient-1', { text: 'second' })
    expect(result).toEqual({ sessionId: 'ses_real_1', sessionRef: { provider: 'opencode', sessionId: 'ses_real_1' } })
    expect(manager.createSession).toHaveBeenCalledTimes(1)
    expect(manager.promptAsync).toHaveBeenCalledTimes(2)
    expect(manager.promptAsync).toHaveBeenNthCalledWith(2, 'ses_real_1', expect.objectContaining({ parts: [{ type: 'text', text: 'second' }] }))
  })

  it('does not produce an unhandled rejection when promptAsync fails while onceIdle is still pending', async () => {
    const manager = makeFakeManager()
    let idleReject!: (reason: Error) => void
    manager.onceIdle = vi.fn(() => new Promise<void>((_, reject) => { idleReject = reject }))
    manager.promptAsync = vi.fn(async () => { throw new Error('prompt rejected') })

    const adapter = makeAdapter(manager)
    await adapter.create({ requestId: 'unhandled-1', sessionType: 'freshopencode', provider: 'opencode' })

    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      await expect(adapter.send?.('freshopencode-unhandled-1', { text: 'boom' })).rejects.toThrow('prompt rejected')
      // Simulating the idle timeout rejection that would otherwise arrive later.
      idleReject(new Error('idle timeout'))
    await new Promise((r) => setTimeout(r, 10))
    expect(unhandled).not.toHaveBeenCalled()
  } finally {
    process.off('unhandledRejection', unhandled)
  }
  })

  it('emits idle status and rejects when onceIdle rejects with a lost-session error (sidecar died)', async () => {
    const manager = makeFakeManager()
    manager.onceIdle = vi.fn(() => Promise.reject(new Error('opencode serve sidecar was lost.')))
    const adapter = makeAdapter(manager)
    await adapter.create({ requestId: 'lost-1', sessionType: 'freshopencode', provider: 'opencode' })

    const events: unknown[] = []
    adapter.subscribe?.('freshopencode-lost-1', (e) => events.push(e))

    await expect(adapter.send?.('freshopencode-lost-1', { text: 'hi' })).rejects.toThrow(/sidecar was lost/i)
    expect(events).toContainEqual({ type: 'sdk.session.snapshot', sessionId: 'freshopencode-lost-1', status: 'idle' })
  })

  it('does not return to running when OpenCode emits a late message update after idle', async () => {
    const manager = makeFakeManager()
    const adapter = makeAdapter(manager)
    await adapter.create({ requestId: 'late-update', sessionType: 'freshopencode', provider: 'opencode' })

    const events: unknown[] = []
    adapter.subscribe?.('freshopencode-late-update', (event) => events.push(event))

    await adapter.send?.('freshopencode-late-update', { text: 'go' })
    manager._emit('ses_real_1', {
      kind: 'session.idle',
      sessionId: 'ses_real_1',
      properties: { sessionID: 'ses_real_1' },
      raw: { type: 'session.idle', properties: { sessionID: 'ses_real_1' } },
    })
    manager._emit('ses_real_1', {
      kind: 'message.updated',
      sessionId: 'ses_real_1',
      properties: { sessionID: 'ses_real_1', info: { id: 'msg_user_1', role: 'user' } },
      raw: { type: 'message.updated', properties: { sessionID: 'ses_real_1' } },
    })

    expect(events).toContainEqual({
      type: 'sdk.session.snapshot',
      sessionId: 'freshopencode-late-update',
      status: 'idle',
    })
    expect(events.at(-1)).toEqual({
      type: 'sdk.session.changed',
      sessionId: 'freshopencode-late-update',
      reason: 'opencode-message',
    })
    await expect(adapter.getSnapshot?.({
      sessionType: 'freshopencode',
      provider: 'opencode',
      threadId: 'freshopencode-late-update',
    })).resolves.toMatchObject({ status: 'idle' })
  })

  it('forwards compact instructions to the serve manager', async () => {
    const manager = makeFakeManager()
    const adapter = makeAdapter(manager)
    await adapter.create({ requestId: 'compact-1', sessionType: 'freshopencode', provider: 'opencode' })
    await adapter.send?.('freshopencode-compact-1', { text: 'go' })
    await adapter.compact?.('freshopencode-compact-1', { instructions: 'keep it short' })
    expect(manager.compact).toHaveBeenCalledWith('ses_real_1', { instructions: 'keep it short' })
  })
})

describe('OpenCode serve adapter: history reads', () => {
  const messages = [
    { info: { id: 'msg_user_1', role: 'user', time: { created: 1779557095868 } }, parts: [{ id: 'p1', type: 'text', text: 'reply ok' }] },
    { info: { id: 'msg_assistant_1', role: 'assistant', providerID: 'provider', modelID: 'model' }, parts: [{ id: 'p2', type: 'text', text: 'ok' }] },
  ]

  it('getSnapshot assembles HTTP messages into the normalized transcript', async () => {
    const manager = makeFakeManager()
    manager.getSession = vi.fn(async () => ({ id: 'ses_real_1', directory: '/repo/history', title: 'Kimi chat', time: { updated: 12 } }))
    manager.listMessages = vi.fn(async () => ({ messages, nextCursor: null }))
    const adapter = makeAdapter(manager)
    await adapter.attach?.({ sessionType: 'freshopencode', provider: 'opencode', sessionId: 'ses_real_1', cwd: '/repo/history' })
    await expect(adapter.getSnapshot?.({ sessionType: 'freshopencode', provider: 'opencode', threadId: 'ses_real_1' })).resolves.toMatchObject({
      sessionId: 'ses_real_1', summary: 'Kimi chat', revision: 12,
      turns: [{ turnId: 'msg_user_1', role: 'user', summary: 'reply ok' }, { turnId: 'msg_assistant_1', role: 'assistant', summary: 'ok' }],
    })
    expect(manager.getSession).toHaveBeenCalledWith('ses_real_1', { cwd: '/repo/history' })
    expect(manager.listMessages).toHaveBeenCalledWith('ses_real_1', { limit: 200 }, { cwd: '/repo/history' })
  })

  it('omits history route arguments when no cwd is known', async () => {
    const manager = makeFakeManager()
    manager.getSession = vi.fn(async () => ({ id: 'ses_real_1', title: 'Kimi chat', time: { updated: 12 } }))
    manager.listMessages = vi.fn(async () => ({ messages, nextCursor: null }))
    manager.getMessage = vi.fn(async () => messages[1])
    const adapter = makeAdapter(manager)

    await adapter.attach?.({ sessionType: 'freshopencode', provider: 'opencode', sessionId: 'ses_real_1' })
    await adapter.getSnapshot?.({ sessionType: 'freshopencode', provider: 'opencode', threadId: 'ses_real_1' })
    await adapter.getTurnPage?.({ sessionType: 'freshopencode', provider: 'opencode', threadId: 'ses_real_1' }, { limit: 1, revision: 0 })
    await adapter.getTurnBody?.({ sessionType: 'freshopencode', provider: 'opencode', threadId: 'ses_real_1', turnId: 'msg_assistant_1' }, 12)

    expect(manager.getSession).toHaveBeenNthCalledWith(1, 'ses_real_1')
    expect(manager.getSession).toHaveBeenNthCalledWith(2, 'ses_real_1')
    expect(manager.listMessages).toHaveBeenNthCalledWith(1, 'ses_real_1', { limit: 200 })
    expect(manager.listMessages).toHaveBeenNthCalledWith(2, 'ses_real_1', { limit: 1, before: undefined })
    expect(manager.getMessage).toHaveBeenCalledWith('ses_real_1', 'msg_assistant_1')
  })

  it('getTurnPage forwards cursor as before= and returns nextCursor from the header', async () => {
    const manager = makeFakeManager()
    manager.listMessages = vi.fn(async () => ({ messages: messages.slice(0, 1), nextCursor: 'NEXT' }))
    const adapter = makeAdapter(manager)
    await adapter.attach?.({ sessionType: 'freshopencode', provider: 'opencode', sessionId: 'ses_real_1', cwd: '/repo/history' })
    const page = await adapter.getTurnPage?.({ sessionType: 'freshopencode', provider: 'opencode', threadId: 'ses_real_1' }, { cursor: 'CUR', limit: 1, revision: 0 })
    expect(page).toMatchObject({ nextCursor: 'NEXT', turns: [{ turnId: 'msg_user_1' }] })
    expect(manager.getSession).toHaveBeenCalledWith('ses_real_1', { cwd: '/repo/history' })
    expect(manager.listMessages).toHaveBeenCalledWith('ses_real_1', { limit: 1, before: 'CUR' }, { cwd: '/repo/history' })
  })

  it('getTurnBody fetches a single message and normalizes it', async () => {
    const manager = makeFakeManager()
    manager.getMessage = vi.fn(async () => messages[1])
    const adapter = makeAdapter(manager)
    await adapter.attach?.({ sessionType: 'freshopencode', provider: 'opencode', sessionId: 'ses_real_1', cwd: '/repo/history' })
    await expect(adapter.getTurnBody?.({ sessionType: 'freshopencode', provider: 'opencode', threadId: 'ses_real_1', turnId: 'msg_assistant_1' }, 12)).resolves.toMatchObject({
      turnId: 'msg_assistant_1', role: 'assistant', items: expect.arrayContaining([expect.objectContaining({ kind: 'text', text: 'ok' })]),
    })
    expect(manager.getMessage).toHaveBeenCalledWith('ses_real_1', 'msg_assistant_1', { cwd: '/repo/history' })
  })

  it('reports fork capability true and approvals/questions false', async () => {
    const manager = makeFakeManager()
    manager.getSession = vi.fn(async () => ({ id: 'ses_real_1', directory: '/repo/history', time: { updated: 1 } }))
    manager.listMessages = vi.fn(async () => ({ messages: [], nextCursor: null }))
    const adapter = makeAdapter(manager)
    await adapter.attach?.({ sessionType: 'freshopencode', provider: 'opencode', sessionId: 'ses_real_1', cwd: '/repo/history' })
    const snap: any = await adapter.getSnapshot?.({ sessionType: 'freshopencode', provider: 'opencode', threadId: 'ses_real_1' })
    expect(snap.capabilities).toMatchObject({ fork: true, approvals: false, questions: false })
  })
})

describe('OpenCode serve adapter: control', () => {
  async function materialized() {
    const manager = makeFakeManager()
    const adapter = makeAdapter(manager)
    await adapter.create({ requestId: 'req-c', sessionType: 'freshopencode', provider: 'opencode' })
    await adapter.send?.('freshopencode-req-c', { text: 'go' })
    return { manager, adapter }
  }

  it('interrupt calls abort on the real session', async () => {
    const { manager, adapter } = await materialized()
    await adapter.interrupt?.('freshopencode-req-c')
    expect(manager.abort).toHaveBeenCalledWith('ses_real_1')
  })

  it('rejects interrupt for no-cwd recovered durable sessions', async () => {
    const manager = makeFakeManager()
    const adapter = makeAdapter(manager)

    await adapter.attach?.({
      sessionType: 'freshopencode',
      provider: 'opencode',
      sessionId: 'ses_interrupt_no_cwd',
    })

    await expect(adapter.interrupt?.('ses_interrupt_no_cwd')).rejects.toThrow(/cwd/i)
    expect(manager.abort).not.toHaveBeenCalled()
  })

  it('rejects interrupt when OpenCode abort fails', async () => {
    const { manager, adapter } = await materialized()
    manager.abort.mockRejectedValueOnce(new Error('abort failed upstream'))

    await expect(adapter.interrupt?.('freshopencode-req-c')).rejects.toThrow('abort failed upstream')
  })

  it('compact calls the dedicated compact endpoint', async () => {
    const { manager, adapter } = await materialized()
    await adapter.compact?.('freshopencode-req-c')
    expect(manager.compact).toHaveBeenCalledWith('ses_real_1')
  })

  it('emits a server-authoritative sdk.turn.complete on a successful compact', async () => {
    // Removing the client busy->idle derivation left compact (a user-visible /compact
    // command) with no completion edge; like a normal send it must green/chime when done.
    const { adapter } = await materialized()
    const events: unknown[] = []
    adapter.subscribe?.('freshopencode-req-c', (e) => events.push(e))
    await adapter.compact?.('freshopencode-req-c', { instructions: 'trim' })
    const completions = events.filter((e) => !!e && typeof e === 'object' && (e as { type?: unknown }).type === 'sdk.turn.complete')
    expect(completions).toHaveLength(1)
  })

  it('fork registers child state so the child session can be sent/subscribed', async () => {
    const { manager, adapter } = await materialized()
    await expect(adapter.fork?.('freshopencode-req-c')).resolves.toEqual({
      sessionId: 'ses_child_1', sessionRef: { provider: 'opencode', sessionId: 'ses_child_1' },
    })
    const events: unknown[] = []
    const off = adapter.subscribe?.('ses_child_1', (e) => events.push(e)) ?? (() => {})
    try {
      await adapter.send?.('ses_child_1', { text: 'child turn' })
      expect(manager.promptAsync).toHaveBeenCalledWith('ses_child_1', expect.objectContaining({ parts: [{ type: 'text', text: 'child turn' }] }))
      manager._emit('ses_child_1', { kind: 'session.idle', sessionId: 'ses_child_1', raw: { type: 'session.idle', properties: { sessionID: 'ses_child_1' } } })
      expect(events).toContainEqual({ type: 'sdk.session.snapshot', sessionId: 'ses_child_1', status: 'idle' })
    } finally {
      off()
    }
  })

  it('routes control operations through the known cwd', async () => {
    const manager = makeFakeManager()
    const adapter = makeAdapter(manager)

    await adapter.attach?.({
      sessionType: 'freshopencode',
      provider: 'opencode',
      sessionId: 'ses_known_cwd',
      cwd: '/repo/control',
    })

    await adapter.interrupt?.('ses_known_cwd')
    await adapter.compact?.('ses_known_cwd', { instructions: 'trim' })
    await expect(adapter.fork?.('ses_known_cwd')).resolves.toEqual({
      sessionId: 'ses_child_1',
      sessionRef: { provider: 'opencode', sessionId: 'ses_child_1' },
    })
    await adapter.send?.('ses_child_1', { text: 'child continue' })

    expect(manager.getSession).toHaveBeenCalledWith('ses_known_cwd', { cwd: '/repo/control' })
    expect(manager.abort).toHaveBeenCalledWith('ses_known_cwd', { cwd: '/repo/control' })
    expect(manager.compact).toHaveBeenCalledWith('ses_known_cwd', { instructions: 'trim' }, { cwd: '/repo/control' })
    expect(manager.fork).toHaveBeenCalledWith('ses_known_cwd', { cwd: '/repo/control' })
    expect(manager.promptAsync).toHaveBeenCalledWith(
      'ses_child_1',
      expect.objectContaining({ parts: [{ type: 'text', text: 'child continue' }] }),
      { cwd: '/repo/control' },
    )
  })

  it('routes forked children through the returned child directory when present', async () => {
    const manager = makeFakeManager()
    manager.fork.mockResolvedValueOnce({ id: 'ses_child_1', directory: '/repo/child' })
    const adapter = makeAdapter(manager)

    await adapter.attach?.({
      sessionType: 'freshopencode',
      provider: 'opencode',
      sessionId: 'ses_parent',
      cwd: '/repo/parent',
    })

    await expect(adapter.fork?.('ses_parent')).resolves.toEqual({
      sessionId: 'ses_child_1',
      sessionRef: { provider: 'opencode', sessionId: 'ses_child_1' },
    })
    await adapter.send?.('ses_child_1', { text: 'child turn' })

    expect(manager.fork).toHaveBeenCalledWith('ses_parent', { cwd: '/repo/parent' })
    expect(manager.promptAsync).toHaveBeenCalledWith(
      'ses_child_1',
      expect.objectContaining({ parts: [{ type: 'text', text: 'child turn' }] }),
      { cwd: '/repo/child' },
    )
  })

  it('shutdown delegates to the serve manager', async () => {
    const { manager, adapter } = await materialized()
    await adapter.shutdown?.()
    expect(manager.shutdown).toHaveBeenCalled()
  })
})

describe('OpenCode serve adapter: status observability', () => {
  function findStatusEvents(): Array<Record<string, unknown>> {
    return observabilityMocks.recordFreshAgentObservabilityEvent.mock.calls
      .map(([event]) => event as Record<string, unknown>)
      .filter((event) => event.kind === 'fresh_agent_opencode_status_observed')
  }

  it('logs running and idle status from adapter emitStatus during a send', async () => {
    observabilityMocks.recordFreshAgentObservabilityEvent.mockClear()
    const manager = makeFakeManager()
    const adapter = makeAdapter(manager)
    await adapter.create({ requestId: 'obs-1', sessionType: 'freshopencode', provider: 'opencode', cwd: '/repo' })
    await adapter.send?.('freshopencode-obs-1', { text: 'go' })

    const statusEvents = findStatusEvents()
    const running = statusEvents.find((e) => e.status === 'running')
    const idle = statusEvents.find((e) => e.status === 'idle')
    expect(running).toBeDefined()
    expect(idle).toBeDefined()
    expect(running!.source).toBe('adapter')
    expect(idle!.source).toBe('adapter')
    expect(running!.provider).toBe('opencode')
    // Session id is hashed, not raw
    expect(JSON.stringify(running)).not.toContain('ses_real_1')
    expect(JSON.stringify(idle)).not.toContain('ses_real_1')
  })

  it('logs idle status from adapter emitStatus when send fails', async () => {
    observabilityMocks.recordFreshAgentObservabilityEvent.mockClear()
    const manager = makeFakeManager()
    manager.createSession.mockRejectedValueOnce(new Error('boom'))
    const adapter = makeAdapter(manager)
    await adapter.create({ requestId: 'obs-fail', sessionType: 'freshopencode', provider: 'opencode' })

    await expect(adapter.send?.('freshopencode-obs-fail', { text: 'go' })).rejects.toThrow('boom')

    const statusEvents = findStatusEvents()
    const running = statusEvents.find((e) => e.status === 'running')
    const idle = statusEvents.find((e) => e.status === 'idle')
    expect(running).toBeDefined()
    expect(idle).toBeDefined()
  })

  it('logs status from SSE session.idle with source=sse and opencodeEventKind', async () => {
    observabilityMocks.recordFreshAgentObservabilityEvent.mockClear()
    const manager = makeFakeManager()
    const adapter = makeAdapter(manager)
    await adapter.create({ requestId: 'obs-sse', sessionType: 'freshopencode', provider: 'opencode' })
    await adapter.send?.('freshopencode-obs-sse', { text: 'go' })
    observabilityMocks.recordFreshAgentObservabilityEvent.mockClear()

    manager._emit('ses_real_1', {
      kind: 'session.idle',
      sessionId: 'ses_real_1',
      properties: { sessionID: 'ses_real_1' },
      raw: { type: 'session.idle', properties: { sessionID: 'ses_real_1' } },
    })

    const statusEvents = findStatusEvents()
    expect(statusEvents).toHaveLength(1)
    expect(statusEvents[0].status).toBe('idle')
    expect(statusEvents[0].source).toBe('sse')
    expect(statusEvents[0].opencodeEventKind).toBe('session.idle')
    expect(JSON.stringify(statusEvents[0])).not.toContain('ses_real_1')
  })

  it('logs status from SSE session.status busy with source=sse', async () => {
    observabilityMocks.recordFreshAgentObservabilityEvent.mockClear()
    const manager = makeFakeManager()
    const adapter = makeAdapter(manager)
    await adapter.create({ requestId: 'obs-sse-busy', sessionType: 'freshopencode', provider: 'opencode' })
    await adapter.send?.('freshopencode-obs-sse-busy', { text: 'go' })
    observabilityMocks.recordFreshAgentObservabilityEvent.mockClear()

    manager._emit('ses_real_1', {
      kind: 'session.status',
      sessionId: 'ses_real_1',
      properties: { sessionID: 'ses_real_1', status: { type: 'busy' } },
      raw: { type: 'session.status', properties: { sessionID: 'ses_real_1', status: { type: 'busy' } } },
    })

    const statusEvents = findStatusEvents()
    expect(statusEvents).toHaveLength(1)
    expect(statusEvents[0].status).toBe('running')
    expect(statusEvents[0].source).toBe('sse')
    expect(statusEvents[0].opencodeEventKind).toBe('session.status')
  })

  it('does not log status for non-snapshot SSE events like message.updated', async () => {
    observabilityMocks.recordFreshAgentObservabilityEvent.mockClear()
    const manager = makeFakeManager()
    const adapter = makeAdapter(manager)
    await adapter.create({ requestId: 'obs-msg', sessionType: 'freshopencode', provider: 'opencode' })
    await adapter.send?.('freshopencode-obs-msg', { text: 'go' })
    observabilityMocks.recordFreshAgentObservabilityEvent.mockClear()

    manager._emit('ses_real_1', {
      kind: 'message.updated',
      sessionId: 'ses_real_1',
      properties: { sessionID: 'ses_real_1' },
      raw: { type: 'message.updated', properties: { sessionID: 'ses_real_1' } },
    })

    const statusEvents = findStatusEvents()
    expect(statusEvents).toHaveLength(0)
  })

  it('includes cwdHash when cwd is known', async () => {
    observabilityMocks.recordFreshAgentObservabilityEvent.mockClear()
    const manager = makeFakeManager()
    const adapter = makeAdapter(manager)
    await adapter.create({ requestId: 'obs-cwd', sessionType: 'freshopencode', provider: 'opencode', cwd: '/repo/work' })
    await adapter.send?.('freshopencode-obs-cwd', { text: 'go' })

    const statusEvents = findStatusEvents()
    const running = statusEvents.find((e) => e.status === 'running')
    expect(running).toBeDefined()
    expect(running!.cwdHash).toBeDefined()
    expect(running!.cwdHash).not.toBe('/repo/work')
  })
})

describe('restore reconciliation emits and monitors (zrrj)', () => {
  it('emits a running session snapshot when attach reconciles a busy durable session', async () => {
    // Ordering matters: attach registers the state via remember() BEFORE reconcile awaits
    // getSessionStatus, so park the status read on a deferred, start attach, subscribe once
    // the state is registered, THEN release the status read. The running emission must
    // happen inside reconcile, DURING attach — an implementation that arms a monitor but
    // never emits must FAIL here.
    const manager = makeFakeManager()
    const status = createDeferred<{ type: string } | undefined>()
    manager.getSessionStatus = vi.fn(() => status.promise)
    const adapter = makeAdapter(manager)
    const events: any[] = []
    const attaching = adapter.attach!({ sessionId: 'ses_live', sessionType: 'freshopencode', provider: 'opencode', cwd: '/w' })
    await new Promise((r) => setImmediate(r)) // remember() has run; status read still parked
    adapter.subscribe?.('ses_live', (ev) => events.push(ev))
    status.resolve({ type: 'busy' })
    await attaching
    expect(events.some((e) => e.type === 'sdk.session.snapshot' && e.status === 'running')).toBe(true)
  })

  it('arms exactly one idle-recovery monitor per durable session and chimes on resolve', async () => {
    const manager = makeFakeManager()
    manager.getSessionStatus = vi.fn(async () => ({ type: 'busy' }))
    const idle = createDeferred<void>()
    manager.onceIdle = vi.fn(() => idle.promise)
    const adapter = makeAdapter(manager)
    const events: any[] = []
    await adapter.attach!({ sessionId: 'ses_live', sessionType: 'freshopencode', provider: 'opencode', cwd: '/w' })
    await adapter.attach!({ sessionId: 'ses_live', sessionType: 'freshopencode', provider: 'opencode', cwd: '/w' }) // second restore path
    expect(manager.onceIdle).toHaveBeenCalledTimes(1) // exactly ONE monitor
    adapter.subscribe?.('ses_live', (ev) => events.push(ev))
    idle.resolve()
    await new Promise((r) => setImmediate(r))
    expect(events.some((e) => e.type === 'sdk.session.snapshot' && e.status === 'idle')).toBe(true)
    expect(events.some((e) => e.type === 'sdk.turn.complete' && typeof e.at === 'number')).toBe(true)
  })

  it('emits idle + a structured interruption signal when the monitor rejects with sidecar loss', async () => {
    const manager = makeFakeManager()
    manager.getSessionStatus = vi.fn(async () => ({ type: 'busy' }))
    const idle = createDeferred<void>()
    manager.onceIdle = vi.fn(() => idle.promise)
    const adapter = makeAdapter(manager)
    const events: any[] = []
    await adapter.attach!({ sessionId: 'ses_live', sessionType: 'freshopencode', provider: 'opencode', cwd: '/w' })
    adapter.subscribe?.('ses_live', (ev) => events.push(ev))
    idle.reject(new OpencodeServeLostError('ses_live'))
    await new Promise((r) => setImmediate(r))
    expect(events.some((e) => e.type === 'sdk.session.snapshot' && e.status === 'idle')).toBe(true)
    expect(events.some((e) => e.type === 'sdk.error' && /interrupted/i.test(e.message))).toBe(true)
    expect(events.some((e) => e.type === 'sdk.turn.complete')).toBe(false) // no chime on interruption
  })

  it('emits idle + a structured interruption signal when the monitor times out', async () => {
    const manager = makeFakeManager()
    manager.getSessionStatus = vi.fn(async () => ({ type: 'busy' }))
    const idle = createDeferred<void>()
    manager.onceIdle = vi.fn(() => idle.promise)
    const adapter = makeAdapter(manager)
    const events: any[] = []
    await adapter.attach!({ sessionId: 'ses_live', sessionType: 'freshopencode', provider: 'opencode', cwd: '/w' })
    adapter.subscribe?.('ses_live', (ev) => events.push(ev))
    idle.reject(new Error('Timed out after 600000ms waiting for OpenCode session ses_live to go idle.'))
    await new Promise((r) => setImmediate(r))
    expect(events.some((e) => e.type === 'sdk.session.snapshot' && e.status === 'idle')).toBe(true)
    expect(events.some((e) => e.type === 'sdk.error' && /interrupted/i.test(e.message))).toBe(true)
    expect(events.some((e) => e.type === 'sdk.turn.complete')).toBe(false)
  })

  it('does not arm a monitor when reconcile finds the session idle/absent', async () => {
    const manager = makeFakeManager()
    manager.getSessionStatus = vi.fn(async () => undefined) // absent == idle
    const adapter = makeAdapter(manager)
    await adapter.attach!({ sessionId: 'ses_calm', sessionType: 'freshopencode', provider: 'opencode', cwd: '/w' })
    expect(manager.onceIdle).not.toHaveBeenCalled()
  })

  it('disarms a cold monitor when a new user send starts (no double idle/chime)', async () => {
    const manager = makeFakeManager()
    manager.getSessionStatus = vi.fn(async () => ({ type: 'busy' }))
    const monitorIdle = createDeferred<void>()
    manager.onceIdle = vi.fn()
      .mockReturnValueOnce(monitorIdle.promise) // the cold monitor's waiter
      .mockResolvedValue(undefined) // the send path's own waiter
    const adapter = makeAdapter(manager)
    await adapter.attach!({ sessionId: 'ses_live', sessionType: 'freshopencode', provider: 'opencode', cwd: '/w' })
    expect(manager.onceIdle).toHaveBeenCalledTimes(1)
    const events: any[] = []
    adapter.subscribe?.('ses_live', (ev) => events.push(ev))

    await adapter.send?.('ses_live', { text: 'next turn' })
    // The cancelled monitor resolving later must not add a second idle/chime for this turn.
    monitorIdle.resolve()
    await new Promise((r) => setImmediate(r))

    const idles = events.filter((e) => e.type === 'sdk.session.snapshot' && e.status === 'idle')
    const completions = events.filter((e) => e.type === 'sdk.turn.complete')
    expect(idles).toHaveLength(1)
    expect(completions).toHaveLength(1)
  })

  it('disarms a cold monitor when a compact starts (no double idle/chime)', async () => {
    const manager = makeFakeManager()
    manager.getSessionStatus = vi.fn(async () => ({ type: 'busy' }))
    const monitorIdle = createDeferred<void>()
    manager.onceIdle = vi.fn()
      .mockReturnValueOnce(monitorIdle.promise) // the cold monitor's waiter
      .mockResolvedValue(undefined) // the compact path's own waiter
    const adapter = makeAdapter(manager)
    await adapter.attach!({ sessionId: 'ses_live', sessionType: 'freshopencode', provider: 'opencode', cwd: '/w' })
    expect(manager.onceIdle).toHaveBeenCalledTimes(1)
    const events: any[] = []
    adapter.subscribe?.('ses_live', (ev) => events.push(ev))

    await adapter.compact?.('ses_live')
    // The cancelled monitor resolving later must not add a second idle/chime for this turn.
    monitorIdle.resolve()
    await new Promise((r) => setImmediate(r))

    const idles = events.filter((e) => e.type === 'sdk.session.snapshot' && e.status === 'idle')
    const completions = events.filter((e) => e.type === 'sdk.turn.complete')
    expect(idles).toHaveLength(1)
    expect(completions).toHaveLength(1)
  })

  it('does not arm a monitor when an attach reconciles busy during an in-flight send (no double idle/chime)', async () => {
    const sendIdle = createDeferred<void>()
    const manager = makeFakeManager()
    manager.getSessionStatus = vi.fn(async () => ({ type: 'busy' }))
    manager.onceIdle = vi.fn(() => sendIdle.promise)
    const adapter = makeAdapter(manager)
    await adapter.create({ requestId: 'req-mid', sessionType: 'freshopencode', provider: 'opencode', cwd: '/repo' })
    const events: any[] = []
    adapter.subscribe?.('freshopencode-req-mid', (e) => events.push(e))

    const sendPromise = adapter.send?.('freshopencode-req-mid', { text: 'go' })
    await vi.waitFor(() => expect(manager.promptAsync).toHaveBeenCalled())

    // A pane refresh/reveal attach arrives while the send path's own onceIdle owns the turn.
    await adapter.attach!({ sessionId: 'ses_real_1', sessionType: 'freshopencode', provider: 'opencode', cwd: '/repo' })
    expect(manager.onceIdle).toHaveBeenCalledTimes(1) // only the send path's waiter

    sendIdle.resolve()
    await sendPromise
    await new Promise((r) => setImmediate(r))

    const idles = events.filter((e) => e?.type === 'sdk.session.snapshot' && e.status === 'idle')
    const completions = events.filter((e) => e?.type === 'sdk.turn.complete')
    expect(idles).toHaveLength(1)
    expect(completions).toHaveLength(1)
  })
})

describe('idle freshness (zrrj)', () => {
  it('withholds idle and turn-complete until the final assistant message is queryable', async () => {
    const now = Date.now()
    const manager = makeFakeManager()
    const idle = createDeferred<void>()
    manager.onceIdle = vi.fn(() => idle.promise)
    // First two polls: transcript still missing the final answer; third poll: it appears.
    const unfinished = {
      // user messages never carry time.completed (verified live, V2)
      messages: [{ info: { id: 'm1', role: 'user', time: { created: now } }, parts: [] }],
      nextCursor: null,
    }
    const finished = {
      messages: [
        ...unfinished.messages,
        { info: { id: 'm2', role: 'assistant', time: { created: now, completed: now } }, parts: [] },
      ],
      nextCursor: null,
    }
    const events: any[] = []
    // Each poll records whether idle had (wrongly) already been emitted before it ran.
    const idleAlreadyEmittedAtPoll: boolean[] = []
    manager.listMessages.mockImplementation(async () => {
      idleAlreadyEmittedAtPoll.push(events.some((e) => e?.type === 'sdk.session.snapshot' && e.status === 'idle'))
      return (idleAlreadyEmittedAtPoll.length >= 3 ? finished : unfinished) as any
    })
    const adapter = makeAdapter(manager, { settleSleep: async () => {} }) // injected no-op sleep
    await adapter.create({ requestId: 'fresh-1', sessionType: 'freshopencode', provider: 'opencode' })
    adapter.subscribe?.('freshopencode-fresh-1', (e) => events.push(e))
    const sendPromise = adapter.send!('freshopencode-fresh-1', { text: 'q' })
    idle.resolve()
    await sendPromise
    expect(manager.listMessages).toHaveBeenCalledTimes(3)
    expect(idleAlreadyEmittedAtPoll).toEqual([false, false, false]) // idle withheld through every poll
    const idleIndex = events.findIndex((e) => e?.type === 'sdk.session.snapshot' && e.status === 'idle')
    const completeIndex = events.findIndex((e) => e?.type === 'sdk.turn.complete')
    expect(idleIndex).toBeGreaterThanOrEqual(0)
    expect(completeIndex).toBeGreaterThan(idleIndex - 1) // both emitted, after settling
  })

  it('gives up after the poll budget but still emits idle (never strands the pane busy)', async () => {
    loggerMocks.logger.warn.mockClear()
    const manager = makeFakeManager()
    const idle = createDeferred<void>()
    manager.onceIdle = vi.fn(() => idle.promise)
    // Default listMessages fixture ({ messages: [] }) never settles.
    const adapter = makeAdapter(manager, { settleSleep: async () => {} })
    await adapter.create({ requestId: 'fresh-2', sessionType: 'freshopencode', provider: 'opencode' })
    const events: any[] = []
    adapter.subscribe?.('freshopencode-fresh-2', (e) => events.push(e))
    const sendPromise = adapter.send!('freshopencode-fresh-2', { text: 'q' })
    idle.resolve()
    await sendPromise
    expect(manager.listMessages.mock.calls.length).toBeGreaterThanOrEqual(2) // bounded polling actually happened
    expect(manager.listMessages.mock.calls.length).toBeLessThanOrEqual(11) // 1 + max 10 polls
    expect(events.some((e) => e?.type === 'sdk.session.snapshot' && e.status === 'idle')).toBe(true)
    // Exhaustion degrades to the pre-task behavior (idle + chime) rather than stranding the turn.
    expect(events.some((e) => e?.type === 'sdk.turn.complete')).toBe(true)
    const warnCall = loggerMocks.logger.warn.mock.calls.find((call) => call[1] === 'transcript did not settle after idle')
    expect(warnCall).toBeDefined()
    expect(JSON.stringify(warnCall![0])).not.toContain('ses_real_1') // hashed identity only
  })

  it('monitor-resolve path proves the transcript (any completed assistant message) before emitting idle', async () => {
    const manager = makeFakeManager()
    manager.getSessionStatus = vi.fn(async () => ({ type: 'busy' }))
    const idle = createDeferred<void>()
    manager.onceIdle = vi.fn(() => idle.promise)
    const events: any[] = []
    const idleAlreadyEmittedAtPoll: boolean[] = []
    manager.listMessages.mockImplementation(async () => {
      idleAlreadyEmittedAtPoll.push(events.some((e) => e?.type === 'sdk.session.snapshot' && e.status === 'idle'))
      // First poll: not yet queryable; second poll: an OLD completed assistant message —
      // the monitor path passes sentAtMs = 0, so ANY completed assistant message settles.
      return (idleAlreadyEmittedAtPoll.length >= 2
        ? { messages: [{ info: { id: 'a1', role: 'assistant', time: { created: 1, completed: 2 } }, parts: [] }], nextCursor: null }
        : { messages: [], nextCursor: null }) as any
    })
    const adapter = makeAdapter(manager)
    await adapter.attach!({ sessionId: 'ses_live', sessionType: 'freshopencode', provider: 'opencode', cwd: '/w' })
    adapter.subscribe?.('ses_live', (ev) => events.push(ev))
    idle.resolve()
    await vi.waitFor(() => expect(events.some((e) => e?.type === 'sdk.session.snapshot' && e.status === 'idle')).toBe(true))
    expect(manager.listMessages).toHaveBeenCalledTimes(2)
    expect(idleAlreadyEmittedAtPoll).toEqual([false, false]) // idle withheld until the transcript proved queryable
    expect(events.some((e) => e?.type === 'sdk.turn.complete')).toBe(true)
  })
})

describe('statusFromLiveState (zrrj, Task 4 gate)', () => {
  it('is false/absent for an untracked session snapshot (idle default)', async () => {
    const manager = makeFakeManager()
    const adapter = makeAdapter(manager)

    // getSnapshot for a ses_ id with no adapter state: status falls back to the
    // placeholder-default 'idle', which must NOT license a client busy-clear.
    const snapshot: any = await adapter.getSnapshot?.({
      sessionType: 'freshopencode',
      provider: 'opencode',
      threadId: 'ses_untracked',
      cwd: '/repo/safe',
    })

    expect(snapshot.status).toBe('idle')
    expect(snapshot.extensions.opencode.statusFromLiveState).not.toBe(true)
    expect(snapshot.extensions.opencode.statusFromLiveState).toBe(false)
  })

  it('is true only after the initial reconcile completed', async () => {
    // Reconcile resolves (absent from the status map => confirmed idle) -> true.
    const manager = makeFakeManager()
    manager.getSessionStatus = vi.fn(async () => undefined)
    const adapter = makeAdapter(manager)
    await adapter.attach?.({
      sessionId: 'ses_reconciled',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/safe',
    })
    const snapshot: any = await adapter.getSnapshot?.({
      sessionType: 'freshopencode',
      provider: 'opencode',
      threadId: 'ses_reconciled',
      cwd: '/repo/safe',
    })
    expect(snapshot.status).toBe('idle')
    expect(snapshot.extensions.opencode.statusFromLiveState).toBe(true)

    // Error-swallow path: getSessionStatus rejecting must leave the flag false —
    // a failed read never licenses a busy-clear.
    const failingManager = makeFakeManager()
    failingManager.getSessionStatus = vi.fn(async () => { throw new Error('status failed') })
    const failingAdapter = makeAdapter(failingManager)
    await failingAdapter.attach?.({
      sessionId: 'ses_reconcile_failed',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/safe',
    })
    const failedSnapshot: any = await failingAdapter.getSnapshot?.({
      sessionType: 'freshopencode',
      provider: 'opencode',
      threadId: 'ses_reconcile_failed',
      cwd: '/repo/safe',
    })
    expect(failedSnapshot.status).toBe('idle')
    expect(failedSnapshot.extensions.opencode.statusFromLiveState).toBe(false)
  })

  it('is true when the reconcile resolves busy (running branch)', async () => {
    const manager = makeFakeManager()
    manager.getSessionStatus = vi.fn(async () => ({ type: 'busy' }))
    // Keep the restore idle-recovery monitor pending so the session stays running.
    manager.onceIdle = vi.fn(() => new Promise<void>(() => {}))
    const adapter = makeAdapter(manager)
    await adapter.attach?.({
      sessionId: 'ses_busy_flag',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/safe',
    })
    const snapshot: any = await adapter.getSnapshot?.({
      sessionType: 'freshopencode',
      provider: 'opencode',
      threadId: 'ses_busy_flag',
      cwd: '/repo/safe',
    })
    expect(snapshot.status).toBe('running')
    expect(snapshot.extensions.opencode.statusFromLiveState).toBe(true)
  })
})

describe('interrupted-turn recovery (zrrj)', () => {
  const OLD = Date.now() - 60_000
  const interruptedTranscript = {
    messages: [
      // realistic: user messages never carry time.completed (verified, V2)
      { info: { id: 'm1', role: 'user', time: { created: OLD - 10 } }, parts: [] },
      { info: { id: 'm2', role: 'assistant', time: { created: OLD } }, parts: [{ type: 'tool', state: { status: 'running' } }] },
    ],
    nextCursor: null,
  }

  function turnRecoveryAudits(): Array<Record<string, unknown>> {
    return observabilityMocks.recordFreshAgentObservabilityEvent.mock.calls
      .map(([event]) => event as Record<string, unknown>)
      .filter((event) => event.kind === 'fresh_agent_turn_recovery')
  }

  it('injects exactly one continuation for an interrupted turn on attach', async () => {
    observabilityMocks.recordFreshAgentObservabilityEvent.mockClear()
    const manager = makeFakeManager()
    manager.getSessionStatus.mockResolvedValue(undefined) // idle
    manager.listMessages.mockResolvedValue(interruptedTranscript as any)
    const adapter = makeAdapter(manager, { recoveryStore: makeTempRecoveryStore() })
    await adapter.attach!({ sessionId: 'ses_int', sessionType: 'freshopencode', provider: 'opencode', cwd: '/w' })
    await flushRecovery()
    expect(manager.promptAsync).toHaveBeenCalledTimes(1)
    const body = (manager.promptAsync.mock.calls[0] as any[])[1]
    expect(body.parts[0].text).toMatch(/interrupted/i)

    // Auditable: exactly one continuation_injected row, hashed identity only.
    const injected = turnRecoveryAudits().filter((e) => e.action === 'continuation_injected')
    expect(injected).toHaveLength(1)
    expect(JSON.stringify(injected[0])).not.toContain('ses_int')
    expect(JSON.stringify(injected[0])).not.toContain('/w')

    // Second attach (same store): ledger suppresses.
    manager.promptAsync.mockClear()
    await adapter.attach!({ sessionId: 'ses_int', sessionType: 'freshopencode', provider: 'opencode', cwd: '/w' })
    await flushRecovery()
    expect(manager.promptAsync).not.toHaveBeenCalled()
    expect(turnRecoveryAudits().some((e) => e.action === 'suppressed_already_recovered')).toBe(true)
  })

  it('injects exactly one continuation when two restores race on the same session (no double-inject)', async () => {
    // Multi-pane restore after a restart: two attaches of the same session land
    // near-simultaneously. Without serializing the recovery passes, both hasRecovery
    // reads resolve false before either recordRecovery lands (the store queues
    // operations individually, with no atomic check-and-set) and BOTH inject —
    // violating "at most ONE recovery per (session, message) ever".
    observabilityMocks.recordFreshAgentObservabilityEvent.mockClear()
    const store = makeTempRecoveryStore()
    const manager = makeFakeManager()
    manager.getSessionStatus.mockResolvedValue(undefined) // idle
    manager.listMessages.mockResolvedValue(interruptedTranscript as any)
    const adapter = makeAdapter(manager, { recoveryStore: store })

    // Two schedule calls on the same state while the first pass is still in flight
    // (its recovery-store reads are fs-async, so it cannot have finished yet).
    await adapter.attach!({ sessionId: 'ses_int', sessionType: 'freshopencode', provider: 'opencode', cwd: '/w' })
    await adapter.attach!({ sessionId: 'ses_int', sessionType: 'freshopencode', provider: 'opencode', cwd: '/w' })
    await flushRecovery()

    expect(manager.promptAsync).toHaveBeenCalledTimes(1)
    const injected = turnRecoveryAudits().filter((e) => e.action === 'continuation_injected')
    expect(injected).toHaveLength(1)
    expect(turnRecoveryAudits().some((e) => e.action === 'suppressed_already_recovered')).toBe(true)
    expect(await store.hasRecovery('ses_int', 'm2')).toBe(true)
  })

  it('never recovers after an explicit user interrupt, across adapter instances', async () => {
    observabilityMocks.recordFreshAgentObservabilityEvent.mockClear()
    const store = makeTempRecoveryStore()
    const manager = makeFakeManager()
    manager.getSessionStatus.mockResolvedValue(undefined)
    manager.listMessages.mockResolvedValue(interruptedTranscript as any)
    const adapter1 = makeAdapter(manager, { recoveryStore: store })
    await adapter1.attach!({ sessionId: 'ses_int', sessionType: 'freshopencode', provider: 'opencode', cwd: '/w' })
    await flushRecovery()
    await adapter1.interrupt!('ses_int') // user stop
    expect(await store.hasInterrupt('ses_int')).toBe(true)

    // Simulated restart: fresh adapter + manager sharing the durable store. The
    // transcript now ends on a DIFFERENT interrupted assistant message (m9) — a
    // fresh (session, message) pair with no ledger entry — so ledger suppression
    // cannot mask the user-stop gate: only hasInterrupt can suppress this one.
    const manager2 = makeFakeManager()
    manager2.getSessionStatus.mockResolvedValue(undefined)
    manager2.listMessages.mockResolvedValue({
      messages: [
        ...interruptedTranscript.messages,
        { info: { id: 'm8', role: 'user', time: { created: OLD + 5 } }, parts: [] },
        { info: { id: 'm9', role: 'assistant', time: { created: OLD + 10 } }, parts: [{ type: 'tool', state: { status: 'running' } }] },
      ],
      nextCursor: null,
    } as any)
    const adapter2 = makeAdapter(manager2, { recoveryStore: store })
    observabilityMocks.recordFreshAgentObservabilityEvent.mockClear()
    await adapter2.attach!({ sessionId: 'ses_int', sessionType: 'freshopencode', provider: 'opencode', cwd: '/w' })
    await flushRecovery()
    expect(manager2.promptAsync).not.toHaveBeenCalled()
    // The suppression must come from the user-stop gate itself, not the ledger.
    expect(turnRecoveryAudits().some((e) => e.action === 'suppressed_user_stop')).toBe(true)
    expect(turnRecoveryAudits().some((e) => e.action === 'continuation_injected')).toBe(false)
    // The gate fires before any ledger write: the fresh turn stays unburned.
    expect(await store.hasRecovery('ses_int', 'm9')).toBe(false)
  })

  it('does not burn the recovery ledger on a no-cwd attach (route check precedes record)', async () => {
    observabilityMocks.recordFreshAgentObservabilityEvent.mockClear()
    const store = makeTempRecoveryStore()
    const manager = makeFakeManager()
    manager.getSessionStatus.mockResolvedValue(undefined)
    manager.listMessages.mockResolvedValue(interruptedTranscript as any)
    const adapter = makeAdapter(manager, { recoveryStore: store })
    await adapter.attach!({ sessionId: 'ses_int', sessionType: 'freshopencode', provider: 'opencode' }) // NO cwd — the incident shape
    await flushRecovery()
    expect(manager.promptAsync).not.toHaveBeenCalled() // no injection possible
    expect(turnRecoveryAudits().some((e) => e.action === 'suppressed_no_route')).toBe(true)
    expect(await store.hasRecovery('ses_int', 'm2')).toBe(false) // ledger NOT burned

    // A later cwd-bearing attach can still recover the turn.
    await adapter.attach!({ sessionId: 'ses_int', sessionType: 'freshopencode', provider: 'opencode', cwd: '/w' })
    await flushRecovery()
    expect(manager.promptAsync).toHaveBeenCalledTimes(1)
    expect(await store.hasRecovery('ses_int', 'm2')).toBe(true)
  })

  it('does not recover when the user already sent a follow-up', async () => {
    observabilityMocks.recordFreshAgentObservabilityEvent.mockClear()
    const manager = makeFakeManager()
    manager.getSessionStatus.mockResolvedValue(undefined)
    manager.listMessages.mockResolvedValue({
      messages: [
        ...interruptedTranscript.messages,
        { info: { id: 'm3', role: 'user', time: { created: OLD + 5 } }, parts: [] },
      ],
      nextCursor: null,
    } as any)
    const adapter = makeAdapter(manager, { recoveryStore: makeTempRecoveryStore() })
    await adapter.attach!({ sessionId: 'ses_int', sessionType: 'freshopencode', provider: 'opencode', cwd: '/w' })
    await flushRecovery()
    expect(manager.promptAsync).not.toHaveBeenCalled()
    expect(turnRecoveryAudits().some((e) => e.action === 'suppressed_user_followup')).toBe(true)
  })

  it('a normal user send clears recorded interrupt intent', async () => {
    const store = makeTempRecoveryStore()
    const manager = makeFakeManager()
    const adapter = makeAdapter(manager, { recoveryStore: store })
    await adapter.attach!({ sessionId: 'ses_int', sessionType: 'freshopencode', provider: 'opencode', cwd: '/w' })
    await adapter.interrupt!('ses_int')
    expect(await store.hasInterrupt('ses_int')).toBe(true)
    await adapter.send!('ses_int', { text: 'user follow-up' })
    expect(await store.hasInterrupt('ses_int')).toBe(false)
  })
})

describe('inspectSessions: read-only incident summary (zrrj)', () => {
  it('reports a hashed, content-free summary for a running session with an armed monitor', async () => {
    const manager = makeFakeManager()
    manager.getSessionStatus = vi.fn(async () => ({ type: 'busy' }))
    // Keep the restore idle-recovery monitor pending so it stays armed.
    manager.onceIdle = vi.fn(() => new Promise<void>(() => {}))
    const adapter = makeAdapter(manager)
    await adapter.attach!({ sessionId: 'ses_live', sessionType: 'freshopencode', provider: 'opencode', cwd: '/w' })

    const result = adapter.inspectSessions()

    expect(result).toEqual([{
      sessionIdHash: hashForLogs('ses_live'),
      status: 'running',
      hasRealSession: true,
      cwdHash: hashForLogs('/w'),
      monitorArmed: true,
    }])
    // Content-free: neither the raw ses_ id nor the raw cwd may appear anywhere.
    const json = JSON.stringify(result)
    expect(json).not.toContain('ses_')
    expect(json).not.toContain('/w')
  })

  it('dedupes placeholder/real aliases and reports turn flags after a completed send', async () => {
    const manager = makeFakeManager()
    const adapter = makeAdapter(manager)
    await adapter.create({ requestId: 'req-inspect', sessionType: 'freshopencode', provider: 'opencode', cwd: '/repo' })
    await adapter.send!('freshopencode-req-inspect', { text: 'secret user prompt' })

    const result = adapter.inspectSessions()

    // The state is remembered under BOTH the placeholder and the real ses_ id —
    // the summary must report the underlying state exactly once.
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      sessionIdHash: hashForLogs('ses_real_1'),
      status: 'idle',
      hasRealSession: true,
      monitorArmed: false,
      turnAborted: false,
      turnErrored: false,
    })
    expect(typeof result[0].lastTurnCompleteAt).toBe('number')
    // No message text and no raw identity leaks into the summary.
    const json = JSON.stringify(result)
    expect(json).not.toContain('secret user prompt')
    expect(json).not.toContain('ses_')
    expect(json).not.toContain('/repo')
  })

  it('reports an unmaterialized placeholder with hasRealSession false', async () => {
    const manager = makeFakeManager()
    const adapter = makeAdapter(manager)
    await adapter.create({ requestId: 'req-cold', sessionType: 'freshopencode', provider: 'opencode', cwd: '/repo' })

    const result = adapter.inspectSessions()

    expect(result).toEqual([{
      sessionIdHash: hashForLogs('freshopencode-req-cold'),
      status: 'idle',
      hasRealSession: false,
      cwdHash: hashForLogs('/repo'),
      monitorArmed: false,
    }])
    expect(JSON.stringify(result)).not.toContain('freshopencode-req-cold')
  })
})
