import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const observabilityMocks = vi.hoisted(() => ({
  recordFreshAgentObservabilityEvent: vi.fn(),
}))

vi.mock('../../../../server/fresh-agent/observability.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../server/fresh-agent/observability.js')>()
  return { ...actual, recordFreshAgentObservabilityEvent: observabilityMocks.recordFreshAgentObservabilityEvent }
})

import { createOpencodeFreshAgentAdapter } from '../../../../server/fresh-agent/adapters/opencode/adapter.js'

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
    getSession: vi.fn(async () => ({ id: 'ses_real_1', title: 'T', time: { updated: 5 } })),
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

function makeAdapter(manager: FakeManager, overrides: Partial<Parameters<typeof createOpencodeFreshAgentAdapter>[0]> = {}) {
  return createOpencodeFreshAgentAdapter({
    serveManager: manager as any,
    validateCwd: async () => undefined,
    ...overrides,
  })
}

describe('OpenCode serve adapter: create + send', () => {
  it('creates a placeholder, materializes on first send via POST /session, and awaits idle', async () => {
    const manager = makeFakeManager()
    const adapter = makeAdapter(manager)
    const created = await adapter.create({
      requestId: 'req-1', sessionType: 'freshopencode', provider: 'opencode',
      cwd: '/repo', model: 'umans-ai-coding-plan/umans-kimi-k2.7', effort: 'high',
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
      model: { providerID: 'umans-ai-coding-plan', modelID: 'umans-kimi-k2.7' },
      variant: 'high',
    }, { cwd: '/repo' })
    expect(manager.onceIdle).toHaveBeenCalledWith('ses_real_1', expect.any(Number), { cwd: '/repo' })
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

    expect(manager.promptAsync).toHaveBeenCalledWith(
      'ses_attached_send',
      { parts: [{ type: 'text', text: 'continue' }] },
      { cwd: '/repo/restored-worktree' },
    )
  })

  it('keeps attached no-cwd sessions sendable without a route argument', async () => {
    const manager = makeFakeManager()
    const adapter = makeAdapter(manager)

    await adapter.attach?.({
      sessionType: 'freshopencode',
      provider: 'opencode',
      sessionId: 'ses_attached_nocwd',
    })
    await adapter.send?.('ses_attached_nocwd', { text: 'continue' })

    expect(manager.promptAsync).toHaveBeenCalledWith(
      'ses_attached_nocwd',
      { parts: [{ type: 'text', text: 'continue' }] },
    )
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
    { info: { id: 'msg_assistant_1', role: 'assistant', providerID: 'umans-ai-coding-plan', modelID: 'umans-kimi-k2.7' }, parts: [{ id: 'p2', type: 'text', text: 'ok' }] },
  ]

  it('getSnapshot assembles HTTP messages into the normalized transcript', async () => {
    const manager = makeFakeManager()
    manager.getSession = vi.fn(async () => ({ id: 'ses_real_1', title: 'Kimi chat', time: { updated: 12 } }))
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
    manager.getSession = vi.fn(async () => ({ id: 'ses_real_1', time: { updated: 1 } }))
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

  it('compact calls the dedicated compact endpoint', async () => {
    const { manager, adapter } = await materialized()
    await adapter.compact?.('freshopencode-req-c')
    expect(manager.compact).toHaveBeenCalledWith('ses_real_1')
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
