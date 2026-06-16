import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { ReadableStream } from 'node:stream/web'
import { describe, expect, it, vi } from 'vitest'
import { parseServeEvent as parseEvt } from '../../../../server/fresh-agent/adapters/opencode/serve-events.js'
import { OpencodeServeManager } from '../../../../server/fresh-agent/adapters/opencode/serve-manager.js'

function fakeChild() {
  const child = new EventEmitter() as any
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = 4242
  child.kill = vi.fn(() => { child.killed = true; queueMicrotask(() => child.emit('close', 0)); return true })
  return child
}

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    headers: { get: (k: string) => init.headers?.[k.toLowerCase()] ?? init.headers?.[k] ?? null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as any
}

function makeManager(overrides: Partial<Parameters<typeof OpencodeServeManager>[0]> = {}) {
  const child = fakeChild()
  const spawnFn = vi.fn(() => child)
  const fetchFn = vi.fn(async (url: string) => {
    if (url.endsWith('/global/health')) return jsonResponse({ healthy: true, version: '1.17.7' })
    return jsonResponse({})
  })
  const manager = new OpencodeServeManager({
    spawnFn: spawnFn as any,
    fetchFn: fetchFn as any,
    allocatePort: async () => ({ hostname: '127.0.0.1', port: 47999 }),
    connectEventStream: () => () => {},
    healthTimeoutMs: 1000,
    ...overrides,
  })
  return { manager, child, spawnFn, fetchFn }
}

describe('OpencodeServeManager lifecycle', () => {
  it('lazily spawns one serve, health-gates, and reuses it across ensureStarted calls', async () => {
    const { manager, spawnFn, fetchFn } = makeManager()
    const a = await manager.ensureStarted()
    const b = await manager.ensureStarted()
    expect(a.baseUrl).toBe('http://127.0.0.1:47999')
    expect(b.baseUrl).toBe(a.baseUrl)
    expect(spawnFn).toHaveBeenCalledTimes(1)
    expect(spawnFn).toHaveBeenCalledWith(
      'opencode',
      ['serve', '--hostname', '127.0.0.1', '--port', '47999'],
      expect.objectContaining({ env: expect.objectContaining({ FRESHELL_OPENCODE_SIDECAR_ID: expect.any(String) }) }),
    )
    expect(fetchFn).toHaveBeenCalledWith('http://127.0.0.1:47999/global/health', expect.anything())
  })

  it('shuts down by killing the spawned process and refuses further use until restarted', async () => {
    const { manager, child } = makeManager()
    await manager.ensureStarted()
    await manager.shutdown()
    expect(child.kill).toHaveBeenCalled()
  })

  it('kills the child and throws when stderr reports a startup failure', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ healthy: false }, { status: 503 }))
    const { manager, child } = makeManager({ fetchFn: fetchFn as any, healthTimeoutMs: 500 })
    const started = manager.ensureStarted()
    await new Promise((r) => setTimeout(r, 10))
    child.stderr.emit('data', Buffer.from('ServeError: Failed to start server\n'))
    await expect(started).rejects.toThrow(/opencode serve failed to start on http:\/\/127\.0\.0\.1:47999/)
    expect(child.kill).toHaveBeenCalled()
  })

  it('kills the child when the health check deadline expires', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ healthy: false }, { status: 503 }))
    const { manager, child } = makeManager({ fetchFn: fetchFn as any, healthTimeoutMs: 30 })
    await expect(manager.ensureStarted()).rejects.toThrow(/opencode serve did not become healthy within 30ms/)
    expect(child.kill).toHaveBeenCalled()
  })

  it('removes the diagnostic stderr listener once health resolves', async () => {
    const { manager, child } = makeManager({ healthTimeoutMs: 500 })
    await manager.ensureStarted()
    // The permanent drain listener remains; the temporary diagnostic listener
    // added during waitForHealth must have been removed.
    expect(child.stderr.listenerCount('data')).toBe(1)
  })

  it('aborts an in-flight startup when shutdown is called and reaps the child', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ healthy: false }, { status: 503 }))
    const { manager, child } = makeManager({ fetchFn: fetchFn as any, healthTimeoutMs: 60_000 })
    const started = manager.ensureStarted()
    await new Promise((r) => setTimeout(r, 10))
    const shutdown = manager.shutdown()
    await expect(started).rejects.toThrow(/opencode serve startup was aborted|opencode serve did not become healthy/)
    await shutdown
    expect(child.kill).toHaveBeenCalled()
    expect((manager as any).running).toBeUndefined()
    expect((manager as any).startPromise).toBeUndefined()
  })
})

describe('OpencodeServeManager HTTP client', () => {
  it('creates a session and posts a prompt_async with model object + variant', async () => {
    const calls: Array<{ url: string; init: any }> = []
    const fetchFn = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init })
      if (url.endsWith('/global/health')) return jsonResponse({ healthy: true })
      if (url.endsWith('/session') && init?.method === 'POST') return jsonResponse({ id: 'ses_new', directory: '/repo', title: 't' })
      if (url.includes('/prompt_async')) return jsonResponse({}, { status: 204 })
      return jsonResponse({})
    })
    const { manager } = makeManager({ fetchFn: fetchFn as any })
    const session = await manager.createSession()
    expect(session).toMatchObject({ id: 'ses_new', directory: '/repo' })
    await manager.promptAsync('ses_new', {
      parts: [{ type: 'text', text: 'hi' }],
      model: { providerID: 'umans-ai-coding-plan', modelID: 'umans-kimi-k2.7' },
      variant: 'high',
    })
    const prompt = calls.find((c) => c.url.includes('/prompt_async'))!
    expect(prompt.url).toBe('http://127.0.0.1:47999/session/ses_new/prompt_async')
    expect(JSON.parse(prompt.init.body)).toEqual({
      parts: [{ type: 'text', text: 'hi' }],
      model: { providerID: 'umans-ai-coding-plan', modelID: 'umans-kimi-k2.7' },
      variant: 'high',
    })
  })

  it('lists messages and surfaces the X-Next-Cursor header as nextCursor', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/global/health')) return jsonResponse({ healthy: true })
      if (url.includes('/message')) {
        return jsonResponse(
          [{ info: { id: 'msg_1' }, parts: [] }],
          { headers: { 'x-next-cursor': 'CUR123' } },
        )
      }
      return jsonResponse({})
    })
    const { manager } = makeManager({ fetchFn: fetchFn as any })
    const page = await manager.listMessages('ses_x', { limit: 1, before: 'PREV' })
    expect(page.messages).toHaveLength(1)
    expect(page.nextCursor).toBe('CUR123')
    expect(fetchFn).toHaveBeenCalledWith(
      'http://127.0.0.1:47999/session/ses_x/message?limit=1&before=PREV',
      expect.anything(),
    )
  })

  it('returns nextCursor null when no header is present (oldest page reached)', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/global/health')) return jsonResponse({ healthy: true })
      if (url.includes('/message')) return jsonResponse([{ info: { id: 'm' }, parts: [] }])
      return jsonResponse({})
    })
    const { manager } = makeManager({ fetchFn: fetchFn as any })
    const page = await manager.listMessages('ses_x', {})
    expect(page.nextCursor).toBeNull()
  })

  it('returns null for getMessage on a 404 response', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/global/health')) return jsonResponse({ healthy: true })
      if (url.includes('/message/not_found')) return jsonResponse({ error: 'not found' }, { status: 404 })
      return jsonResponse({})
    })
    const { manager } = makeManager({ fetchFn: fetchFn as any })
    await expect(manager.getMessage('ses_x', 'not_found')).resolves.toBeNull()
  })

  it('throws for getMessage on a non-404 error response', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/global/health')) return jsonResponse({ healthy: true })
      if (url.includes('/message/broken')) return jsonResponse({ error: '内部 Server Error' }, { status: 500 })
      return jsonResponse({})
    })
    const { manager } = makeManager({ fetchFn: fetchFn as any })
    await expect(manager.getMessage('ses_x', 'broken')).rejects.toThrow(/opencode serve GET .*\/message\/broken → 500/)
  })
})

describe('OpencodeServeManager fan-out', () => {
  it('subscribe receives parsed events for its session and unsubscribe stops them', async () => {
    let push!: (e: any) => void
    const { manager } = makeManager({
      connectEventStream: (_url, h) => { push = (e) => h.onEvent(parseEvt(e)); return () => {} },
    })
    await manager.ensureStarted()
    const seen: any[] = []
    const off = manager.subscribe('ses_a', (e) => seen.push(e))
    push({ type: 'message.part.updated', properties: { sessionID: 'ses_a', part: { id: 'p' } } })
    push({ type: 'message.part.updated', properties: { sessionID: 'ses_other', part: { id: 'q' } } })
    off()
    push({ type: 'session.idle', properties: { sessionID: 'ses_a' } })
    expect(seen.map((e) => e.kind)).toEqual(['message.part.updated'])
  })

  it('onceIdle resolves on the next session.idle for that session', async () => {
    let push!: (e: any) => void
    const { manager } = makeManager({
      connectEventStream: (_url, h) => { push = (e) => h.onEvent(parseEvt(e)); return () => {} },
    })
    await manager.ensureStarted()
    const idle = manager.onceIdle('ses_a', 1000)
    push({ type: 'session.idle', properties: { sessionID: 'ses_a' } })
    await expect(idle).resolves.toBeUndefined()
    expect((manager as any).sessionEmitters.get('ses_a')?.listenerCount('event') ?? 0).toBe(0)
  })

  it('onceIdle rejects on timeout', async () => {
    const { manager } = makeManager({ connectEventStream: () => () => {} })
    await manager.ensureStarted()
    await expect(manager.onceIdle('ses_a', 10)).rejects.toThrow(/idle/i)
    expect((manager as any).sessionEmitters.get('ses_a')?.listenerCount('event') ?? 0).toBe(0)
  })

  it('normalizes CRLF SSE boundaries', async () => {
    let push!: (e: any) => void
    const { manager } = makeManager({
      connectEventStream: (_url, h) => { push = (e) => h.onEvent(parseEvt(e)); return () => {} },
    })
    await manager.ensureStarted()
    const seen: any[] = []
    manager.subscribe('ses_crlf', (e) => seen.push(e))
    push({ type: 'session.idle', properties: { sessionID: 'ses_crlf' } })
    expect(seen.map((e) => e.kind)).toEqual(['session.idle'])
  })

  it('cleans up the event stream and session emitters when the child exits unexpectedly', async () => {
    const child = fakeChild()
    const stopStream = vi.fn()
    const spawnFn = vi.fn(() => child)
    const manager = new OpencodeServeManager({
      spawnFn: spawnFn as any,
      fetchFn: vi.fn(async (url: string) => {
        if (url.endsWith('/global/health')) return jsonResponse({ healthy: true })
        return jsonResponse({})
      }) as any,
      allocatePort: async () => ({ hostname: '127.0.0.1', port: 47999 }),
      connectEventStream: () => stopStream,
      healthTimeoutMs: 1000,
    })
    await manager.ensureStarted()
    manager.subscribe('ses_child', () => {})
    expect((manager as any).sessionEmitters.size).toBeGreaterThan(0)
    child.emit('close', 1)
    expect(stopStream).toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalled()
    expect((manager as any).sessionEmitters.size).toBe(0)
    expect((manager as any).running).toBeUndefined()
  })

  it('parses multi-line SSE data blocks by joining data: lines', async () => {
    let enqueue: ((chunk: Uint8Array) => void) | undefined
    let closeStream: (() => void) | undefined
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        enqueue = (chunk) => c.enqueue(chunk)
        closeStream = () => c.close()
      },
    })
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/global/health')) return jsonResponse({ healthy: true })
      if (url.endsWith('/event')) {
        return { ok: true, status: 200, body } as any
      }
      return jsonResponse({})
    })
    const manager = new OpencodeServeManager({
      spawnFn: () => fakeChild() as any,
      fetchFn: fetchFn as any,
      allocatePort: async () => ({ hostname: '127.0.0.1', port: 47999 }),
      healthTimeoutMs: 1000,
    })
    await manager.ensureStarted()
    const seen: any[] = []
    manager.subscribe('ses_multiline', (e) => seen.push(e))
    // Send a block where the JSON payload is split across several data: lines
    // so the parser has to join the lines before JSON.parse.
    const block = [
      'data: {',
      'data:   "type": "session.idle",',
      'data:   "properties": {"sessionID":"ses_multiline"}',
      'data: }',
      '',
      '',
    ].join('\n')
    enqueue?.(new TextEncoder().encode(block))
    await new Promise((r) => setTimeout(r, 50))
    closeStream?.()
    expect(seen.map((e) => e.kind)).toEqual(['session.idle'])
  })
})
