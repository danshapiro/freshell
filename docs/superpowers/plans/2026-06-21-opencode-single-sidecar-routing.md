# OpenCode Single Sidecar Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix freshopencode cwd routing while keeping one shared `opencode serve` sidecar.

**Architecture:** Freshell owns one OpenCode serve process and routes cwd per HTTP request with OpenCode's `directory` query parameter. First-send materialization validates the selected cwd before session creation, then OpenCode's returned `session.directory` becomes canonical. Events come from one `/global/event` stream and are unwrapped into the existing session event dispatcher.

**Tech Stack:** NodeNext/ESM TypeScript, Vitest, Express/supertest smoke tests, OpenCode HTTP API.

## Global Constraints

- Work in `/home/dan/code/freshell/.worktrees/rollback-opencode-sidecars` on branch `rollback/opencode-sidecars`.
- Preserve the existing rollback commit that removes cwd-scoped sidecars.
- Do not add automatic `POST /instance/dispose` cleanup in this change.
- Do not add `@opencode-ai/sdk` unless implementation proves the manual route wrapper is insufficient.
- Relative TypeScript imports must include `.js` extensions.
- Use `npm run test:vitest -- ...` for focused Vitest runs.
- Broad repo verification uses the coordinator: `FRESHELL_TEST_SUMMARY="opencode single sidecar routing" npm run check`.
- The real OpenCode smoke test is opt-in and may skip when `opencode` is unavailable.

---

## File Structure

- Modify `server/fresh-agent/adapters/opencode/serve-manager.ts`
  - Add cwd query routing helper.
  - Remove body `directory` from `POST /session`.
  - Route all manager methods that receive `ServeRoute`.
  - Route `/session/status` polling by the cwd passed to `onceIdle`.
  - Connect the default event stream to `/global/event`.

- Modify `server/fresh-agent/adapters/opencode/serve-events.ts`
  - Parse old flat `/event` frames and new `/global/event` envelope frames.
  - Ignore `server.connected` and `server.heartbeat`.

- Modify `server/fresh-agent/adapters/opencode/adapter.ts`
  - Validate selected cwd before first materialization.
  - Preserve returned `session.directory` as canonical cwd.
  - Keep no-cwd attach/resume behavior unchanged.

- Modify `test/unit/server/fresh-agent/opencode-serve-manager.test.ts`
  - Assert actual URLs include `directory=` for routed requests.
  - Assert create-session body does not contain `directory`.
  - Rewrite old exact-URL mocks that currently assume route cwd is ignored.
  - Assert `onceIdle` polls `/session/status?directory=<cwd>` for non-default cwd sessions.
  - Assert `/global/event` is the default stream.
  - Assert global event envelopes dispatch to the right session.

- Modify `test/unit/server/fresh-agent/opencode-serve-events.test.ts`
  - Move global-envelope parser coverage here.
  - Update the existing `server.connected` parser assertion to expect `null`.

- Modify `test/unit/server/fresh-agent/opencode-serve-adapter.test.ts`
  - Assert invalid selected cwd rejects before `createSession`.
  - Assert cwd override in send settings is validated and routed.
  - Keep existing restored/forked cwd behavior tests.

- Modify `test/integration/server/opencode-serve-real-provider-smoke.test.ts`
  - Add an opt-in, no-LLM cwd routing smoke that starts one serve from a non-project cwd and uses `POST /session?directory=<project>` directly through the manager.
  - Keep Kimi turn tests gated as they are.

---

### Task 1: Route OpenCode HTTP Requests By Query

**Files:**
- Modify: `server/fresh-agent/adapters/opencode/serve-manager.ts`
- Test: `test/unit/server/fresh-agent/opencode-serve-manager.test.ts`

**Interfaces:**
- Consumes: existing `ServeRoute = { cwd?: string }`.
- Produces: every routed manager method, including `/session/status` fallback polling, appends `directory=<cwd>` to the request query string.

- [ ] **Step 1: Write failing create-session routing tests**

Update the existing `posts the requested session directory without changing the serve process cwd` test so its fetch mock matches the routed URL:

```ts
if (url.includes('/session?') && init?.method === 'POST') {
  return jsonResponse({ id: 'ses_project_x', directory: '/project-x', title: 'Project X' })
}
```

Then assert the routed URL and body:

```ts
expect(calls.find((call) => call.url.includes('/session?'))).toMatchObject({
  url: 'http://127.0.0.1:47999/session?directory=%2Fproject-x',
  init: expect.objectContaining({
    method: 'POST',
    body: JSON.stringify({}),
  }),
})
expect(JSON.parse(calls.find((call) => call.url.includes('/session?'))!.init.body)).not.toHaveProperty('directory')
```

Add a second test for encoding:

```ts
it('URL-encodes routed cwd values without putting cwd in the body', async () => {
  const calls: Array<{ url: string; init: any }> = []
  const fetchFn = vi.fn(async (url: string, init: any) => {
    calls.push({ url, init })
    if (url.endsWith('/global/health')) return jsonResponse({ healthy: true })
    if (url.includes('/session?') && init?.method === 'POST') {
      return jsonResponse({ id: 'ses_spaced', directory: '/repo with space/a?b' })
    }
    return jsonResponse({})
  })
  const { manager } = makeManager({ fetchFn: fetchFn as any })

  await manager.createSession({ directory: '/repo with space/a?b' })

  expect(calls.find((call) => call.url.includes('/session?'))?.url)
    .toBe('http://127.0.0.1:47999/session?directory=%2Frepo+with+space%2Fa%3Fb')
})
```

- [ ] **Step 2: Run the focused manager test and verify failure**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/fresh-agent/opencode-serve-manager.test.ts --run
```

Expected: FAIL because `createSession` still posts `/session` with body `directory`.

- [ ] **Step 3: Implement route helper**

In `serve-manager.ts`, add:

```ts
function withRoute(requestPath: string, route: ServeRoute = {}): string {
  const cwd = typeof route.cwd === 'string' && route.cwd.trim().length > 0 ? route.cwd : undefined
  if (!cwd) return requestPath
  const marker = 'http://freshell.local'
  const url = new URL(requestPath, marker)
  url.searchParams.set('directory', cwd)
  return `${url.pathname}${url.search}`
}
```

Change `createSession` to:

```ts
async createSession(input: { title?: string; parentID?: string; directory?: string } = {}): Promise<{ id: string; directory?: string; title?: string }> {
  const body: { title?: string; parentID?: string } = {}
  if (input.title !== undefined) body.title = input.title
  if (input.parentID !== undefined) body.parentID = input.parentID
  return this.json(withRoute('/session', { cwd: input.directory }), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
```

- [ ] **Step 4: Route every route-aware manager method**

Use `withRoute()` in:

```ts
getSession(id, route)
promptAsync(id, body, route)
listMessages(id, query, route)
getMessage(id, messageId, route)
abort(id, route)
compact(id, body, route)
fork(id, route)
getSessionStatusMap(route)
onceIdle(sessionId, timeoutMs, route)
```

For `listMessages`, build the existing limit/before params first, then apply route last so `directory` is preserved alongside `limit` and `before`.

Change the private status helper and idle waiter to accept the same route:

```ts
private async getSessionStatusMap(route: ServeRoute = {}, init?: RequestInit): Promise<OpencodeStatusMap> {
  return this.json<OpencodeStatusMap>(withRoute('/session/status', route), { method: 'GET', ...init })
}

onceIdle(sessionId: string, timeoutMs: number, route: ServeRoute = {}): Promise<void> {
  // existing body; call this.getSessionStatusMap(route)
}
```

- [ ] **Step 5: Add routed follow-up request assertions**

Replace the old tests that assert route cwd is ignored. The affected tests are:

- `reuses one serve process for sessions created in different directories`
- `posts summarize requests on the single serve process even when a route is supplied`
- `ignores route cwd when fork response omits directory`
- `uses the same serve route for unknown existing sessions after project session creation`

For each test, update exact `url === '.../session'`, `url.endsWith('/session')`, `url === '.../fork'`, and `url.endsWith('/summarize')` mocks to accept routed query URLs. For example:

```ts
if (url === 'http://127.0.0.1:47999/session?directory=%2Fproject-a' && init?.method === 'POST') {
  return jsonResponse({ id: 'ses_a', directory: '/project-a' })
}
if (url === 'http://127.0.0.1:47999/session/ses_known/summarize?directory=%2Fproject-a' && init?.method === 'POST') {
  return jsonResponse({}, { status: 204 })
}
if (url === 'http://127.0.0.1:47999/session/ses_parent/fork?directory=%2Fparent' && init?.method === 'POST') {
  return jsonResponse({ id: 'ses_child' })
}
```

Add one manager test that calls every route-aware method with `{ cwd: '/project-a' }` and asserts URLs:

```ts
expect(urls).toContain('http://127.0.0.1:47999/session/ses_a?directory=%2Fproject-a')
expect(urls).toContain('http://127.0.0.1:47999/session/ses_a/prompt_async?directory=%2Fproject-a')
expect(urls).toContain('http://127.0.0.1:47999/session/ses_a/message?limit=2&before=CUR&directory=%2Fproject-a')
expect(urls).toContain('http://127.0.0.1:47999/session/ses_a/message/msg_1?directory=%2Fproject-a')
expect(urls).toContain('http://127.0.0.1:47999/session/ses_a/abort?directory=%2Fproject-a')
expect(urls).toContain('http://127.0.0.1:47999/session/ses_a/summarize?directory=%2Fproject-a')
expect(urls).toContain('http://127.0.0.1:47999/session/ses_a/fork?directory=%2Fproject-a')
```

Also update old assertions that use `url.endsWith('/summarize')` or exact unrouted URLs so they assert the routed query URL.

- [ ] **Step 5b: Add status polling regression test**

Add a test that proves a non-default cwd session does not poll the serve cwd status map:

```ts
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
  const { manager } = makeManager({ fetchFn: fetchFn as any, idlePollMs: 5 })

  await expect(manager.onceIdle('ses_a', 1000, { cwd: '/project-a' })).resolves.toBeUndefined()

  expect(urls).toContain('http://127.0.0.1:47999/session/status?directory=%2Fproject-a')
})
```

- [ ] **Step 6: Run manager tests to green**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/fresh-agent/opencode-serve-manager.test.ts --run
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/fresh-agent/adapters/opencode/serve-manager.ts test/unit/server/fresh-agent/opencode-serve-manager.test.ts
git commit -m "fix: route opencode requests by directory query"
```

---

### Task 2: Parse Global OpenCode Events

**Files:**
- Modify: `server/fresh-agent/adapters/opencode/serve-events.ts`
- Modify: `server/fresh-agent/adapters/opencode/serve-manager.ts`
- Test: `test/unit/server/fresh-agent/opencode-serve-manager.test.ts`
- Test: `test/unit/server/fresh-agent/opencode-serve-events.test.ts`

**Interfaces:**
- Consumes: `/global/event` frames shaped as `{ directory, payload: { type, properties } }`.
- Produces: existing `ParsedServeEvent` and `serveEventToSdk` behavior unchanged for callers.

- [ ] **Step 1: Write parser tests for global event envelopes**

Add these tests in `test/unit/server/fresh-agent/opencode-serve-events.test.ts`, next to the existing `parseServeEvent` coverage:

```ts
it('parses global event envelopes by unwrapping payload', () => {
  const parsed = parseEvt({
    directory: '/repo',
    payload: {
      type: 'session.status',
      properties: { sessionID: 'ses_a', status: { type: 'busy' } },
    },
  })
  expect(parsed).toMatchObject({
    kind: 'session.status',
    sessionId: 'ses_a',
    properties: { sessionID: 'ses_a', status: { type: 'busy' } },
  })
})

it('ignores global heartbeat and connected frames', () => {
  expect(parseEvt({ payload: { type: 'server.connected', properties: {} } })).toBeNull()
  expect(parseEvt({ payload: { type: 'server.heartbeat', properties: {} } })).toBeNull()
})
```

Update the existing flat `server.connected` assertion in that same file so it also expects `null`:

```ts
expect(parseServeEvent({ type: 'server.connected', properties: {} })).toBeNull()
```

- [ ] **Step 2: Write manager stream URL test**

Add:

```ts
it('connects one global event stream by default', async () => {
  const connectEventStream = vi.fn(() => () => {})
  const { manager } = makeManager({ connectEventStream })
  await manager.ensureStarted()
  expect(connectEventStream).toHaveBeenCalledWith(
    'http://127.0.0.1:47999/global/event',
    expect.anything(),
  )
})
```

- [ ] **Step 3: Run manager tests and verify failure**

Run the same manager test command. Expected: FAIL because the parser expects flat events and the manager uses `/event`.

- [ ] **Step 4: Implement global event normalization**

In `serve-events.ts`, add an unwrap helper:

```ts
function eventPayload(raw: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof raw.type === 'string') return raw
  const payload = raw.payload
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as Record<string, unknown>
  }
  return null
}
```

Then update `parseServeEvent()` to use `eventPayload(raw)`, return null for `server.connected` and `server.heartbeat`, and preserve the payload as `raw`.

- [ ] **Step 5: Switch the default event stream**

In `serve-manager.ts`, change both injected and default event URLs from `/event` to `/global/event`.

- [ ] **Step 6: Run manager tests to green**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/fresh-agent/opencode-serve-manager.test.ts test/unit/server/fresh-agent/opencode-serve-events.test.ts --run
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/fresh-agent/adapters/opencode/serve-events.ts server/fresh-agent/adapters/opencode/serve-manager.ts test/unit/server/fresh-agent/opencode-serve-manager.test.ts test/unit/server/fresh-agent/opencode-serve-events.test.ts
git commit -m "fix: consume opencode global event stream"
```

---

### Task 3: Validate Selected Cwd Before First Materialization

**Files:**
- Modify: `server/fresh-agent/adapters/opencode/adapter.ts`
- Test: `test/unit/server/fresh-agent/opencode-serve-adapter.test.ts`

**Interfaces:**
- Produces: adapter option `validateCwd?: (cwd: string) => Promise<void>` for tests.
- Production default validates `cwd` exists and is a directory.
- Produces: adapter calls `serveManager.onceIdle(realId, timeoutMs, route)` when a cwd is known, so idle polling uses the same directory as the OpenCode session.

- [ ] **Step 1: Write failing adapter validation tests**

Replace the existing one-argument `makeAdapter` helper with an overrides-aware helper. It should stub cwd validation by default so existing unit tests that use fictional cwd values remain isolated from the real filesystem:

```ts
function makeAdapter(manager: FakeManager, overrides: Partial<Parameters<typeof createOpencodeFreshAgentAdapter>[0]> = {}) {
  return createOpencodeFreshAgentAdapter({
    serveManager: manager as any,
    validateCwd: async () => undefined,
    ...overrides,
  })
}
```

Add tests:

```ts
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
})
```

Update existing expectations for `manager.onceIdle` when cwd is known:

```ts
expect(manager.onceIdle).toHaveBeenCalledWith('ses_real_1', expect.any(Number), { cwd: '/repo' })
```

Keep no-cwd tests expecting the two-argument form or accepting the third argument as omitted.

- [ ] **Step 2: Run adapter tests and verify failure**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/fresh-agent/opencode-serve-adapter.test.ts --run
```

Expected: FAIL because `validateCwd` is not an adapter option.

- [ ] **Step 3: Implement cwd validation**

In `adapter.ts`, import `stat`:

```ts
import { stat } from 'node:fs/promises'
```

Extend options:

```ts
validateCwd?: (cwd: string) => Promise<void>
```

Add default validator:

```ts
async function defaultValidateCwd(cwd: string): Promise<void> {
  const info = await stat(cwd).catch((error: unknown) => {
    throw new Error(`OpenCode cwd is not accessible: ${cwd}`, { cause: error })
  })
  if (!info.isDirectory()) throw new Error(`OpenCode cwd is not a directory: ${cwd}`)
}
```

Inside `createOpencodeFreshAgentAdapter`, set:

```ts
const validateCwd = options.validateCwd ?? defaultValidateCwd
```

Before `serveManager.createSession(...)` in `materializeOrSend`, run:

```ts
if (effectiveCwd) await validateCwd(effectiveCwd)
```

Then route the idle waiter through the canonical cwd:

```ts
const route = cwdRoute(state.cwd)
const idle = route
  ? serveManager.onceIdle(realId, turnTimeoutMs, route)
  : serveManager.onceIdle(realId, turnTimeoutMs)
```

- [ ] **Step 4: Run adapter tests to green**

Run the same adapter test command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/fresh-agent/adapters/opencode/adapter.ts test/unit/server/fresh-agent/opencode-serve-adapter.test.ts
git commit -m "fix: validate freshopencode cwd before materialization"
```

---

### Task 4: Add One-Serve Cwd Routing Smoke Coverage

**Files:**
- Modify: `test/integration/server/opencode-serve-real-provider-smoke.test.ts`
- Test: `test/integration/server/opencode-serve-real-provider-smoke.test.ts`

**Interfaces:**
- Consumes: `OpencodeServeManager.createSession({ directory })`.
- Produces: opt-in no-LLM smoke proving two cwd values route through one serve.

- [ ] **Step 1: Add no-LLM real-provider cwd smoke**

Add imports:

```ts
import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
```

Add a test in the `OpencodeServeManager lifecycle` describe that creates two temporary existing directories, then removes them in `finally`:

```ts
it('creates sessions in two routed directories on one serve without an LLM turn', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'freshell-opencode-route-smoke-'))
  const projectA = path.join(root, 'project-a')
  const projectB = path.join(root, 'project-b')
  await mkdir(projectA, { recursive: true })
  await mkdir(projectB, { recursive: true })
  const manager = new OpencodeServeManager()
  try {
    const first = await manager.createSession({ directory: projectA })
    const second = await manager.createSession({ directory: projectB })

    expect(first.id).toMatch(/^ses_/)
    expect(second.id).toMatch(/^ses_/)
    expect(first.directory).toBe(await realpath(projectA))
    expect(second.directory).toBe(await realpath(projectB))
    expect(manager.baseUrlOrUndefined).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  } finally {
    await manager.shutdown()
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
```

If Kimi is available, update the first real turn smoke to use a temporary cwd different from `process.cwd()`:

```ts
const root = await mkdtemp(path.join(os.tmpdir(), 'freshell-opencode-turn-cwd-'))
try {
  const cwd = path.join(root, 'project')
  await mkdir(cwd, { recursive: true })
  const created = await request(app!).post('/api/tabs').send({ agent: 'opencode', cwd, model: KIMI, effort: 'low' })
  // Keep the existing send/capture assertions after this create call.
} finally {
  await rm(root, { recursive: true, force: true })
}
```

This turn smoke is opt-in, but it protects the exact regression where unrouted `/session/status` returns the serve cwd status map and `send-keys` completes early.

- [ ] **Step 2: Run focused non-real tests first**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/fresh-agent/opencode-serve-manager.test.ts test/unit/server/fresh-agent/opencode-serve-events.test.ts test/unit/server/fresh-agent/opencode-serve-adapter.test.ts --run
```

Expected: PASS.

- [ ] **Step 3: Run opt-in real smoke only if acceptable in this environment**

Run:

```bash
npm run test:opencode-serve-smoke
```

Expected: PASS or SKIP when `opencode` is unavailable. If it fails because the local provider config lacks Kimi, the no-LLM cwd test should still pass and Kimi tests should remain skipped.

- [ ] **Step 4: Commit**

```bash
git add test/integration/server/opencode-serve-real-provider-smoke.test.ts
git commit -m "test: cover opencode routed cwd smoke"
```

---

### Task 5: Final Verification

**Files:**
- No new files beyond previous tasks.

**Interfaces:**
- Produces: verified branch ready for review.

- [ ] **Step 1: Run focused OpenCode tests**

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/fresh-agent/opencode-serve-manager.test.ts test/unit/server/fresh-agent/opencode-serve-adapter.test.ts --run
```

Expected: PASS.

- [ ] **Step 1b: Run the opt-in real OpenCode smoke separately**

```bash
npm run test:opencode-serve-smoke
```

Expected: PASS or SKIP when `opencode` is unavailable. This file is excluded from `vitest.server.config.ts`, so it must run through the dedicated smoke config.

- [ ] **Step 2: Run broad verification through the coordinator**

```bash
FRESHELL_TEST_SUMMARY="opencode single sidecar routing" npm run check
```

Expected: PASS.

- [ ] **Step 3: Confirm no automatic dispose was added**

```bash
rg -n "instance/dispose|dispose\\(" server/fresh-agent/adapters/opencode
```

Expected: no automatic `instance/dispose` call in Freshell's OpenCode adapter/manager.

- [ ] **Step 4: Inspect final diff**

```bash
git diff origin/main...HEAD -- server/fresh-agent/adapters/opencode test/unit/server/fresh-agent test/integration/server/opencode-serve-real-provider-smoke.test.ts
```

Expected: diff shows rollback plus single-sidecar route fix, global event parsing, cwd validation, and tests.

- [ ] **Step 5: Commit any final fixes**

If verification required small adjustments:

```bash
git add <changed-files>
git commit -m "test: verify opencode single sidecar routing"
```

If no files changed, do not create an empty commit.

---

## Load-Bearing Findings Applied

- Body `directory` is ignored by OpenCode session create; routing must use query/header.
- Stored `session.directory` wins for existing session routes.
- `/global/event` is available but must be unwrapped.
- Automatic `instance.dispose` is not safe without a cwd activity ledger.
- Missing cwd can fall back or normalize unexpectedly; Freshell must validate selected cwd before create.
- CI availability for real OpenCode smoke is not proven; keep it opt-in.

## Fresh Eyes Scope

After committing this plan, run:

```bash
bash "/home/dan/.codex/skills/fresheyes/fresheyes.sh" --claude "Review the plan in docs/superpowers/plans/2026-06-21-opencode-single-sidecar-routing.md."
```

After implementation, run fresh eyes on:

```bash
git diff origin/main...HEAD
```
