import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createOpencodeFreshAgentAdapter } from '../../../../server/fresh-agent/adapters/opencode/adapter.js'

type FakeManager = ReturnType<typeof makeFakeManager>

function makeFakeManager() {
  const sessionEmitters = new Map<string, EventEmitter>()
  const emitterFor = (id: string) => {
    let e = sessionEmitters.get(id)
    if (!e) { e = new EventEmitter(); sessionEmitters.set(id, e) }
    return e
  }
  return {
    createSession: vi.fn(async () => ({ id: 'ses_real_1', directory: '/repo', title: 'T' })),
    promptAsync: vi.fn(async () => undefined),
    listMessages: vi.fn(async () => ({ messages: [], nextCursor: null })),
    getMessage: vi.fn(async () => null),
    getSession: vi.fn(async () => ({ id: 'ses_real_1', title: 'T', time: { updated: 5 } })),
    abort: vi.fn(async () => undefined),
    compact: vi.fn(async () => undefined),
    fork: vi.fn(async () => ({ id: 'ses_child_1' })),
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

function makeAdapter(manager: FakeManager) {
  return createOpencodeFreshAgentAdapter({ serveManager: manager as any })
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
    })
    expect(manager.onceIdle).toHaveBeenCalledWith('ses_real_1', expect.any(Number))
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

  it('passes the effective cwd to createSession on first materialization', async () => {
    const manager = makeFakeManager()
    const adapter = makeAdapter(manager)
    await adapter.create({ requestId: 'cwd-1', sessionType: 'freshopencode', provider: 'opencode', cwd: '/project-x' })
    await adapter.send?.('freshopencode-cwd-1', { text: 'hi' })
    expect(manager.createSession).toHaveBeenCalledTimes(1)
    expect(manager.createSession).toHaveBeenLastCalledWith({ directory: '/project-x' })
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

  it('forwards compact instructions to the serve manager', async () => {
    const manager = makeFakeManager()
    const adapter = makeAdapter(manager)
    await adapter.create({ requestId: 'compact-1', sessionType: 'freshopencode', provider: 'opencode' })
    await adapter.send?.('freshopencode-compact-1', { text: 'go' })
    await adapter.compact?.('freshopencode-compact-1', { instructions: 'keep it short' })
    expect(manager.compact).toHaveBeenCalledWith('ses_real_1', { instructions: 'keep it short' })
  })
})
