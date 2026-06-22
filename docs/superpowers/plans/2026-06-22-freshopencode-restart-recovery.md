# FreshOpenCode Restart Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make FreshOpenCode panes recover safely after a Freshell process restart, without sending prompts to the wrong OpenCode project, and remove the duplicate snapshot and terminal retention-loss storms covered by kata `zrrj`.

**Architecture:** Recovery is FreshOpenCode-specific and route-safe. A durable `ses_*` id is necessary but not sufficient: any recovered provider mutation must validate the OpenCode session directory against the pane's expected cwd before it sends, interrupts, compacts, or forks. WebSocket mutations carry enough route data to recover on demand, while client snapshot refreshes become scoped and coalesced.

**Tech Stack:** React 18, Redux Toolkit, TypeScript, Express/WebSocket `ws`, NodeNext/ESM, Vitest, Playwright browser e2e harness, fake OpenCode serve fixture.

## Global Constraints

- Work only in `.worktrees/zrrj-freshopencode-recovery` on branch `fix/zrrj-freshopencode-recovery`.
- Do not restart the self-hosted Freshell server without the explicit word `APPROVED`.
- Do not push behavior changes directly to `origin/main`; do not create a PR without explicit approval.
- Keep `.kata.toml` committed if it is modified; this plan does not require modifying `.kata.toml`.
- Server code uses NodeNext/ESM; relative imports must include `.js` extensions.
- Provider history reads remain read-only; never invent or mutate OpenCode history to fake recovery.
- FreshOpenCode placeholders matching `freshopencode-*` are not durable session ids and must not be recovered as durable sessions.
- Durable OpenCode session ids must match `ses_*`, but a `ses_*` alone is not a safe mutation target; recovered mutation also requires a validated cwd.
- Runtime status after restart is best-effort from OpenCode `/session/status`; do not claim an interrupted turn promise was recovered unless OpenCode reports `busy` or `retry`.
- Do not add broad OpenCode sidecar reaping in this kata. Existing owned shutdown remains, but startup must not kill unrelated `opencode serve` processes.
- Use structured logs for repo code.
- Prefer integration/e2e proof over isolated unit-only proof when behavior spans client/server boundaries.

---

## Load-Bearing Results Folded Into This Plan

- OpenCode provides the needed read-only validation surface: `GET /session/:sessionID?directory=<cwd>` returns session info with a `directory` field. Freshell must compare the returned directory to the expected cwd; the query parameter alone is not enough.
- Freshell already stores the route source for materialized FreshOpenCode panes: `FreshAgentPaneContent.initialCwd` plus durable `sessionRef`.
- `FreshAgentSessionLocator` already supports `cwd`; the missing work is to carry it through WebSocket mutation messages and use it for FreshOpenCode-only recovery.
- Existing fake OpenCode serve coverage is not enough for route-safe restart proof. The fixture must add route-aware session read, prompt, message, status, and audit behavior.
- Current WebSocket attach/send can race because message handlers run concurrently and authorization is granted only after attach resolves.
- Current client `freshAgent.send.accepted` is unscoped and every `freshAgent.event` triggers a snapshot fetch.
- Terminal retention-loss coalescing is not proven by existing tests; implement it test-first and keep replay/gap invariants explicit.

## File Structure

- Modify `shared/ws-protocol.ts`: add `cwd` and `sessionRef` where needed on Fresh Agent messages, and add locator fields to `freshAgent.send.accepted`.
- Modify `src/components/fresh-agent/FreshAgentView.tsx`: send cwd/sessionRef on attach and mutations, resend attach on reconnect, scope/coalesce snapshot invalidations, and clear stale local echo on recovered idle snapshots.
- Modify `server/ws-handler.ts`: build route-aware locators, track pending attach per socket, wait on same-session pending attach before mutation auth, and emit scoped accepted messages.
- Modify `server/fresh-agent/runtime-manager.ts`: add FreshOpenCode-only singleflight recovery for missing `ses_*` sessions with cwd.
- Modify `server/fresh-agent/adapters/opencode/serve-manager.ts`: expose route-aware session status helper if still needed by implementation/tests.
- Modify `server/fresh-agent/adapters/opencode/adapter.ts`: keep durable attaches readable, validate recovered real sessions against expected cwd at mutation time, and reconcile status as a read-only best-effort signal.
- Modify `test/e2e-browser/fixtures/fake-opencode.cjs`: make fake serve route-aware enough to prove FreshOpenCode restart recovery.
- Modify `server/terminal-stream/broker.ts`: coalesce retention-loss stream identity replacement only after tests prove one replacement preserves output/gap semantics.
- Test `test/unit/server/fresh-agent/opencode-serve-adapter.test.ts`: route validation, missing/mismatched cwd fail-closed, status reconciliation.
- Test `test/unit/server/fresh-agent/runtime-manager.test.ts`: scoped lazy recovery, singleflight, provider isolation, missing cwd rejection.
- Test `test/unit/server/ws-handler-fresh-agent-ownership.test.ts`: attach/send race, failed attach does not authorize, cwd locators are passed.
- Test `test/unit/server/ws-handler-fresh-agent.test.ts`: accepted locator payload and mutation message routing.
- Test `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`: reconnect attach, cwd on mutations, accepted scoping, coalescing, stale echo clearing.
- Test `test/unit/client/store/tabRegistrySync.test.ts`: materialized FreshOpenCode tab snapshots preserve `initialCwd` and durable `sessionRef`.
- Test `test/unit/server/ws-handler-backpressure.test.ts`: one retention-loss stream change per raw output append plus replay/gap invariants.
- Add or extend `test/e2e-browser/specs/freshopencode-restart-recovery.spec.ts`: route-safe FreshOpenCode server restart smoke with fake OpenCode.

---

## Task 1: Route-Safe OpenCode Mutation Guard

**Files:**
- Modify: `server/fresh-agent/adapters/opencode/adapter.ts`
- Modify: `server/fresh-agent/adapters/opencode/serve-manager.ts`
- Test: `test/unit/server/fresh-agent/opencode-serve-adapter.test.ts`
- Test: `test/unit/server/fresh-agent/opencode-serve-manager.test.ts`

**Interfaces:**
- Produces: `OpencodeServeManager.getSessionStatus(sessionId: string, route?: { cwd?: string }): Promise<{ type?: unknown } | undefined>`.
- Produces: adapter attach/resume behavior that can rebuild read-only local state for durable `ses_*` sessions without cwd.
- Produces: adapter mutation behavior that validates a recovered `ses_*` against the expected cwd before provider mutation.
- Consumes: existing `OpencodeServeManager.getSession(id, route)` and `FreshAgentSessionLocator.cwd`.

- [ ] **Step 1: Write failing tests for mutation-boundary route validation**

Add tests to `test/unit/server/fresh-agent/opencode-serve-adapter.test.ts`:

```ts
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

it('keeps no-cwd recovered durable sessions readable but not sendable', async () => {
  const manager = makeFakeManager()
  manager.getSession.mockResolvedValueOnce({
    id: 'ses_no_cwd',
    time: { updated: 10 },
  })
  manager.listMessages.mockResolvedValueOnce({ messages: [], nextCursor: null })
  const adapter = makeAdapter(manager)

  await expect(adapter.attach?.({
    sessionId: 'ses_no_cwd',
    sessionType: 'freshopencode',
    provider: 'opencode',
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

it('rejects recovered durable session mutation when OpenCode reports a different directory', async () => {
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
  })).resolves.toEqual({
    sessionId: 'ses_wrong',
    sessionRef: { provider: 'opencode', sessionId: 'ses_wrong' },
  })

  await expect(adapter.send?.('ses_wrong', { text: 'must not send' })).rejects.toThrow(/belongs to|directory/i)
  expect(manager.promptAsync).not.toHaveBeenCalled()
})
```

Run: `npm run test:vitest -- --run test/unit/server/fresh-agent/opencode-serve-adapter.test.ts`
Expected: FAIL because recovered mutation currently sends without validating the reported directory, and no-cwd recovered sessions remain sendable.

- [ ] **Step 2: Implement recovered route validation**

In `server/fresh-agent/adapters/opencode/adapter.ts`, import `realpath` from `node:fs/promises`, extend `CreateOpencodeFreshAgentAdapterOptions`, and add state for validation:

```ts
type CreateOpencodeFreshAgentAdapterOptions = {
  serveManager: OpencodeServeManager
  turnTimeoutMs?: number
  validateCwd?: (cwd: string) => Promise<void>
  canonicalizePath?: (cwd: string) => Promise<string>
}

const canonicalizePath = options.canonicalizePath ?? realpath

type OpencodeSessionState = {
  placeholderId: string
  realSessionId?: string
  cwd?: string
  routeValidatedCwd?: string
  ...
}
```

Add a helper near `cwdRoute`:

```ts
async function ensureMutableRoute(state: OpencodeSessionState): Promise<void> {
  const realId = state.realSessionId
  if (!realId) return
  const cwd = state.cwd
  if (!cwd || cwd.trim().length === 0) {
    throw new FreshAgentLostSessionError(`OpenCode session ${realId} requires a cwd before it can be mutated after recovery.`)
  }
  const expected = await canonicalizePath(cwd)
  if (state.routeValidatedCwd === expected) return
  await validateCwd(cwd)
  const session = await serveManager.getSession(realId, { cwd })
  if (typeof session?.id === 'string' && session.id !== realId) {
    throw new FreshAgentLostSessionError(`OpenCode session lookup for ${realId} returned ${session.id}.`)
  }
  const reportedDirectory = typeof session?.directory === 'string' ? session.directory : undefined
  if (!reportedDirectory) {
    throw new FreshAgentLostSessionError(`OpenCode session ${realId} did not report a directory.`)
  }
  const actual = await canonicalizePath(reportedDirectory)
  if (expected !== actual) {
    throw new FreshAgentLostSessionError(`OpenCode session ${realId} belongs to ${reportedDirectory}, not ${cwd}.`)
  }
  state.routeValidatedCwd = expected
}
```

Call `ensureMutableRoute(state)` inside `materializeOrSend` after a real id exists and before `promptAsyncForState`. Also call it in `abortForState`, `compactForState`, and `forkForState` before provider mutation. Do not call it in shared `attach()`, `resume()`, `getSnapshot()`, `getTurnPage()`, or `getTurnBody()`; read-only history viewing must still work for legacy sessions without cwd.

When `createSession()` materializes a new session and returns a directory, set `state.routeValidatedCwd = await canonicalizePath(state.cwd)` after `state.cwd` is assigned, because this is the provider-created route.

Update existing adapter tests that attach a real session and then mutate it to have `manager.getSession` return a matching `directory`, or pass `canonicalizePath: async (value) => value` where fake paths are used. Keep existing read-only history tests no-cwd-compatible; change only the old no-cwd-sendable assertion to expect mutation rejection.

Run: `npm run test:vitest -- --run test/unit/server/fresh-agent/opencode-serve-adapter.test.ts`
Expected: PASS for the new route validation tests.

- [ ] **Step 3: Add attach-time status reconciliation without requiring mutation validation**

Add a public helper to `server/fresh-agent/adapters/opencode/serve-manager.ts`:

```ts
async getSessionStatus(sessionId: string, route: ServeRoute = {}): Promise<{ type?: unknown } | undefined> {
  const statuses = await this.getSessionStatusMap(route)
  return statuses[sessionId]
}
```

Add adapter tests:

```ts
it('marks recovered durable sessions running only when OpenCode status is busy or retry', async () => {
  const manager = makeFakeManager()
  manager.getSessionStatus = vi.fn(async () => ({ type: 'busy' }))
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
```

Implement a `reconcileStatus(state)` helper that maps `busy` and `retry` to `running`, maps `idle` to `idle`, and leaves failures/unknowns as non-running. Log a structured warning on failure; do not throw after route validation succeeds.
Call it after real-session `attach()` and `resume()` remember local state. This is a read-only best-effort status query; it must not make a no-cwd read-only attach fail.

Run: `npm run test:vitest -- --run test/unit/server/fresh-agent/opencode-serve-adapter.test.ts test/unit/server/fresh-agent/opencode-serve-manager.test.ts`
Expected: PASS.

---

## Task 2: Scoped Runtime Recovery

**Files:**
- Modify: `server/fresh-agent/runtime-manager.ts`
- Test: `test/unit/server/fresh-agent/runtime-manager.test.ts`

**Interfaces:**
- Produces: missing-session recovery only for `freshopencode/opencode/ses_*` with non-empty `cwd`.
- Produces: singleflight recovery keyed by existing fresh-agent session key plus cwd mismatch protection.
- Consumes: adapter `attach(locator)` route validation from Task 1.

- [ ] **Step 1: Write failing tests for FreshOpenCode-only recovery**

Add tests in `test/unit/server/fresh-agent/runtime-manager.test.ts`:

```ts
it('recovers a missing FreshOpenCode durable session with cwd before mutation', async () => {
  const opencodeAdapter = {
    create: vi.fn(),
    attach: vi.fn().mockResolvedValue({ sessionId: 'ses_restored' }),
    send: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn().mockResolvedValue(undefined),
    compact: vi.fn().mockResolvedValue(undefined),
    fork: vi.fn().mockResolvedValue({ sessionId: 'ses_child' }),
  }
  const registry = createFreshAgentProviderRegistry([{
    sessionType: 'freshopencode',
    runtimeProvider: 'opencode',
    adapter: opencodeAdapter as any,
  }])
  const manager = new FreshAgentRuntimeManager({ registry })
  const locator = {
    sessionId: 'ses_restored',
    sessionType: 'freshopencode' as const,
    provider: 'opencode' as const,
    cwd: '/repo/safe',
  }

  await manager.send(locator, { text: 'continue' })
  await manager.interrupt(locator)
  await manager.compact(locator, { instructions: 'keep decisions' })
  await manager.fork(locator)

  expect(opencodeAdapter.attach).toHaveBeenCalledTimes(1)
  expect(opencodeAdapter.attach).toHaveBeenCalledWith(locator)
  expect(opencodeAdapter.send).toHaveBeenCalledWith('ses_restored', { text: 'continue' })
})

it('does not recover placeholders, missing cwd, or non-OpenCode providers', async () => {
  const opencodeAdapter = { create: vi.fn(), attach: vi.fn(), send: vi.fn() }
  const codexAdapter = { create: vi.fn(), attach: vi.fn(), send: vi.fn() }
  const registry = createFreshAgentProviderRegistry([
    { sessionType: 'freshopencode', runtimeProvider: 'opencode', adapter: opencodeAdapter as any },
    { sessionType: 'freshcodex', runtimeProvider: 'codex', adapter: codexAdapter as any },
  ])
  const manager = new FreshAgentRuntimeManager({ registry })

  await expect(manager.send({
    sessionId: 'freshopencode-temp',
    sessionType: 'freshopencode',
    provider: 'opencode',
    cwd: '/repo/safe',
  }, { text: 'no' })).rejects.toThrow(/not tracked|not available/i)
  await expect(manager.send({
    sessionId: 'ses_missing_cwd',
    sessionType: 'freshopencode',
    provider: 'opencode',
  }, { text: 'no' })).rejects.toThrow(/not tracked|cwd|not available/i)
  await expect(manager.send({
    sessionId: 'codex-thread',
    sessionType: 'freshcodex',
    provider: 'codex',
  }, { text: 'no' })).rejects.toThrow(/not tracked/i)

  expect(opencodeAdapter.attach).not.toHaveBeenCalled()
  expect(codexAdapter.attach).not.toHaveBeenCalled()
})
```

Run: `npm run test:vitest -- --run test/unit/server/fresh-agent/runtime-manager.test.ts`
Expected: FAIL because missing sessions are never recovered.

- [ ] **Step 2: Implement `requireOrRecoverSession`**

In `server/fresh-agent/runtime-manager.ts`, add:

```ts
private readonly freshOpencodeRecoveries = new Map<string, { cwd: string; promise: Promise<SessionRecord> }>()

private canRecoverFreshOpenCode(locator: FreshAgentSessionLocator): locator is FreshAgentSessionLocator & { cwd: string } {
  return locator.sessionType === 'freshopencode'
    && locator.provider === 'opencode'
    && locator.sessionId.startsWith('ses_')
    && typeof locator.cwd === 'string'
    && locator.cwd.trim().length > 0
}
```

Add `requireOrRecoverSession(locator)`:

```ts
private async requireOrRecoverSession(locator: FreshAgentSessionLocator): Promise<SessionRecord> {
  const existing = this.sessions.get(this.key(locator))
  if (existing) {
    if (existing.sessionType !== locator.sessionType || existing.runtimeProvider !== locator.provider) {
      throw new FreshAgentSessionLocatorMismatchError(
        `Fresh-agent session ${locator.sessionId} is tracked as ${existing.sessionType}/${existing.runtimeProvider}, not ${locator.sessionType}/${locator.provider}`,
      )
    }
    return existing
  }
  if (!this.canRecoverFreshOpenCode(locator)) {
    return this.requireSession(locator)
  }
  const registration = this.requireRegistration(locator.sessionType, locator.provider)
  if (!registration.adapter.attach) {
    return this.requireSession(locator)
  }
  const key = this.key(locator)
  const pending = this.freshOpencodeRecoveries.get(key)
  if (pending) {
    if (pending.cwd !== locator.cwd) {
      throw new FreshAgentSessionLocatorMismatchError(
        `Fresh-agent session ${locator.sessionId} is already being recovered for ${pending.cwd}, not ${locator.cwd}`,
      )
    }
    return await pending.promise
  }
  const promise = Promise.resolve(registration.adapter.attach(locator)).then(() => {
    const record: SessionRecord = {
      sessionType: locator.sessionType,
      runtimeProvider: registration.runtimeProvider,
      adapter: registration.adapter,
    }
    this.sessions.set(key, record)
    return record
  })
  this.freshOpencodeRecoveries.set(key, { cwd: locator.cwd, promise })
  try {
    return await promise
  } finally {
    if (this.freshOpencodeRecoveries.get(key)?.promise === promise) {
      this.freshOpencodeRecoveries.delete(key)
    }
  }
}
```

Use this helper in `send`, `interrupt`, `compact`, `fork`, `answerQuestion`, and `resolveApproval`. Keep `kill` strict unless tests show a user-facing need; killing a lost OpenCode record is local cleanup and must not mutate provider state without route proof.

Run: `npm run test:vitest -- --run test/unit/server/fresh-agent/runtime-manager.test.ts`
Expected: PASS.

- [ ] **Step 3: Add singleflight and cwd mismatch tests**

Add:

```ts
function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

it('singleflights concurrent FreshOpenCode recovery for the same cwd', async () => {
  const attachDeferred = createDeferred<{ sessionId: string }>()
  const opencodeAdapter = {
    create: vi.fn(),
    attach: vi.fn(() => attachDeferred.promise),
    send: vi.fn().mockResolvedValue(undefined),
  }
  const registry = createFreshAgentProviderRegistry([
    { sessionType: 'freshopencode', runtimeProvider: 'opencode', adapter: opencodeAdapter as any },
  ])
  const manager = new FreshAgentRuntimeManager({ registry })
  const locator = { sessionId: 'ses_one', sessionType: 'freshopencode' as const, provider: 'opencode' as const, cwd: '/repo' }

  const first = manager.send(locator, { text: 'one' })
  const second = manager.send(locator, { text: 'two' })
  await Promise.resolve()
  expect(opencodeAdapter.attach).toHaveBeenCalledTimes(1)
  attachDeferred.resolve({ sessionId: 'ses_one' })
  await Promise.all([first, second])
  expect(opencodeAdapter.send).toHaveBeenCalledTimes(2)
})
```

Run: `npm run test:vitest -- --run test/unit/server/fresh-agent/runtime-manager.test.ts`
Expected: PASS.

---

## Task 3: WebSocket Route, Authorization, And Race Handling

**Files:**
- Modify: `shared/ws-protocol.ts`
- Modify: `server/ws-handler.ts`
- Test: `test/unit/server/ws-handler-fresh-agent-ownership.test.ts`
- Test: `test/unit/server/ws-handler-fresh-agent.test.ts`

**Interfaces:**
- Produces: all Fresh Agent mutation messages can carry `cwd?: string`; `freshAgent.attach` can carry `sessionRef`.
- Produces: same-socket mutations wait for pending attach before authorization.
- Produces: `freshAgent.send.accepted` includes `sessionId`, `sessionType`, and `provider`.

- [ ] **Step 1: Write failing protocol/server tests**

In `test/unit/server/ws-handler-fresh-agent-ownership.test.ts`, add:

```ts
function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

it('waits for same-socket attach before sending a raced FreshOpenCode prompt', async () => {
  const attach = createDeferred<{ sessionId: string; runtimeProvider: string }>()
  const runtimeManager = {
    attach: vi.fn(() => attach.promise),
    subscribe: vi.fn().mockResolvedValue(() => undefined),
    send: vi.fn().mockResolvedValue(undefined),
  }
  const { server, registry, handler } = await createServer({ freshAgentRuntimeManager: runtimeManager })
  try {
    const { ws, messages } = await connectAndAuth(server)
    ws.send(JSON.stringify({
      type: 'freshAgent.attach',
      sessionId: 'ses_race',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/safe',
      sessionRef: { provider: 'opencode', sessionId: 'ses_race' },
    }))
    ws.send(JSON.stringify({
      type: 'freshAgent.send',
      requestId: 'send-after-attach',
      sessionId: 'ses_race',
      sessionType: 'freshopencode',
      provider: 'opencode',
      cwd: '/repo/safe',
      text: 'continue',
    }))

    await vi.waitFor(() => expect(runtimeManager.attach).toHaveBeenCalled())
    expect(runtimeManager.send).not.toHaveBeenCalled()
    attach.resolve({ sessionId: 'ses_race', runtimeProvider: 'opencode' })

    await vi.waitFor(() => {
      expect(runtimeManager.send).toHaveBeenCalledWith({
        sessionId: 'ses_race',
        sessionType: 'freshopencode',
        provider: 'opencode',
        cwd: '/repo/safe',
      }, expect.objectContaining({ requestId: 'send-after-attach', text: 'continue' }))
    })
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'freshAgent.send.accepted',
      requestId: 'send-after-attach',
      sessionId: 'ses_race',
      sessionType: 'freshopencode',
      provider: 'opencode',
    }))
  } finally {
    handler.close()
    registry.shutdown()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
```

Run: `npm run test:vitest -- --run test/unit/server/ws-handler-fresh-agent-ownership.test.ts test/unit/server/ws-handler-fresh-agent.test.ts`
Expected: FAIL because send is unauthorized while attach is pending and accepted lacks locator fields.

- [ ] **Step 2: Extend protocol schemas and server locators**

In `shared/ws-protocol.ts`:
- Add `cwd: z.string().optional()` to `freshAgent.send`, `freshAgent.interrupt`, `freshAgent.compact`, `freshAgent.approval.respond`, `freshAgent.question.respond`, `freshAgent.kill`, and `freshAgent.fork`.
- Add `sessionRef: SessionLocatorSchema.optional()` to `freshAgent.attach`.
- Extend `FreshAgentServerMessage` accepted type to:

```ts
| {
  type: 'freshAgent.send.accepted'
  requestId: string
  sessionId: string
  sessionType: string
  provider: string
  submittedTurnId?: string
}
```

In `server/ws-handler.ts`, add a helper:

```ts
import type { FreshAgentRuntimeProvider, FreshAgentSessionType } from '../shared/fresh-agent.js'

private freshAgentLocatorFromMessage(m: {
  sessionId: string
  sessionType: FreshAgentSessionType
  provider: FreshAgentRuntimeProvider
  cwd?: string
  settings?: { cwd?: string }
}): FreshAgentLocator {
  const cwd = typeof m.cwd === 'string' && m.cwd.trim().length > 0
    ? m.cwd
    : (typeof m.settings?.cwd === 'string' && m.settings.cwd.trim().length > 0 ? m.settings.cwd : undefined)
  return {
    sessionId: m.sessionId,
    sessionType: m.sessionType,
    provider: m.provider,
    ...(cwd ? { cwd } : {}),
  }
}
```

Use it for every Fresh Agent mutation case.

Run: `npm run test:vitest -- --run test/unit/server/ws-handler-fresh-agent.test.ts`
Expected: tests compile, accepted locator assertions still fail until Step 3.

- [ ] **Step 3: Implement pending attach authorization**

Add to the `ClientState` type and to client-state initialization:

```ts
pendingFreshAgentAttachByKey: Map<string, Promise<void>>
```

Initialize it beside the existing Fresh Agent authorization/subscription maps:

```ts
pendingFreshAgentAttachByKey: new Map(),
```

In `freshAgent.attach`:
- Build locator with cwd.
- Create `attachPromise` before awaiting manager attach.
- Store it by `freshAgentKey(locator)`.
- On success, authorize and subscribe.
- On failure, send an error and do not authorize.
- In `finally`, delete only the same promise.

Add async helper:

```ts
private async waitForFreshAgentAuthorization(
  ws: LiveWebSocket,
  state: ClientState,
  locator: FreshAgentLocator,
  requestId?: string,
): Promise<boolean> {
  if (this.isFreshAgentAuthorized(state, locator)) return true
  const pending = state.pendingFreshAgentAttachByKey.get(this.freshAgentKey(locator))
  if (pending) {
    await pending.catch(() => undefined)
    if (this.isFreshAgentAuthorized(state, locator)) return true
  }
  this.sendError(ws, {
    code: 'UNAUTHORIZED',
    message: 'Not authorized for this Fresh Agent session',
    ...(requestId ? { requestId } : {}),
  })
  return false
}
```

Use it for `send`; use it for other async mutation cases where tests are added. Keep failed attach from authorizing.

Run: `npm run test:vitest -- --run test/unit/server/ws-handler-fresh-agent-ownership.test.ts test/unit/server/ws-handler-fresh-agent.test.ts`
Expected: PASS.

---

## Task 4: Client Route Propagation, Reconnect, And Snapshot Invalidation

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentView.tsx`
- Modify: `src/lib/fresh-agent-ws.ts` only if needed for type narrowing.
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
- Test: `test/unit/client/store/tabRegistrySync.test.ts`

**Interfaces:**
- Produces: every Fresh Agent mutation sent by `FreshAgentView` includes cwd when known.
- Produces: materialized panes send attach on reconnect.
- Produces: snapshot refresh invalidations are scoped and coalesced.
- Produces: stale local echo is cleared when an idle recovered snapshot lacks the submitted user turn.

- [ ] **Step 1: Write failing route propagation and reconnect tests**

Add tests to `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`:

```ts
it('sends cwd and sessionRef on attach and cwd on later mutations for materialized FreshOpenCode panes', async () => {
  const store = createStore()
  store.dispatch(initLayout({
    tabId: 'tab-route',
    paneId: 'pane-route',
    content: {
      kind: 'fresh-agent',
      sessionType: 'freshopencode',
      provider: 'opencode',
      createRequestId: 'req-route',
      sessionId: 'ses_route',
      resumeSessionId: 'ses_route',
      sessionRef: { provider: 'opencode', sessionId: 'ses_route' },
      initialCwd: '/repo/safe',
      status: 'idle',
    },
  }))

  render(<Provider store={store}><StoreBackedFreshAgentView tabId="tab-route" paneId="pane-route" /></Provider>)

  await waitFor(() => expect(sentFreshAgentMessages('freshAgent.attach').at(-1)).toMatchObject({
    type: 'freshAgent.attach',
    sessionId: 'ses_route',
    cwd: '/repo/safe',
    sessionRef: { provider: 'opencode', sessionId: 'ses_route' },
  }))

  fireEvent.change(screen.getByRole('textbox', { name: 'Chat message input' }), { target: { value: 'continue' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect(sentFreshAgentMessages('freshAgent.send').at(-1)).toMatchObject({
    sessionId: 'ses_route',
    cwd: '/repo/safe',
    settings: expect.objectContaining({ cwd: '/repo/safe' }),
  })
})
```

Add a reconnect test that invokes `ws.onReconnect` handler and expects `freshAgent.attach` for an existing `sessionId`.

Run: `npm run test:vitest -- --run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
Expected: FAIL because attach lacks sessionRef, control mutations lack cwd, and existing-session reconnect does not attach.

- [ ] **Step 2: Implement route propagation**

In `FreshAgentView.tsx`:
- Include `sessionRef: paneContent.sessionRef` in attach when present.
- Add a helper:

```ts
function routeFields(content: FreshAgentPaneContent) {
  return content.initialCwd ? { cwd: content.initialCwd } : {}
}
```

Use it in `freshAgent.send`, interrupt, compact, approval response, question response, fork, and kill messages. Keep `settings.cwd` for send settings too.

Add reconnect handler for panes with `sessionId`:

```ts
useEffect(() => {
  if (!paneContent.sessionId || hidden) return
  if (typeof ws.onReconnect !== 'function') return
  return ws.onReconnect(() => {
    const current = paneContentRef.current
    if (!current.sessionId) return
    sendFreshAgentMessage({
      type: 'freshAgent.attach',
      sessionId: current.sessionId,
      sessionType: current.sessionType,
      provider: current.provider,
      resumeSessionId: current.resumeSessionId,
      sessionRef: current.sessionRef,
      cwd: current.initialCwd,
    })
  })
}, [hidden, paneContent.sessionId, sendFreshAgentMessage, ws])
```

Run: `npm run test:vitest -- --run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
Expected: route propagation and reconnect tests PASS.

- [ ] **Step 3: Write failing accepted scoping and coalescing tests**

Add tests proving:
- A mounted unrelated pane ignores another pane's `freshAgent.send.accepted`.
- A burst of owner `freshAgent.send.accepted` plus `freshAgent.session.snapshot` causes one snapshot refetch.
- `freshAgent.stream` does not fetch a snapshot.
- `freshAgent.session.changed`, `freshAgent.session.snapshot`, `freshAgent.result`, `freshAgent.permission.request`, and `freshAgent.question.request` still invalidate unless the UI is changed to source those from reducer state.

For the existing partial refresh test around `freshAgent.send.accepted` plus snapshot event, change the expected snapshot call count from two additional fetches to one additional fetch.

Run: `npm run test:vitest -- --run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
Expected: FAIL because the current code increments nonce immediately for every accepted/event.

- [ ] **Step 4: Implement scoped coalesced invalidation**

In `FreshAgentView.tsx`, replace direct `setSnapshotRefreshNonce((value) => value + 1)` calls with:

```ts
const snapshotRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
const scheduleSnapshotRefresh = useCallback(() => {
  if (snapshotRefreshTimerRef.current) return
  snapshotRefreshTimerRef.current = setTimeout(() => {
    snapshotRefreshTimerRef.current = null
    setSnapshotRefreshNonce((value) => value + 1)
  }, 50)
}, [])
```

Clean it up on unmount.

For `freshAgent.send.accepted`, require:
- `message.requestId` exists in `pendingSendMetadataRef.current`, or local echo request id matches.
- If accepted carries `sessionId/sessionType/provider`, it must match current pane.

For `freshAgent.event`, only schedule refresh for:

```ts
const snapshotInvalidatingEvents = new Set([
  'freshAgent.session.changed',
  'freshAgent.session.snapshot',
  'freshAgent.result',
  'freshAgent.permission.request',
  'freshAgent.permission.cancelled',
  'freshAgent.question.request',
])
```

Do not refresh on `freshAgent.stream`, `freshAgent.status`, `freshAgent.session.init`, or `freshAgent.session.metadata`.

Run: `npm run test:vitest -- --run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
Expected: PASS.

- [ ] **Step 5: Clear stale local echo on recovered idle snapshots**

Add a test where pane content has `pendingLocalEcho`, recovered snapshot is `idle`, and turns do not include the pending request/submitted turn. Expect the visible optimistic echo and persisted `pendingLocalEcho` to clear.

Implement:
- After applying a snapshot, if `snapshot.status !== 'running'` and local echo has no matching turn in the snapshot, call `setLocalEchoState(null)` and update pane content with `pendingLocalEcho: undefined`.
- Preserve current behavior when a matching user turn exists.

Run: `npm run test:vitest -- --run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
Expected: PASS.

- [ ] **Step 6: Prove route survives registry/persistence**

Add or update `test/unit/client/store/tabRegistrySync.test.ts` so a materialized FreshOpenCode pane snapshot contains durable `sessionRef` and `initialCwd`.

Run: `npm run test:vitest -- --run test/unit/client/store/tabRegistrySync.test.ts`
Expected: PASS.

---

## Task 5: Route-Aware Fake OpenCode And Browser Restart Smoke

**Files:**
- Modify: `test/e2e-browser/fixtures/fake-opencode.cjs`
- Add: `test/e2e-browser/specs/freshopencode-restart-recovery.spec.ts`
- Reuse: `test/e2e-browser/helpers/test-server.ts`

**Interfaces:**
- Produces: fake OpenCode serve endpoints needed to prove route-safe FreshOpenCode recovery.
- Produces: e2e smoke that starts/stops only isolated `TestServer` instances, never the self-hosted Freshell server.

- [ ] **Step 1: Extend fake serve routes test-first through e2e expectations**

Add helper expectations in the new e2e spec that will require fake audit entries:

```ts
expect(auditEvents).toContainEqual(expect.objectContaining({
  event: 'serve_session_get',
  sessionId,
  routeDirectory: cwd,
  storedDirectory: cwd,
  ok: true,
}))
expect(auditEvents).toContainEqual(expect.objectContaining({
  event: 'serve_prompt_async',
  sessionId,
  routeDirectory: cwd,
  storedDirectory: cwd,
  ok: true,
}))
```

Run the new spec target:
`npm run test:e2e -- test/e2e-browser/specs/freshopencode-restart-recovery.spec.ts`
Expected: FAIL because the fixture/spec do not exist or fake endpoints return 404.

- [ ] **Step 2: Implement fake route-aware serve endpoints**

In `test/e2e-browser/fixtures/fake-opencode.cjs`:
- Add `routeDirectory(url)` reading `url.searchParams.get('directory')`.
- Make `POST /session?directory=<cwd>` create session rows using the query directory, not JSON body `directory`.
- Add `GET /session/:id?directory=<cwd>` returning DB session info and auditing stored/route directory.
- Add `POST /session/:id/prompt_async?directory=<cwd>` that verifies stored directory matches route, appends user/assistant messages, audits the mutation, and returns `204`.
- Add `GET /session/:id/message?directory=<cwd>` and `GET /session/:id/message/:messageId?directory=<cwd>` for snapshot/turn body reads.
- Add `/global/event` SSE alias for current event behavior.
- Add route-aware `/session/status?directory=<cwd>` audit entries.
- Add optional env `FAKE_OPENCODE_REQUIRE_DIRECTORY_ROUTE=1`; when enabled, missing or mismatched route returns 409 and audits `ok: false`.

Run focused e2e spec again.
Expected: PASS after implementation.

- [ ] **Step 3: Implement route-safe restart smoke**

The new e2e should:
- Create a temp shared root, fake `opencode` binary, shared OpenCode data dir, and cwd A.
- Start `TestServer` with fake OpenCode and Fresh Agent enabled.
- Open a FreshOpenCode pane in cwd A.
- Send first prompt, wait for prompt/response and pane state `sessionId` matching `ses_*`.
- Flush persisted layout.
- Stop `server1`; start `server2` on the same port/token and shared fake OpenCode data.
- Wait for browser reconnection.
- Send a follow-up prompt.
- Assert the same `ses_*` was used, no second `session_create_requested` happened for the follow-up, route audit entries use cwd A, and the follow-up appears in the UI.

Run:
`npm run test:e2e -- test/e2e-browser/specs/freshopencode-restart-recovery.spec.ts`
Expected: PASS.

---

## Task 6: Terminal Retention-Loss Coalescing

**Files:**
- Modify: `server/terminal-stream/broker.ts`
- Test: `test/unit/server/ws-handler-backpressure.test.ts`

**Interfaces:**
- Produces: one `terminal.stream.changed` with `reason: 'retention_lost'` per `terminal.output.raw` append, while preserving output retagging and replay gap semantics.

- [ ] **Step 1: Tighten the existing failing test**

In `test/unit/server/ws-handler-backpressure.test.ts`, update the large-fragment retention test to assert:

```ts
expect(streamChanges).toHaveLength(1)
expect(outputs.length).toBeGreaterThan(0)
expect(outputs.every((payload) => payload.streamId === streamChanges[0].streamId)).toBe(true)
expect(outputs.map((payload) => payload.data).join('')).toHaveLength(200 * 1024)
```

Add a replay attach after the large append and assert either a replay gap or retained frames use the final stream id consistently.

Run: `npm run test:vitest -- --run test/unit/server/ws-handler-backpressure.test.ts`
Expected: FAIL because current code can emit multiple stream changes inside one raw append.

- [ ] **Step 2: Coalesce retention handling per append**

In `server/terminal-stream/broker.ts`, change `appendOutputFrames` so fragments are appended first, and retention loss is consumed once after the loop:

```ts
for (const fragment of fragments) {
  frames.push(state.replayRing.append(fragment, { streamId }))
}
const retainedStreamId = this.handleReplayRetentionLoss(terminalId, state, streamId)
if (retainedStreamId) {
  this.retagFrames(frames, streamId, retainedStreamId)
}
```

If the replay test shows this loses a retained suffix boundary, adjust the broker to track the retained suffix boundary explicitly, but keep the externally visible stream-change count at one per raw append.

Run: `npm run test:vitest -- --run test/unit/server/ws-handler-backpressure.test.ts`
Expected: PASS.

---

## Task 7: Focused And Broad Verification

**Files:**
- No production files unless earlier tasks reveal gaps.

**Interfaces:**
- Produces: evidence that kata `zrrj` is fixed as one cohesive change.

- [ ] **Step 1: Run focused unit suites**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/server/fresh-agent/opencode-serve-adapter.test.ts \
  test/unit/server/fresh-agent/opencode-serve-manager.test.ts \
  test/unit/server/fresh-agent/runtime-manager.test.ts \
  test/unit/server/ws-handler-fresh-agent.test.ts \
  test/unit/server/ws-handler-fresh-agent-ownership.test.ts \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx \
  test/unit/client/store/tabRegistrySync.test.ts \
  test/unit/server/ws-handler-backpressure.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the FreshOpenCode browser smoke**

Run:

```bash
npm run test:e2e -- test/e2e-browser/specs/freshopencode-restart-recovery.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Run full coordinated verification**

Run:

```bash
FRESHELL_TEST_SUMMARY='zrrj FreshOpenCode restart recovery' npm run check
```

Expected: PASS.

- [ ] **Step 4: Commit the implementation**

```bash
git add shared/ws-protocol.ts src/components/fresh-agent/FreshAgentView.tsx src/lib/fresh-agent-ws.ts src/store server test docs/superpowers/plans/2026-06-22-freshopencode-restart-recovery.md
git commit -m "fix: recover FreshOpenCode sessions safely after restart"
```

Expected: commit succeeds with only kata `zrrj` files changed.
