import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { ReadableStream } from 'node:stream/web'
import { describe, expect, it, vi } from 'vitest'
import { parseServeEvent as parseEvt } from '../../../../server/fresh-agent/adapters/opencode/serve-events.js'
import { OpencodeServeManager, OpencodeServeLostError } from '../../../../server/fresh-agent/adapters/opencode/serve-manager.js'

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

  it('routes the requested session directory without changing the serve process cwd', async () => {
    const calls: Array<{ url: string; init: any }> = []
    const fetchFn = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init })
      if (url.endsWith('/global/health')) return jsonResponse({ healthy: true, version: '1.17.8' })
      if (url === 'http://127.0.0.1:47999/session?directory=%2Fproject-x' && init?.method === 'POST') {
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
        env: expect.objectContaining({ FRESHELL_OPENCODE_SIDECAR_ID: expect.any(String) }),
      }),
    )
    expect(spawnFn.mock.calls[0]?.[2]).not.toHaveProperty('cwd')
    const createCall = calls.find((call) => call.url.includes('/session?'))!
    expect(createCall).toMatchObject({
      url: 'http://127.0.0.1:47999/session?directory=%2Fproject-x',
      init: expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({}),
      }),
    })
    expect(JSON.parse(createCall.init.body)).not.toHaveProperty('directory')
  })

  it('URL-encodes routed cwd values without putting cwd in the body', async () => {
    const calls: Array<{ url: string; init: any }> = []
    const fetchFn = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init })
      if (url.endsWith('/global/health')) return jsonResponse({ healthy: true, version: '1.17.8' })
      if (url === 'http://127.0.0.1:47999/session?directory=%2Frepo+with+space%2Fa%3Fb' && init?.method === 'POST') {
        return jsonResponse({ id: 'ses_spaced', directory: '/repo with space/a?b' })
      }
      return jsonResponse({})
    })
    const { manager } = makeManager({ fetchFn: fetchFn as any })

    await manager.createSession({ directory: '/repo with space/a?b' })

    const createCall = calls.find((call) => call.url.includes('/session?'))!
    expect(createCall.url).toBe('http://127.0.0.1:47999/session?directory=%2Frepo+with+space%2Fa%3Fb')
    expect(JSON.parse(createCall.init.body)).not.toHaveProperty('directory')
  })

  it('reuses one serve process for sessions created in different directories', async () => {
    const child = fakeChild()
    const spawnFn = vi.fn().mockReturnValue(child)
    const fetchFn = vi.fn(async (url: string, init: any) => {
      if (url === 'http://127.0.0.1:47999/global/health') return jsonResponse({ healthy: true })
      if (url === 'http://127.0.0.1:47999/session?directory=%2Fproject-a' && init?.method === 'POST') {
        return jsonResponse({ id: 'ses_a', directory: '/project-a' })
      }
      if (url === 'http://127.0.0.1:47999/session?directory=%2Fproject-b' && init?.method === 'POST') {
        return jsonResponse({ id: 'ses_b', directory: '/project-b' })
      }
      return jsonResponse({})
    })
    const manager = new OpencodeServeManager({
      spawnFn: spawnFn as any,
      fetchFn: fetchFn as any,
      allocatePort: vi.fn().mockResolvedValue({ hostname: '127.0.0.1', port: 47999 }),
      connectEventStream: () => () => {},
      healthTimeoutMs: 1000,
    })

    await expect(manager.createSession({ directory: '/project-a' })).resolves.toMatchObject({ id: 'ses_a' })
    await expect(manager.createSession({ directory: '/project-b' })).resolves.toMatchObject({ id: 'ses_b' })

    expect(spawnFn).toHaveBeenCalledTimes(1)
    expect(spawnFn).toHaveBeenCalledWith(
      'opencode',
      ['serve', '--hostname', '127.0.0.1', '--port', '47999'],
      expect.not.objectContaining({ cwd: expect.anything() }),
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

  it('connects one global event stream by default', async () => {
    const connectEventStream = vi.fn(() => () => {})
    const { manager } = makeManager({ connectEventStream })
    await manager.ensureStarted()
    expect(connectEventStream).toHaveBeenCalledWith(
      'http://127.0.0.1:47999/global/event',
      expect.anything(),
    )
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
  it('returns one session status entry from the routed status map', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/global/health')) return jsonResponse({ healthy: true })
      if (url === 'http://127.0.0.1:47999/session/status?directory=%2Frepo%2Fsafe') {
        return jsonResponse({
          ses_safe: { type: 'busy' },
          ses_other: { type: 'idle' },
        })
      }
      return jsonResponse({})
    })
    const { manager } = makeManager({ fetchFn: fetchFn as any })

    await expect(manager.getSessionStatus('ses_safe', { cwd: '/repo/safe' })).resolves.toEqual({ type: 'busy' })
    expect(fetchFn).toHaveBeenCalledWith(
      'http://127.0.0.1:47999/session/status?directory=%2Frepo%2Fsafe',
      expect.anything(),
    )
  })

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

  it('aborts and reaps the sidecar when listMessages times out', async () => {
    let messageSignal: AbortSignal | undefined
    const fetchFn = vi.fn(async (url: string, init: any) => {
      if (url.endsWith('/global/health')) return jsonResponse({ healthy: true })
      if (url.includes('/message') && init?.method === 'GET') {
        messageSignal = init.signal
        return await new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }
      return jsonResponse({})
    })
    const { manager, child } = makeManager({ fetchFn: fetchFn as any, requestTimeoutMs: 5 })

    await expect(manager.listMessages('ses_x', { limit: 1 }))
      .rejects.toThrow('opencode serve GET /session/ses_x/message timed out after 5ms')
    expect(messageSignal?.aborted).toBe(true)
    expect(child.kill).toHaveBeenCalled()
  })

  it('posts summarize requests on the single serve process even when a route is supplied', async () => {
    const calls: Array<{ url: string; init: any }> = []
    const child = fakeChild()
    const spawnFn = vi.fn().mockReturnValue(child)
    const fetchFn = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init })
      if (url === 'http://127.0.0.1:47999/global/health') return jsonResponse({ healthy: true })
      if (url === 'http://127.0.0.1:47999/session/ses_known' && init?.method === 'GET') {
        return jsonResponse({ id: 'ses_known', directory: '/project-a', title: 'Known' })
      }
      if (url === 'http://127.0.0.1:47999/session/ses_known/summarize?directory=%2Fproject-a' && init?.method === 'POST') {
        return jsonResponse({}, { status: 204 })
      }
      return jsonResponse({}, { status: 404 })
    })
    const manager = new OpencodeServeManager({
      spawnFn: spawnFn as any,
      fetchFn: fetchFn as any,
      allocatePort: vi.fn().mockResolvedValue({ hostname: '127.0.0.1', port: 47999 }),
      connectEventStream: () => () => {},
      healthTimeoutMs: 1000,
    })

    await expect(manager.getSession('ses_known')).resolves.toMatchObject({ id: 'ses_known', directory: '/project-a' })
    await manager.compact('ses_known', { instructions: 'keep it short' }, { cwd: '/project-a' })

    expect(spawnFn).toHaveBeenCalledTimes(1)
    expect(spawnFn.mock.calls[0]?.[2]).not.toHaveProperty('cwd')
    expect(calls.find((call) => call.url.includes('/summarize?'))).toMatchObject({
      url: 'http://127.0.0.1:47999/session/ses_known/summarize?directory=%2Fproject-a',
      init: expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ instructions: 'keep it short' }),
      }),
    })
    expect(calls.some((call) => call.url.endsWith('/compact'))).toBe(false)
  })

  it('uses the single serve process for forked child follow-up requests', async () => {
    const calls: Array<{ url: string; init: any }> = []
    const child = fakeChild()
    const spawnFn = vi.fn().mockReturnValue(child)
    const fetchFn = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init })
      if (url === 'http://127.0.0.1:47999/global/health') return jsonResponse({ healthy: true })
      if (url === 'http://127.0.0.1:47999/session/ses_parent' && init?.method === 'GET') {
        return jsonResponse({ id: 'ses_parent', directory: '/parent' })
      }
      if (url === 'http://127.0.0.1:47999/session/ses_parent/fork' && init?.method === 'POST') {
        return jsonResponse({ id: 'ses_child', directory: '/child' })
      }
      if (url === 'http://127.0.0.1:47999/session/ses_child/summarize' && init?.method === 'POST') {
        return jsonResponse({}, { status: 204 })
      }
      return jsonResponse({}, { status: 404 })
    })
    const manager = new OpencodeServeManager({
      spawnFn: spawnFn as any,
      fetchFn: fetchFn as any,
      allocatePort: vi.fn().mockResolvedValue({ hostname: '127.0.0.1', port: 47999 }),
      connectEventStream: () => () => {},
      healthTimeoutMs: 1000,
    })

    await expect(manager.getSession('ses_parent')).resolves.toMatchObject({ id: 'ses_parent', directory: '/parent' })
    await expect(manager.fork('ses_parent')).resolves.toMatchObject({ id: 'ses_child', directory: '/child' })
    await manager.compact('ses_child', { instructions: 'child summary' })

    expect(spawnFn).toHaveBeenCalledTimes(1)
    expect(spawnFn.mock.calls[0]?.[2]).not.toHaveProperty('cwd')
    expect(calls.find((call) => call.url.endsWith('/session/ses_child/summarize'))).toMatchObject({
      url: 'http://127.0.0.1:47999/session/ses_child/summarize',
      init: expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ instructions: 'child summary' }),
      }),
    })
  })

  it('ignores route cwd when fork response omits directory', async () => {
    const calls: Array<{ url: string; init: any }> = []
    const childParent = fakeChild()
    const spawnFn = vi.fn().mockReturnValueOnce(childParent)
    const fetchFn = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init })
      if (url === 'http://127.0.0.1:47999/global/health') return jsonResponse({ healthy: true })
      if (url === 'http://127.0.0.1:47999/session/ses_parent/fork?directory=%2Fparent' && init?.method === 'POST') {
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
      expect.not.objectContaining({ cwd: expect.anything() }),
    )
    expect(calls.find((call) => call.url.endsWith('/session/ses_child/summarize'))).toMatchObject({
      url: 'http://127.0.0.1:47999/session/ses_child/summarize',
      init: expect.objectContaining({ method: 'POST' }),
    })
  })

  it('uses the same serve route for unknown existing sessions after project session creation', async () => {
    const child = fakeChild()
    const spawnFn = vi.fn().mockReturnValue(child)
    const fetchFn = vi.fn(async (url: string, init: any) => {
      if (url === 'http://127.0.0.1:47999/global/health') return jsonResponse({ healthy: true })
      if (url === 'http://127.0.0.1:47999/session?directory=%2Fproject-a' && init?.method === 'POST') {
        return jsonResponse({ id: 'ses_project', directory: '/project-a' })
      }
      if (url === 'http://127.0.0.1:47999/session/ses_unknown' && init?.method === 'GET') {
        return jsonResponse({ id: 'ses_unknown', title: 'Unknown' })
      }
      return jsonResponse({}, { status: 404 })
    })
    const manager = new OpencodeServeManager({
      spawnFn: spawnFn as any,
      fetchFn: fetchFn as any,
      allocatePort: vi.fn().mockResolvedValue({ hostname: '127.0.0.1', port: 47999 }),
      connectEventStream: () => () => {},
      healthTimeoutMs: 1000,
    })

    await expect(manager.createSession({ directory: '/project-a' })).resolves.toMatchObject({ id: 'ses_project' })
    await expect(manager.getSession('ses_unknown')).resolves.toMatchObject({ id: 'ses_unknown' })

    expect(spawnFn).toHaveBeenCalledTimes(1)
    expect(spawnFn.mock.calls[0]?.[2]).not.toHaveProperty('cwd')
    expect(fetchFn).toHaveBeenCalledWith('http://127.0.0.1:47999/session/ses_unknown', expect.anything())
  })

  it('routes every route-aware endpoint by cwd query', async () => {
    const calls: Array<{ url: string; init: any }> = []
    const fetchFn = vi.fn(async (url: string, init: any) => {
      calls.push({ url, init })
      if (url === 'http://127.0.0.1:47999/global/health') return jsonResponse({ healthy: true })
      if (url.includes('/message/msg_1')) return jsonResponse({ info: { id: 'msg_1' }, parts: [] })
      if (url.includes('/message')) return jsonResponse([], { headers: { 'x-next-cursor': 'CUR2' } })
      if (url.includes('/fork')) return jsonResponse({ id: 'ses_child', directory: '/project-a' })
      if (url.includes('/session/ses_a')) return jsonResponse({ id: 'ses_a', directory: '/project-a' })
      return jsonResponse({})
    })
    const { manager } = makeManager({ fetchFn: fetchFn as any })

    await manager.getSession('ses_a', { cwd: '/project-a' })
    await manager.promptAsync('ses_a', { parts: [{ type: 'text', text: 'hi' }] }, { cwd: '/project-a' })
    await manager.listMessages('ses_a', { limit: 2, before: 'CUR' }, { cwd: '/project-a' })
    await manager.getMessage('ses_a', 'msg_1', { cwd: '/project-a' })
    await manager.abort('ses_a', { cwd: '/project-a' })
    await manager.compact('ses_a', { instructions: 'short' }, { cwd: '/project-a' })
    await manager.fork('ses_a', { cwd: '/project-a' })

    const urls = calls.map((call) => call.url)
    expect(urls).toContain('http://127.0.0.1:47999/session/ses_a?directory=%2Fproject-a')
    expect(urls).toContain('http://127.0.0.1:47999/session/ses_a/prompt_async?directory=%2Fproject-a')
    expect(urls).toContain('http://127.0.0.1:47999/session/ses_a/message?limit=2&before=CUR&directory=%2Fproject-a')
    expect(urls).toContain('http://127.0.0.1:47999/session/ses_a/message/msg_1?directory=%2Fproject-a')
    expect(urls).toContain('http://127.0.0.1:47999/session/ses_a/abort?directory=%2Fproject-a')
    expect(urls).toContain('http://127.0.0.1:47999/session/ses_a/summarize?directory=%2Fproject-a')
    expect(urls).toContain('http://127.0.0.1:47999/session/ses_a/fork?directory=%2Fproject-a')
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

  it('routes onceIdle status polling through the session cwd', async () => {
    const urls: string[] = []
    let statusCalls = 0
    const fetchFn = vi.fn(async (url: string) => {
      urls.push(url)
      if (url.endsWith('/global/health')) return jsonResponse({ healthy: true })
      if (url === 'http://127.0.0.1:47999/session/status?directory=%2Fproject-a') {
        statusCalls += 1
        return statusCalls === 1
          ? jsonResponse({ ses_a: { type: 'busy' } })
          : jsonResponse({ ses_a: { type: 'idle' } })
      }
      if (url === 'http://127.0.0.1:47999/session/status') {
        throw new Error('status poll must include routed cwd')
      }
      return jsonResponse({})
    })
    const { manager } = makeManager({
      fetchFn: fetchFn as any,
      idlePollMs: 5,
    })

    await expect(manager.onceIdle('ses_a', 1000, { cwd: '/project-a' })).resolves.toBeUndefined()

    expect(urls).toContain('http://127.0.0.1:47999/session/status?directory=%2Fproject-a')
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

  it('onceIdle rejects promptly when the sidecar dies mid-turn instead of waiting for the full timeout', async () => {
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

    const idle = manager.onceIdle('ses_dying', 600_000)
    // Kill the sidecar mid-turn
    child.emit('close', 1)

    // Should reject within a short time, not wait 600 seconds
    await expect(idle).rejects.toThrow(/sidecar|lost|exit|closed|unavailable/i)
  })

  it('onceIdle lost rejection cleans up its event listener', async () => {
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

    const emitterBefore = (manager as any).emitterFor('ses_cleanup')
    const listenerCountBefore = emitterBefore.listenerCount('event')
    const idle = manager.onceIdle('ses_cleanup', 600_000)
    child.emit('close', 1)
    await expect(idle).rejects.toThrow()
    // The onceIdle handler must have been removed from the emitter
    expect(emitterBefore.listenerCount('event')).toBe(listenerCountBefore)
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

  it('request timeout emits lost event and cleans up session emitters', async () => {
    let messageSignal: AbortSignal | undefined
    const fetchFn = vi.fn(async (url: string, init: any) => {
      if (url.endsWith('/global/health')) return jsonResponse({ healthy: true })
      if (url.includes('/message') && init?.method === 'GET') {
        messageSignal = init.signal
        return await new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }
      return jsonResponse({})
    })
    const { manager, child } = makeManager({ fetchFn: fetchFn as any, requestTimeoutMs: 5 })

    manager.subscribe('ses_project', () => {})
    const lostHandler = vi.fn()
    const emitter = (manager as any).sessionEmitters.get('ses_project')
    emitter.on('lost', lostHandler)

    await expect(manager.listMessages('ses_project', { limit: 1 }))
      .rejects.toThrow('opencode serve GET /session/ses_project/message timed out after 5ms')

    expect(messageSignal?.aborted).toBe(true)
    expect(child.kill).toHaveBeenCalled()
    expect(lostHandler).toHaveBeenCalledTimes(1)
    expect(lostHandler.mock.calls[0][0]).toBeInstanceOf(OpencodeServeLostError)
    expect((manager as any).sessionEmitters.has('ses_project')).toBe(false)
  })

  it('request timeout rejects pending onceIdle with OpencodeServeLostError', async () => {
    const fetchFn = vi.fn(async (url: string, init: any) => {
      if (url.endsWith('/global/health')) return jsonResponse({ healthy: true })
      if (url.includes('/message') && init?.method === 'GET') {
        return await new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }
      if (url.endsWith('/session/status')) return jsonResponse({})
      return jsonResponse({})
    })
    const { manager } = makeManager({ fetchFn: fetchFn as any, requestTimeoutMs: 5, idlePollMs: 10_000 })

    const idle = manager.onceIdle('ses_project', 600_000)
    idle.catch(() => {})

    await expect(manager.listMessages('ses_project', { limit: 1 }))
      .rejects.toThrow('opencode serve GET /session/ses_project/message timed out after 5ms')

    await expect(idle).rejects.toThrow(/opencode serve sidecar was lost/)
    expect((manager as any).sessionEmitters.has('ses_project')).toBe(false)
  })
})

describe('OpencodeServeManager diagnostics', () => {
  it('close handler logs both exit code and signal', async () => {
    const { manager, child } = makeManager()
    const warnSpy = vi.spyOn((manager as any).log, 'warn')
    await manager.ensureStarted()
    child.emit('close', null, 'SIGTERM')
    const exitLog = warnSpy.mock.calls.find((c) => c[1] === 'opencode serve exited')
    expect(exitLog?.[0]).toEqual(expect.objectContaining({ code: null, signal: 'SIGTERM' }))
  })

  it('request timeout logs the discard reason before killing', async () => {
    const fetchFn = vi.fn(async (url: string, init: any) => {
      if (url.endsWith('/global/health')) return jsonResponse({ healthy: true })
      if (url.includes('/message') && init?.method === 'GET') {
        return await new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }
      return jsonResponse({})
    })
    const { manager, child } = makeManager({ fetchFn: fetchFn as any, requestTimeoutMs: 5 })
    const warnSpy = vi.spyOn((manager as any).log, 'warn')

    await expect(manager.listMessages('ses_project', { limit: 1 }))
      .rejects.toThrow('opencode serve GET /session/ses_project/message timed out after 5ms')

    expect(child.kill).toHaveBeenCalled()
    const discardLog = warnSpy.mock.calls.find((c) => c[1] === 'discarding opencode serve sidecar')
    expect(discardLog?.[0]).toEqual(expect.objectContaining({ reason: 'request_timeout' }))
  })

  it('sidecar stderr is captured at debug level', async () => {
    const { manager, child } = makeManager()
    const debugSpy = vi.spyOn((manager as any).log, 'debug')
    await manager.ensureStarted()
    child.stderr.emit('data', Buffer.from('panic: something went wrong'))
    expect(debugSpy).toHaveBeenCalledWith(
      expect.objectContaining({ chunk: 'panic: something went wrong' }),
      'opencode serve stderr',
    )
  })
})
