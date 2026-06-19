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

  it('starts the serve process in the requested session directory before creating the first session', async () => {
    const calls: Array<{ url: string; init: any }> = []
    const fetchFn = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init })
      if (url.endsWith('/global/health')) return jsonResponse({ healthy: true, version: '1.17.8' })
      if (url.endsWith('/session') && init?.method === 'POST') {
        return jsonResponse({ id: 'ses_project_x', directory: '/project-x', title: 'Project X' })
      }
      return jsonResponse({})
    })
    const { manager, spawnFn } = makeManager({ fetchFn: fetchFn as any })

    const session = await manager.createSession({ directory: '/project-x' })

    expect(session).toMatchObject({ id: 'ses_project_x', directory: '/project-x' })
    expect(spawnFn).toHaveBeenCalledWith(
      'opencode',
      ['serve', '--hostname', '127.0.0.1', '--port', '47999'],
      expect.objectContaining({
        cwd: '/project-x',
        env: expect.objectContaining({ FRESHELL_OPENCODE_SIDECAR_ID: expect.any(String) }),
      }),
    )
    expect(calls.find((call) => call.url.endsWith('/session'))).toMatchObject({
      url: 'http://127.0.0.1:47999/session',
      init: expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ directory: '/project-x' }),
      }),
    })
  })

  it('uses separate serve processes for sessions created in different directories', async () => {
    const childA = fakeChild()
    const childB = fakeChild()
    const spawnFn = vi.fn()
      .mockReturnValueOnce(childA)
      .mockReturnValueOnce(childB)
    const fetchFn = vi.fn(async (url: string, init: any) => {
      if (url === 'http://127.0.0.1:47999/global/health') return jsonResponse({ healthy: true })
      if (url === 'http://127.0.0.1:48000/global/health') return jsonResponse({ healthy: true })
      if (url === 'http://127.0.0.1:47999/session' && init?.method === 'POST') {
        return jsonResponse({ id: 'ses_a', directory: '/project-a' })
      }
      if (url === 'http://127.0.0.1:48000/session' && init?.method === 'POST') {
        return jsonResponse({ id: 'ses_b', directory: '/project-b' })
      }
      return jsonResponse({})
    })
    const manager = new OpencodeServeManager({
      spawnFn: spawnFn as any,
      fetchFn: fetchFn as any,
      allocatePort: vi.fn()
        .mockResolvedValueOnce({ hostname: '127.0.0.1', port: 47999 })
        .mockResolvedValueOnce({ hostname: '127.0.0.1', port: 48000 }),
      connectEventStream: () => () => {},
      healthTimeoutMs: 1000,
    })

    await expect(manager.createSession({ directory: '/project-a' })).resolves.toMatchObject({ id: 'ses_a' })
    await expect(manager.createSession({ directory: '/project-b' })).resolves.toMatchObject({ id: 'ses_b' })

    expect(spawnFn).toHaveBeenCalledTimes(2)
    expect(spawnFn).toHaveBeenNthCalledWith(
      1,
      'opencode',
      ['serve', '--hostname', '127.0.0.1', '--port', '47999'],
      expect.objectContaining({ cwd: '/project-a' }),
    )
    expect(spawnFn).toHaveBeenNthCalledWith(
      2,
      'opencode',
      ['serve', '--hostname', '127.0.0.1', '--port', '48000'],
      expect.objectContaining({ cwd: '/project-b' }),
    )
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
    expect((manager as any).runningByCwd.size).toBe(0)
    expect((manager as any).startPromiseByCwd.size).toBe(0)
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

  it('aborts and fails hung JSON requests instead of waiting forever', async () => {
    let sessionSignal: AbortSignal | undefined
    const fetchFn = vi.fn(async (url: string, init: any) => {
      if (url.endsWith('/global/health')) return jsonResponse({ healthy: true })
      if (url.endsWith('/session') && init?.method === 'POST') {
        sessionSignal = init.signal
        return await new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }
      return jsonResponse({})
    })
    const { manager, child } = makeManager({ fetchFn: fetchFn as any, requestTimeoutMs: 5 })

    await expect(manager.createSession()).rejects.toThrow('opencode serve POST /session timed out after 5ms')
    expect(sessionSignal?.aborted).toBe(true)
    expect(child.kill).toHaveBeenCalled()
  })

  it('posts summarize requests to a cwd sidecar learned from getSession', async () => {
    const calls: Array<{ url: string; init: any }> = []
    const childDefault = fakeChild()
    const childProject = fakeChild()
    const spawnFn = vi.fn()
      .mockReturnValueOnce(childDefault)
      .mockReturnValueOnce(childProject)
    const fetchFn = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init })
      if (url === 'http://127.0.0.1:47999/global/health') return jsonResponse({ healthy: true })
      if (url === 'http://127.0.0.1:47999/session/ses_known' && init?.method === 'GET') {
        return jsonResponse({ id: 'ses_known', directory: '/project-a', title: 'Known' })
      }
      if (url === 'http://127.0.0.1:47999/session/ses_known/compact' && init?.method === 'POST') {
        return jsonResponse({}, { status: 204 })
      }
      if (url === 'http://127.0.0.1:48000/global/health') return jsonResponse({ healthy: true })
      if (url === 'http://127.0.0.1:48000/session/ses_known/summarize' && init?.method === 'POST') {
        return jsonResponse({}, { status: 204 })
      }
      return jsonResponse({}, { status: 404 })
    })
    const manager = new OpencodeServeManager({
      spawnFn: spawnFn as any,
      fetchFn: fetchFn as any,
      allocatePort: vi.fn()
        .mockResolvedValueOnce({ hostname: '127.0.0.1', port: 47999 })
        .mockResolvedValueOnce({ hostname: '127.0.0.1', port: 48000 }),
      connectEventStream: () => () => {},
      healthTimeoutMs: 1000,
    })

    await expect(manager.getSession('ses_known')).resolves.toMatchObject({ id: 'ses_known', directory: '/project-a' })
    await manager.compact('ses_known', { instructions: 'keep it short' })

    expect(spawnFn).toHaveBeenCalledTimes(2)
    expect(spawnFn.mock.calls[0]?.[2]).not.toHaveProperty('cwd')
    expect(spawnFn).toHaveBeenNthCalledWith(
      2,
      'opencode',
      ['serve', '--hostname', '127.0.0.1', '--port', '48000'],
      expect.objectContaining({ cwd: '/project-a' }),
    )
    expect(calls.find((call) => call.url.endsWith('/summarize'))).toMatchObject({
      url: 'http://127.0.0.1:48000/session/ses_known/summarize',
      init: expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ instructions: 'keep it short' }),
      }),
    })
    expect(calls.some((call) => call.url.endsWith('/compact'))).toBe(false)
  })

  it('remembers the forked child directory for later requests instead of keeping the parent route', async () => {
    const calls: Array<{ url: string; init: any }> = []
    const childDefault = fakeChild()
    const childParent = fakeChild()
    const childFork = fakeChild()
    const spawnFn = vi.fn()
      .mockReturnValueOnce(childDefault)
      .mockReturnValueOnce(childParent)
      .mockReturnValueOnce(childFork)
    const fetchFn = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init })
      if (url === 'http://127.0.0.1:47999/global/health') return jsonResponse({ healthy: true })
      if (url === 'http://127.0.0.1:47999/session/ses_parent' && init?.method === 'GET') {
        return jsonResponse({ id: 'ses_parent', directory: '/parent' })
      }
      if (url === 'http://127.0.0.1:47999/session/ses_parent/fork' && init?.method === 'POST') {
        return jsonResponse({ id: 'ses_child', directory: '/child' })
      }
      if (url === 'http://127.0.0.1:47999/session/ses_child/compact' && init?.method === 'POST') {
        return jsonResponse({}, { status: 204 })
      }
      if (url === 'http://127.0.0.1:48000/global/health') return jsonResponse({ healthy: true })
      if (url === 'http://127.0.0.1:48000/session/ses_parent/fork' && init?.method === 'POST') {
        return jsonResponse({ id: 'ses_child', directory: '/child' })
      }
      if (url === 'http://127.0.0.1:48001/global/health') return jsonResponse({ healthy: true })
      if (url === 'http://127.0.0.1:48001/session/ses_child/summarize' && init?.method === 'POST') {
        return jsonResponse({}, { status: 204 })
      }
      return jsonResponse({}, { status: 404 })
    })
    const manager = new OpencodeServeManager({
      spawnFn: spawnFn as any,
      fetchFn: fetchFn as any,
      allocatePort: vi.fn()
        .mockResolvedValueOnce({ hostname: '127.0.0.1', port: 47999 })
        .mockResolvedValueOnce({ hostname: '127.0.0.1', port: 48000 })
        .mockResolvedValueOnce({ hostname: '127.0.0.1', port: 48001 }),
      connectEventStream: () => () => {},
      healthTimeoutMs: 1000,
    })

    await expect(manager.getSession('ses_parent')).resolves.toMatchObject({ id: 'ses_parent', directory: '/parent' })
    await expect(manager.fork('ses_parent')).resolves.toMatchObject({ id: 'ses_child', directory: '/child' })
    await manager.compact('ses_child', { instructions: 'child summary' })

    expect(spawnFn).toHaveBeenCalledTimes(3)
    expect(spawnFn).toHaveBeenNthCalledWith(
      2,
      'opencode',
      ['serve', '--hostname', '127.0.0.1', '--port', '48000'],
      expect.objectContaining({ cwd: '/parent' }),
    )
    expect(spawnFn).toHaveBeenNthCalledWith(
      3,
      'opencode',
      ['serve', '--hostname', '127.0.0.1', '--port', '48001'],
      expect.objectContaining({ cwd: '/child' }),
    )
    expect(calls.find((call) => call.url.endsWith('/session/ses_child/summarize'))).toMatchObject({
      url: 'http://127.0.0.1:48001/session/ses_child/summarize',
      init: expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ instructions: 'child summary' }),
      }),
    })
  })

  it('falls back to the fork route cwd when the fork response omits directory', async () => {
    const calls: Array<{ url: string; init: any }> = []
    const childParent = fakeChild()
    const spawnFn = vi.fn().mockReturnValueOnce(childParent)
    const fetchFn = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init })
      if (url === 'http://127.0.0.1:47999/global/health') return jsonResponse({ healthy: true })
      if (url === 'http://127.0.0.1:47999/session/ses_parent/fork' && init?.method === 'POST') {
        return jsonResponse({ id: 'ses_child' })
      }
      if (url === 'http://127.0.0.1:47999/session/ses_child/summarize' && init?.method === 'POST') {
        return jsonResponse({}, { status: 204 })
      }
      if (url.includes('/session/ses_child/summarize')) {
        throw new Error(`child summarize should stay on parent cwd route, got ${url}`)
      }
      return jsonResponse({}, { status: 404 })
    })
    const manager = new OpencodeServeManager({
      spawnFn: spawnFn as any,
      fetchFn: fetchFn as any,
      allocatePort: vi.fn()
        .mockResolvedValueOnce({ hostname: '127.0.0.1', port: 47999 }),
      connectEventStream: () => () => {},
      healthTimeoutMs: 1000,
    })

    await expect(manager.fork('ses_parent', { cwd: '/parent' })).resolves.toMatchObject({ id: 'ses_child' })
    await manager.compact('ses_child', { instructions: 'child summary' })

    expect(spawnFn).toHaveBeenCalledTimes(1)
    expect(spawnFn).toHaveBeenCalledWith(
      'opencode',
      ['serve', '--hostname', '127.0.0.1', '--port', '47999'],
      expect.objectContaining({ cwd: '/parent' }),
    )
    expect(calls.find((call) => call.url.endsWith('/session/ses_child/summarize'))).toMatchObject({
      url: 'http://127.0.0.1:47999/session/ses_child/summarize',
      init: expect.objectContaining({ method: 'POST' }),
    })
  })

  it('uses the default serve route for unknown existing sessions even after cwd sidecars exist', async () => {
    const childProject = fakeChild()
    const childDefault = fakeChild()
    const spawnFn = vi.fn()
      .mockReturnValueOnce(childProject)
      .mockReturnValueOnce(childDefault)
    const fetchFn = vi.fn(async (url: string, init: any) => {
      if (url === 'http://127.0.0.1:48000/global/health') return jsonResponse({ healthy: true })
      if (url === 'http://127.0.0.1:48000/session' && init?.method === 'POST') {
        return jsonResponse({ id: 'ses_project', directory: '/project-a' })
      }
      if (url === 'http://127.0.0.1:48000/session/ses_unknown' && init?.method === 'GET') {
        throw new Error('unknown session lookup must not hit cwd sidecar')
      }
      if (url === 'http://127.0.0.1:47999/global/health') return jsonResponse({ healthy: true })
      if (url === 'http://127.0.0.1:47999/session/ses_unknown' && init?.method === 'GET') {
        return jsonResponse({ id: 'ses_unknown', title: 'Unknown' })
      }
      return jsonResponse({}, { status: 404 })
    })
    const manager = new OpencodeServeManager({
      spawnFn: spawnFn as any,
      fetchFn: fetchFn as any,
      allocatePort: vi.fn()
        .mockResolvedValueOnce({ hostname: '127.0.0.1', port: 48000 })
        .mockResolvedValueOnce({ hostname: '127.0.0.1', port: 47999 }),
      connectEventStream: () => () => {},
      healthTimeoutMs: 1000,
    })

    await expect(manager.createSession({ directory: '/project-a' })).resolves.toMatchObject({ id: 'ses_project' })
    await expect(manager.getSession('ses_unknown')).resolves.toMatchObject({ id: 'ses_unknown' })

    expect(spawnFn).toHaveBeenCalledTimes(2)
    expect(spawnFn).toHaveBeenNthCalledWith(
      1,
      'opencode',
      ['serve', '--hostname', '127.0.0.1', '--port', '48000'],
      expect.objectContaining({ cwd: '/project-a' }),
    )
    expect(spawnFn.mock.calls[1]?.[2]).not.toHaveProperty('cwd')
    expect(fetchFn).not.toHaveBeenCalledWith('http://127.0.0.1:48000/session/ses_unknown', expect.anything())
    expect(fetchFn).toHaveBeenCalledWith('http://127.0.0.1:47999/session/ses_unknown', expect.anything())
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

  it('onceIdle resolves on session.status with idle for that session', async () => {
    let push!: (e: any) => void
    const { manager } = makeManager({
      connectEventStream: (_url, h) => { push = (e) => h.onEvent(parseEvt(e)); return () => {} },
    })
    await manager.ensureStarted()
    const idle = manager.onceIdle('ses_a', 1000)
    push({ type: 'session.status', properties: { sessionID: 'ses_a', status: { type: 'idle' } } })
    await expect(idle).resolves.toBeUndefined()
    expect((manager as any).sessionEmitters.get('ses_a')?.listenerCount('event') ?? 0).toBe(0)
  })

  it('onceIdle does not resolve on session.status busy for that session', async () => {
    let push!: (e: any) => void
    const { manager } = makeManager({
      connectEventStream: (_url, h) => { push = (e) => h.onEvent(parseEvt(e)); return () => {} },
    })
    await manager.ensureStarted()
    const idle = manager.onceIdle('ses_a', 100)
    push({ type: 'session.status', properties: { sessionID: 'ses_a', status: { type: 'busy' } } })
    const pending = await new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 50))
    expect(pending).toBe('pending')
    await expect(idle).rejects.toThrow(/idle/i)
  })

  it('onceIdle does not resolve on session.status idle for a different session', async () => {
    let push!: (e: any) => void
    const { manager } = makeManager({
      connectEventStream: (_url, h) => { push = (e) => h.onEvent(parseEvt(e)); return () => {} },
    })
    await manager.ensureStarted()
    const idle = manager.onceIdle('ses_a', 100)
    push({ type: 'session.status', properties: { sessionID: 'ses_b', status: { type: 'idle' } } })
    const pending = await new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 50))
    expect(pending).toBe('pending')
    await expect(idle).rejects.toThrow(/idle/i)
  })

  it('onceIdle resolves when status-map activity drops out of the OpenCode status map', async () => {
    let statusCalls = 0
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/global/health')) return jsonResponse({ healthy: true })
      if (url.endsWith('/session/status')) {
        statusCalls += 1
        return statusCalls === 1
          ? jsonResponse({ ses_a: { type: 'busy' } })
          : jsonResponse({})
      }
      return jsonResponse({})
    })
    const { manager } = makeManager({
      fetchFn: fetchFn as any,
      idlePollMs: 5,
    })
    await manager.ensureStarted()

    const idle = manager.onceIdle('ses_a', 1000)

    await expect(idle).resolves.toBeUndefined()
    expect(fetchFn).toHaveBeenCalledWith('http://127.0.0.1:47999/session/status', expect.anything())
    expect((manager as any).sessionEmitters.get('ses_a')?.listenerCount('event') ?? 0).toBe(0)
  })

  it('onceIdle does not resolve from status-map absence before observed OpenCode activity', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/global/health')) return jsonResponse({ healthy: true })
      if (url.endsWith('/session/status')) return jsonResponse({})
      return jsonResponse({})
    })
    const { manager } = makeManager({
      fetchFn: fetchFn as any,
      idlePollMs: 5,
    })
    await manager.ensureStarted()

    await expect(manager.onceIdle('ses_a', 30)).rejects.toThrow(/idle/i)
  })

  it('onceIdle ignores late message.updated events when the status map stays absent', async () => {
    let push!: (e: any) => void
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/global/health')) return jsonResponse({ healthy: true })
      if (url.endsWith('/session/status')) return jsonResponse({})
      return jsonResponse({})
    })
    const { manager } = makeManager({
      fetchFn: fetchFn as any,
      connectEventStream: (_url, h) => { push = (e) => h.onEvent(parseEvt(e)); return () => {} },
      idlePollMs: 5,
    })
    await manager.ensureStarted()

    const idle = manager.onceIdle('ses_a', 30)
    push({ type: 'message.updated', properties: { sessionID: 'ses_a', message: { id: 'old-turn' } } })

    await expect(idle).rejects.toThrow(/idle/i)
  })

  it('onceIdle waits for later running status-map evidence after a late message.updated event', async () => {
    let push!: (e: any) => void
    let statusCalls = 0
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/global/health')) return jsonResponse({ healthy: true })
      if (url.endsWith('/session/status')) {
        statusCalls += 1
        if (statusCalls <= 2) return jsonResponse({})
        if (statusCalls === 3) return jsonResponse({ ses_a: { type: 'busy' } })
        return jsonResponse({})
      }
      return jsonResponse({})
    })
    const { manager } = makeManager({
      fetchFn: fetchFn as any,
      connectEventStream: (_url, h) => { push = (e) => h.onEvent(parseEvt(e)); return () => {} },
      idlePollMs: 5,
    })
    await manager.ensureStarted()

    const idle = manager.onceIdle('ses_a', 80)
    push({ type: 'message.updated', properties: { sessionID: 'ses_a', message: { id: 'old-turn' } } })

    await expect(idle).resolves.toBeUndefined()
  })

  it('onceIdle does not resolve from a single busy signal plus one empty status-map poll', async () => {
    let push!: (e: any) => void
    let statusCalls = 0
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/global/health')) return jsonResponse({ healthy: true })
      if (url.endsWith('/session/status')) {
        statusCalls += 1
        if (statusCalls === 1) return jsonResponse({})
        throw new Error('status map unavailable')
      }
      return jsonResponse({})
    })
    const { manager } = makeManager({
      fetchFn: fetchFn as any,
      connectEventStream: (_url, h) => { push = (e) => h.onEvent(parseEvt(e)); return () => {} },
      idlePollMs: 5,
    })
    await manager.ensureStarted()

    const idle = manager.onceIdle('ses_a', 40)
    push({ type: 'session.status', properties: { sessionID: 'ses_a', status: { type: 'busy' } } })

    const pending = await Promise.race([
      idle.then(() => 'resolved', () => 'rejected'),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 15)),
    ])
    expect(pending).toBe('pending')
    await expect(idle).rejects.toThrow(/idle/i)
  })

  it('onceIdle warns only once per wait when status-map fallback polling keeps failing', async () => {
    let push!: (e: any) => void
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/global/health')) return jsonResponse({ healthy: true })
      if (url.endsWith('/session/status')) throw new Error('status map unavailable')
      return jsonResponse({})
    })
    const { manager } = makeManager({
      fetchFn: fetchFn as any,
      connectEventStream: (_url, h) => { push = (e) => h.onEvent(parseEvt(e)); return () => {} },
      idlePollMs: 5,
    })
    await manager.ensureStarted()

    const warnSpy = vi.spyOn((manager as any).log, 'warn').mockImplementation(() => undefined)
    const idle = manager.onceIdle('ses_a', 35)
    push({ type: 'session.status', properties: { sessionID: 'ses_a', status: { type: 'busy' } } })

    await expect(idle).rejects.toThrow(/idle/i)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('onceIdle requires a fresh consecutive idle/absent pair after a status-map poll failure', async () => {
    let push!: (e: any) => void
    let statusCalls = 0
    let allowFifthPoll!: () => void
    let noteFifthPollStarted!: () => void
    const fifthPollGate = new Promise<void>((resolve) => {
      allowFifthPoll = resolve
    })
    const fifthPollStarted = new Promise<void>((resolve) => {
      noteFifthPollStarted = resolve
    })
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/global/health')) return jsonResponse({ healthy: true })
      if (url.endsWith('/session/status')) {
        statusCalls += 1
        if (statusCalls === 1) return jsonResponse({ ses_a: { type: 'busy' } })
        if (statusCalls === 2) return jsonResponse({})
        if (statusCalls === 3) throw new Error('status map unavailable')
        if (statusCalls === 4) return jsonResponse({})
        if (statusCalls === 5) {
          noteFifthPollStarted()
          await fifthPollGate
          return jsonResponse({})
        }
        return jsonResponse({})
      }
      return jsonResponse({})
    })
    const { manager } = makeManager({
      fetchFn: fetchFn as any,
      connectEventStream: (_url, h) => { push = (e) => h.onEvent(parseEvt(e)); return () => {} },
      idlePollMs: 5,
    })
    await manager.ensureStarted()

    const idle = manager.onceIdle('ses_a', 100)
    push({ type: 'session.status', properties: { sessionID: 'ses_a', status: { type: 'busy' } } })

    await fifthPollStarted
    const pending = await Promise.race([
      idle.then(() => 'resolved', () => 'rejected'),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 15)),
    ])
    expect(pending).toBe('pending')

    allowFifthPoll()
    await expect(idle).resolves.toBeUndefined()
    expect(statusCalls).toBe(5)
  }, 1000)

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
    expect((manager as any).runningByCwd.size).toBe(0)
  })

  it('default sidecar close clears unmapped emitters but preserves mapped cwd sessions', async () => {
    const childDefault = fakeChild()
    const childProject = fakeChild()
    const spawnFn = vi.fn()
      .mockReturnValueOnce(childDefault)
      .mockReturnValueOnce(childProject)
    const fetchFn = vi.fn(async (url: string, init: any) => {
      if (url === 'http://127.0.0.1:47999/global/health') return jsonResponse({ healthy: true })
      if (url === 'http://127.0.0.1:47999/session/ses_project' && init?.method === 'GET') {
        return jsonResponse({ id: 'ses_project', directory: '/project-a' })
      }
      if (url === 'http://127.0.0.1:47999/session/ses_project/compact' && init?.method === 'POST') {
        return jsonResponse({}, { status: 204 })
      }
      if (url === 'http://127.0.0.1:48000/global/health') return jsonResponse({ healthy: true })
      if (url === 'http://127.0.0.1:48000/session/ses_project/summarize' && init?.method === 'POST') {
        return jsonResponse({}, { status: 204 })
      }
      return jsonResponse({}, { status: 404 })
    })
    const manager = new OpencodeServeManager({
      spawnFn: spawnFn as any,
      fetchFn: fetchFn as any,
      allocatePort: vi.fn()
        .mockResolvedValueOnce({ hostname: '127.0.0.1', port: 47999 })
        .mockResolvedValueOnce({ hostname: '127.0.0.1', port: 48000 }),
      connectEventStream: () => () => {},
      healthTimeoutMs: 1000,
    })

    await manager.ensureStarted()
    manager.subscribe('ses_default', () => {})
    await manager.getSession('ses_project')
    await manager.compact('ses_project')
    manager.subscribe('ses_project', () => {})
    expect(spawnFn).toHaveBeenCalledTimes(2)

    childDefault.emit('close', 1)

    expect((manager as any).sessionEmitters.has('ses_default')).toBe(false)
    expect((manager as any).sessionEmitters.has('ses_project')).toBe(true)
  })

  it('non-default sidecar close removes its mapped emitter and preserves unrelated default emitters', async () => {
    const childDefault = fakeChild()
    const childProject = fakeChild()
    const spawnFn = vi.fn()
      .mockReturnValueOnce(childDefault)
      .mockReturnValueOnce(childProject)
    const fetchFn = vi.fn(async (url: string, init: any) => {
      if (url === 'http://127.0.0.1:47999/global/health') return jsonResponse({ healthy: true })
      if (url === 'http://127.0.0.1:47999/session/ses_project' && init?.method === 'GET') {
        return jsonResponse({ id: 'ses_project', directory: '/project-a' })
      }
      if (url === 'http://127.0.0.1:47999/session/ses_project/compact' && init?.method === 'POST') {
        return jsonResponse({}, { status: 204 })
      }
      if (url === 'http://127.0.0.1:48000/global/health') return jsonResponse({ healthy: true })
      if (url === 'http://127.0.0.1:48000/session/ses_project/summarize' && init?.method === 'POST') {
        return jsonResponse({}, { status: 204 })
      }
      return jsonResponse({}, { status: 404 })
    })
    const manager = new OpencodeServeManager({
      spawnFn: spawnFn as any,
      fetchFn: fetchFn as any,
      allocatePort: vi.fn()
        .mockResolvedValueOnce({ hostname: '127.0.0.1', port: 47999 })
        .mockResolvedValueOnce({ hostname: '127.0.0.1', port: 48000 }),
      connectEventStream: () => () => {},
      healthTimeoutMs: 1000,
    })

    await manager.ensureStarted()
    manager.subscribe('ses_default', () => {})
    await manager.getSession('ses_project')
    await manager.compact('ses_project')
    manager.subscribe('ses_project', () => {})
    expect(spawnFn).toHaveBeenCalledTimes(2)
    expect((manager as any).sessionEmitters.has('ses_default')).toBe(true)
    expect((manager as any).sessionEmitters.has('ses_project')).toBe(true)

    childProject.emit('close', 1)

    expect((manager as any).sessionEmitters.has('ses_project')).toBe(false)
    expect((manager as any).sessionEmitters.has('ses_default')).toBe(true)
  })

  it('idles out cwd sidecars without stopping the default serve', async () => {
    vi.useFakeTimers()
    try {
      const childDefault = fakeChild()
      const childProject = fakeChild()
      const spawnFn = vi.fn()
        .mockReturnValueOnce(childDefault)
        .mockReturnValueOnce(childProject)
      const fetchFn = vi.fn(async (url: string, init: any) => {
        if (url === 'http://127.0.0.1:47999/global/health') return jsonResponse({ healthy: true })
        if (url === 'http://127.0.0.1:47999/session/ses_project' && init?.method === 'GET') {
          return jsonResponse({ id: 'ses_project', directory: '/project-a' })
        }
        if (url === 'http://127.0.0.1:47999/session/ses_project/compact' && init?.method === 'POST') {
          return jsonResponse({}, { status: 204 })
        }
        if (url === 'http://127.0.0.1:48000/global/health') return jsonResponse({ healthy: true })
        if (url === 'http://127.0.0.1:48000/session/ses_project/summarize' && init?.method === 'POST') {
          return jsonResponse({}, { status: 204 })
        }
        return jsonResponse({}, { status: 404 })
      })
      const manager = new OpencodeServeManager({
        spawnFn: spawnFn as any,
        fetchFn: fetchFn as any,
        allocatePort: vi.fn()
          .mockResolvedValueOnce({ hostname: '127.0.0.1', port: 47999 })
          .mockResolvedValueOnce({ hostname: '127.0.0.1', port: 48000 }),
        connectEventStream: () => () => {},
        healthTimeoutMs: 1000,
        idleShutdownMs: 50,
      } as any)

      await manager.ensureStarted()
      await manager.getSession('ses_project')
      await manager.compact('ses_project')
      expect(spawnFn).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(51)

      expect(childProject.kill).toHaveBeenCalled()
      expect(childDefault.kill).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
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
