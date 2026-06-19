# Freshopencode Cwd-Scoped Serve Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freshopencode first-run sessions start in the directory the user selected, not in the Freshell server checkout.

**Architecture:** OpenCode `serve` is cwd-bound: OpenCode 1.17.8 records new sessions in the serve process cwd even when `POST /session` includes a different `directory`. Replace the single global serve process inside `OpencodeServeManager` with cwd-scoped serve processes and route every session operation to the sidecar that owns that session. Keep the existing adapter surface stable; only add optional cwd routing where existing restored-session paths need it.

**Tech Stack:** Node.js/TypeScript, ESM with `.js` relative imports, Vitest server config, Express/supertest for existing agent API coverage, OpenCode CLI `serve`.

## Global Constraints

- Server uses NodeNext/ESM; relative imports must include `.js` extensions.
- Do not restart the self-hosted Freshell server without explicit user approval containing the word `APPROVED`.
- Do not use broad kill patterns; stop only owned PIDs or ownership-tagged OpenCode serve processes.
- Preserve unrelated worktree changes from other agents.
- Use red/green/refactor TDD; do not skip tests or reduce coverage.
- Keep behavior changes on this dedicated worktree branch and commit focused, atomic changes.
- Prefer integration/end-to-end tests that prove the user-visible contract.

## Load-Bearing Validation Amendments

These amendments supersede any conflicting task text below:

- OpenCode 1.17.8 uses persisted `session.directory` as the execution/tool cwd for existing session-scoped operations. Fixing session creation directory is the critical user-visible fix.
- Existing session-scoped operations can be sent through any healthy serve process because OpenCode loads the session row and routes by stored `directory`; cwd routing is still useful when Freshell already knows cwd, but restored no-cwd paths must remain valid through the default route.
- Freshopencode cannot assume every restored/attached durable session has pane cwd available. When cwd is missing, do not fail the operation; use the default serve route for existing session endpoints, and remember cwd if a later `getSession` or `fork` response exposes a `directory`.
- OpenCode 1.17.8 does not expose a JSON `/session/:id/compact` endpoint. Freshell compaction must call the current `/session/:id/summarize` route.
- A sidecar per cwd must not live forever by default. Add a configurable idle shutdown timer for non-default cwd-scoped sidecars and cancel/reschedule it around operations.
- Project-local OpenCode config is intentionally selected by the user's cwd. Preserve inherited global credentials/config environment, but expect provider/model/project config to vary by selected cwd.

Implementation updates required by this amendment:

- Treat concrete code snippets later in this plan as subordinate to this section. If a snippet still calls `/compact`, omits idle shutdown, forgets returned `directory`, or unconditionally passes `{ cwd: undefined }`, implement the corrected behavior below instead.
- In `OpencodeServeManager`, add an optional constructor setting such as `idleShutdownMs` and default it to a nonzero idle timeout for cwd-scoped sidecars. Tests may set it to `0` or a small value.
- Do not route an existing session with unknown cwd to a guessed project cwd. Use the default serve route and let OpenCode's session middleware route by stored `directory`.
- When `getSession()` or `fork()` returns a `directory`, call `rememberSessionCwd()` for that session id.
- Change `compact()` to POST `/session/:id/summarize`.
- Add manager tests for `/summarize`, no-cwd restored-session routing through the default serve, returned-directory remembering, and idle sidecar shutdown.
- Add adapter tests for both known-cwd restored sends and no-cwd restored sends. The no-cwd case should call manager methods without a third `{ cwd }` argument.
- In the real-provider regression, prefer the existing isolated real-session harness helpers so `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, and DB path are temp-scoped and the suite remains single-threaded.

Task-level override checklist:

- Task 2 must update `OpencodeServeManagerOptions`, `RunningServe`, `ensureStarted`, `start`, HTTP helpers, `shutdown`, and child-close cleanup for cwd-scoped sidecars. On child close, delete emitters for sessions mapped to that cwd; when the closing sidecar is the default route, also delete unmapped emitters, because no-cwd restored sessions use the default route.
- Task 2 must add an optional `env?: NodeJS.ProcessEnv` manager option. Spawn env should be `{ ...(options.env ?? process.env), [FRESHELL_OPENCODE_SIDECAR_ID]: ownershipId }`, so real-provider tests can use isolated OpenCode homes without mutating global `process.env`.
- Task 2 must clear successful `startPromiseByCwd` entries after a sidecar has moved into `runningByCwd`.
- Task 2 must add tests proving:
  - `createSession({ directory })` spawns `opencode serve` with that `cwd`.
  - different directories get different sidecars/ports.
  - `compact()` posts to `/session/:id/summarize`.
  - `getSession()` remembers a returned `directory`.
  - `fork()` remembers the returned child `directory`, not just the parent route.
  - existing-session calls with no known cwd use the default serve route.
  - default sidecar close clears unmapped emitters, while non-default sidecar close only clears emitters for sessions mapped to that cwd.
  - idle shutdown stops non-default sidecars after the configured timeout and does not stop the default sidecar.
- Task 3 must update `makeFakeManager().createSession` so it returns `directory: input.directory` only when a test actually created the pane with cwd, or else update every existing arity-strict manager expectation affected by the new route argument. Do not leave tests with a fake manager that always returns `/repo` while claiming no-cwd calls stay two-argument.
- Task 3 must ensure helper calls omit the route argument entirely when no cwd is known. History helpers must not pass `{ cwd: undefined }`.
- Task 3 must update all existing adapter expectations affected by known cwd routing, including `promptAsync`, `abort`, `compact`, `fork`, `getSession`, `listMessages`, and `getMessage`.
- Task 4 must avoid a static top-level `node:sqlite` import in the real-provider smoke. Use existing helper functions such as `seedOpencodeHomes()` and `waitForOpencodeDbSession()` or the same dynamic/read-only pattern already used by OpenCode history code.

---

## File Structure

- Modify: `server/fresh-agent/adapters/opencode/serve-manager.ts`
  - Own cwd-scoped OpenCode serve processes.
  - Normalize cwd keys.
  - Route session HTTP calls to the sidecar for that session.
  - Clean up only the sidecar and emitters for the cwd that exits.
- Modify: `server/fresh-agent/adapters/opencode/adapter.ts`
  - Preserve cwd on create/resume/attach.
  - Pass cwd fallbacks into serve-manager methods for restored sessions whose session id was not created in this process.
- Modify: `test/unit/server/fresh-agent/opencode-serve-manager.test.ts`
  - Pin cwd-scoped spawn behavior and per-session routing.
- Modify: `test/unit/server/fresh-agent/opencode-serve-adapter.test.ts`
  - Pin attach/resume cwd propagation into manager session operations.
- Modify: `test/integration/server/opencode-serve-real-provider-smoke.test.ts`
  - Add a no-LLM real-provider regression: `POST /session` from a manager whose process cwd is not the selected cwd must still produce an OpenCode session whose directory is the selected cwd.

## Task 1: Pin The OpenCode Serve Cwd Contract

**Files:**
- Modify: `test/unit/server/fresh-agent/opencode-serve-manager.test.ts`

**Interfaces:**
- Consumes: existing `OpencodeServeManager.createSession(input: { directory?: string })`
- Produces: failing tests that require `OpencodeServeManager` to spawn serve with `cwd: input.directory`

- [ ] **Step 1: Write the failing unit test for first materialization cwd**

Add this test in `describe('OpencodeServeManager lifecycle', ...)` after `lazily spawns one serve, health-gates, and reuses it across ensureStarted calls`:

```ts
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
```

- [ ] **Step 2: Write the failing unit test for separate cwd sidecars**

Add this test in the same describe block:

```ts
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/fresh-agent/opencode-serve-manager.test.ts --run
```

Expected: FAIL. The first new test should show `spawnFn` was called without `cwd`. The second new test should show only one spawn/port was used for both directories.

- [ ] **Step 4: Commit the red tests**

```bash
git add test/unit/server/fresh-agent/opencode-serve-manager.test.ts
git commit -m "test: pin freshopencode serve cwd contract"
```

## Task 2: Make OpencodeServeManager Cwd-Scoped

**Files:**
- Modify: `server/fresh-agent/adapters/opencode/serve-manager.ts`
- Test: `test/unit/server/fresh-agent/opencode-serve-manager.test.ts`

**Interfaces:**
- Consumes: `createSession(input: { title?: string; parentID?: string; directory?: string })`
- Produces:
  - `ensureStarted(input?: { cwd?: string }): Promise<{ baseUrl: string }>`
  - `rememberSessionCwd(sessionId: string, cwd?: string): void`
  - `OpencodeServeManagerOptions.env?: NodeJS.ProcessEnv`
  - `OpencodeServeManagerOptions.idleShutdownMs?: number`
  - Existing public methods still work, with optional route argument where session ids need a restored cwd fallback.

- [ ] **Step 1: Add cwd route types and maps**

In `server/fresh-agent/adapters/opencode/serve-manager.ts`, add the `node:path` import and replace the single-running fields with cwd-keyed state:

```ts
import path from 'node:path'
```

Replace the current `RunningServe` type with:

```ts
type RunningServe = {
  baseUrl: string
  ownershipId: string
  child: ChildProcessWithoutNullStreams
  stopEventStream: () => void
  cwdKey: string
  cwd?: string
  idleTimer?: NodeJS.Timeout
  activeRequests: number
}

type ServeRoute = {
  cwd?: string
}

const DEFAULT_CWD_KEY = '<inherit-process-cwd>'
```

Replace:

```ts
  private running: RunningServe | undefined
  private startPromise: Promise<RunningServe> | undefined
  private startAbort: AbortController | undefined
```

with:

```ts
  private readonly runningByCwd = new Map<string, RunningServe>()
  private readonly startPromiseByCwd = new Map<string, Promise<RunningServe>>()
  private readonly startAbortByCwd = new Map<string, AbortController>()
  private readonly cwdByKey = new Map<string, string | undefined>()
  private readonly sessionCwdById = new Map<string, string>()
  private readonly env: NodeJS.ProcessEnv
  private readonly idleShutdownMs: number
```

Add these constructor fields:

```ts
    this.env = options.env ?? process.env
    this.idleShutdownMs = options.idleShutdownMs ?? 15 * 60_000
```

- [ ] **Step 2: Add cwd normalization and session routing helpers**

Add these private helpers inside `OpencodeServeManager`:

```ts
  private routeFromCwd(cwd?: string): { cwdKey: string; cwd?: string } {
    const trimmed = typeof cwd === 'string' && cwd.trim().length > 0 ? cwd.trim() : undefined
    if (!trimmed) return { cwdKey: DEFAULT_CWD_KEY }
    const resolved = path.resolve(trimmed)
    return { cwdKey: resolved, cwd: resolved }
  }

  private routeForSession(sessionId: string, fallback?: ServeRoute): { cwdKey: string; cwd?: string } {
    const existingKey = this.sessionCwdById.get(sessionId)
    if (existingKey) {
      return { cwdKey: existingKey, cwd: this.cwdByKey.get(existingKey) }
    }
    return this.routeFromCwd(fallback?.cwd)
  }

  rememberSessionCwd(sessionId: string, cwd?: string): void {
    if (!sessionId) return
    const route = this.routeFromCwd(cwd)
    this.cwdByKey.set(route.cwdKey, route.cwd)
    this.sessionCwdById.set(sessionId, route.cwdKey)
  }

  private forgetSessionsForCwd(cwdKey: string): void {
    for (const [sessionId, sessionCwdKey] of this.sessionCwdById.entries()) {
      if (sessionCwdKey !== cwdKey) continue
      this.sessionCwdById.delete(sessionId)
      this.sessionEmitters.delete(sessionId)
    }
    if (cwdKey === DEFAULT_CWD_KEY) {
      for (const sessionId of this.sessionEmitters.keys()) {
        if (!this.sessionCwdById.has(sessionId)) this.sessionEmitters.delete(sessionId)
      }
    }
  }

  private clearIdleTimer(running: RunningServe): void {
    if (!running.idleTimer) return
    clearTimeout(running.idleTimer)
    running.idleTimer = undefined
  }

  private scheduleIdleShutdown(running: RunningServe): void {
    this.clearIdleTimer(running)
    if (running.cwdKey === DEFAULT_CWD_KEY || this.idleShutdownMs <= 0 || running.activeRequests > 0) return
    running.idleTimer = setTimeout(() => {
      if (running.activeRequests > 0) return
      if (this.runningByCwd.get(running.cwdKey) !== running) return
      this.runningByCwd.delete(running.cwdKey)
      this.startPromiseByCwd.delete(running.cwdKey)
      this.forgetSessionsForCwd(running.cwdKey)
      try { running.stopEventStream() } catch { /* ignore */ }
      void killOwnedProcesses(running.child, running.ownershipId, this.log)
    }, this.idleShutdownMs)
    running.idleTimer.unref?.()
  }

  private async withRunning<T>(
    route: { cwdKey: string; cwd?: string },
    fn: (baseUrl: string) => Promise<T>,
  ): Promise<T> {
    const { baseUrl } = await this.ensureStarted({ cwd: route.cwd })
    const running = this.runningByCwd.get(route.cwdKey)
    if (!running) return fn(baseUrl)
    this.clearIdleTimer(running)
    running.activeRequests += 1
    try {
      return await fn(baseUrl)
    } finally {
      running.activeRequests -= 1
      this.scheduleIdleShutdown(running)
    }
  }
```

- [ ] **Step 3: Replace `ensureStarted` and `start` with cwd-aware versions**

Replace `ensureStarted()` with:

```ts
  async ensureStarted(input: ServeRoute = {}): Promise<{ baseUrl: string }> {
    if (this.shutdownRequested) {
      throw new Error('opencode serve manager is shutting down')
    }
    const route = this.routeFromCwd(input.cwd)
    this.cwdByKey.set(route.cwdKey, route.cwd)
    const running = this.runningByCwd.get(route.cwdKey)
    if (running) return { baseUrl: running.baseUrl }
    if (!this.startPromiseByCwd.has(route.cwdKey)) {
      const promise = this.start(route).catch((err) => {
        this.startPromiseByCwd.delete(route.cwdKey)
        throw err
      })
      this.startPromiseByCwd.set(route.cwdKey, promise)
    }
    const next = await this.startPromiseByCwd.get(route.cwdKey)!
    this.startPromiseByCwd.delete(route.cwdKey)
    return { baseUrl: next.baseUrl }
  }
```

Change the `start` signature and spawn options:

```ts
  private async start(route: { cwdKey: string; cwd?: string }): Promise<RunningServe> {
    const startAbort = new AbortController()
    this.startAbortByCwd.set(route.cwdKey, startAbort)
    const startSignal = startAbort.signal
    let child: ChildProcessWithoutNullStreams | undefined
    try {
      const endpoint = await this.allocatePort()
      const baseUrl = `http://${endpoint.hostname}:${endpoint.port}`
      const ownershipId = randomUUID()
      child = this.spawnFn(
        this.command,
        ['serve', '--hostname', endpoint.hostname, '--port', String(endpoint.port)],
        {
          ...(route.cwd ? { cwd: route.cwd } : {}),
          env: { ...this.env, [OWNERSHIP_ENV]: ownershipId },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ) as unknown as ChildProcessWithoutNullStreams
      child.stdout?.on('data', () => {})
      child.stderr?.on('data', () => {})
      child.on('error', (err) => this.log.error({ err }, 'opencode serve process error'))
      child.on('close', (code) => {
        this.log.warn({ code }, 'opencode serve exited')
        const running = this.runningByCwd.get(route.cwdKey)
        if (running && running.child === child) {
          this.runningByCwd.delete(route.cwdKey)
          this.startPromiseByCwd.delete(route.cwdKey)
          this.startAbortByCwd.delete(route.cwdKey)
          this.clearIdleTimer(running)
          try { running.stopEventStream() } catch { /* ignore */ }
          void killOwnedProcesses(running.child, running.ownershipId, this.log)
          this.forgetSessionsForCwd(route.cwdKey)
        }
      })

      await this.waitForHealth(baseUrl, child, startSignal)

      if (this.shutdownRequested || startSignal.aborted) {
        this.stopChild(child)
        throw new Error('opencode serve startup was aborted')
      }

      const stopEventStream = this.connectEventStream
        ? this.connectEventStream(`${baseUrl}/event`, {
            onEvent: (e) => this.dispatchEvent(e),
            onError: (err) => this.log.warn({ err }, 'opencode serve event stream error'),
          })
        : this.startDefaultEventStream(baseUrl)

      const running: RunningServe = { baseUrl, ownershipId, child, stopEventStream, cwdKey: route.cwdKey, cwd: route.cwd, activeRequests: 0 }
      this.runningByCwd.set(route.cwdKey, running)
      this.scheduleIdleShutdown(running)
      return running
    } catch (err) {
      if (child) this.stopChild(child)
      this.startPromiseByCwd.delete(route.cwdKey)
      throw err
    } finally {
      if (this.startAbortByCwd.get(route.cwdKey) === startAbort) this.startAbortByCwd.delete(route.cwdKey)
    }
  }
```

- [ ] **Step 4: Route HTTP helpers by cwd or session id**

Replace `requireBase` and `json` with:

```ts
  private async requireBase(input: ServeRoute & { sessionId?: string } = {}): Promise<string> {
    const route = input.sessionId
      ? this.routeForSession(input.sessionId, input)
      : this.routeFromCwd(input.cwd)
    const { baseUrl } = await this.ensureStarted({ cwd: route.cwd })
    return baseUrl
  }

  private async json<T>(
    route: ServeRoute & { sessionId?: string },
    requestPath: string,
    init?: RequestInit & { notFoundValue?: T },
  ): Promise<T> {
    const resolved = route.sessionId
      ? this.routeForSession(route.sessionId, route)
      : this.routeFromCwd(route.cwd)
    return this.withRunning(resolved, async (base) => {
      const res = await this.fetchFn(`${base}${requestPath}`, init)
      if (!res.ok && res.status !== 204) {
        if (res.status === 404 && init?.notFoundValue !== undefined) return init.notFoundValue
        const text = await res.text().catch(() => '')
        throw new Error(`opencode serve ${init?.method ?? 'GET'} ${requestPath} → ${res.status} ${text}`)
      }
      if (res.status === 204) return undefined as T
      return (await res.json()) as T
    })
  }
```

Update each caller:

```ts
  async createSession(input: { title?: string; parentID?: string; directory?: string } = {}): Promise<{ id: string; directory?: string; title?: string }> {
    const body: { title?: string; parentID?: string; directory?: string } = {}
    if (input.title !== undefined) body.title = input.title
    if (input.parentID !== undefined) body.parentID = input.parentID
    if (input.directory !== undefined) body.directory = input.directory
    const session = await this.json<{ id: string; directory?: string; title?: string }>(
      { cwd: input.directory },
      '/session',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    )
    if (typeof session.id === 'string') this.rememberSessionCwd(session.id, input.directory)
    return session
  }

  async getSession(id: string, route: ServeRoute = {}): Promise<Record<string, any>> {
    const session = await this.json<Record<string, any>>({ ...route, sessionId: id }, `/session/${encodeURIComponent(id)}`, { method: 'GET' })
    if (typeof session?.directory === 'string' && session.directory.length > 0) {
      this.rememberSessionCwd(id, session.directory)
    }
    return session
  }

  async promptAsync(
    id: string,
    body: { parts: Array<Record<string, unknown>>; model?: { providerID: string; modelID: string }; variant?: string; agent?: string },
    route: ServeRoute = {},
  ): Promise<void> {
    await this.json({ ...route, sessionId: id }, `/session/${encodeURIComponent(id)}/prompt_async`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  async getMessage(id: string, messageId: string, route: ServeRoute = {}): Promise<OpencodeServeMessage | null> {
    return this.json<OpencodeServeMessage | null>(
      { ...route, sessionId: id },
      `/session/${encodeURIComponent(id)}/message/${encodeURIComponent(messageId)}`,
      { method: 'GET', notFoundValue: null },
    )
  }

  async abort(id: string, route: ServeRoute = {}): Promise<void> {
    await this.json({ ...route, sessionId: id }, `/session/${encodeURIComponent(id)}/abort`, { method: 'POST' })
  }

  async compact(id: string, body?: { instructions?: string }, route: ServeRoute = {}): Promise<void> {
    await this.json({ ...route, sessionId: id }, `/session/${encodeURIComponent(id)}/summarize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
  }

  async fork(id: string, route: ServeRoute = {}): Promise<{ id: string; directory?: string }> {
    const child = await this.json<{ id: string; directory?: string }>({ ...route, sessionId: id }, `/session/${encodeURIComponent(id)}/fork`, { method: 'POST' })
    if (typeof child.id === 'string') {
      this.rememberSessionCwd(child.id, child.directory)
    }
    return child
  }
```

Update `listMessages`:

```ts
  async listMessages(id: string, query: { limit?: number; before?: string }, route: ServeRoute = {}): Promise<OpencodeServeMessagePage> {
    const resolved = this.routeForSession(id, route)
    return this.withRunning(resolved, async (base) => {
      const params = new URLSearchParams()
      if (typeof query.limit === 'number') params.set('limit', String(query.limit))
      if (query.before) params.set('before', query.before)
      const qs = params.toString()
      const url = `${base}/session/${encodeURIComponent(id)}/message${qs ? `?${qs}` : ''}`
      const res = await this.fetchFn(url, { method: 'GET' })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`opencode serve GET messages → ${res.status} ${text}`)
      }
      const messages = (await res.json()) as OpencodeServeMessage[]
      const nextCursor = res.headers.get('x-next-cursor') || null
      return { messages: Array.isArray(messages) ? messages : [], nextCursor }
    })
  }
```

- [ ] **Step 5: Update shutdown and inspection behavior**

Replace `shutdown()` with:

```ts
  async shutdown(): Promise<void> {
    this.shutdownRequested = true
    for (const controller of this.startAbortByCwd.values()) {
      controller.abort()
    }

    const starts = [...this.startPromiseByCwd.values()]
    if (starts.length > 0) {
      await Promise.all(starts.map(async (promise) => {
        try { await promise } catch { /* ignore startup errors */ }
      }))
      this.startPromiseByCwd.clear()
    }

    const running = [...this.runningByCwd.values()]
    this.runningByCwd.clear()
    this.startPromiseByCwd.clear()
    this.startAbortByCwd.clear()
    await Promise.all(running.map(async (entry) => {
      this.clearIdleTimer(entry)
      try { entry.stopEventStream() } catch { /* ignore */ }
      await killOwnedProcesses(entry.child, entry.ownershipId, this.log)
    }))
    this.sessionEmitters.clear()
    this.sessionCwdById.clear()
    this.cwdByKey.clear()
  }

  /** @internal test/inspection accessor */
  get baseUrlOrUndefined(): string | undefined {
    return [...this.runningByCwd.values()][0]?.baseUrl
  }
```

- [ ] **Step 6: Update existing tests for private state names**

In `test/unit/server/fresh-agent/opencode-serve-manager.test.ts`, replace assertions that inspect `(manager as any).running` and `(manager as any).startPromise`:

```ts
    expect((manager as any).runningByCwd.size).toBe(0)
    expect((manager as any).startPromiseByCwd.size).toBe(0)
```

Replace the child-exit cleanup test assertions:

```ts
    expect((manager as any).sessionEmitters.size).toBe(0)
    expect((manager as any).runningByCwd.size).toBe(0)
```

- [ ] **Step 7: Run tests to verify the manager change**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/fresh-agent/opencode-serve-manager.test.ts --run
```

Expected: PASS.

- [ ] **Step 8: Commit the manager implementation**

```bash
git add server/fresh-agent/adapters/opencode/serve-manager.ts test/unit/server/fresh-agent/opencode-serve-manager.test.ts
git commit -m "fix: scope opencode serve processes by cwd"
```

## Task 3: Route Adapter Operations With Preserved Cwd

**Files:**
- Modify: `server/fresh-agent/adapters/opencode/adapter.ts`
- Modify: `test/unit/server/fresh-agent/opencode-serve-adapter.test.ts`

**Interfaces:**
- Consumes:
  - `OpencodeServeManager.rememberSessionCwd(sessionId: string, cwd?: string): void`
  - Optional route arguments on `getSession`, `listMessages`, `getMessage`, `promptAsync`, `abort`, `compact`, and `fork`
- Produces: restored or attached freshopencode sessions use their pane cwd when the manager has not seen their session id yet.

- [ ] **Step 1: Extend the fake manager test double**

In `test/unit/server/fresh-agent/opencode-serve-adapter.test.ts`, add `rememberSessionCwd` to `makeFakeManager()`:

```ts
    createSession: vi.fn(async (input?: { directory?: string }) => ({
      id: 'ses_real_1',
      ...(input?.directory ? { directory: input.directory } : {}),
      title: 'T',
    })),
    rememberSessionCwd: vi.fn(),
```

Replace the old always-`/repo` fake `createSession` with the conditional version above, then update `FakeManager` automatically through the existing `ReturnType`.

- [ ] **Step 2: Add failing test for attach cwd registration**

Add this test in `describe('OpenCode serve adapter: history reads', ...)` before `getSnapshot assembles HTTP messages into the normalized transcript`:

```ts
  it('remembers cwd when attaching a durable OpenCode session', async () => {
    const manager = makeFakeManager()
    const adapter = makeAdapter(manager)

    await adapter.attach?.({
      sessionType: 'freshopencode',
      provider: 'opencode',
      sessionId: 'ses_existing_cwd',
      cwd: '/repo/from-pane',
    })

    expect(manager.rememberSessionCwd).toHaveBeenCalledWith('ses_existing_cwd', '/repo/from-pane')
  })
```

- [ ] **Step 3: Add failing test for restored send cwd routing**

Add this test in `describe('OpenCode serve adapter: create + send', ...)`:

```ts
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
```

- [ ] **Step 4: Run adapter tests to verify failure**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/fresh-agent/opencode-serve-adapter.test.ts --run
```

Expected: FAIL. The first new test should show `rememberSessionCwd` was not called. The second should show `promptAsync` was called without the route argument.

- [ ] **Step 5: Implement adapter cwd propagation**

In `server/fresh-agent/adapters/opencode/adapter.ts`, add these helpers near `sendResult`:

```ts
  function cwdRoute(cwd?: string): { cwd?: string } | undefined {
    return typeof cwd === 'string' && cwd.trim().length > 0 ? { cwd } : undefined
  }

  async function promptAsyncForState(
    state: OpencodeSessionState,
    realId: string,
    body: Parameters<OpencodeServeManager['promptAsync']>[1],
  ): Promise<void> {
    const route = cwdRoute(state.cwd)
    if (route) {
      await serveManager.promptAsync(realId, body, route)
      return
    }
    await serveManager.promptAsync(realId, body)
  }

  async function abortForState(state: OpencodeSessionState): Promise<void> {
    if (!state.realSessionId) return
    const route = cwdRoute(state.cwd)
    if (route) {
      await serveManager.abort(state.realSessionId, route)
      return
    }
    await serveManager.abort(state.realSessionId)
  }

  async function compactForState(state: OpencodeSessionState, input?: { instructions?: string }): Promise<void> {
    if (!state.realSessionId) return
    const route = cwdRoute(state.cwd)
    if (route) {
      await serveManager.compact(state.realSessionId, input, route)
      return
    }
    await serveManager.compact(state.realSessionId, input)
  }

  async function forkForState(state: OpencodeSessionState): Promise<{ id: string }> {
    if (!state.realSessionId) throw new FreshAgentLostSessionError(`OpenCode session ${state.placeholderId} has not materialized; cannot fork.`)
    const route = cwdRoute(state.cwd)
    return route
      ? await serveManager.fork(state.realSessionId, route)
      : await serveManager.fork(state.realSessionId)
  }
```

Update `materializeOrSend` prompt call:

```ts
      await promptAsyncForState(state, realId, {
        parts: [{ type: 'text', text }],
        ...(splitOpencodeModel(modelStr) ? { model: splitOpencodeModel(modelStr)! } : {}),
        ...(effort ? { variant: effort } : {}),
      })
```

Update `assembleExport` signature and calls:

```ts
  async function assembleExport(
    realSessionId: string,
    query: { limit?: number; before?: string },
    route: { cwd?: string } = {},
  ): Promise<{ exported: OpencodeExport; nextCursor: string | null; revision: number }> {
    const [session, page] = await Promise.all([
      serveManager.getSession(realSessionId, route).then(
        (session) => session,
        () => ({} as Record<string, unknown>),
      ),
      serveManager.listMessages(realSessionId, query, route),
    ])
    const sessionTime = session && typeof session === 'object' ? session.time : undefined
    const sessionTimeUpdated = sessionTime && typeof sessionTime === 'object' && !Array.isArray(sessionTime)
      ? (sessionTime as Record<string, unknown>).updated
      : undefined
    const revision = Number.isFinite(Number(sessionTimeUpdated)) ? Number(sessionTimeUpdated) : page.messages.length
    const exported: OpencodeExport = {
      info: { id: realSessionId, ...(session ?? {}) },
      messages: page.messages.map((m) => ({ info: m.info, parts: m.parts })),
    }
    return { exported, nextCursor: page.nextCursor, revision }
  }
```

Update `attach(locator)`:

```ts
    async attach(locator) {
      const existing = sessions.get(locator.sessionId)
      if (existing) {
        if (locator.cwd) {
          existing.cwd = locator.cwd
          if (existing.realSessionId) serveManager.rememberSessionCwd(existing.realSessionId, locator.cwd)
        }
        remember(existing)
        return { sessionId: locator.sessionId, sessionRef: { provider: 'opencode', sessionId: locator.sessionId } }
      }
      if (isPlaceholderOpencodeSessionId(locator.sessionId) || !isRealOpencodeSessionId(locator.sessionId)) {
        throw new FreshAgentLostSessionError(`OpenCode session ${locator.sessionId} is not a durable OpenCode session.`)
      }
      const state: OpencodeSessionState = {
        placeholderId: locator.sessionId,
        realSessionId: locator.sessionId,
        cwd: locator.cwd,
        status: 'idle',
        events: new EventEmitter(),
        sendQueue: Promise.resolve(),
      }
      if (locator.cwd) serveManager.rememberSessionCwd(locator.sessionId, locator.cwd)
      remember(state)
      bindServeStream(state)
      return { sessionId: locator.sessionId, sessionRef: { provider: 'opencode', sessionId: locator.sessionId } }
    },
```

Update control methods:

```ts
      await abortForState(state).catch((err) => log.warn({ err }, 'abort failed'))
```

```ts
        () => compactForState(state, hasInstructions ? { instructions } : undefined),
        () => compactForState(state, hasInstructions ? { instructions } : undefined),
```

```ts
      const child = await forkForState(state)
```

Update history calls:

```ts
      const route = cwdRoute(liveState?.cwd ?? thread.cwd)
      const { exported, revision } = route
        ? await assembleExport(realId, { limit: DEFAULT_SNAPSHOT_TURN_LIMIT }, route)
        : await assembleExport(realId, { limit: DEFAULT_SNAPSHOT_TURN_LIMIT })
```

```ts
      const route = cwdRoute(liveState?.cwd ?? thread.cwd)
      const pageQuery = {
        limit: typeof query.limit === 'number' ? query.limit : DEFAULT_SNAPSHOT_TURN_LIMIT,
        before: typeof query.cursor === 'string' ? query.cursor : undefined,
      }
      const { exported, nextCursor, revision } = route
        ? await assembleExport(realId, pageQuery, route)
        : await assembleExport(realId, pageQuery)
```

```ts
      const route = cwdRoute(liveState?.cwd ?? thread.cwd)
      const message = route
        ? await serveManager.getMessage(realId, thread.turnId, route)
        : await serveManager.getMessage(realId, thread.turnId)
```

- [ ] **Step 6: Update existing adapter expectations for cwd-aware calls**

In `test/unit/server/fresh-agent/opencode-serve-adapter.test.ts`, update the first test's `promptAsync` expectation because that pane was created with `cwd: '/repo'`:

```ts
    expect(manager.promptAsync).toHaveBeenCalledWith('ses_real_1', {
      parts: [{ type: 'text', text: 'reply ok' }],
      model: { providerID: 'umans-ai-coding-plan', modelID: 'umans-kimi-k2.7' },
      variant: 'high',
    }, { cwd: '/repo' })
```

Leave no-cwd expectations as two-argument calls; the helper above deliberately does not pass a third `{}` argument when no cwd is known.

- [ ] **Step 7: Run adapter tests**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/fresh-agent/opencode-serve-adapter.test.ts --run
```

Expected: PASS.

- [ ] **Step 8: Commit adapter routing**

```bash
git add server/fresh-agent/adapters/opencode/adapter.ts test/unit/server/fresh-agent/opencode-serve-adapter.test.ts
git commit -m "fix: route freshopencode operations with pane cwd"
```

## Task 4: Add Real No-LLM Regression Coverage

**Files:**
- Modify: `test/integration/server/opencode-serve-real-provider-smoke.test.ts`

**Interfaces:**
- Consumes: real `opencode` binary if available.
- Produces: a no-LLM regression proving OpenCode stores new session `directory` as the selected cwd even when Freshell process cwd is different.

- [ ] **Step 1: Add isolated OpenCode helper imports**

At the top of `test/integration/server/opencode-serve-real-provider-smoke.test.ts`, add:

```ts
import fs from 'node:fs/promises'
import {
  ProbeWorkspace,
  seedOpencodeHomes,
  waitForOpencodeDbSession,
} from '../../../test/helpers/coding-cli/real-session-contract-harness.js'
```

- [ ] **Step 2: Use the existing temp workspace and DB wait helpers**

Do not add a static top-level `node:sqlite` import. `waitForOpencodeDbSession()` already uses the repo's supported dynamic/read-only SQLite path and waits for the OpenCode DB row to exist.

- [ ] **Step 3: Add no-LLM cwd regression test**

Add this test inside `describe('OpencodeServeManager lifecycle', ...)`:

```ts
      it('creates first-run sessions in the requested cwd, not the Freshell process cwd', async () => {
        const workspace = await ProbeWorkspace.create('freshell-opencode-real-cwd-')
        const requestedCwd = workspace.inTemp('requested-project')
        const homes = await seedOpencodeHomes(workspace)
        const manager = new OpencodeServeManager({
          env: {
            ...process.env,
            XDG_DATA_HOME: homes.dataHome,
            XDG_CONFIG_HOME: homes.configHome,
          },
        })
        try {
          await fs.mkdir(requestedCwd, { recursive: true })
          const session = await manager.createSession({ directory: requestedCwd })
          expect(session.id).toMatch(/^ses_/)
          expect(session.directory).toBe(requestedCwd)

          const row = await waitForOpencodeDbSession(homes.dbPath, session.id)
          expect(row.directory).toBe(requestedCwd)
        } finally {
          await manager.shutdown()
          await workspace.cleanup()
        }
      }, 60_000)
```

- [ ] **Step 4: Run real-provider smoke test**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/integration/server/opencode-serve-real-provider-smoke.test.ts --run
```

Expected when `opencode` is installed: PASS. Expected when `opencode` is unavailable: suite reports skipped tests, not failure.

- [ ] **Step 5: Commit real regression coverage**

```bash
git add test/integration/server/opencode-serve-real-provider-smoke.test.ts
git commit -m "test: cover freshopencode real cwd materialization"
```

## Task 5: Focused And Broad Verification

**Files:**
- No code changes.

**Interfaces:**
- Consumes: completed Tasks 1-4.
- Produces: verified branch ready for review/PR.

- [ ] **Step 1: Run focused freshopencode tests**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/fresh-agent/opencode-serve-manager.test.ts test/unit/server/fresh-agent/opencode-serve-adapter.test.ts test/integration/server/opencode-serve-real-provider-smoke.test.ts --run
```

Expected: PASS, or real-provider smoke skipped only if `opencode` is unavailable.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run coordinated full check**

Run:

```bash
FRESHELL_TEST_SUMMARY="verify freshopencode cwd-scoped serve fix" npm run check
```

Expected: PASS. If another agent holds the coordinator gate, wait for the coordinated run instead of killing the holder.

- [ ] **Step 4: Inspect final diff**

Run:

```bash
git diff --check
git status --short
git log --oneline -5
```

Expected:
- `git diff --check` has no output.
- `git status --short` shows only intended files before the final commit, or clean after the final commit.
- Recent commits are the focused task commits from this plan.

- [ ] **Step 5: Commit final verification note if any files changed**

If no files changed during verification, do not create an empty commit. If a test-only adjustment was needed, commit it:

```bash
git add server/fresh-agent/adapters/opencode/serve-manager.ts server/fresh-agent/adapters/opencode/adapter.ts test/unit/server/fresh-agent/opencode-serve-manager.test.ts test/unit/server/fresh-agent/opencode-serve-adapter.test.ts test/integration/server/opencode-serve-real-provider-smoke.test.ts
git commit -m "chore: finalize freshopencode cwd-scoped serve"
```

## Self-Review

- Spec coverage: The plan covers first-run freshopencode cwd, real OpenCode behavior, the manager architecture that caused the bug, restored/attached session routing, sidecar cleanup, and broad verification.
- Placeholder scan: No task uses `TBD`, `TODO`, `implement later`, or a generic “write tests” instruction without concrete test code.
- Type consistency: `ServeRoute`, `rememberSessionCwd`, and the optional route arguments are introduced in Task 2 and consumed by Task 3 with the same names and shapes.
