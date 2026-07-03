# Fresh-Agent Status Authoritative — Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two server-authoritativeness gaps left behind by the 2026-06-23 fresh-agent turn-complete migration: (A) freshcodex must self-heal a crashed/disconnected codex sidecar so a pane can't stick BLUE forever, and (B) the waiting-for-approval attention edge must become a discrete server event so the last fragile client-side derivation (`useAgentSessionTurnCompletion`) can be deleted.

**Architecture:** Both fixes mirror the already-landed discrete-edge pattern. (A) consumes the codex runtime's existing `onExit` hook inside the adapter's `subscribe()` and emits the same terminal `sdk.status: 'exited'` that `thread_closed` already emits — clearing BLUE with NO turn-complete chime. (B) adds a discrete `sdk.turn.waiting` event emitted by the Claude/kilroy `SdkBridge` on the 0→≥1 pending-approval/question edge, normalized to `freshAgent.turn.waiting`, routed through the existing `freshAgent.event` envelope, and folded into the GREEN/SOUND pipeline by a new `applyFreshAgentWaiting` thunk (a sibling of `applyFreshAgentCompletion`) under a distinct `#waiting` dedupe namespace. The client hook is then deleted.

**Tech Stack:** TypeScript (NodeNext/ESM — relative imports MUST end in `.js`), React 18 + Redux Toolkit client, Node server, Vitest + Testing Library.

## Global Constraints

- Relative server/client imports use explicit `.js` extensions (NodeNext/ESM). Copy verbatim from neighboring imports.
- TDD red→green→refactor for every code task; never skip the refactor; never weaken/skip a test to pass.
- Focused test command + CONFIG (critical — wrong config silently runs ZERO tests = false green): default config (jsdom) covers `test/unit/client/**` and `test/e2e/**` → `npm run test:vitest -- run <path>`. The server config (node) covers BOTH `test/server/**` AND `test/unit/server/**` (the latter is EXCLUDED from the default config) → `npm run test:vitest -- run <path> --config config/vitest/vitest.server.config.ts`. So: `codex-adapter.test.ts`, `sdk-events.test.ts`, `sdk-bridge.test.ts` (all under `test/unit/server/`) MUST use `--config config/vitest/vitest.server.config.ts`; `fresh-agent-turn-complete.test.ts` and the e2e use the default config.
- Avoid tautological tests (no "string is present" assertions); test behavior/contracts.
- A "completion" (GREEN + chime) fires ONLY on a discrete turn-complete/waiting edge. A self-heal/recovery emits a terminal STATUS (`exited`/`idle`) and MUST NOT emit any `*.turn.complete`/`*.turn.waiting` — recovery clears BLUE without chiming.
- The discrete edge stamps a per-session strictly-monotonic wall-clock `at` via `nextMonotonicTurnCompleteAt(...)` (`server/fresh-agent/turn-complete-clock.ts`). Each new edge type keeps its OWN per-session `last*At` field.
- The client dedupes each edge by `terminalId` via the `at`-monotonic regime in `recordTurnComplete`. The waiting edge MUST use a `terminalId` distinct from the completion edge (`${sessionKey}#waiting`) so an approval `at` can never suppress a real completion `at` and vice-versa.
- Only Claude/kilroy raise approvals/questions today (codex/opencode declare `approvals:false, questions:false` in `server/fresh-agent/adapters/codex/normalize.ts`); the waiting emit therefore lives only in the shared `SdkBridge`.

---

## File Structure

**Part A — freshcodex onExit self-heal**
- Modify: `server/fresh-agent/adapters/codex/adapter.ts` — add `onExit?` to `CodexRuntimePort`; register it in `subscribe()`.
- Test: `test/unit/server/fresh-agent/codex-adapter.test.ts` — inject a fake runtime exposing `onExit`.

**Part B — waiting-for-approval server-authoritative**
- Modify: `server/sdk-bridge-types.ts` — add `sdk.turn.waiting` to `SdkServerMessage`; add `lastWaitingAt?` to `SdkSessionState`.
- Modify: `server/fresh-agent/sdk-events.ts` — add `freshAgent.turn.waiting` to `FreshAgentProviderEvent` + normalize case.
- Modify: `server/sdk-bridge.ts` — emit the 0→≥1 waiting edge from `handlePermissionRequest` and `handleAskUserQuestion`.
- Modify: `src/store/turnCompletionThunks.ts` — add `applyFreshAgentWaiting` thunk.
- Modify: `src/lib/fresh-agent-ws.ts` — route `freshAgent.turn.waiting`.
- Delete: `src/hooks/useAgentSessionTurnCompletion.ts` and `test/unit/client/hooks/useAgentSessionTurnCompletion.test.tsx`.
- Modify: `src/App.tsx` — remove the hook import + call.
- Tests: `test/unit/server/fresh-agent/sdk-events.test.ts`, `test/unit/server/sdk-bridge.test.ts`, `test/unit/client/lib/fresh-agent-turn-complete.test.ts` (or new `fresh-agent-waiting.test.ts`), e2e `test/e2e/fresh-agent-turn-complete-notification.test.tsx` (mirror for waiting), plus migrate any e2e that drove waiting-green via the hook.
- Modify: `AGENTS.md` — update the Agent Status Indicators note.

---

## Part A — freshcodex `onExit` self-heal

### Task A1: Self-heal a crashed/disconnected codex sidecar to `exited` (no chime)

**Why:** The freshcodex adapter subscribes only to `onThreadLifecycle` and `onTurnCompleted`. If the codex app-server process exits or its client disconnects mid-turn WITHOUT a `thread_closed`/`thread_status_changed`, the adapter emits nothing and the pane stays BLUE forever. The real runtime (`CodexAppServerRuntime`) already exposes `onExit(handler)` (gated on `!shutdownRequested`, so a normal `adapter.shutdown()`/`kill()` does NOT fire it), but `CodexRuntimePort` hides it so the adapter can't call it.

**Scope decision — subscription-scoped is correct and complete (validated):** The handler is registered inside `subscribe()`, so it only fires while a client is actively subscribed. This is the right scope because BLUE is only *shown* when a client is subscribed — there is no stuck-BLUE to clear during an offline window. The remaining concern ("a sidecar exit while offline leaves a stale `runtimeByThread` entry, and the next `ensureRuntime()` returns a dead runtime") is NOT a real bug: the child-exit handler nulls the runtime's `child`/`ready`/`ensureReadyPromise`/`readyCwd` (`runtime.ts:1220-1225`), and EVERY runtime operation calls `ensureReady()`, which sees `ready === null` and lazily restarts the child via `startRuntime` (`runtime.ts:744-769`). So on reconnect, `ensureRuntime()` returns the cached runtime and its next `resumeThread` transparently restarts it — the exact path the existing test "lazily resumes a Codex runtime before subscribing to a persisted thread after server reload" already covers. Reuse self-heals; no scope expansion (runtime-lifetime `onExit`) is needed.

**CRITICAL — do NOT call `releaseRuntime`/`clearThreadState` from the `onExit` handler (recovery correctness):** A crash/disconnect is RECOVERABLE, unlike `thread_closed` (terminal). The handler must emit `sdk.status: 'exited'` ONLY and leave the runtime mapping intact. If it released the runtime, the mapping would be deleted, so the next `send()` would allocate a FRESH runtime that the still-registered subscription is NOT bound to (`ws-handler` skips re-subscription for an existing key) — orphaning all post-recovery lifecycle/turn-complete events (the pane would clear BLUE once, then go silent on the recovered turn). Leaving the runtime mapped means the next `send()` reuses the SAME runtime object (lazy-restart via `ensureReady`), and this subscription's handlers — bound to that object — keep delivering events. This mirrors the offline case exactly, plus the immediate BLUE clear.

**Files:**
- Modify: `server/fresh-agent/adapters/codex/adapter.ts:49-80` (port type) and `:873-925` (`subscribe`)
- Test: `test/unit/server/fresh-agent/codex-adapter.test.ts`

**Interfaces:**
- Consumes: the real runtime's `onExit(handler: (error?: Error, source?: 'app_server_exit' | 'app_server_client_disconnect') => void): () => void` (`server/coding-cli/codex-app-server/runtime.ts:859-864`).
- Produces: on sidecar exit, the adapter listener receives `{ type: 'sdk.status', sessionId, status: 'exited' }` (identical to the existing `thread_closed` path at `adapter.ts:888-893`), and NO `sdk.turn.complete`.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/server/fresh-agent/codex-adapter.test.ts` (mirror the `thread_closed`→`exited` test at lines ~1058-1077 and the "must NOT chime" pattern at ~1111-1118):

```ts
it('self-heals to exited (no chime) when the codex sidecar exits mid-turn', async () => {
  let exitHandler: ((error?: Error, source?: string) => void) | undefined
  const offExit = vi.fn()
  const runtime = {
    startThread: vi.fn(),
    resumeThread: vi.fn(),
    onThreadLifecycle: vi.fn(() => vi.fn()),
    onTurnCompleted: vi.fn(() => vi.fn()),
    onExit: vi.fn((handler: (error?: Error, source?: string) => void) => {
      exitHandler = handler
      return offExit
    }),
    readThread: vi.fn(),
    listThreadTurns: vi.fn(),
    readThreadTurn: vi.fn(),
  }
  const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any })
  const listener = vi.fn()
  const unsubscribe = await adapter.subscribe?.('thread-new-1', listener)

  expect(runtime.onExit).toHaveBeenCalledTimes(1)

  exitHandler?.(undefined, 'app_server_exit')

  expect(listener).toHaveBeenCalledWith({ type: 'sdk.status', sessionId: 'thread-new-1', status: 'exited' })
  // A crash is NOT a positive completion: it clears BLUE but must never chime green.
  expect(listener).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'sdk.turn.complete' }))

  // Teardown unsubscribes the exit handler too.
  unsubscribe?.()
  expect(offExit).toHaveBeenCalledTimes(1)
})

it('preserves the runtime on sidecar exit so recovery reuses the SAME subscribed runtime', async () => {
  // A crash is RECOVERABLE: onExit must NOT release the runtime. Releasing it deletes the
  // runtimeByThread mapping, so the next send() allocates a FRESH runtime this still-registered
  // subscription is not bound to (ws-handler skips re-subscription for an existing key),
  // orphaning post-recovery lifecycle/turn-complete events. Prove the fix: shutdown is NOT
  // called on a crash, the next send reuses the SAME runtime (factory called once), and the
  // subscription's lifecycle handler still delivers events to the listener after the crash.
  let exitHandler: ((error?: Error, source?: string) => void) | undefined
  let lifecycleHandler: ((event: any) => void) | undefined
  const runtime = {
    startThread: vi.fn().mockResolvedValue({ threadId: 'thread-new-1', wsUrl: 'ws://127.0.0.1:43123' }),
    resumeThread: vi.fn(),
    startTurn: vi.fn().mockResolvedValue({ turnId: 'turn-1' }),
    onThreadLifecycle: vi.fn((handler: (event: any) => void) => { lifecycleHandler = handler; return vi.fn() }),
    onTurnCompleted: vi.fn(() => vi.fn()),
    onExit: vi.fn((handler: (error?: Error, source?: string) => void) => { exitHandler = handler; return vi.fn() }),
    readThread: vi.fn(),
    listThreadTurns: vi.fn(),
    readThreadTurn: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
  const runtimeFactory = vi.fn(() => runtime)
  const adapter = createCodexFreshAgentAdapter({ runtimeFactory: runtimeFactory as any })
  const listener = vi.fn()
  await adapter.create({ requestId: 'req-1', sessionType: 'freshcodex', cwd: '/tmp' })
  await adapter.subscribe?.('thread-new-1', listener)
  expect(runtimeFactory).toHaveBeenCalledTimes(1)

  exitHandler?.(undefined, 'app_server_exit')
  expect(listener).toHaveBeenCalledWith({ type: 'sdk.status', sessionId: 'thread-new-1', status: 'exited' })
  expect(runtime.shutdown).not.toHaveBeenCalled() // recovery, not teardown

  await adapter.send?.('thread-new-1', { requestId: 'send-2', text: 'retry' })
  expect(runtimeFactory).toHaveBeenCalledTimes(1) // SAME runtime reused
  expect(runtime.startTurn).toHaveBeenCalledTimes(1)

  lifecycleHandler?.({ kind: 'thread_status_changed', threadId: 'thread-new-1', status: { type: 'active', activeFlags: [] } })
  expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: 'running' }))
})
```

> The assertion that matters: after `onExit`, `runtime.shutdown` is NOT called and the next `send()` does NOT call `runtimeFactory` again (the SAME runtime is reused), and the still-bound lifecycle handler delivers post-recovery events. The buggy `releaseRuntime`-in-onExit version fails BOTH (shutdown called; factory called twice) — a genuine RED.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- run test/unit/server/fresh-agent/codex-adapter.test.ts -t "self-heals to exited" --config config/vitest/vitest.server.config.ts`
Expected: FAIL — `runtime.onExit` is never called (the adapter doesn't subscribe to it), so `exitHandler` is undefined and the `sdk.status exited` assertion fails.

- [ ] **Step 3: Add `onExit?` to `CodexRuntimePort`**

In `server/fresh-agent/adapters/codex/adapter.ts`, inside the `CodexRuntimePort` type (after `onTurnCompleted?` at line ~71), add:

```ts
  onExit?: (
    handler: (error?: Error, source?: 'app_server_exit' | 'app_server_client_disconnect') => void,
  ) => () => void
```

(Optional `?` keeps every existing runtime fake — which omits `onExit` — valid.)

- [ ] **Step 4: Register `onExit` in `subscribe()`**

In `subscribe()` (`adapter.ts:873-925`), after the `offTurnCompleted` registration (line ~919) and before the teardown `return`, add a handler that mirrors `thread_closed` for THIS subscription's `sessionId` (the runtime's `onExit` fires once per runtime, with no threadId; each subscription emits only for its own `sessionId`):

```ts
      const offExit = runtime.onExit?.(() => {
        // A crash/disconnect is RECOVERABLE — unlike thread_closed (terminal), the user may
        // send again on this same pane/subscription. Do NOT release the runtime here: that
        // would delete the runtimeByThread mapping, so the next send() allocates a FRESH
        // runtime this still-registered subscription is NOT bound to (ws-handler skips
        // re-subscription for an existing key), orphaning its lifecycle/turn-complete events.
        // Leave the runtime mapped — its next operation lazily restarts the child via
        // ensureReady(), and this subscription's handlers (bound to the same runtime object)
        // keep delivering events. Just emit the terminal status to clear BLUE (no chime; a
        // crash is not a positive completion).
        listener({ type: 'sdk.status', sessionId, status: 'exited' })
      })
```

Then extend the teardown closure (currently lines ~921-924) to also detach it:

```ts
      return () => {
        offLifecycle()
        offTurnCompleted?.()
        offExit?.()
      }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test:vitest -- run test/unit/server/fresh-agent/codex-adapter.test.ts -t "self-heals to exited" --config config/vitest/vitest.server.config.ts`
Expected: PASS.

- [ ] **Step 6: Run the full codex-adapter suite (regression)**

Run: `npm run test:vitest -- run test/unit/server/fresh-agent/codex-adapter.test.ts --config config/vitest/vitest.server.config.ts`
Expected: PASS (all existing tests still green; existing fakes that omit `onExit` are unaffected because the call is `runtime.onExit?.(...)`).

- [ ] **Step 7: Refactor**

Review: the handler emits `sdk.status: 'exited'` ONLY — deliberately NOT `clearThreadState`/`releaseRuntime` (those belong to the terminal `thread_closed` path; calling them here would break recovery, see the CRITICAL note above). Confirm the comment explains both the no-chime invariant and the no-release-for-recovery invariant. Keep as-is if clean.

- [ ] **Step 8: Commit**

```bash
git add server/fresh-agent/adapters/codex/adapter.ts test/unit/server/fresh-agent/codex-adapter.test.ts
git commit -m "fix(freshcodex): self-heal stuck-blue on codex sidecar exit via onExit"
```

---

## Part B — waiting-for-approval server-authoritative

### Task B1: Add the `sdk.turn.waiting` / `freshAgent.turn.waiting` event type + normalize

**Files:**
- Modify: `server/sdk-bridge-types.ts:78` (SdkServerMessage union) and `:130` (SdkSessionState)
- Modify: `server/fresh-agent/sdk-events.ts:35` (FreshAgentProviderEvent) and `:70-71` (normalize)
- Test: `test/unit/server/fresh-agent/sdk-events.test.ts`

**Interfaces:**
- Produces: `{ type: 'sdk.turn.waiting'; sessionId: string; at: number }` (server) → normalized to `{ type: 'freshAgent.turn.waiting'; sessionId: string; at: number }`.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/server/fresh-agent/sdk-events.test.ts` (mirror the existing `sdk.turn.complete` mapping test):

```ts
it('normalizes sdk.turn.waiting to freshAgent.turn.waiting preserving at', () => {
  expect(normalizeFreshAgentProviderEvent({ type: 'sdk.turn.waiting', sessionId: 's1', at: 42 }))
    .toEqual({ type: 'freshAgent.turn.waiting', sessionId: 's1', at: 42 })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:vitest -- run test/unit/server/fresh-agent/sdk-events.test.ts -t "freshAgent.turn.waiting" --config config/vitest/vitest.server.config.ts`
Expected: FAIL — `sdk.turn.waiting` falls through `default` and is returned unchanged (type stays `sdk.turn.waiting`).

- [ ] **Step 3: Add the union members**

In `server/sdk-bridge-types.ts`, after `| { type: 'sdk.turn.complete'; sessionId: string; at: number }` (line ~78):

```ts
  | { type: 'sdk.turn.waiting'; sessionId: string; at: number }
```

And in `SdkSessionState` (after `lastTurnCompleteAt?: number` at line ~130):

```ts
  /** Last emitted turn-waiting `at`, kept per session so the waiting edge stays strictly monotonic, independent of the completion edge. */
  lastWaitingAt?: number
```

In `server/fresh-agent/sdk-events.ts`, after `| { type: 'freshAgent.turn.complete'; sessionId: string; at: number }` (line ~35):

```ts
  | { type: 'freshAgent.turn.waiting'; sessionId: string; at: number }
```

- [ ] **Step 4: Add the normalize case**

In `server/fresh-agent/sdk-events.ts`, after the `sdk.turn.complete` case (line ~70-71):

```ts
    case 'sdk.turn.waiting':
      return { ...providerEvent, type: 'freshAgent.turn.waiting' } as FreshAgentProviderEvent
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm run test:vitest -- run test/unit/server/fresh-agent/sdk-events.test.ts --config config/vitest/vitest.server.config.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/sdk-bridge-types.ts server/fresh-agent/sdk-events.ts test/unit/server/fresh-agent/sdk-events.test.ts
git commit -m "feat(fresh-agent): add sdk.turn.waiting -> freshAgent.turn.waiting event type"
```

### Task B2: Emit the waiting edge on the 0→≥1 pending-approval/question transition

**Why:** Replicate the hook's edge semantics server-side: fire ONCE when a session goes from "no pending items" to "has a pending permission OR question", covering BOTH `handlePermissionRequest` and `handleAskUserQuestion`. A second concurrent request while one is already pending must NOT re-fire (matches the hook's count-based 0→≥1 edge).

**Files:**
- Modify: `server/sdk-bridge.ts:508-549` (`handlePermissionRequest`), `:551-607` (`handleAskUserQuestion`), and add a private helper near the completion emit (`:465-477`).
- Test: `test/unit/server/sdk-bridge.test.ts`

**Interfaces:**
- Consumes: `nextMonotonicTurnCompleteAt` (already imported at `sdk-bridge.ts:20`), `state.lastWaitingAt` (Task B1).
- Produces: `this.broadcastToSession(sessionId, { type: 'sdk.turn.waiting', sessionId, at })`.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/server/sdk-bridge.test.ts`. **CRITICAL — use the DRIVEN pattern, not the injected one.** That file has two patterns: the `describe('permission round-trip')` block INJECTS pending state directly via `state.pendingPermissions.set(...)` — this BYPASSES `handlePermissionRequest`, so it would NOT exercise the new emit and would be a FALSE GREEN. You MUST instead follow the `describe('canUseTool branching')` pattern (around lines 619-732) which drives the real flow through the captured `mockCanUseTool` closure. Requirements: set `mockKeepStreamOpen = true` before `createSession`, create with `permissionMode: 'default'`, `subscribe` a `received` array, and use the `await new Promise(r => setTimeout(r, 50))` timing the existing driven tests use.

```ts
it('emits one sdk.turn.waiting on the 0->1 pending-approval edge, not on a second concurrent request', async () => {
  mockKeepStreamOpen = true
  const session = await bridge.createSession({ cwd: '/tmp', permissionMode: 'default' })
  const received: any[] = []
  bridge.subscribe(session.sessionId, (msg) => received.push(msg))
  await new Promise((r) => setTimeout(r, 50))
  const waiting = () => received.filter((m) => m.type === 'sdk.turn.waiting')

  // First permission while nothing pending -> exactly one waiting edge with a numeric at.
  const p1 = mockCanUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'tool-1' })
  await new Promise((r) => setTimeout(r, 50))
  expect(waiting()).toHaveLength(1)
  expect(Number.isFinite(waiting()[0].at)).toBe(true)
  const perm1 = received.find((m) => m.type === 'sdk.permission.request')

  // Second permission while p1 still pending -> NO new waiting edge (already waiting).
  const p2 = mockCanUseTool('Edit', { file_path: '/tmp/x' }, { signal: new AbortController().signal, toolUseID: 'tool-2' })
  await new Promise((r) => setTimeout(r, 50))
  expect(waiting()).toHaveLength(1)

  // Resolve both so the parked canUseTool promises settle (avoid open handles).
  bridge.respondPermission(session.sessionId, perm1.requestId, { behavior: 'allow', updatedInput: {} })
  const perm2 = received.filter((m) => m.type === 'sdk.permission.request')[1]
  bridge.respondPermission(session.sessionId, perm2.requestId, { behavior: 'allow', updatedInput: {} })
  await Promise.all([p1, p2])
})

it('emits a fresh, strictly-greater sdk.turn.waiting on a new 0->1 edge after pending clears', async () => {
  mockKeepStreamOpen = true
  const session = await bridge.createSession({ cwd: '/tmp', permissionMode: 'default' })
  const received: any[] = []
  bridge.subscribe(session.sessionId, (msg) => received.push(msg))
  await new Promise((r) => setTimeout(r, 50))
  const waiting = () => received.filter((m) => m.type === 'sdk.turn.waiting')

  const p1 = mockCanUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'tool-1' })
  await new Promise((r) => setTimeout(r, 50))
  expect(waiting()).toHaveLength(1)
  const firstAt = waiting()[0].at
  const perm1 = received.find((m) => m.type === 'sdk.permission.request')
  bridge.respondPermission(session.sessionId, perm1.requestId, { behavior: 'allow', updatedInput: {} })
  await p1

  // Pending empty again -> next request is a fresh 0->1 edge with a strictly greater at.
  const p2 = mockCanUseTool('Bash', { command: 'pwd' }, { signal: new AbortController().signal, toolUseID: 'tool-2' })
  await new Promise((r) => setTimeout(r, 50))
  expect(waiting()).toHaveLength(2)
  expect(waiting()[1].at).toBeGreaterThan(firstAt)
  const perm2 = received.filter((m) => m.type === 'sdk.permission.request')[1]
  bridge.respondPermission(session.sessionId, perm2.requestId, { behavior: 'allow', updatedInput: {} })
  await p2
})

it('emits sdk.turn.waiting on a 0->1 AskUserQuestion edge too (not just permissions)', async () => {
  mockKeepStreamOpen = true
  const session = await bridge.createSession({ cwd: '/tmp', permissionMode: 'default' })
  const received: any[] = []
  bridge.subscribe(session.sessionId, (msg) => received.push(msg))
  await new Promise((r) => setTimeout(r, 50))

  const questions = [{ question: 'Which option?', header: 'Choice', options: [{ label: 'A', description: 'Option A' }], multiSelect: false }]
  const q = mockCanUseTool('AskUserQuestion', { questions }, { signal: new AbortController().signal, toolUseID: 'tool-q1' })
  await new Promise((r) => setTimeout(r, 50))
  expect(received.filter((m) => m.type === 'sdk.turn.waiting')).toHaveLength(1)
  const qMsg = received.find((m) => m.type === 'sdk.question.request')
  bridge.respondQuestion(session.sessionId, qMsg.requestId, { 'Which option?': 'A' })
  await q
})

it('treats permissions and questions as ONE combined waiting set (no cross-type re-chime)', async () => {
  // The edge is 0->1 over the COMBINED pending set (permissions OR questions). An impl that
  // checks only one map per handler would double-chime when a question lands while a
  // permission is pending (or vice versa). Prove both cross-type directions.
  mockKeepStreamOpen = true
  const session = await bridge.createSession({ cwd: '/tmp', permissionMode: 'default' })
  const received: any[] = []
  bridge.subscribe(session.sessionId, (msg) => received.push(msg))
  await new Promise((r) => setTimeout(r, 50))
  const waiting = () => received.filter((m) => m.type === 'sdk.turn.waiting')

  // Permission first (0->1) -> one waiting edge.
  const p = mockCanUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'tool-1' })
  await new Promise((r) => setTimeout(r, 50))
  expect(waiting()).toHaveLength(1)

  // Question while the permission is still pending -> NO new waiting edge (combined set already >=1).
  const questions = [{ question: 'Which?', header: 'H', options: [{ label: 'A', description: 'A' }], multiSelect: false }]
  const q = mockCanUseTool('AskUserQuestion', { questions }, { signal: new AbortController().signal, toolUseID: 'tool-q' })
  await new Promise((r) => setTimeout(r, 50))
  expect(waiting()).toHaveLength(1)

  const perm = received.find((m) => m.type === 'sdk.permission.request')
  const qMsg = received.find((m) => m.type === 'sdk.question.request')
  bridge.respondPermission(session.sessionId, perm.requestId, { behavior: 'allow', updatedInput: {} })
  bridge.respondQuestion(session.sessionId, qMsg.requestId, { Which: 'A' })
  await Promise.all([p, q])
})

it('combined waiting set — the REVERSE direction (question first, then permission) also does not re-chime', async () => {
  // Symmetry matters: an impl that checks the combined set in handleAskUserQuestion but only
  // pendingPermissions in handlePermissionRequest would pass the permission-first test yet
  // still double-chime here. Both handlers must read the combined (permissions + questions) set.
  mockKeepStreamOpen = true
  const session = await bridge.createSession({ cwd: '/tmp', permissionMode: 'default' })
  const received: any[] = []
  bridge.subscribe(session.sessionId, (msg) => received.push(msg))
  await new Promise((r) => setTimeout(r, 50))
  const waiting = () => received.filter((m) => m.type === 'sdk.turn.waiting')

  // Question first (0->1) -> one waiting edge.
  const questions = [{ question: 'Which?', header: 'H', options: [{ label: 'A', description: 'A' }], multiSelect: false }]
  const q = mockCanUseTool('AskUserQuestion', { questions }, { signal: new AbortController().signal, toolUseID: 'tool-q' })
  await new Promise((r) => setTimeout(r, 50))
  expect(waiting()).toHaveLength(1)

  // Permission while the question is still pending -> NO new waiting edge.
  const p = mockCanUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'tool-1' })
  await new Promise((r) => setTimeout(r, 50))
  expect(waiting()).toHaveLength(1)

  const qMsg = received.find((m) => m.type === 'sdk.question.request')
  const perm = received.find((m) => m.type === 'sdk.permission.request')
  bridge.respondQuestion(session.sessionId, qMsg.requestId, { Which: 'A' })
  bridge.respondPermission(session.sessionId, perm.requestId, { behavior: 'allow', updatedInput: {} })
  await Promise.all([p, q])
})
```

> The names `bridge`, `mockCanUseTool`, `mockKeepStreamOpen`, `createSession`, `subscribe`, `respondPermission`, `respondQuestion` are the REAL helpers already in `sdk-bridge.test.ts` (see lines 7-79, 564-657, 708-732). Do NOT invent a harness; do NOT inject `pendingPermissions` directly.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:vitest -- run test/unit/server/sdk-bridge.test.ts -t "sdk.turn.waiting" --config config/vitest/vitest.server.config.ts`
Expected: FAIL — no `sdk.turn.waiting` is ever broadcast.

- [ ] **Step 3: Add the emit helper**

In `server/sdk-bridge.ts`, add a private method (place it near `handlePermissionRequest`, e.g. before line 508):

```ts
  /**
   * Server-authoritative "waiting for approval/question" edge for the GREEN/SOUND
   * pipeline. Fires only on the 0 -> >=1 pending transition (mirrors the deleted
   * client hook's count-based edge), covering both permission and question requests.
   * Uses a per-session monotonic `at` independent of the turn-complete clock; the
   * client routes it under a distinct `#waiting` dedupe namespace.
   */
  private emitWaitingEdge(sessionId: string, state: SdkSessionState): void {
    const at = nextMonotonicTurnCompleteAt(state.lastWaitingAt, Date.now())
    state.lastWaitingAt = at
    this.broadcastToSession(sessionId, { type: 'sdk.turn.waiting', sessionId, at })
  }
```

- [ ] **Step 4: Fire the edge from `handlePermissionRequest`**

In `handlePermissionRequest` (`sdk-bridge.ts:508-549`), capture emptiness BEFORE the `.set`, and emit after the existing `sdk.permission.request` broadcast:

```ts
    const requestId = nanoid()
    const wasIdle = state.pendingPermissions.size === 0 && state.pendingQuestions.size === 0

    return new Promise((resolve) => {
      state.pendingPermissions.set(requestId, {
        // ...unchanged...
      })

      this.broadcastToSession(sessionId, {
        type: 'sdk.permission.request',
        // ...unchanged...
      })

      if (wasIdle) this.emitWaitingEdge(sessionId, state)
    })
```

- [ ] **Step 5: Fire the edge from `handleAskUserQuestion`**

In `handleAskUserQuestion` (`sdk-bridge.ts:551-607`), capture emptiness before the `.set` (place it right before `return new Promise(...)` at line ~593, after the `questions.length === 0` early-return at ~589-591) and emit after the existing `sdk.question.request` broadcast:

```ts
    const wasIdle = state.pendingPermissions.size === 0 && state.pendingQuestions.size === 0
    return new Promise((resolve) => {
      state.pendingQuestions.set(requestId, {
        // ...unchanged...
      })

      this.broadcastToSession(sessionId, {
        type: 'sdk.question.request',
        // ...unchanged...
      })

      if (wasIdle) this.emitWaitingEdge(sessionId, state)
    })
```

- [ ] **Step 6: Run to verify it passes**

Run: `npm run test:vitest -- run test/unit/server/sdk-bridge.test.ts --config config/vitest/vitest.server.config.ts`
Expected: PASS (new waiting tests green; existing permission/question/turn-complete tests still green).

- [ ] **Step 7: Refactor**

Confirm `wasIdle` is computed before any `.set` in both handlers and that no `await` sits between the read and the `.set` (it doesn't — both are synchronous up to the `new Promise`). Keep the helper DRY across both call sites.

- [ ] **Step 8: Commit**

```bash
git add server/sdk-bridge.ts test/unit/server/sdk-bridge.test.ts
git commit -m "feat(fresh-agent): emit server-authoritative sdk.turn.waiting on 0->1 pending edge"
```

### Task B3: Route `freshAgent.turn.waiting` on the client → `applyFreshAgentWaiting`

**Files:**
- Modify: `src/store/turnCompletionThunks.ts` (add `applyFreshAgentWaiting`)
- Modify: `src/lib/fresh-agent-ws.ts:233-247` (add the `freshAgent.turn.waiting` case)
- Test: `test/unit/client/lib/fresh-agent-turn-complete.test.ts` (add cases) or a new `test/unit/client/lib/fresh-agent-waiting.test.ts`

**Interfaces:**
- Consumes: `findFreshAgentPaneBySessionKey` (private in `turnCompletionThunks.ts`), `recordTurnComplete`.
- Produces: `applyFreshAgentWaiting({ provider, sessionId, at })` dispatching `recordTurnComplete` with `terminalId: ${provider}:${sessionId}#waiting`.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/client/lib/fresh-agent-turn-complete.test.ts`. **Use a CLAUDE pane fixture** — waiting is Claude/kilroy-only, and the file's default `makeStore()` builds an OPENCODE pane (provider mismatch would make `findFreshAgentPaneBySessionKey` no-op). Mirror the `claudeLeaf` fixture in that file's last test (`RUNTIME_ID` ≠ `DURABLE_ID`, lines ~115-156): the server keys the edge by the runtime handle, so the recorded `terminalId` is `claude:${RUNTIME_ID}#waiting`.

```ts
const RUNTIME_ID = 'claude-runtime-nanoid'
const DURABLE_ID = '11111111-2222-4333-8444-555555555555'
const claudeLeaf: PaneNode = {
  type: 'leaf',
  id: 'pane-claude',
  content: {
    kind: 'fresh-agent', createRequestId: 'cr-claude', sessionType: 'freshclaude',
    provider: 'claude', sessionId: RUNTIME_ID, sessionRef: { provider: 'claude', sessionId: DURABLE_ID },
  } as never,
}
function makeClaudeStore() {
  return configureStore({
    reducer: {
      panes: () => ({ layouts: { 'tab-claude': claudeLeaf }, activePane: {} }) as never,
      tabs: () => ({ activeTabId: 'tab-claude' }) as never,
      freshAgent: freshAgentReducer,
      turnCompletion: turnCompletionReducer,
    },
  })
}
function waitingMessage(at: number) {
  return {
    type: 'freshAgent.event', sessionId: RUNTIME_ID, sessionType: 'freshclaude', provider: 'claude',
    event: { type: 'freshAgent.turn.waiting', sessionId: RUNTIME_ID, at },
  }
}

it('routes freshAgent.turn.waiting to recordTurnComplete under the #waiting namespace (runtime-handle key)', () => {
  const store = makeClaudeStore()
  const handled = handleFreshAgentMessage(store.dispatch, waitingMessage(1000))
  expect(handled).toBe(true)
  const events = store.getState().turnCompletion.pendingEvents
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ tabId: 'tab-claude', paneId: 'pane-claude', terminalId: `claude:${RUNTIME_ID}#waiting`, at: 1000 })
})

it('a waiting edge does NOT suppress a later completion edge (separate dedupe namespace)', () => {
  const store = makeClaudeStore()
  handleFreshAgentMessage(store.dispatch, waitingMessage(5000))
  // A completion with a SMALLER at must still record (different terminalId bucket).
  handleFreshAgentMessage(store.dispatch, {
    type: 'freshAgent.event', sessionId: RUNTIME_ID, sessionType: 'freshclaude', provider: 'claude',
    event: { type: 'freshAgent.turn.complete', sessionId: RUNTIME_ID, at: 1000 },
  })
  const events = store.getState().turnCompletion.pendingEvents
  expect(events.map((e) => e.terminalId).sort())
    .toEqual([`claude:${RUNTIME_ID}`, `claude:${RUNTIME_ID}#waiting`].sort())
})

it('drops a malformed waiting edge without a numeric at', () => {
  const store = makeClaudeStore()
  handleFreshAgentMessage(store.dispatch, {
    type: 'freshAgent.event', sessionId: RUNTIME_ID, sessionType: 'freshclaude', provider: 'claude',
    event: { type: 'freshAgent.turn.waiting', sessionId: RUNTIME_ID },
  })
  expect(store.getState().turnCompletion.pendingEvents).toHaveLength(0)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/lib/fresh-agent-turn-complete.test.ts -t "waiting"`
Expected: FAIL — `freshAgent.turn.waiting` hits the `default` (returns `false`) and nothing is dispatched.

- [ ] **Step 3: Add the `applyFreshAgentWaiting` thunk**

In `src/store/turnCompletionThunks.ts`, after `applyFreshAgentCompletion` (line ~67), add:

```ts
export type ApplyFreshAgentWaitingPayload = {
  provider: string
  sessionId: string
  at: number
}

/**
 * Server-authoritative fresh-agent "waiting for approval/question" edge. Mirrors
 * applyFreshAgentCompletion but records under a distinct `#waiting` terminalId so the
 * approval attention can never poison (or be poisoned by) the turn-complete dedupe
 * bucket via the monotonic `at` guard. Only Claude/kilroy ever emit this today.
 *
 * Like the completion edge, the server buffers and replays this only to the FIRST
 * subscriber of a session (so a create-then-attach gap still greens once); a
 * reconnecting client gets NO replay and rehydrates pending state from the session
 * snapshot, which carries no waiting edge — so a still-pending approval does not
 * spuriously re-green on reconnect (matching the deleted hook's first-observation
 * suppression).
 */
export function applyFreshAgentWaiting(payload: ApplyFreshAgentWaitingPayload) {
  return (dispatch: AppDispatch, getState: () => RootState): void => {
    const state = getState()
    const sessionKey = `${payload.provider}:${payload.sessionId}`
    const location = findFreshAgentPaneBySessionKey(state, sessionKey)
    if (!location) return

    dispatch(recordTurnComplete({
      tabId: location.tabId,
      paneId: location.paneId,
      terminalId: `${sessionKey}#waiting`,
      at: payload.at,
    }))
  }
}
```

- [ ] **Step 4: Route the event in the transport switch**

In `src/lib/fresh-agent-ws.ts`, import the new thunk (extend the existing import from `@/store/turnCompletionThunks`):

```ts
import { applyFreshAgentCompletion, applyFreshAgentWaiting } from '@/store/turnCompletionThunks'
```

Add a case after `freshAgent.turn.complete` (line ~247), mirroring its malformed-`at` guard:

```ts
    case 'freshAgent.turn.waiting': {
      if (typeof event.at !== 'number' || !Number.isFinite(event.at)) {
        log.warn('dropping malformed freshAgent.turn.waiting without a numeric at', { sessionId, at: event.at })
        return true
      }
      dispatch(applyFreshAgentWaiting({
        provider: locator.provider,
        sessionId,
        at: event.at,
      }))
      return true
    }
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm run test:vitest -- run test/unit/client/lib/fresh-agent-turn-complete.test.ts`
Expected: PASS.

- [ ] **Step 6: Refactor**

`applyFreshAgentWaiting` and `applyFreshAgentCompletion` are near-identical save the `#waiting` suffix. Two short, well-documented functions read more clearly than one parameterized one here; keep both unless the duplication is more than the suffix. Confirm no lint errors (`npm run lint -- src/store/turnCompletionThunks.ts src/lib/fresh-agent-ws.ts`).

- [ ] **Step 7: Commit**

```bash
git add src/store/turnCompletionThunks.ts src/lib/fresh-agent-ws.ts test/unit/client/lib/fresh-agent-turn-complete.test.ts
git commit -m "feat(fresh-agent): route freshAgent.turn.waiting to applyFreshAgentWaiting"
```

### Task B4: Delete the client hook and its busy-derivation legacy

**Why:** With waiting now server-authoritative, `useAgentSessionTurnCompletion` has no remaining responsibility. Removing it eliminates the last client-side attention derivation.

**Files:**
- Delete: `src/hooks/useAgentSessionTurnCompletion.ts`
- Delete: `test/unit/client/hooks/useAgentSessionTurnCompletion.test.tsx`
- Modify: `src/App.tsx:41` (import) and `:159` (call site)

**Interfaces:**
- Removes: the `useAgentSessionTurnCompletion()` hook entirely. No other module imports it (verify with grep in Step 1).

- [ ] **Step 1: Verify no other consumers**

Run: `grep -rn "useAgentSessionTurnCompletion" src test`
Expected: only `src/hooks/useAgentSessionTurnCompletion.ts`, `src/App.tsx`, and `test/unit/client/hooks/useAgentSessionTurnCompletion.test.tsx`. If anything else references it, STOP and reassess.

- [ ] **Step 2: Remove the call site and import in `src/App.tsx`**

Delete the import line (`:41`) `import { useAgentSessionTurnCompletion } from '@/hooks/useAgentSessionTurnCompletion'` and the call (`:159`) `useAgentSessionTurnCompletion()`.

- [ ] **Step 3: Delete the hook and its test**

```bash
git rm src/hooks/useAgentSessionTurnCompletion.ts test/unit/client/hooks/useAgentSessionTurnCompletion.test.tsx
```

(The meaningful behaviors from that test — waiting fires green on the 0→1 edge, and the `#waiting` namespace isolation — are now covered server-side in `sdk-bridge.test.ts` and client-side in `fresh-agent-turn-complete.test.ts` from Tasks B2/B3.)

- [ ] **Step 4: Typecheck (client) + targeted client suite**

MANDATORY: use the CLIENT typecheck — `npm run build:server` only runs `tsc -p tsconfig.server.json` and will NOT catch a dangling React-hook import in `src/App.tsx`.
Run: `npm run typecheck:client` (= `tsc -p tsconfig.json --noEmit`) and `npm run test:vitest -- run test/unit/client/`
Expected: typecheck clean (no dangling import — this is the step that proves the deletion is complete), client unit suite green.

- [ ] **Step 5: Commit (exact paths only — multi-agent worktree, no `git add -A`)**

The two deletions were already staged by `git rm` in Step 3; stage only the App.tsx edit:

```bash
git add src/App.tsx
git commit -m "refactor(fresh-agent): delete useAgentSessionTurnCompletion (waiting now server-authoritative)"
```

### Task B5: e2e — server-pushed waiting edge chimes once and sets attention

**Why:** Prove the full chain end-to-end (the user's quality bar prioritizes e2e/integration). NOTE (validated): there is NOTHING to migrate — no e2e ever drove waiting-green via the deleted hook (the pane-activity e2e permission tests assert BLUE, not green). This task is ADD-only.

**Files:**
- Add: a Claude-pane test in `test/e2e/fresh-agent-turn-complete-notification.test.tsx` for the waiting edge.

**Real harness names (validated, NOT placeholders):** chime mock is `playSound` (`vi.hoisted` + `vi.mock('@/hooks/useNotificationSound', ...)`); WS injection is `wsMocks.emitMessage(msg)`; the existing `createStore()` builds an OPENCODE `agentLeaf` on `tab-2`/`pane-2`. The waiting test needs a CLAUDE pane (waiting is Claude-only).

**Interfaces:**
- Drives a `freshAgent.event` with `event.type === 'freshAgent.turn.waiting'` via `wsMocks.emitMessage` (server-authoritative) — adding a permission alone no longer greens (by design).

- [ ] **Step 1: Add a Claude pane fixture + a `turnWaiting` emitter**

In the e2e file, add a Claude `agentLeaf` analog to the store (model the existing opencode leaf at ~lines 81-96: `sessionType: 'freshclaude'`, `provider: 'claude'`, a runtime `sessionId`, on a non-active tab so a chime both fires and highlights). Add a helper modeled on the existing `turnComplete(at)` (~lines 49-57):

```ts
function turnWaiting(at: number) {
  wsMocks.emitMessage({
    type: 'freshAgent.event', sessionId: CLAUDE_SESSION_ID, sessionType: 'freshclaude', provider: 'claude',
    event: { type: 'freshAgent.turn.waiting', sessionId: CLAUDE_SESSION_ID, at },
  })
}
```

- [ ] **Step 2: Write the e2e acceptance test (passes after B1–B4; not RED-first)**

```ts
it('greens + chimes exactly once when the server pushes freshAgent.turn.waiting', async () => {
  // (render <Provider store={store}><Harness /></Provider> as the completion test does)
  turnWaiting(1000)
  await waitFor(() => {
    expect(store.getState().turnCompletion.attentionByPane[CLAUDE_PANE]).toBe(true)
    expect(store.getState().turnCompletion.attentionByTab[CLAUDE_TAB]).toBe(true)
  })
  expect(playSound).toHaveBeenCalledTimes(1)

  // A replayed/same-at waiting edge must NOT re-chime (at-monotonic #waiting dedupe).
  turnWaiting(1000)
  expect(playSound).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 3: Run the e2e — it PASSES (this is the end-to-end acceptance guard, not a RED-first unit)**

This task runs AFTER B1–B4, so the full chain is wired and the e2e PASSES on first run. That is intentional: the RED→GREEN discipline for the waiting feature already happened at the UNIT level — B3's `fresh-agent-turn-complete.test.ts` router test genuinely fails before the `freshAgent.turn.waiting` case/thunk exist and passes after. B5 is the integration test that proves the WS→reducer→notification chain end-to-end; it adds no production code, so it is not itself a RED-first cycle.

Run: `npm run test:vitest -- run test/e2e/fresh-agent-turn-complete-notification.test.tsx -t "freshAgent.turn.waiting"`
Expected: PASS.

Optional dependence check (executable, not a contrived edit): to confirm the e2e genuinely exercises the new wiring, run it against the pre-feature client router — `git stash` is not appropriate here (committed work); instead trust the B3 unit RED as the dependence proof. Do NOT add a temporary stub as a "step".

- [ ] **Step 4: Run the full file (regression)**

Run: `npm run test:vitest -- run test/e2e/fresh-agent-turn-complete-notification.test.tsx`
Expected: PASS (existing opencode completion tests unaffected by the added Claude pane/test).

- [ ] **Step 5: Commit (exact path only — multi-agent worktree, no `git add -A`)**

```bash
git add test/e2e/fresh-agent-turn-complete-notification.test.tsx
git commit -m "test(fresh-agent): e2e for server-pushed waiting edge (chimes once, sets attention)"
```

### Task B6: Update the architecture note

**Files:**
- Modify: `AGENTS.md` — the "Agent Status Indicators" paragraph.

- [ ] **Step 1: Update the note**

In `AGENTS.md`, update the Agent Status Indicators paragraph to state that the waiting-for-approval edge is now also server-authoritative via a discrete `freshAgent.turn.waiting` event (emitted by the Claude/kilroy `SdkBridge` on the 0→≥1 pending permission/question transition, routed via `applyFreshAgentWaiting` under the `#waiting` dedupe namespace), that `useAgentSessionTurnCompletion` has been DELETED, and that freshcodex now self-heals a crashed/disconnected sidecar to `exited` via the runtime `onExit` hook (clearing BLUE, no chime).

- [ ] **Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "docs: update agent-status note for server-authoritative waiting + codex onExit self-heal"
```

---

## Deliberately out of scope (further follow-ups)

These were NOT part of the two suggested next steps and are intentionally excluded to preserve scope:
- A codex turn-activity deadman/timeout for a *wedged-but-alive* sidecar (different failure mode than a crash; `onExit` covers the crash/disconnect case fully).
- snapshot status-clobber / provider-agnostic `statusSeq` for BLUE correctness on reconnect.
- Centralizing GREEN/BLUE render precedence across TabItem / PaneHeader / Sidebar.

---

## Load-bearing assumptions — VALIDATED (load-bearing skill, 2026-06-23)

All assumptions were validated by parallel read-only validators against the worktree. Verdicts:

1. **CONFIRMED** — The codex runtime's `onExit` fires on BOTH sidecar process exit (`app_server_exit`) and client disconnect (`app_server_client_disconnect`), gated on `!shutdownRequested`. A false self-heal on a graceful `shutdown()` is NOT reachable: independent of the flag, the child `'exit'` handler short-circuits on `this.child !== child` (runtime.ts:1213-1217), and `stopActiveChild` synchronously nulls `this.child` before the async kill — so a late exit event after the `finally` reset never reaches the `exitHandlers` loop. [runtime.ts:859-864, 1047-1052, 1213-1254, 905-934]
2. **CONFIRMED (code-proven)** — `{ type: 'sdk.status', status: 'exited' }` clears BLUE (`isFreshAgentBusy` true only for `running`/`compacting`/`streamingActive`; `setSessionStatus('exited')` clears `streamingActive`) and never routes to `recordTurnComplete`, so no chime. [src/lib/pane-activity.ts:48-67, src/store/freshAgentSlice.ts:393-402]
3. **CORRECTED (my original claim was FALSIFIED)** — `broadcastToSession` buffers and replays edges ONLY to the very FIRST subscriber ever (`hasSubscribers` is a one-way latch; once any client attaches the buffer is drained and bypassed). A RECONNECTING client gets NO replay — it rehydrates pending approvals from the `freshAgent.session.snapshot` (`pendingApprovals`), which carries NO waiting edge. Therefore a still-pending approval does **NOT** re-green on reconnect. This MATCHES the deleted hook's first-observation suppression (the desired behavior). The waiting edge IS buffered exactly like `sdk.turn.complete`, so a create-then-attach gap (permission lands before the first subscriber) correctly greens once on first attach. [sdk-bridge.ts:223, 683-705, 803-812; snapshot in adapters/claude/normalize.ts:186-244]
4. **CONFIRMED (code-proven)** — `recordTurnComplete` dedupes strictly by `terminalId` (`lastAtByTerminalId`), and `resetCompletionDedupeBaselines` wipes it wholesale, so `${sessionKey}#waiting` is a fully independent bucket from `${sessionKey}` across restart. [src/store/turnCompletionSlice.ts:96-112]
5. **CONFIRMED** — codex/opencode declare `approvals:false, questions:false` AND have zero permission/question emit paths (opencode serve-events maps only to snapshot/changed/error; codex/opencode never populate pending arrays), so the `SdkBridge`-only emit loses no provider coverage. `SdkBridge` is the SAME instance behind both `freshclaude` and `kilroy` (kilroy is a session-type alias routed through the claude adapter). Deleting the hook costs codex/opencode nothing — they never reached its 0→≥1 trigger. [adapters/codex/normalize.ts:767-768, adapters/opencode/normalize.ts:385-386, adapters/opencode/serve-events.ts:62-102, index.ts:315-346]
6. **CONFIRMED (code-proven)** — `useAgentSessionTurnCompletion` is imported only by `src/App.tsx` (:41/:159) and its own test; no e2e renders it. [grep]

### Behavioral delta to accept (validated benign)

Deleting the hook is a behavioral *substitution*, not strict equivalence, on ONE path: a RESUMED Claude session whose SDK RE-RAISES a permission produces a fresh server-side 0→1 edge and now greens, where the old hook suppressed it as a first observation. This is benign / arguably MORE correct (a re-raised approval genuinely needs attention). Pure snapshot hydration of an already-pending session does NOT fire (snapshot carries no waiting edge — assumption #3), so the spurious-green case the hook guarded against remains guarded. Freshell never reconstructs `pendingPermissions` from durable history (`createSession` always inits `new Map()`), so the only way pending becomes non-empty post-resume is a genuine new `canUseTool` edge. [sdk-bridge.ts:178; validated]

### Validation-surfaced implementation notes (folded into the tasks above)

- `onExit` returns a per-handler unsubscribe → the `offExit()` MUST be added to the `subscribe` teardown closure (done in Task A1 Step 4).
- The `sdk-bridge.test.ts` waiting test MUST DRIVE the real permission flow via `mockCanUseTool(...)` (the `canUseTool branching` describe), NOT inject `state.pendingPermissions.set(...)` directly (the `permission round-trip` describe) — the latter bypasses `handlePermissionRequest` and would be a FALSE GREEN (Task B2 Step 1).
- The client + e2e harnesses default to an OPENCODE pane; the waiting tests need a CLAUDE fixture (waiting is Claude-only). Real helper names: `playSound` (chime), `wsMocks.emitMessage` (WS inject) — NOT `playMock`/`pushFreshAgentEvent` (Tasks B3/B5).
- There is NOTHING to migrate: no e2e ever drove waiting-green via the hook; the pane-activity e2e permission tests assert BLUE, not green. Task B5 is ADD-only.

---

## Self-Review

- **Spec coverage:** (A) onExit self-heal → Task A1. (B) server-authoritative waiting → Tasks B1 (type) + B2 (emit) + B3 (route) + B5 (e2e); delete the hook → Task B4; docs → Task B6. Both suggested next steps covered.
- **Placeholder scan:** Test helpers in B2/B3/B5 are explicitly flagged as bindings to the EXISTING harness in each file (not new scaffolding) — the implementer must wire them to the real helpers, not invent them. All production code steps show exact code.
- **Type consistency:** `sdk.turn.waiting` ⇄ `freshAgent.turn.waiting`, `applyFreshAgentWaiting`, `lastWaitingAt`, `${sessionKey}#waiting` used consistently across B1–B4. `emitWaitingEdge(sessionId, state)` signature consistent between B2 definition and call sites.
- **Ordering:** B1 → B2 (server) and B1 → B3 (client) independent; B4 (delete hook) only AFTER B2+B3 so attention is never lost; B5 e2e after B4; A1 fully independent.
