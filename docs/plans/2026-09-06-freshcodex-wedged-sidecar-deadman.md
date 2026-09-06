# Freshcodex Wedged-Sidecar Deadman Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result

A wedged-but-alive codex app-server sidecar (process running, no events, no exit)
must no longer leave a freshcodex fresh-agent pane asserting "working" forever.
After a bounded quiet window with a turn in flight, the pane stops asserting
busy, shows a visible "agent appears stuck" state, and offers recovery (restart
sidecar / resume). Recovery returns the pane to a truthful status (idle with
history intact, or a clear failure). The bound is deliberate and is observable
in logs either way (armed / fired / resolved).

### Explicit constraints

- A seeded wedged-sidecar scenario (e2e on the Rust lane; unit on the Node lane)
  ends in a visible stuck state plus an offered recovery, not an eternal spinner.
- Normal long turns within the bound are unaffected; the bound is covered by
  tests, including boundary (bound − 1 / bound + 1) cases.
- The deadman must never fabricate a turn completion: no
  `sdk.turn.complete` / `freshAgent.turn.complete` edge, no green/needs-attention
  chime from a deadman fire (repo policy for stuck-recovery paths).
- Fire/arm/resolve are observable in structured logs.
- Recovery reuses the existing kill/restart/resume machinery; durable thread
  history survives whenever the provider still holds it.

### Accepted tradeoffs and residuals

- "Alive but silent" cannot be distinguished from a legitimately quiet long
  turn (e.g. a silent 10-minute test run); a false positive produces only a
  dismissible notice, never kills or interrupts the turn, and self-clears when
  events resume.
- Dual-lane coverage is asymmetric by proof depth: e2e seeding runs on the
  Rust lane (the repo's freshcodex fresh-agent e2e specs are Rust-pinned); the
  Node lane is proven at unit level.
- A sidecar wedged before emitting any event is detected from send/attach-time
  arming only; a thread restored mid-turn with zero subsequent events is armed
  from snapshot observation (empty→running re-seed: Node `findActiveTurnId`
  (:273-285); Rust `get_snapshot` seed, Task 3 §3c), never from later snapshot
  polls.
- All file:line anchors were verified against the run's base commit
  `398a866f527909e37e68c46424a5d3a77951cf60`; `origin/main` has since drifted
  the Rust lane heavily, so landing reconciliation re-verifies anchors by
  symbol name.

**Goal:** A freshcodex pane whose app-server sidecar is alive but silent shows
"agent appears stuck" after a bounded quiet window, stops claiming to be
working, and offers a one-click sidecar restart + resume — in both server lanes
(Node parity lane and production Rust lane) with one shared client surface.

**Architecture:** Server-side per-thread quiet-window deadmen in both
freshcodex fresh-agent adapters. The Node adapter
(`server/fresh-agent/adapters/codex/adapter.ts`) and the Rust
`FreshCodexState` (`crates/freshell-freshagent/src/codex.rs`) each track a
resettable per-thread deadline: armed when a turn goes in flight, reset by
every lane-visible event for that thread, disarmed on turn end/exit/kill. On
expiry the lane sets a new shared `stuck` session status, emits it as a
`freshAgent.status` WS event (never a turn-complete), holds it in snapshot
truth (REST included), and logs `fresh_agent_stuck_deadman` /
`freshagent.codex.quiet_deadman` structured events. The client gains `'stuck'`
in its status union, stops deriving busy for it, and renders a dismissible
notice card whose actions reuse the existing kill + resume recovery machinery.

**Tech Stack:** TypeScript/Node adapter + Express/ws server, React/Redux
client (Vitest, Testing Library), Rust tokio lane (tracing, in-crate
`#[tokio::test]` with scripted `ChannelPeer` fakes), Playwright e2e
(`rust-chromium` project; `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`
behavior-driven fake).

## Global Constraints

- Anchors are pinned to base commit `398a866f527909e37e68c46424a5d3a77951cf60`.
  The full-QA gate is `darkforge qa --repo '/home/dan/code/freshell' --id
  'r47n'`; acceptance honors the baseline ledger by identity (the three
  `test/unit/vite-config.test.ts > getNetworkHost` failures are pre-existing
  and must not be "fixed").
- Never fabricate a completion. Deadman expiry must not emit
  `sdk.turn.complete` / `freshAgent.turn.complete` and must not ring the
  idle/green signal. Precedents: `server/coding-cli/amplifier-activity-tracker.ts`
  ("The deadman never fabricates a completion", :99-101),
  `server/coding-cli/claude-activity-tracker.ts` :60-61,
  `test/unit/server/coding-cli/truly-idle-emitter.test.ts:196-209` (deadman idle
  flips never ring the bell).
- Observability: Node events go through `recordFreshAgentObservabilityEvent`
  (`server/fresh-agent/observability.ts`), with identities hashed via
  `hashForLogs` (`server/fresh-agent/log-hash.ts`); `fired` is warn-level,
  `armed`/`resolved` info-level (extend `isWarnEvent`, observability.ts:148-158).
  Rust logs via `tracing::info!/warn!` with the event name
  `freshagent.codex.quiet_deadman` and the lane's existing hashed-id fields.
- Quiet-window bound: default 600_000 ms (mirrors freshopencode
  `DEFAULT_TURN_TIMEOUT_MS`, `server/fresh-agent/adapters/opencode/adapter.ts:46`
  and `crates/freshell-freshagent/src/opencode_ws.rs` — a turn-scale bound, not
  the 120 s terminal-lane deadman, because a healthy fresh-agent turn has no
  per-second activity requirement). Overridable via the
  `FRESHELL_FRESHCODEX_QUIET_WINDOW_MS` env var (positive integer ms; missing or
  unparseable falls back to the default) on both lanes; tests inject scaled
  bounds (adapter factory dep / `#[cfg(test)]` setter).
- Feed rule: only lane-visible push notifications feed the quiet window.
  Request/response RPC traffic (including the client's busy snapshot polling)
  must never reset it — the client's 3 s busy-poll
  (`FreshAgentView.tsx:2293-2303`) would otherwise starve the deadman forever.
- Node lane: NodeNext/ESM — relative imports include `.js` extensions.
- Client: the notice is WCAG-compliant (semantic `<button>`s, `role="alert"`,
  labeled actions); `npm run lint` (eslint-plugin-jsx-a11y) stays clean.
- Every new test must fail for the intended reason first (TDD red) and must
  fail if the deadman code is reverted; no static-copy or prose-matching tests.
- Do not modify: terminal-mode activity trackers/lanes, the opencode lane, the
  fake fixture's default behavior, `docs/index.html` unless Task 2's explicit
  criterion triggers, or anything outside the listed task files.
- Keep both lanes' wire behavior byte-identical for the client: the event
  shape `{ type: 'freshAgent.status', sessionId, status: 'stuck' }` and the
  REST snapshot `status: 'stuck'` overlay are produced by both servers.
- Rust plumbing (validator-established): the sessions map is a tokio Mutex
  (codex.rs:109) and must never be held across an await; `reduce_notification`
  (:3922) is sync. Deadman state therefore lives in a per-session
  `Arc<std::sync::Mutex<QuietDeadman>>` (the `active_turn` :207 field pattern),
  threaded by parameter into the consumer/watchers; no new workspace
  dependencies, and no `tokio::time::pause` (unused in this crate).

---

### Task 1: Node freshcodex adapter quiet-window deadman + `'stuck'` wire status

**Files:**
- Create: none.
- Modify: `server/fresh-agent/adapters/codex/adapter.ts` (port :49-83, factory deps :286-, subscribe :876-953, send :955-1002, compact :1040-1060, getSnapshot :1082-1125, kill :1214-1220, shutdown :1222-1238)
- Modify: `shared/ws-protocol.ts:1109` (`SdkSessionStatus` union)
- Modify: `server/sdk-bridge-types.ts:44` (status union mirror)
- Modify: `server/fresh-agent/observability.ts` (event union :10-127; `isWarnEvent` :148-158)
- Test: `test/unit/server/fresh-agent/codex-adapter.test.ts`

**Interfaces:**
- Consumes: existing `CodexRuntimePort` (adapter.ts:49-83), `recordFreshAgentObservabilityEvent`, `hashForLogs`, `normalizeCodexThreadStatus` (:246-254), `makeCodexStatusEvent` (:256-265), `activeTurnByThread` (:295), `findActiveTurnId(rawSnapshot)` re-seed (:1099-1104), `__setFreshAgentObservabilitySinkForTest` for tests.
- Produces:
  - `export const DEFAULT_FRESHCODEX_QUIET_WINDOW_MS = 600_000`
  - `CreateCodexFreshAgentAdapterDeps.quietWindowMs?: number` (new optional factory dep; absent → env var → default; the `server/index.ts:369-372` wiring passes nothing new)
  - `CodexRuntimePort.onTurnStarted?: (listener: (event: { threadId: string; turnId?: string }) => void) => () => void` (new optional hook; `CodexAppServerRuntime` already exposes `onTurnStarted` at `server/coding-cli/codex-app-server/runtime.ts:1665`)
  - `'stuck'` in `SdkSessionStatus` / sdk-bridge mirror
  - observability event kind `fresh_agent_stuck_deadman` with `phase: 'armed' | 'fired' | 'resolved'`, `resolution?: 'activity' | 'exit' | 'thread_closed' | 'kill' | 'shutdown'`, `quietWindowMs: number`, hashed ids
  - wire: `{ type: 'sdk.status', sessionId, status: 'stuck' }` (normalizes to `freshAgent.status` via the existing `normalizeFreshAgentProviderEvent` passthrough)
  - `getSnapshot` reports `status: 'stuck'` while the thread is flagged stuck

- [ ] **Step 1: Write the failing behavioral test**

Add the following `describe` block to `test/unit/server/fresh-agent/codex-adapter.test.ts`
(new describe near the existing self-heal tests; top-of-file imports gain
`__setFreshAgentObservabilitySinkForTest` and `hashForLogs` from
`../../../../server/fresh-agent/observability.js`):

```ts
describe('wedged-sidecar deadman (quiet window)', () => {
  const QUIET_MS = 1_000

  function makeDeadmanStubRuntime(
    threadStatus: unknown = { type: 'idle' },
    options: { inProgressTurnId?: string } = {},
  ) {
    const handlers: {
      lifecycle?: (event: any) => void
      turnStarted?: (event: any) => void
      turnCompleted?: (event: any) => void
      exit?: () => void
    } = {}
    const thread = { ...makeCodexThread('thread-1'), status: threadStatus }
    const inProgressTurn = options.inProgressTurnId
      ? [{ ...makeCodexTurn(options.inProgressTurnId), status: 'inProgress' }]
      : []
    const runtime = {
      startThread: vi.fn(),
      resumeThread: vi.fn(),
      startTurn: vi.fn().mockResolvedValue({ turnId: 'turn-1' }),
      interruptTurn: vi.fn(),
      onThreadLifecycle: vi.fn((handler: any) => { handlers.lifecycle = handler; return vi.fn() }),
      onTurnStarted: vi.fn((handler: any) => { handlers.turnStarted = handler; return vi.fn() }),
      onTurnCompleted: vi.fn((handler: any) => { handlers.turnCompleted = handler; return vi.fn() }),
      onExit: vi.fn((handler: any) => { handlers.exit = handler; return vi.fn() }),
      readThread: vi.fn().mockResolvedValue({ thread: { ...thread, turns: inProgressTurn } }),
      listThreadTurns: vi.fn().mockResolvedValue({ turns: [], nextCursor: null, revision: 7 }),
      readThreadTurn: vi.fn().mockResolvedValue(null),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }
    return { runtime, handlers }
  }

  async function subscribeAndSend(adapter: ReturnType<typeof createCodexFreshAgentAdapter>) {
    const listener = vi.fn()
    await adapter.subscribe?.('thread-1', listener)
    await adapter.send('thread-1', { requestId: 'req-1', text: 'hello' } as any)
    return listener
  }

  it('emits a stuck status after the quiet window elapses with a turn in flight (and never a turn-complete edge)', async () => {
    vi.useFakeTimers()
    try {
      const { runtime } = makeDeadmanStubRuntime()
      const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any, quietWindowMs: QUIET_MS } as any)
      const listener = await subscribeAndSend(adapter)
      await vi.advanceTimersByTimeAsync(QUIET_MS - 1)
      expect(listener).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'stuck' }))
      await vi.advanceTimersByTimeAsync(2)
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith({ type: 'sdk.status', sessionId: 'thread-1', status: 'stuck' })
      expect(listener).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'sdk.turn.complete' }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not fire for turns completing before the quiet window (normal long turns within bound unaffected)', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, handlers } = makeDeadmanStubRuntime()
      const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any, quietWindowMs: QUIET_MS } as any)
      const listener = await subscribeAndSend(adapter)
      await vi.advanceTimersByTimeAsync(Math.floor(QUIET_MS / 2))
      handlers.turnCompleted?.({ threadId: 'thread-1', params: { turn: { status: 'completed' } } })
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'sdk.session.snapshot', status: 'idle' }))
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: 'sdk.turn.complete' }))
      await vi.advanceTimersByTimeAsync(QUIET_MS * 3)
      expect(listener).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'stuck' }))
      expect(listener).toHaveBeenCalledTimes(2) // idle snapshot + one turn-complete; nothing after
    } finally {
      vi.useRealTimers()
    }
  })

  it('resets the quiet window on lifecycle and turn/started events', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, handlers } = makeDeadmanStubRuntime()
      const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any, quietWindowMs: QUIET_MS } as any)
      const listener = await subscribeAndSend(adapter)
      await vi.advanceTimersByTimeAsync(QUIET_MS - 100)
      handlers.lifecycle?.({ kind: 'thread_status_changed', threadId: 'thread-1', status: { type: 'active', activeFlags: [] } })
      await vi.advanceTimersByTimeAsync(QUIET_MS - 100)
      handlers.turnStarted?.({ threadId: 'thread-1', turnId: 'turn-1' })
      await vi.advanceTimersByTimeAsync(QUIET_MS - 1)
      expect(listener).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'stuck' }))
      await vi.advanceTimersByTimeAsync(2)
      expect(listener).toHaveBeenCalledWith({ type: 'sdk.status', sessionId: 'thread-1', status: 'stuck' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('disarms on sidecar exit without emitting stuck', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, handlers } = makeDeadmanStubRuntime()
      const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any, quietWindowMs: QUIET_MS } as any)
      const listener = await subscribeAndSend(adapter)
      await vi.advanceTimersByTimeAsync(QUIET_MS - 100)
      handlers.exit?.()
      expect(listener).toHaveBeenCalledWith({ type: 'sdk.status', sessionId: 'thread-1', status: 'exited' })
      await vi.advanceTimersByTimeAsync(QUIET_MS * 3)
      expect(listener).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'stuck' }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports stuck through REST snapshots until events resume (resolution clears the flag)', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, handlers } = makeDeadmanStubRuntime({ type: 'active', activeFlags: [] })
      const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any, quietWindowMs: QUIET_MS } as any)
      const listener = await subscribeAndSend(adapter)
      await vi.advanceTimersByTimeAsync(QUIET_MS + 1)
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: 'stuck' }))
      const stuckNow: any = await adapter.getSnapshot?.({ sessionType: 'freshcodex', provider: 'codex', threadId: 'thread-1' } as any, 7)
      expect(stuckNow.status).toBe('stuck')
      handlers.turnCompleted?.({ threadId: 'thread-1', params: { turn: { status: 'completed' } } })
      // the provider truth moves to idle after the completion commits:
      runtime.readThread.mockResolvedValue({ thread: { ...makeCodexThread('thread-1'), status: { type: 'idle' }, turns: [] } })
      const resolvedNow: any = await adapter.getSnapshot?.({ sessionType: 'freshcodex', provider: 'codex', threadId: 'thread-1' } as any, 8)
      expect(resolvedNow.status).toBe('idle')
    } finally {
      vi.useRealTimers()
    }
  })

  it('arms a snapshot-observed running thread once and is not starved by snapshot polls', async () => {
    vi.useFakeTimers()
    try {
      const { runtime } = makeDeadmanStubRuntime({ type: 'active', activeFlags: ['turn-1'] }, { inProgressTurnId: 'turn-1' })
      const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any, quietWindowMs: QUIET_MS } as any)
      const listener = vi.fn()
      await adapter.subscribe?.('thread-1', listener)
      // attach-mid-turn: snapshot re-seeds the in-flight turn and arms the deadman
      await adapter.getSnapshot?.({ sessionType: 'freshcodex', provider: 'codex', threadId: 'thread-1' } as any, 7)
      await vi.advanceTimersByTimeAsync(QUIET_MS - 50)
      // a later snapshot poll must NOT reset the window
      await adapter.getSnapshot?.({ sessionType: 'freshcodex', provider: 'codex', threadId: 'thread-1' } as any, 8)
      await vi.advanceTimersByTimeAsync(60)
      expect(listener).toHaveBeenCalledWith({ type: 'sdk.status', sessionId: 'thread-1', status: 'stuck' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('logs fresh_agent_stuck_deadman armed/fired/resolved with hashed ids (fired at warn)', async () => {
    vi.useFakeTimers()
    const infoSpy = vi.fn()
    const warnSpy = vi.fn()
    __setFreshAgentObservabilitySinkForTest({ info: infoSpy, warn: warnSpy })
    try {
      const { runtime, handlers } = makeDeadmanStubRuntime()
      const adapter = createCodexFreshAgentAdapter({ runtime: runtime as any, quietWindowMs: QUIET_MS } as any)
      const listener = await subscribeAndSend(adapter)
      await vi.advanceTimersByTimeAsync(QUIET_MS + 1)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      const [payload] = warnSpy.mock.calls[0]
      expect(payload).toMatchObject({
        event: 'fresh_agent_stuck_deadman',
        component: 'fresh-agent-observability',
        provider: 'codex',
        phase: 'fired',
        sessionIdHash: hashForLogs('thread-1'),
        quietWindowMs: QUIET_MS,
      })
      expect(JSON.stringify(payload)).not.toContain('thread-1')
      handlers.turnCompleted?.({ threadId: 'thread-1', params: { turn: { status: 'completed' } } })
      const phases = infoSpy.mock.calls.map(([p]) => (p as any).phase)
      expect(phases).toContain('armed')
      expect(phases).toContain('resolved')
      void listener
    } finally {
      __setFreshAgentObservabilitySinkForTest({ info: () => {}, warn: () => {} })
      vi.useRealTimers()
    }
  })
})
```

Test-file conventions the block above relies on (verified in-file): the file's
local `createCodexFreshAgentAdapter` wrapper injects `displayIdSecret:
DISPLAY_SECRET` (lines 14-19 — the factory hard-throws without a non-empty
secret); `makeCodexThread(id)` returns a thread with `status: { type: 'idle'
}`; `findActiveTurnId(rawSnapshot)` (adapter.ts:273-285) finds the in-flight
turn by scanning `thread.turns` for `status: 'inProgress'` — hence the
`inProgressTurnId` option on the stub.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/server/fresh-agent/codex-adapter.test.ts`

Expected: FAIL — the 7 new deadman tests fail because `quietWindowMs` is an
unknown dep and no `sdk.status` `'stuck'` event, no `onTurnStarted`
subscription, and no `fresh_agent_stuck_deadman` observability events exist
yet. (Existing tests in the file must stay green; if the type-only additions
land first as scaffolding, the new tests must still fail at the runtime
assertions.)

- [ ] **Step 3: Add the minimal production implementation**

3a. `shared/ws-protocol.ts:1109` and `server/sdk-bridge-types.ts:44`: add
`'stuck'` to the `SdkSessionStatus` union (and mirror).

```ts
export type SdkSessionStatus =
  | 'creating' | 'starting' | 'connected' | 'running' | 'idle' | 'compacting' | 'exited'
  | 'stuck'
```

3b. `server/fresh-agent/observability.ts`: add the event-kind union member (in
the `FreshAgentObservabilityEvent` union, :10-127) and route its warn level in
`isWarnEvent` (:148-158):

```ts
// union member
| {
    kind: 'fresh_agent_stuck_deadman'
    provider: 'codex'
    sessionIdHash: string
    threadIdHash?: string
    phase: 'armed' | 'fired' | 'resolved'
    resolution?: 'activity' | 'turn_complete' | 'exit' | 'thread_closed' | 'kill' | 'shutdown'
    quietWindowMs: number
  }
```

```ts
// in isWarnEvent, alongside the fresh_agent_monitor rule:
if (event.kind === 'fresh_agent_stuck_deadman') return event.phase === 'fired'
```

3c. `server/fresh-agent/adapters/codex/adapter.ts`:

- Extend the factory deps type (:286-296), add the default + env resolution,
  and the port hook (:49-83):

```ts
export const DEFAULT_FRESHCODEX_QUIET_WINDOW_MS = 600_000

function resolveQuietWindowMs(explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) return explicit
  const raw = process.env.FRESHELL_FRESHCODEX_QUIET_WINDOW_MS
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FRESHCODEX_QUIET_WINDOW_MS
}
```

```ts
// CodexRuntimePort gains (optional; freshcodex runtime provides it):
onTurnStarted?: (listener: (event: { threadId: string; turnId?: string }) => void) => () => void
```

- New closure state (next to `activeTurnByThread`, :295):

```ts
const quietWindowMs = resolveQuietWindowMs(deps.quietWindowMs)
const quietTimerByThread = new Map<string, NodeJS.Timeout>()
const stuckSinceByThread = new Map<string, number>()
const deadmanListenersByThread = new Map<string, Set<(event: any) => void>>()
```

- New closure helpers (import `recordFreshAgentObservabilityEvent` from
  `../observability.js` and `hashForLogs` from `../log-hash.js`):

```ts
const logDeadman = (
  sessionId: string,
  phase: 'armed' | 'fired' | 'resolved',
  resolution?: 'activity' | 'turn_complete' | 'exit' | 'thread_closed' | 'kill' | 'shutdown',
) => {
  recordFreshAgentObservabilityEvent({
    kind: 'fresh_agent_stuck_deadman',
    provider: 'codex',
    sessionIdHash: hashForLogs(sessionId),
    phase,
    resolution,
    quietWindowMs,
  })
}

const fireQuietWindow = (sessionId: string) => {
  quietTimerByThread.delete(sessionId)
  if (!activeTurnByThread.has(sessionId)) return
  if (stuckSinceByThread.has(sessionId)) return
  stuckSinceByThread.set(sessionId, Date.now())
  logDeadman(sessionId, 'fired')
  const listeners = deadmanListenersByThread.get(sessionId)
  if (!listeners) return
  for (const listener of listeners) {
    listener({ type: 'sdk.status', sessionId, status: 'stuck' })
  }
}

/** Reset semantics: genuine push activity restarts the window. */
const feedQuietWindow = (sessionId: string) => {
  const existing = quietTimerByThread.get(sessionId)
  if (existing) clearTimeout(existing)
  if (stuckSinceByThread.has(sessionId)) {
    stuckSinceByThread.delete(sessionId)
    logDeadman(sessionId, 'resolved', 'activity')
  }
  if (!activeTurnByThread.has(sessionId)) {
    quietTimerByThread.delete(sessionId)
    return
  }
  if (!existing) logDeadman(sessionId, 'armed')
  const timer = setTimeout(() => fireQuietWindow(sessionId), quietWindowMs)
  timer.unref?.()
  quietTimerByThread.set(sessionId, timer)
}

/** Arm-if-absent semantics: snapshot observation never starves the deadman. */
const armQuietWindowIfAbsent = (sessionId: string) => {
  if (quietTimerByThread.has(sessionId)) return
  if (!activeTurnByThread.has(sessionId)) return
  feedQuietWindow(sessionId)
}

const disarmQuietWindow = (
  sessionId: string,
  reason: 'turn_complete' | 'exit' | 'thread_closed' | 'kill' | 'shutdown',
) => {
  const timer = quietTimerByThread.get(sessionId)
  if (timer) clearTimeout(timer)
  quietTimerByThread.delete(sessionId)
  if (stuckSinceByThread.delete(sessionId)) {
    logDeadman(sessionId, 'resolved', reason)
  }
}
```

- Wire the helpers:

  - `send()` (:955-1002): after `activeTurnByThread.set(sessionId, turn.turnId)`
    add `feedQuietWindow(sessionId)` (a fresh turn resets the window).
  - `compact()` (:1040-1060): after its `activeTurnByThread.set(...)` add
    `feedQuietWindow(sessionId)`.
  - `subscribe()` (:876-953):
    - at the top (after `ensureRuntime`): add the client to the fan-out set and
      arm if a turn is already in flight:
      ```ts
      const deadmanListeners = deadmanListenersByThread.get(sessionId) ?? new Set()
      deadmanListeners.add(listener)
      deadmanListenersByThread.set(sessionId, deadmanListeners)
      const offTurnStarted = runtime.onTurnStarted?.((event) => {
        if (event.threadId !== sessionId) return
        feedQuietWindow(sessionId)
      })
      armQuietWindowIfAbsent(sessionId)
      ```
    - in the `thread_status_changed` handler, after the status computation:
      every matching event feeds the window (reset); the existing
      active-turn cleanup stays as is — add `feedQuietWindow(sessionId)` right
      before the existing `if (status !== 'running' && status !== 'starting')`
      branch is NOT correct order-wise; instead: feed first, then if the
      normalized status is terminal/idle call `disarmQuietWindow(sessionId,
      'activity'-class)`. Concretely:
      ```ts
      if (status !== 'running' && status !== 'starting') {
        activeTurnByThread.delete(sessionId)
        disarmQuietWindow(sessionId, 'activity') // logs resolved only when stuck
      } else {
        feedQuietWindow(sessionId)
      }
      ```
      (The `thread_started` event branch likewise calls
      `feedQuietWindow(sessionId)`; `thread_closed` additionally calls
      `disarmQuietWindow(sessionId, 'thread_closed')` after `clearThreadState`.)
    - in `onTurnCompleted` (:911-928): after `activeTurnByThread.delete(sessionId)`
      add `disarmQuietWindow(sessionId, 'turn_complete')`.
    - in `onExit` (:935-946): add `disarmQuietWindow(sessionId, 'exit')`.
    - in the returned unsubscribe (:948-952): remove the listener from
      `deadmanListenersByThread` and call `offTurnStarted?.()`. The quiet timer
      itself intentionally survives unsubscribe (snapshot truth stays warm for
      the next attach).
  - `getSnapshot()` (:1082-1125): after the `activeTurnId` re-seed add
    `armQuietWindowIfAbsent(thread.threadId)` (this is the ONLY place a
    snapshot may arm, and it never resets an existing timer), and overlay the
    snapshot status with stuck truth:
    ```ts
    const rawStatus = normalizeCodexThreadStatus(rawSnapshot.thread?.status)
    const status = stuckSinceByThread.has(thread.threadId) && (rawStatus === 'running' || rawStatus === 'starting')
      ? 'stuck'
      : rawStatus
    ```
    then pass `status` into `normalizeCodexThreadSnapshot`.
  - `kill()` (:1214-1220): add `disarmQuietWindow(sessionId, 'kill')`.
  - `shutdown()` (:1222-1238): iterate `quietTimerByThread` keys and
    `disarmQuietWindow(id, 'shutdown')`; clear `deadmanListenersByThread`.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/server/fresh-agent/codex-adapter.test.ts`

Expected: PASS (all tests in the file, including the 7 new deadman tests).

- [ ] **Step 5: Refactor while green**

Hoist any duplicated `'codex'` provider literal use in the new helpers into the
existing provider constant if one exists in the adapter; extract the overlay
into a small named function (`withStuckOverlay(sessionId, rawStatus)`) next to
`normalizeCodexThreadStatus` if the ternary obscures the snapshot builder. No
new files; the deadman belongs with the lane's other lifecycle bookkeeping.
Do not add a metrics stub — the structured-log events are the observability
surface.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: everything under `test/unit/server/fresh-agent/` (adapter contract
consumers, observability tests, ws-handler fresh-agent folds) plus the server
typecheck for the status-union and port changes.

Run: `npm run test:vitest -- run test/unit/server/fresh-agent test/server && npm run typecheck:server && npm run typecheck:client`

Expected: PASS. (The union additions are additive; the shared `stuck` value is
consumed by client code only in Task 2 — client typecheck must still sort.)

- [ ] **Step 7: Commit the task**

```bash
git add server/fresh-agent/adapters/codex/adapter.ts shared/ws-protocol.ts server/sdk-bridge-types.ts server/fresh-agent/observability.ts test/unit/server/fresh-agent/codex-adapter.test.ts
git commit -m "feat(freshagent): wedged-sidecar quiet-window deadman in the Node freshcodex adapter lane"
```


---

### Task 2: client fold for `'stuck'` + stuck notice card with recovery actions

**Files:**
- Create: none.
- Modify: `src/store/freshAgentTypes.ts:21-29` (`FreshAgentSessionStatus` union)
- Modify: `src/store/freshAgentSlice.ts:395-405` (`setSessionStatus` busy-flag clearing)
- Modify: `src/components/fresh-agent/FreshAgentView.tsx` (top-stack card beside the session-ended card at :2604-2615; new `restartStuckSidecar` helper beside `triggerRecovery` :1322-1371; no changes to `canAdoptSnapshotStatus` :1991-2014 or the pane-content status sync — the card reads the store status, not pane content)
- Test: `test/unit/client/store/freshAgentSlice.test.ts`
- Test: `test/unit/client/lib/pane-activity.test.ts`
- Test: `test/unit/client/lib/fresh-agent-ws.test.ts`
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`

**Interfaces:**
- Consumes: `{ type: 'freshAgent.event', ..., event: { type: 'freshAgent.status', status: 'stuck' } }` from Task 1 (and Task 3 for the Rust lane), `triggerRecovery` (:1322-1371), `startNewConversation` (:1209-1242), `getCanonicalCodexResumeSessionId` (via `triggerRecovery`), the `wsMock` store-backed render harness (`FreshAgentView.test.tsx:47-66`, `renderFocusPane` :5996-6012).
- Produces: `'stuck'` in `FreshAgentSessionStatus`; `setSessionStatus('stuck')` clears `streamingActive`; `isFreshAgentBusy` returns false for stuck sessions (status not in any busy set; the pin test documents this as contract); the visible stuck card with two semantic button actions; `restartStuckSidecar` = kill frame + `triggerRecovery()`.

- [ ] **Step 1: Write the failing behavioral test**

Four test additions:

```ts
// test/unit/client/store/freshAgentSlice.test.ts — sibling of the existing
// `setSessionStatus(idle) clears streamingActive` test (:24-27); the file
// already defines the `codexLoc` locator (:51).
it('setSessionStatus(stuck) writes the status and clears streamingActive', () => {
  let state = reducer(undefined, setSessionStatus({ ...codexLoc, status: 'running' }))
  // seed an in-flight stream exactly like the file's existing streaming tests;
  // then the stuck fold must stop busy-driving flags:
  state = reducer(state, setSessionStatus({ ...codexLoc, status: 'stuck' }))
  const session = <same lookup expression the sibling test uses>(state, codexLoc)
  expect(session.status).toBe('stuck')
  expect(session.streamingActive).toBe(false)
  state = reducer(state, setSessionStatus({ ...codexLoc, status: 'idle' }))
  expect(<same lookup>(state, codexLoc).status).toBe('idle')
})
```

```ts
// test/unit/client/lib/pane-activity.test.ts — mirror the adjacent busy=true
// freshcodex case (status 'running') with only the status changed:
it('isFreshAgentBusy is false for a stuck freshcodex session', () => {
  const session = <the file's existing fresh-agent session fixture> with status 'stuck'
  expect(isFreshAgentBusy(session, 'codex')).toBe(false)
})
```

```ts
// test/unit/client/lib/fresh-agent-ws.test.ts — using the file's existing
// handleFreshAgentMessage dispatch/store harness:
it('folds freshAgent.status(stuck) into the store and dispatches no turn-completion action', () => {
  const dispatchSpy = <the file's harness dispatch spy or vi.spyOn(store, 'dispatch')>
  handleFreshAgentMessage(store.dispatch, {
    type: 'freshAgent.event',
    sessionId: 'thread-stuck-1',
    sessionType: 'freshcodex',
    provider: 'codex',
    event: { type: 'freshAgent.status', status: 'stuck' },
  }, wsMock)
  expect(<store session lookup>.status).toBe('stuck')
  expect(dispatchSpy.mock.calls.map(([a]) => a.type).filter((t: string) => t.startsWith('turnCompletion/'))).toHaveLength(0)
})
```

```tsx
// test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
describe('freshcodex wedged-sidecar notice', () => {
  it('renders the stuck notice with restart and start-new actions', async () => {
    const { store } = renderFocusPane({ sessionId: 'thread-stuck-1', status: 'running' })
    act(() => {
      store.dispatch(setSessionStatus({
        sessionId: 'thread-stuck-1', sessionType: 'freshcodex', provider: 'codex', status: 'stuck',
      }))
    })
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/appears stuck/i)
    expect(screen.getByRole('button', { name: /restart sidecar and resume session/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /start new conversation/i })).toBeInTheDocument()
  })

  it('Restart sidecar kills the wedged session then re-mints a creating pane on the canonical resume id', async () => {
    const { store } = renderFocusPane({ sessionId: 'thread-stuck-1', status: 'running' })
    act(() => {
      store.dispatch(setSessionStatus({
        sessionId: 'thread-stuck-1', sessionType: 'freshcodex', provider: 'codex', status: 'stuck',
      }))
    })
    await screen.findByRole('alert')
    const dispatchSpy = vi.spyOn(store, 'dispatch')
    fireEvent.click(screen.getByRole('button', { name: /restart sidecar and resume session/i }))
    expect(wsMock.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'freshAgent.kill',
      sessionId: 'thread-stuck-1',
      sessionType: 'freshcodex',
      provider: 'codex',
    }))
    const remints = dispatchSpy.mock.calls
      .map(([action]) => action)
      .filter((action: any) => action?.type === 'panes/updatePaneContent'
        && action.payload?.content?.status === 'creating')
    expect(remints).toHaveLength(1)
    expect(remints[0].payload.content.resumeSessionId).toBe('thread-stuck-1')
    expect(remints[0].payload.content.sessionId).toBeUndefined()
    expect(remints[0].payload.content.createRequestId).not.toBe('req-focus-0bc6')
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/store/freshAgentSlice.test.ts test/unit/client/lib/pane-activity.test.ts test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`

Expected: FAIL — `'stuck'` is not assignable to `FreshAgentSessionStatus`,
no card renders, and the slice does not clear `streamingActive` for it.

- [ ] **Step 3: Add the minimal production implementation**

3a. `src/store/freshAgentTypes.ts:21-29`: add `'stuck'` to the union.

3b. `src/store/freshAgentSlice.ts:395-405`: extend the busy-flag clearing branch:

```ts
if (status === 'idle' || status === 'exited' || status === 'stuck') {
  existing.streamingActive = false
}
```

3c. `src/components/fresh-agent/FreshAgentView.tsx`:

- New helper next to `triggerRecovery` (:1322-1371), reusing the kill-frame
  construction from `startNewConversation` (:1209-1242):

```ts
const restartStuckSidecar = useCallback(() => {
  const current = paneContentRef.current
  if (current.sessionId) {
    const cwd = getFreshOpenCodeRouteCwd(current, { sessionCwd: freshOpenCodeRouteCwdRef.current })
    sendFreshAgentMessage({
      type: 'freshAgent.kill',
      sessionId: current.sessionId,
      sessionType: current.sessionType,
      provider: current.provider,
      ...(cwd ? { cwd } : {}),
    })
  }
  triggerRecovery()
}, [sendFreshAgentMessage, triggerRecovery])
```

- New card in the `fresh-agent-top-stack`, immediately before the session-ended
  card (:2604-2615), keyed on the store-derived `effectiveStatus` (:2252-2255):

```tsx
{effectiveStatus === 'stuck' ? (
  <div
    className="fresh-agent-stuck-card flex items-center justify-between gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm"
    role="alert"
  >
    <span>Agent appears stuck — no events from the agent process for a while.</span>
    <div className="flex shrink-0 gap-2">
      <button
        type="button"
        className="shrink-0 rounded border border-border/70 px-2 py-1 text-xs"
        aria-label="Restart sidecar and resume session"
        onClick={restartStuckSidecar}
      >
        Restart sidecar
      </button>
      <button
        type="button"
        className="shrink-0 rounded border border-border/70 px-2 py-1 text-xs"
        aria-label="Start new conversation"
        onClick={startNewConversation}
      >
        Start new conversation
      </button>
    </div>
  </div>
) : null}
```

- Verify-by-reading during implementation: the status-sync effect that maintains
  pane `content.status` maps only known values (unchanged by this task — the
  card reads the store status, so `content.status` derivation needs no edit).
  `canAdoptSnapshotStatus` (:1991-2014) needs no change: `'stuck'` snapshots
  are adopted for codex through the existing provider/sessionType gate and the
  existing non-busy guards (`snapshotIsBusy` stays false for `'stuck'`).

- Also check `docs/index.html`: if it already depicts fresh-agent error or
  recovery cards (search for `session-ended`, `restore`), mock up the stuck
  card alongside them; if it depicts none (expected — it mocks the default
  experience), leave it unchanged and record that rationale in the commit
  message.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/store/freshAgentSlice.test.ts test/unit/client/lib/pane-activity.test.ts test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Extract the notice text constant next to the view's other copy constants if one
exists; confirm both buttons share the exact action-button class list used by
the adjacent session-ended card. No behavioral changes.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: all client fresh-agent surfaces (slice, ws fold, pane activity,
the whole FreshAgentView suite including the reconcile and hidden-rebind
variants), plus the client typecheck and the a11y lint.

Run: `npm run test:vitest -- run test/unit/client/store/freshAgentSlice.test.ts test/unit/client/lib test/unit/client/components/fresh-agent && npm run typecheck:client && npm run lint`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add src/store/freshAgentTypes.ts src/store/freshAgentSlice.ts src/components/fresh-agent/FreshAgentView.tsx test/unit/client/store/freshAgentSlice.test.ts test/unit/client/lib/pane-activity.test.ts test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
git commit -m "feat(freshagent): surface agent-stuck state with restart/resume recovery for freshcodex panes"
```


---

### Task 3: Rust freshcodex quiet deadman (production lane)

**Files:**
- Create: none.
- Modify: `crates/freshell-codex/src/events.rs` — add `CodexStatus::Stuck` (:29-35 enum) with the lowercase `"stuck"` arm in `as_str()` (:40-47); no serde derives there, the wire casing is manual.
- Modify: `crates/freshell-freshagent/src/codex.rs` (session state + `CodexSession` :207 region, `FreshCodexState` fields :141-144 precedent, `handle_send` :1090-1193, `handle_compact` only reads active_turn (:1339) — NOT an arm site, consumer `spawn_consumer_after` :2587-2633, `spawn_exit_watcher` :3859-3911, `reduce_notification` :3922-3981 incl. the TurnStarted arm :3965, `get_snapshot` :2644 incl. the post-`read_thread` point :2665 and status serialization :3675, `adapter_event_to_frame` :3985-4012 esp. the Status arm :4011)
- Modify: no changes to `crates/freshell-server/src/main.rs` (env parse happens inside codex.rs; `FreshCodexState::new` keeps its current params — window config rides a plain field per the `dead_thread_ttl` :141-144 precedent).
- Test: in-crate `mod tests` inside `crates/freshell-freshagent/src/codex.rs` (:4238+; REAL harness names: `state_with_bus` :4712, `insert_fake_session_with_real_consumer` :4780, scripted peer idiom `peer.expect_request()` → `peer.respond(&id, json!(...))` → `peer.emit_notification(...)` :5134-5141 (+`crates/freshell-codex/src/app_server.rs:867`), tracing capture `tracing_capture::capture_by_session(id)` → `.events()` :4244-4451 (usage :4472-4497), frame-string assertions `serde_json::from_str` :4590-4624, `spawn_sleeper` :4767 — note the existing self-heal test :6246 uses a plain `true` child and so do these tests).

**Interfaces:**
- Consumes: existing `CodexSession.active_turn` (:207 field region), `CodexAdapterEvent` + `adapter_event_to_frame` (:3985-4012 — the `Status` arm :4011 structurally cannot emit a turn-complete, which is the no-chime guarantee), the broadcast bus from `state_with_bus`, and the scripted `ChannelPeer` harness.
- Produces:
  - `CodexStatus::Stuck` → wire string `"stuck"` via `as_str()`, broadcast as `{ "type": "freshAgent.event", sessionId, sessionType: "freshcodex", provider: "codex", event: { "type": "freshAgent.status", "status": "stuck" } }` — byte-identical to Task 1's Node wire shape; the REST snapshot serializer (:3675) reports `"stuck"` while flagged.
  - Per-session `quiet_deadman: Arc<std::sync::Mutex<QuietDeadman>>` on `CodexSession` (mirrors the `active_turn` :207 field pattern; the sessions map is a tokio Mutex :109 and `reduce_notification` is sync, so deadman state must be independently lockable).
  - `#[cfg(test)] pub(crate) fn set_codex_quiet_window_ms_for_tests(&self, ms: u64)` on `FreshCodexState` (mirrors `set_opencode_busy_deadman_for_tests`, `crates/freshell-ws/src/activity.rs:590/608`).
  - Production scaling: `FRESHELL_FRESHCODEX_QUIET_WINDOW_MS` (positive integer ms; invalid/absent → 600_000).
  - Structured logs: `tracing::info!` on arm/resolve, `tracing::warn!` on fire — event `freshagent.codex.quiet_deadman` with `phase` (`armed|fired|resolved`), field scheme mirroring the existing `freshagent.turn.complete` log (:2624) exactly (same keys, same hashed-id treatment).

- [ ] **Step 1: Write the failing behavioral test**

Four in-crate tests. All idioms below exist in the file today (validated at
base_ref): `state_with_bus()` (:4712) returns the state plus a broadcast frame
`Receiver<String>`; `insert_fake_session_with_real_consumer(...)` (:4780)
registers a session whose client is a scripted `ChannelPeer` with a real
consumer driving production `reduce_notification`; the peer idiom is
`let req = peer.expect_request().await` → `peer.respond(&req["id"], json!({...}))`
→ `peer.emit_notification("turn/started", ...)` (:5134-5141, script format at
`crates/freshell-codex/src/app_server.rs:867`); frames arrive as JSON strings
asserted via `serde_json::from_str` (:4590-4624); tracing assertions use
`tracing_capture::capture_by_session("...")` → `.events()` (:4244-4451, usage
:4472-4497); the child stand-in is a plain `true` process (mirrors :6246).

```rust
#[tokio::test]
async fn quiet_deadman_fires_stuck_status_without_fabricating_a_turn_complete() {
    let (state, mut frame_rx) = state_with_bus();
    state.set_codex_quiet_window_ms_for_tests(150);
    let cap = tracing_capture::capture_by_session("thread-stuck");
    let (peer, _child) = insert_fake_session_with_real_consumer(
        &state, "thread-stuck", /* args per :4780 signature */,
    ).await;
    // Drive the production send path; the peer answers turn/start, emits
    // turn/started, and then stays silent forever (alive process, zero events).
    let send = tokio::spawn(state.clone().handle_send(send_msg("thread-stuck", "run")));
    let req = peer.expect_request().await;                       // turn/start RPC
    peer.respond(&req["id"], serde_json::json!({"turn": {"id": "turn-1"}})).await;
    peer.emit_notification("turn/started",
        serde_json::json!({"threadId": "thread-stuck", "turn": {"id": "turn-1", "status": "inProgress"}})).await;
    send.await.expect("send ok").expect("send accepted");
    // Collect frames for up to 2 s; the stuck status must arrive, and no
    // turn-complete edge may EVER be emitted by the deadman.
    let collect = collect_frames_until(&mut frame_rx, Duration::from_secs(2),
        |w| w["event"]["type"] == "freshAgent.status" && w["event"]["status"] == "stuck").await;
    assert!(collect.matched, "deadman must surface the stuck status");
    assert!(collect.frames.iter().all(|w| w["event"]["type"] != "freshAgent.turn.complete"),
        "deadman must never fabricate a completion edge");
    let snap = state.get_snapshot("thread-stuck").await.expect("snapshot");
    assert_eq!(snap["status"], "stuck");                          // REST overlay agrees
    assert!(cap.events().iter().any(|e| e.contains("freshagent.codex.quiet_deadman") && e.contains("fired")),
        "fire is observable in the tracing stream");
}

#[tokio::test]
async fn quiet_deadman_resets_on_lane_events_and_resolves_on_turn_completion() {
    let (state, mut frame_rx) = state_with_bus();
    state.set_codex_quiet_window_ms_for_tests(300);
    let (peer, _child) = insert_fake_session_with_real_consumer(&state, "thread-reset", /* :4780 args */).await;
    let send = tokio::spawn(state.clone().handle_send(send_msg("thread-reset", "run")));
    let req = peer.expect_request().await;
    peer.respond(&req["id"], serde_json::json!({"turn": {"id": "turn-1"}})).await;
    peer.emit_notification("turn/started", serde_json::json!({"threadId": "thread-reset", "turn": {"id": "turn-1", "status": "inProgress"}})).await;
    send.await.expect("send ok").expect("send accepted");
    tokio::time::sleep(Duration::from_millis(200)).await;
    peer.emit_notification("thread/status/changed",
        serde_json::json!({"threadId": "thread-reset", "status": {"type": "active"}})).await; // feed
    let pre = collect_frames_until(&mut frame_rx, Duration::from_millis(250), |_| false).await;
    assert!(pre.frames.iter().all(|w| w["event"]["status"] != "stuck"),
        "no fire before the RESET deadline");
    let post = collect_frames_until(&mut frame_rx, Duration::from_secs(2),
        |w| w["event"]["status"] == "stuck").await;
    assert!(post.matched, "fire after the reset deadline");
    peer.emit_notification("turn/completed",
        serde_json::json!({"threadId": "thread-reset", "turn": {"id": "turn-1", "status": "completed"}})).await;
    let idle = collect_frames_until(&mut frame_rx, Duration::from_secs(2), |w|
        (w["event"]["type"] == "freshAgent.session.snapshot" && w["event"]["status"] == "idle")
        || (w["event"]["type"] == "freshAgent.status" && w["event"]["status"] == "idle")).await;
    assert!(idle.matched, "genuine completion restores an idle status");
    assert_eq!(idle.frames.iter().filter(|w| w["event"]["status"] == "stuck").count(), 1,
        "exactly one stuck fire, no repeat flapping");
    let snap = state.get_snapshot("thread-reset").await.expect("snapshot");
    assert_eq!(snap["status"], "idle");
}

#[tokio::test]
async fn quiet_deadman_arms_from_snapshot_observed_in_flight_turn() {
    // U-1 repair: a session registered WITHOUT any adapter-observed turn
    // (restore mid-turn), then a live thread read sees an in-flight turn ->
    // seed active_turn (side-state only) and arm the window; wedged still fires.
    let (state, mut frame_rx) = state_with_bus();
    state.set_codex_quiet_window_ms_for_tests(150);
    let (peer, _child) = insert_fake_session_with_real_consumer(&state, "thread-midrestore", /* active_turn: None */ /* :4780 args */).await;
    let snap_req = tokio::spawn(state.clone().get_snapshot("thread-midrestore"));
    let req = peer.expect_request().await;                       // thread/read RPC
    peer.respond(&req["id"], serde_json::json!({
        "thread": {
            "id": "thread-midrestore",
            "status": {"type": "active"},
            "turns": [{"id": "turn-9", "status": "inProgress", "items": []}],
            // ...minimal fields per the :4830 snapshot-drive idiom...
        }
    })).await;
    let snap = snap_req.await.expect("snapshot ok").expect("snapshot");
    assert_eq!(snap["status"], "running");
    let collect = collect_frames_until(&mut frame_rx, Duration::from_secs(2),
        |w| w["event"]["status"] == "stuck").await;
    assert!(collect.matched, "snapshot-observed running turn arms the window");
    let snap2 = state.get_snapshot("thread-midrestore").await.expect("snapshot");
    assert_eq!(snap2["status"], "stuck");
}

#[tokio::test]
async fn quiet_deadman_ignores_quiet_sessions_with_no_turn_in_flight() {
    let (state, mut frame_rx) = state_with_bus();
    state.set_codex_quiet_window_ms_for_tests(150);
    let _peer = insert_fake_session_with_real_consumer(&state, "thread-idle", /* :4780 args */).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let drain = collect_frames_until(&mut frame_rx, Duration::from_millis(50), |_| false).await;
    assert!(drain.frames.iter().all(|w| w["event"]["status"] != "stuck"));
}
```

The test-local helpers written by this task (kept inside `mod tests`):
`send_msg(thread_id, text)` — builds the WS client frame the existing tests
feed to `handle_send` (copy the construction from the :4906-5060
interrupt/kill tests); `collect_frames_until(rx, dur, pred)` — drain-with-timeout
over the `Receiver<String>` returning `{ matched: bool, frames: Vec<serde_json::Value> }`
(parsed per the :4590-4624 idiom). Exact `insert_fake_session_with_real_consumer`
argument list follows its :4780 signature (state, thread id, scripted client,
active_turn, notifs, child, ownership_id).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-freshagent quiet_deadman`

Expected: FAIL — `set_codex_quiet_window_ms_for_tests` and the stuck status do
not exist yet (compile error in the new tests; acceptable red for a new-module
test, per repo TDD then-unblock rule: first make ONLY the compile surface —
the setter + enum variant + no-op wiring — then confirm the behavioral
assertions fail before implementing the timer).

- [ ] **Step 3: Add the minimal production implementation**

3a. Status enum (`crates/freshell-codex/src/events.rs`): add `Stuck` to
`CodexStatus` (:29-35) and the `"stuck"` arm in its `as_str()` (:40-47). The
wire Json then flows through both the `freshAgent.status` arm (:4011) and the
snapshot serializer (:3675) with no additional mapping.

3b. Per-session deadman state (`crates/freshell-freshagent/src/codex.rs`). The
sessions map rides a tokio Mutex (:109, never held across awaits) and
`reduce_notification` is sync, so the deadman state is an independently
lockable per-session field mirroring the `active_turn` pattern (:207):

```rust
// on CodexSession:
quiet_deadman: Arc<std::sync::Mutex<QuietDeadman>>,

struct QuietDeadman {
    generation: u64,                              // bumped on every feed -> stale waiters exit
    deadline: Option<tokio::time::Instant>,       // Some only while a turn is in flight
    stuck_since: Option<std::time::Instant>,
}
```

On `FreshCodexState` add a plain window field following the `dead_thread_ttl`
precedent (:141-144), seeded at construction from
`FRESHELL_FRESHCODEX_QUIET_WINDOW_MS` (u64 ms parse; invalid/absent →
`Duration::from_millis(600_000)`), plus `#[cfg(test)] pub(crate) fn
set_codex_quiet_window_ms_for_tests(&self, ms: u64)` (the file's existing
`dead_thread_ttl` mutator pattern decides Mutex-vs-plain-field; mirror it).

3c. Arm/feed/disarm wiring — state handle threaded by parameter, not by
capture change, at exactly three call sites:

- `spawn_consumer_after` (:2587-2633) gains a `&Arc<FreshCodexState>` (or the
  narrow handle the consumer already holds plus it) and passes it into
  `reduce_notification` (one new parameter); inside `reduce_notification`
  (:3922-3981), at the point the target session is resolved, call
  `note_codex_activity(state, thread_id, &session.quiet_deadman)` — every
  lane-visible notification feeds (generation bump = reset; resolves stuck
  first). The TurnStarted arm (:3965) performs this same call right after it
  sets `active_turn`, so a turn that started outside `handle_send` also arms.
- `handle_send` (:1090-1193): immediately after `active_turn` is set (:1164),
  call `note_codex_activity(...)`. (`handle_compact` only READS `active_turn`
  (:1339) — not an arm site; compact turns feed via their normal events.)
- `get_snapshot` (:2644): after `read_thread` returns (:2665), if the fresh
  read shows the thread running (`thread.status.active` :3621) — with a turn id
  from the `inProgress` turn in the payload (:3648/:3750/:3804) — and the
  session's `active_turn` is `None`, seed `active_turn` (record the turn id;
  this is SIDE-STATE only — never fold into `is_running`; the FIX-1 revert at
  :3622-3640 documents why) and arm-if-absent via `note_codex_activity`. A
  later snapshot MUST NOT reset an armed window (do not call the feed when the
  window is already armed — arm-if-absent only). Also overlay the serialized
  status (:3675): `stuck_since.is_some() && status == Running → Stuck`.
- `spawn_exit_watcher` (:3859-3911): accept the deadman `Arc` as an additional
  parameter (the existing `exited`-flag param is the precedent); on an
  unrequested exit call `disarm_codex_quiet(&quiet, "exit")`. Same on
  `handle_kill`/teardown paths (`"kill"`).

```rust
fn note_codex_activity(state: &Arc<FreshCodexState>, thread_id: &str,
                       quiet: &Arc<std::sync::Mutex<QuietDeadman>>) {
    let mut q = quiet.lock().expect("quiet deadman lock");
    if q.stuck_since.take().is_some() {
        tracing::info!(event = "freshagent.codex.quiet_deadman", phase = "resolved", /* freshagent.turn.complete's field scheme (:2624) */);
    }
    if <session still has active_turn> {
        q.generation += 1;
        let window = state.codex_quiet_window();
        q.deadline = Some(tokio::time::Instant::now() + window);
        let generation = q.generation;
        let first_arm = q.stuck_since.is_none() /* freshly armed from disarmed */;
        if first_arm { tracing::info!(event = "freshagent.codex.quiet_deadman", phase = "armed", quiet_window_ms = window.as_millis() as u64 /* + scheme */); }
        tokio::spawn(state.clone().watch_codex_quiet_deadline(thread_id.to_string(), generation));
    } else {
        q.deadline = None;
    }
}

fn disarm_codex_quiet(quiet: &Arc<std::sync::Mutex<QuietDeadman>>, resolution: &str) {
    let mut q = quiet.lock().expect("quiet deadman lock");
    q.generation += 1;                 // invalidate waiters
    q.deadline = None;
    if q.stuck_since.take().is_some() {
        tracing::info!(event = "freshagent.codex.quiet_deadman", phase = "resolved", resolution, );
    }
}

async fn watch_codex_quiet_deadline(self: Arc<FreshCodexState>, thread_id: String, generation: u64) {
    // snapshot (deadline, quiet Arc) without holding the sessions lock across an await;
    let (quiet, deadline) = { /* lock sessions briefly */ };
    let Some(deadline) = deadline else { return };
    tokio::time::sleep_until(deadline).await;
    // re-lock: sessions -> session -> quiet.deadman; fire iff
    //   q.generation == generation && deadline elapsed(still Some) && active_turn.is_some() && q.stuck_since.is_none()
    // fire: q.stuck_since = Some(Instant::now());
    //   tracing::warn!(event = "freshagent.codex.quiet_deadman", phase = "fired", quiet_window_ms, hashed ids per :2624 scheme);
    //   broadcast adapter_event_to_frame(CodexAdapterEvent::Status{ status: CodexStatus::Stuck }, session_id)
    //     — the :4011 arm structurally cannot emit a turn-complete edge (no-chime guarantee).
    // The waiter exits; the next feed spawns a fresh waiter under a new generation.
}
```

Deadlock audit for the implementer (validator-verified constraints): the
sessions tokio Mutex is never held across an await today and must stay that
way; the deadman `std::sync::Mutex` is LOCK-BRIEF only (never held across
awaits, never held while broadcasting); the waiter locks the sessions map
twice (before/after the sleep), each time briefly.

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-freshagent quiet_deadman`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Keep the deadman block adjacent to the other per-session lifecycle bookkeeping;
confirm no new dependencies were added (all tokio/tracing primitives are already
in use in this file); ensure the waiter task exits on generation mismatch before
any work (no unbounded task accumulation under chatty sessions).

- [ ] **Step 6: Run impacted-test verification**

Impacted set: the whole `freshell-freshagent` crate suite (the consumer and
snapshot builders are shared), the `freshell-ws` codex-touching tests, and the
workspace lint gates for the touched crates.

Run: `cargo test -p freshell-freshagent -p freshell-codex -p freshell-ws && cargo clippy -p freshell-freshagent -p freshell-codex -p freshell-ws --all-targets -- -D warnings && cargo fmt --all --check`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-codex/src/events.rs crates/freshell-freshagent/src/codex.rs
git commit -m "feat(freshagent): wedged-sidecar quiet deadman for the Rust freshcodex lane"
```


---

### Task 4: Rust-lane e2e — seeded wedge and within-bound cases

**Files:**
- Create: none.
- Modify: `test/e2e-browser/specs/fresh-agent-control-rust.spec.ts` (extend the local `bootCodexLane` :1237-1276 with per-test overrides; new tests at the end of the codex section)
- Test: same file (this is an e2e task; the tests ARE the deliverable)
- Consumes (no changes): `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs` — the seeded wedge uses only existing knobs: `recordTurns: true` and `turnCompleteDelayMs` (:753, default 150 ms → set to 3_600_000 so the `turn/completed` broadcast effectively never fires while the process stays alive).

**Interfaces:**
- Consumes: Tasks 2+3 (client card + Rust lane deadman); `bootWall`, `seedWallConfig`, `createFreshAgentPane`, `selectShellIfPickerShowing`, `enableClis`, `waitForPaneStatus` (:472-488), `sendComposerText` (:491-496), `readCodexOps(opLogPath)`.
- Produces: two pinned e2e tests over the production-shaped path; no reusable exports.

- [ ] **Step 1: Write the failing behavioral test**

First extend the local helper (same file, spec-local helpers are the convention
here — :62-65):

```ts
async function bootCodexLane(page: Page, options?: {
  extraBehavior?: Record<string, unknown>
  extraEnv?: Record<string, string>
}): Promise<{ server: RustServer; info: TestServerInfo; harness: TestHarness; sharedRoot: string; projectDir: string; opLogPath: string; tabId: string }> {
  const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-agentctl-codex-'))
  try {
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    const opLogPath = path.join(sharedRoot, 'codex-ops.jsonl')
    const { server, info, harness } = await bootWall(page, {
      env: {
        CODEX_CMD: `${process.execPath} ${CODEX_APP_SERVER_FIXTURE}`,
        FAKE_CODEX_APP_SERVER_BEHAVIOR: JSON.stringify({
          appendThreadOperationLogPath: opLogPath,
          recordTurns: true,
          ...(options?.extraBehavior ?? {}),
        }),
        ...(options?.extraEnv ?? {}),
      },
      setupHome: seedWallConfig({ providers: ['codex'], freshAgent: true }),
    })
    await selectShellIfPickerShowing(page)
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
    await enableClis(page, { codex: true })
    const tabId = (await harness.getActiveTabId())!
    expect(tabId).toBeTruthy()
    await createFreshAgentPane(page, /^Freshcodex$/, 'Freshcodex', projectDir)
    return { server, info, harness, sharedRoot, projectDir, opLogPath, tabId }
  } catch (error) {
    await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}
```

Then the two tests:

```ts
test('wedged sidecar: quiet window surfaces the stuck state with recovery, not an eternal spinner', async ({ page }) => {
  const lane = await bootCodexLane(page, {
    extraBehavior: { turnCompleteDelayMs: 3_600_000 },
    extraEnv: { FRESHELL_FRESHCODEX_QUIET_WINDOW_MS: '4000' },
  })
  const paneRoot = page.locator('[data-context="fresh-agent"]').last()
  const stuckAlert = paneRoot.getByRole('alert').filter({ hasText: /appears stuck/i })

  await sendComposerText(page, 'run a turn that will wedge')
  await expect(page.getByRole('button', { name: 'Stop' }), 'composer busy while the turn runs').toBeVisible()

  // Within the bound: no stuck state, still busy.
  await page.waitForTimeout(2000)
  await expect(stuckAlert).toHaveCount(0)

  // Past the bound: stuck notice visible; busy cleared.
  await expect(stuckAlert, 'stuck notice after the quiet window').toBeVisible({ timeout: 25_000 })
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0)

  // The wedge is a live process: exactly one turn/start, no crash or interrupt RPC.
  const ops = readCodexOps(lane.opLogPath).map((op: any) => op.method)
  expect(ops.filter((m: string) => m === 'turn/start')).toHaveLength(1)

  // Recovery: restart the sidecar and resume the durable thread. Truthful
  // terminal state = idle with transcript intact, or idle with the explicit
  // memory-loss alert (both are acceptance-valid).
  await stuckAlert.getByRole('button', { name: /restart sidecar/i }).click()
  await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
  await expect(stuckAlert).toHaveCount(0)
  const opsAfter = readCodexOps(lane.opLogPath).map((op: any) => op.method)
  const resumed = opsAfter.includes('thread/resume')
  const respawnedFresh = opsAfter.filter((m: string) => m === 'thread/start').length >= 2
  expect(resumed || respawnedFresh).toBe(true)
  if (respawnedFresh && !resumed) {
    await expect(paneRoot.getByRole('alert').filter({ hasText: /no longer has memory/i })).toBeVisible()
  }
})

test('long turn within the quiet window completes normally and never shows the stuck state', async ({ page }) => {
  const lane = await bootCodexLane(page, {
    extraBehavior: { turnCompleteDelayMs: 3_000 },
    extraEnv: { FRESHELL_FRESHCODEX_QUIET_WINDOW_MS: '8000' },
  })
  const paneRoot = page.locator('[data-context="fresh-agent"]').last()
  const stuckAlert = paneRoot.getByRole('alert').filter({ hasText: /appears stuck/i })

  await sendComposerText(page, 'a slow but healthy turn')
  await waitForPaneStatus(lane.harness, lane.tabId, 'idle')
  await page.waitForTimeout(2_000)
  await expect(stuckAlert).toHaveCount(0)
})
```

Note: if the spec's shared `Stop`-button selector is scoped elsewhere, use the
pane-scoped equivalent the file already uses for busy assertion. The composer
Stop button carries `aria-label="Stop"` (`FreshAgentComposer.tsx:788-796`).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/fresh-agent-control-rust.spec.ts -g "wedged sidecar|quiet window completes"`

Expected: FAIL — the wedged test times out waiting for a stuck alert that no
code produces yet (Tasks 2+3 provide it; if this task runs after them in TDD
order, the red run precedes their implementation per the plan's task sequence:
run this Step 2 only after Task 3 lands, or temporarily assert the eternal-busy
baseline to prove the seed wedges the turn — the negative baseline: busy
persists past 2× the window with zero alert).

- [ ] **Step 3: Add the minimal production implementation**

None beyond Tasks 1-3. If either assertion exposes a real integration gap (e.g.
the pane-content status sync filtering `stuck`, or the kill frame from the
client not tearing down the sidecar in the Rust lane), fix it in the owning
module (FreshAgentView sync / Rust `handle_kill`) under this task, adding the
appropriate unit coverage to that module's existing suite.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/fresh-agent-control-rust.spec.ts -g "wedged sidecar|quiet window completes"`

Expected: PASS (both tests).

- [ ] **Step 5: Refactor while green**

Deduplicate any repeated pane/alert locator construction into spec-local
constants if the pattern now appears more than twice.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: the whole spec file (shared helpers changed) on the
rust-chromium project, plus Task 3's Rust suite to confirm the lane stayed
green under the same seeding.

Run: `npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/fresh-agent-control-rust.spec.ts && cargo test -p freshell-freshagent`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/fresh-agent-control-rust.spec.ts
git commit -m "test(freshagent): e2e coverage for the freshcodex wedged-sidecar deadman and recovery"
```

---

## Final verification (stage machinery; not a task)

- Task-level reviews and the whole-branch code review run per the execution
  capability during Stage 4.
- The full repository QA gate at every prospective landing commit is:
  `darkforge qa --repo '/home/dan/code/freshell' --id 'r47n'`. Acceptance honors
  the baseline ledger by identity: a zero exit, or a nonzero exit whose parsed
  failure identities are all in the baseline ledger (the three
  `test/unit/vite-config.test.ts > getNetworkHost` failures).
- The landing reconcile (fetch → reconcile onto canonical head → squash →
  re-gate → push) is governed by the owner contract. Expect conflicts in the
  Rust lane files (heavy upstream drift since the base commit); resolve by
  symbol, not by line number, and re-run Task 3's suite and the full QA gate
  after reconciling.

## Plan self-review record (2026-09-06)

1. Spec coverage: every acceptance bullet maps to a named test — seeded wedge
   (Task 4 test 1 + Task 3 `quiet_deadman_fires_...` + Task 1 test 1), bound
   coverage (Task 1 test 1 boundary step + Task 3 window-reset test + Task 4
   within-bound test), recovery truthfulness (Task 4 test 1 recovery block),
   no-fabricated-completion (Task 1 tests 1/2/7; Task 3 test 1 frame
   assertion), observability (Task 1 test 7; Task 3 tracing assertion).
2. No silent deferrals: no stubs or mocks stand in for production behavior in
   the final state; the fake sidecar exercises the real consumer/reducer code.
3. File/interface consistency: all file paths, anchors, helper names, and
   produced interfaces cross-checked between tasks (wire shape byte-identical
   across lanes and consumed by Task 2).
4. Executable tests: each Step 1 tells the implementer exactly what fails and
   why in Step 2; plan code is a draft — the tree supersedes it during
   execution.
5. Placeholder scan: no TBD/TODO/"same as"; one deliberate failure-mode note in
   Task 4 Step 2 (negative baseline) is a stated verification, not a gap.
6. Operational completeness: env knob + test hooks defined for both lanes;
   structured-log observability on both lanes; a11y on the new card; rollback =
   no rollback needed (additive behavior; deleting the tasks' commits reverts).

Self-review result: PASS. No UNRESOLVED COVERAGE GAP.

### Addendum (2026-09-06, post-load-bearing re-review)

Stage 2 applied these corrections (evidence: traces ledger
`load-bearing-ledger.md`, finder/validator reports under `reports/`):
Task 3's enum edit site moved to `crates/freshell-codex/src/events.rs`; its
plumbing rewritten for the sync `reduce_notification` reality (per-session
`Arc<StdMutex<QuietDeadman>>`, parameter threading); the mid-turn-restore seam
became a real Rust code path (`get_snapshot` seed+arm, side-state only per the
FIX-1 revert :3622-3640); its tests rewritten to the in-crate harness's real
idioms with a fourth test pinning the snapshot-observed arm; Task 1 test 5's
post-resolve stub fixed to idle; deadman test count corrected to 7. The
changed tasks re-passed the 6-point self-review above after each edit.
