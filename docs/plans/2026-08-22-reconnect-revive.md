# Reconnect Revive — Fix the Gray-and-Dead Pane Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Fix Freshell's gray-and-dead pane reconnect bug: on WebSocket reconnect (for example a phone browser returning from background), an open pane pointing at a server-side terminal or agent session that is still running must reattach and repaint live content instead of staying gray/dead — and the close-and-reopen fallback for that pane must revive the still-running session instead of dead-ending on a "Session … is still running on the server." error.

### Explicit constraints
- Run this fix through the the-usual-beta skill workflow.
- Reconnect-path only: the multi-view attach feature (#4, including the #2/#3 policy pieces) is deferred to a later run and must not be implemented here.
- Follow repository rules: red-green-refactor TDD with unit and e2e coverage; fix the system over the symptom.
- Never restart the production self-hosted server without the user's explicit "APPROVED".
- Everything lands through a PR targeting `main`; do not create the PR without explicit user approval.

### Accepted tradeoffs and residuals
- Multi-view/multi-device attach and adopt/view policies (#4, #2, #3) are deferred; this run keeps single-viewer-per-connection semantics.
- Reconnect-only scope: pre-existing rough edges that are not on the reconnect/reattach path stay as they are.

**Goal:** After any transport drop with the server still up, every open pane of every kind repairs itself: the client detects a dead or half-open socket, reconnects, reattaches (or is routed by reconcile verdicts), and repaints; and a user who closes and reopens such a pane lands attached to the still-running session instead of on a refusal.

**Architecture:** Fix the wedge at each of its four layers, keeping every existing recovery contract intact. (1) Transport liveness — an app-level ping watchdog plus foreground pokes, recycling a half-open socket by *abandoning* it (handlers detached, generation-guarded, fresh socket driven immediately) rather than relying on `onclose` delivery from a dead transport. (2) Reconcile loss — a bounded client-side wait that falls back to the legacy inventory census, plus an explicit server error instead of accept-and-strip silence on non-negotiated connections. (3) Per-pane reattach gaps — hidden-pane hydration parity on reconnect, fresh-agent `lost` revocation on truth-bearing evidence, opencode placeholder re-keying on attach ack, and a truthful claude attach-ack status. (4) Close→reopen — the negotiated WS door already adopts (LB-1); the residual refusal lanes (REST doors, non-negotiated windows) carry the live terminal id in the D7 refusal, and the client folds an id-carrying refusal into an epoch-bumping reattach reducer instead of a dead-end.

**Tech Stack:** React 18 / Redux Toolkit / TypeScript client (jsdom Vitest), Rust workspace server crates (`freshell-ws`, `freshell-terminal`, `freshell-freshagent`, `freshell-protocol`; cargo tests), Playwright e2e (`test/e2e-browser`, `rust-chromium` project).

## Global Constraints

- Work only in the worktree `/home/dan/code/freshell/.worktrees/reconnect-revive` on branch `the-usual/reconnect-revive`. Never touch the main checkout's files.
- TypeScript server/shared code is NodeNext/ESM: relative imports include the `.js` extension.
- Never restart the production self-hosted server (Rust server, port 3001) without the user's explicit `APPROVED`. Do not create a PR without explicit user approval. Commits keep the existing repo identity (`Dan Shapiro <3732858+danshapiro@users.noreply.github.com>`); never modify git config.
- Focused test commands (run from the worktree root): client unit `npm run test:vitest -- run <file>` (client config is the default); Rust `cargo test -p <crate> <test-name-filter>`; e2e single spec `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium <spec-file>`. Broad suites (`npm test`, `npm run check`) are gate-coordinated and only run at the stage-4 gate, not per task.
- One-JSONL-writer doctrine is untouched: the D7 live-guard and D8 lease stay in force; revival rides `terminal.attach` / `freshAgent.attach` / reconcile `attach` verdicts to the live handle — never a create-with-resume against a live owner.
- Attach generation and geometry authority discipline is untouched: reattach carries a fresh `attachRequestId`; only visible panes claim viewport geometry on the wire (hidden panes use `keepalive_delta`/background hydration per `src/lib/terminal-attach-policy.ts`).
- Frozen-client wire parity: every new wire field is optional and omitted when absent (`#[serde(skip_serializing_if = "Option::is_none")]`); any new error code is emitted only on a code path that pre-reconcile clients never drive (they never send `pane.reconcile.request`).
- Do not add attach ACKs for claude/codex tracked-live attach (wire-shape parity; ws-oracle differential captures pin the silence). Repaint authority for fresh-agent panes stays the client-initiated HTTP snapshot fetch, hardened by Task 4.
- No `TBD`/placeholder steps, no test that only checks static copy, no behavioral outcome left covered only by a mock or stub. UI copy changes go through the a11y lint (`npm run lint`) — this run's only user-visible copy is inside the xterm notice buffer, which is not DOM-a11y scoped.
- `docs/index.html` is not updated by this run: no new user-facing feature or major UI change (behavioral fixes only).

## Root-Cause Map (from the four explorer reports)

Evidence lives in `.worktrees/.the-usual-logs/reconnect-revive/reports/` (`plan-client-terminal-reconnect.md`, `plan-server-ws-attach.md`, `plan-fresh-agent-reconnect.md`, `plan-tests-priorart-graystate.md`). The wedge layers:

1. **No transport liveness on the client.** Everything rides on the browser delivering `onclose`; a half-open socket (phone radio flap, NAT timeout, frozen tab) never starts `scheduleReconnect` (`src/lib/ws-client.ts:508-586` is onclose-only), and nothing re-asserts connectivity on foreground (no `visibilitychange`/`online`/`pageshow` poke reaches `getWsClient()`). While the socket is dead-but-open, keystrokes pour into `pendingMessages` and are filter-dropped on the eventual reconnect (`ws-client.ts:300-304`).
2. **Reconcile-result loss is a silent wedge.** The boot `pane.reconcile.result` is unicast to the requesting socket with no client wall-clock bound (`src/App.tsx:916-918` documents the deliberate absence), and the server accept-and-strip ignores the request on non-negotiated connections (`crates/freshell-ws/src/terminal.rs:1232-1243`). A lost result leaves every pane pending-verdict = gray with zero chrome.
3. **Per-pane reattach gaps.** Hidden terminal panes register with the hydration queue on reconnect WITHOUT enqueueing themselves when their parser checkpoint is unusable (`src/components/TerminalView.tsx:5207`, `queueIfStarted: canResumeFromParserAppliedSurface`), unlike the `terminal.created` path's three-step re-register (`TerminalView.tsx:4506-4508`). Fresh-agent codex panes wedge on `lost=true`: nothing on the reconnect path clears it (`sessionSnapshotReceived` does not; the boot-reconcile attach fold does not; the `.lost` recovery effect cannot re-fire without a dep change — `FreshAgentView.tsx:1726,2045-2077`). Opencode panes addressed by a placeholder id miss frames stamped with the materialized `ses_*` id (`opencode_ws.rs:1394-1397`). Claude attach acks hardcode `idle` (`claude.rs:1203,1373`), leaving stale-busy panes after a dead-window turn completion.
4. **Close→reopen dead-ends — but only off the negotiated WS door.** Sidebar close is detach-only; reopen issues `terminal.create{sessionRef}`. Load-bearing check LB-1 (validator report `reports/load-bearing-validator-LB-1.md`) behaviorally proved that on a `paneReconcileV1`-negotiated WS connection this create is always ADOPTED into the existing terminal (keyed arm / D8 `BoundElsewhere`) and never reaches D7. The `RESTORE_UNAVAILABLE` refusal provably fires only on the REST spawn doors (`crates/freshell-freshagent/src/terminal_tabs.rs:1223-1235`, no adopt arm exists there), on non-negotiated WS connections (mid-deploy stale bundles), and on the fresh-agent cross-kind owner arm. Where it fires, the pane dead-ends at `[Restore failed]` (`TerminalView.tsx:4897-4901`).

Existing reconnect machinery that MUST stay intact (regression surface): the per-connection revival trio (re-attach on `onReconnect` with generation-tagged `terminal.attach`; boot reconcile + verdict folds; legacy census fallback), the sender-level pre-verdict create hold (`RECONCILE_VERDICT_WAIT_MS`), RebindQueue flap safety for hidden fresh-agent panes, the ws-oracle parity pins, and PR #532 launch-retry semantics.

---

### Task 1: WS transport liveness — app-level ping watchdog + foreground reconnect poke

The client recycles a silently-dead socket into the existing reconnect machinery instead of waiting forever for `onclose`. Server-side WS pings are invisible to JS, so liveness is proven by an app-level `{type:'ping'}`→`{type:'pong'}` round trip that both servers already implement (`crates/freshell-ws/src/terminal.rs` Ping dispatch; legacy `server/ws-handler.ts:1832-1835`; pinned by `test/e2e-browser/specs/ws-ping-pong-matrix.spec.ts`).

**Mechanism (load-bearing LB-3, validated):** all four `scheduleReconnect` sites live inside `onclose` (`ws-client.ts:534/557/567/584`), and a dead transport cannot be trusted to deliver `onclose` promptly (or at all) in response to `ws.close()` — the browser close handshake has no reply to expect from a dead peer. So the recycle MUST NOT depend on the old socket's events: it **abandons** the socket — detaches every handler, generation-guards so a late event from the old socket is a no-op (validator LB-3 proved `connect()`'s bare `this.ws` swap corrupts the new connection otherwise), forces connection-local state down, and drives `connect()` immediately.

**Files:**
- Modify: `src/lib/ws-client.ts` (state block ~:120-150; `handleIncomingMessage` :231; `onopen` :454; `onmessage` :478; `onclose` :508; `disconnect` :644; add `tickLiveness`/`poke`/`clearLivenessWatch` methods)
- Modify: `src/App.tsx` (bootstrap effect ~:1470-1487: register/cleanup `visibilitychange`/`online`/`pageshow` listeners)
- Test: `test/unit/client/lib/ws-client.liveness.test.ts` (create)
- Test: `test/unit/client/components/App.ws-bootstrap.test.tsx` (add one wiring case)

**Interfaces:**
- Consumes: existing `sendNow`, `clearReconnectTimer`, `connect()`, `log` (client-logger), both servers' `ping`→`pong` shape.
- Produces: `WsClient.poke(): void` — re-asserts connectivity on foreground: while `ready`, probes or force-recycles a long-silent socket; while down, skips the throttled backoff wait and connects immediately. App's foreground listeners call it.

- [ ] **Step 1: Write the failing behavioral test**

Create `test/unit/client/lib/ws-client.liveness.test.ts`, mirroring the `MockWebSocket` harness and `vi.useFakeTimers()` setup of `test/unit/client/lib/ws-client.test.ts` (its lines 1-60), with a `connectReady(client)` helper that constructs a client, captures the latest `MockWebSocket.instances` entry, calls `_open()`, delivers `{type:'ready', bootId, serverInstanceId, capabilities:{...}}` via `_message`, and returns the socket:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WsClient, resetWsClientForTests } from '../../../../src/lib/ws-client'
// MockWebSocket class + connectReady helper copied from ws-client.test.ts's harness.

describe('WsClient liveness', () => {
  beforeEach(() => { /* identical harness setup: fake timers, WebSocket override, auth token */ })
  afterEach(() => { resetWsClientForTests(); vi.clearAllTimers(); vi.useRealTimers() })

  it('sends an app-level ping after 30s of inbound silence while ready', async () => {
    const { socket } = await connectReady(new WsClient('ws://test/ws'))
    // Ready traffic itself was inbound activity. 10s ticks at t=10/20 skip
    // (silence < 30s); the t=30 tick sees silence === 30s and probes.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(socket.sent.some((s) => JSON.parse(s).type === 'ping')).toBe(true)
  })

  it('does not ping while inbound traffic keeps the socket fresh', async () => {
    const { socket } = await connectReady(new WsClient('ws://test/ws'))
    await vi.advanceTimersByTimeAsync(15_000)
    socket._message({ type: 'settings.updated', settings: {} }) // any inbound frame
    await vi.advanceTimersByTimeAsync(15_000)
    expect(socket.sent.some((s) => JSON.parse(s).type === 'ping')).toBe(false)
  })

  it('abandons a socket whose probe goes unanswered past the pong timeout — no reliance on its onclose', async () => {
    const { socket } = await connectReady(new WsClient('ws://test/ws'))
    await vi.advanceTimersByTimeAsync(30_000)          // probe sent
    expect(socket.sent.some((s) => JSON.parse(s).type === 'ping')).toBe(true)
    // The dead transport NEVER delivers onclose — that is the hazard under test.
    // t=30 tick probes; the t=40 tick sees probe age 10s >= PONG_TIMEOUT_MS and abandons.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(MockWebSocket.instances.length).toBe(2)     // fresh socket driven immediately
    const fresh = MockWebSocket.instances[1]
    fresh._open(); fresh._message(READY_MSG)           // fresh socket completes handshake
    socket._close(4002, 'late')                        // stale socket's LATE close arrives
    await vi.advanceTimersByTimeAsync(5_000)
    expect(MockWebSocket.instances.length).toBe(2)     // …and is ignored (generation guard)
  })

  it('clears the outstanding probe on any inbound message (no abandon while traffic flows)', async () => {
    const { socket } = await connectReady(new WsClient('ws://test/ws'))
    await vi.advanceTimersByTimeAsync(30_000)           // t=30: probe
    socket._message({ type: 'pong', timestamp: 'x' })  // probe cleared; silence restarts from t=30
    // Silence restarts at the last inbound frame, so feed periodic traffic:
    // at each 10s tick silence stays < 30s and no further probe is needed.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(20_000)
      socket._message({ type: 'settings.updated', settings: {} })
    }
    expect(MockWebSocket.instances.length).toBe(1)     // never abandoned
  })

  it('re-probes on persistent silence and abandons when the repeat probe also goes unanswered', async () => {
    const { socket } = await connectReady(new WsClient('ws://test/ws'))
    await vi.advanceTimersByTimeAsync(30_000)           // t=30: probe #1
    socket._message({ type: 'pong', timestamp: 'x' })  // t=30: cleared
    await vi.advanceTimersByTimeAsync(40_000)           // t=60: probe #2; t=70: unanswered 10s → abandon
    expect(MockWebSocket.instances.length).toBe(2)
  })

  it('poke() while ready and recently active sends an immediate probe', async () => {
    const { client, socket } = await connectReady(new WsClient('ws://test/ws'))
    client.poke()
    expect(socket.sent.some((s) => JSON.parse(s).type === 'ping')).toBe(true)
  })

  it('poke() after 65s+ of silence abandons immediately instead of waiting out the probe', async () => {
    const { client, socket } = await connectReady(new WsClient('ws://test/ws'))
    // Simulate a frozen tab: no timers ran (background clamp) but the wall
    // clock jumped past the keepalive window threshold.
    vi.setSystemTime(Date.now() + 65_000)
    client.poke()                                      // no onclose delivery from the dead socket
    expect(socket.sent.some((s) => JSON.parse(s).type === 'ping')).toBe(false) // no probe wait
    expect(MockWebSocket.instances.length).toBe(2)     // abandoned into a fresh socket
    vi.setSystemTime(Date.now() - 65_000)
  })

  it('poke() while disconnected skips the pending backoff wait and connects now', async () => {
    const { client } = await connectReady(new WsClient('ws://test/ws'))
    MockWebSocket.instances[0]._close(4002, 'boom')    // transient → scheduleReconnect armed (1s+)
    client.poke()
    expect(MockWebSocket.instances.length).toBe(2)     // connected without advancing timers
  })

  it('stops probing after disconnect()', async () => {
    const { client, socket } = await connectReady(new WsClient('ws://test/ws'))
    client.disconnect()
    const sentCount = socket.sent.length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(socket.sent.length).toBe(sentCount)
  })
})
```

(`READY_MSG` is a shared fixture object `{type:'ready', bootId:'b1', serverInstanceId:'s1', capabilities:{}}` declared beside `connectReady`; every abandon test uses it for the fresh socket's handshake.)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/lib/ws-client.liveness.test.ts`

Expected: FAIL because `'ping'` frames are never sent, `client.poke is not a function`, and no recycle occurs — the missing behavior, not a setup accident.

- [ ] **Step 3: Add the minimal production implementation**

`src/lib/ws-client.ts`:

```ts
// Constants (top of file, next to CONNECTION_TIMEOUT_MS):
// 10s tick so a probe's 10s timeout is re-evaluated 10s after it was sent
// (a 30s tick would delay abandonment to t=60 — fresh-eyes F1). Probe fires
// once inbound silence reaches 30s (both servers' keepalive cadence); the
// foreground abandon threshold is >2 server keepalive windows.
const LIVENESS_TICK_MS = 10_000
const PROBE_AFTER_SILENCE_MS = 30_000
const PONG_TIMEOUT_MS = 10_000
const FOREGROUND_RECYCLE_SILENCE_MS = 65_000

// Class state:
private lastInboundAt = 0
private probeSentAt: number | null = null
private livenessTimer: number | null = null
```

In `handleIncomingMessage` (top): `this.lastInboundAt = Date.now(); this.probeSentAt = null` — any parsed inbound frame is liveness evidence (a socket relaying traffic is not half-open).

In `onopen`: `this.lastInboundAt = Date.now(); this.probeSentAt = null; this.startLivenessWatch()`.

New state + methods (the abandon mechanism replaces any reliance on the old socket's own events — LB-3):

```ts
// Bumped for every new WebSocket; each socket's handlers capture their
// generation and no-op once superseded (a late event from an abandoned socket
// must never touch the live connection's state).
private socketGen = 0

private startLivenessWatch(): void {
  this.clearLivenessWatch()
  this.livenessTimer = window.setInterval(() => this.tickLiveness(), LIVENESS_TICK_MS)
}

private clearLivenessWatch(): void {
  if (this.livenessTimer !== null) { window.clearInterval(this.livenessTimer); this.livenessTimer = null }
  this.probeSentAt = null
}

private tickLiveness(): void {
  if (this._state !== 'ready' || !this.ws || this.ws.readyState !== WebSocket.OPEN) return
  const now = Date.now()
  if (this.probeSentAt !== null) {
    if (now - this.probeSentAt >= PONG_TIMEOUT_MS) {
      this.abandonStaleSocket('liveness probe unanswered')
    }
    return
  }
  if (now - this.lastInboundAt < PROBE_AFTER_SILENCE_MS) return
  this.probeSentAt = now
  this.sendNow({ type: 'ping' })
}

/**
 * Half-open socket disposal. A dead transport cannot be trusted to deliver
 * onclose promptly (or ever), so recycling never waits on the old socket's
 * events: handlers detach, connection-local state is forced down, and a fresh
 * connect is driven NOW. The generation guard makes the old socket's late
 * events no-ops (LB-3: the bare this.ws swap in connect() would otherwise let
 * the old onclose corrupt the new connection).
 */
private abandonStaleSocket(reason: string): void {
  const old = this.ws
  if (old) {
    old.onopen = null
    old.onmessage = null
    old.onclose = null
    old.onerror = null
    try { old.close() } catch { /* best effort: resource hygiene only */ }
  }
  this.ws = null
  this._state = 'disconnected'
  this.serverCapabilities = {}
  this.resetReconcileHold({ requeueHeld: true })
  this.clearLivenessWatch()
  // Fresh-eyes F2-2: a normal close notifies disconnectHandlers (App flips
  // Redux connection.status at App.tsx:766-773) — abandonment must too, or
  // Redux sits at 'ready' forever and every status-keyed recovery (Task 4's
  // disconnected→ready transition; the Task 8 freeze sampler) wedges.
  this.disconnectHandlers.forEach((h) => h())
  log.warn(`abandoning stale socket: ${reason}`)
  this.connect().catch((err) => log.debug('reconnect after abandon failed', err))
}

/**
 * Foreground poke: re-assert connectivity when the page becomes visible/online.
 * - ready + recently active   → probe immediately (fast failure discovery).
 * - ready + silent past two server keepalive windows → abandon: the peer may
 *   already be reaped, and reconnect convergence is cheaper than the probe wait.
 * - down with a (possibly background-clamped) backoff timer pending → connect now.
 */
poke(): void {
  if (this.intentionalClose) return
  if (this._state === 'ready') {
    if (this.probeSentAt !== null && Date.now() - this.probeSentAt >= PONG_TIMEOUT_MS) {
      this.abandonStaleSocket('foreground poke: outstanding probe expired')
      return
    }
    if (Date.now() - this.lastInboundAt >= FOREGROUND_RECYCLE_SILENCE_MS) {
      this.abandonStaleSocket('foreground poke past keepalive windows')
      return
    }
    // Foreground means "ask now": probe immediately, bypassing the 30s silence
    // gate (fresh-eyes F1 — routing this through tickLiveness's guard could
    // never fire the immediate probe the tests pin).
    if (this.probeSentAt === null) {
      this.probeSentAt = Date.now()
      this.sendNow({ type: 'ping' })
    }
    return
  }
  if (this.connectPromise) return
  if (this._state === 'connecting') return
  this.clearReconnectTimer()
  this.connect().catch((err) => log.debug('poke reconnect failed', err))
}
```

Generation guard inside `connect()` — after `this.ws = new WebSocket(this.url)`:

```ts
const gen = ++this.socketGen
const socket = this.ws
// Each handler starts with: if (gen !== this.socketGen || this.ws !== socket) return
```

Apply that one-line guard at the top of the `onopen`, `onmessage`, `onclose`, and `onerror` handlers. Also bump `this.socketGen` in `disconnect()` so a torn-down socket's late events are inert. Call `this.clearLivenessWatch()` in `onclose` (with the other clears) and in `disconnect()`.

`src/App.tsx` bootstrap effect (next to the `cleanupPromise`/cleanup return, ~:1476-1487):

```ts
const ws = getWsClient()
const pokeWs = () => ws.poke()
const pokeWsWhenVisible = () => { if (document.visibilityState === 'visible') ws.poke() }
window.addEventListener('online', pokeWs)
window.addEventListener('pageshow', pokeWs)
document.addEventListener('visibilitychange', pokeWsWhenVisible)
// ... cleanup: remove the three listeners.
```

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/lib/ws-client.liveness.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx`

Expected: PASS (add one poke-wiring case to the bootstrap suite: dispatch a `visibilitychange` event with the document visible and assert a spy on `WsClient.prototype.poke` fired).

- [ ] **Step 5: Refactor while green**

Keep constants exported only if a test import needs them; otherwise private. No further refactor — single-purpose methods.

- [ ] **Step 6: Run impacted-test verification**

The timer/filter changes touch every ws-client behavior suite plus the offline-chip/App bootstrap path and the client activity-callback wiring.

Run: `npm run test:vitest -- run test/unit/client/lib/ws-client.test.ts test/unit/client/lib/ws-client.reconnect-noise.test.ts test/unit/client/lib/ws-client.reconcile.test.ts test/unit/client/lib/ws-client.liveness.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/App.restart-signals.test.tsx test/e2e/turn-complete-notification-flow.test.tsx`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add src/lib/ws-client.ts src/App.tsx test/unit/client/lib/ws-client.liveness.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx
git commit -m "fix(ws): recycle silently-dead sockets via app-level liveness probe + foreground poke"
```

### Task 2: Boot-reconcile bounded wait (client) + explicit refusal on non-negotiated connections (server)

A lost `pane.reconcile.result` must no longer wedge panes pending-verdict forever. Client side: after sending the boot request, App arms a 10s wall-clock timer (server's single warming deferral is 2s — `crates/freshell-ws/src/terminal.rs:4412-4430`); on expiry with the request still pending it runs the same teardown the correlated-error path already runs (`fallBackToLegacyCensus`). Server side: a `pane.reconcile.request` arriving on a connection that did not negotiate `paneReconcileV1` gets an explicit terminal error carrying the reconcileId, so post-reconcile clients fall back instantly and pre-reconcile clients never send the request at all.

**Files:**
- Modify: `src/lib/pane-reconcile.ts` (export the new constant)
- Modify: `src/App.tsx` (~:1034-1141 ready/reconcile handlers; disconnect handler ~:766-773)
- Modify: `crates/freshell-protocol/src/common.rs` (new `ErrorCode` variant; the enum lives at common.rs:74)
- Modify: `crates/freshell-ws/src/terminal.rs` (:1232-1243 PaneReconcileRequest dispatch arm)
- Test: `test/unit/client/components/App.reconcile-adoption.test.tsx` (add cases)
- Test: `crates/freshell-ws/src/terminal.rs` `#[cfg(test)]` module (add rust test)

**Interfaces:**
- Consumes: existing `fallBackToLegacyCensus`, `pendingReconcileRef`, `clearReconcileCreateHold`, `clearAllReconcilePendingPanes`; server `ErrorMsg` struct + `send(ws_tx, …)`.
- Produces: `export const RECONCILE_RESULT_WAIT_MS = 10_000` (pane-reconcile.ts); wire error code `RECONCILE_NOT_NEGOTIATED` (string) on `error` frames carrying `requestId = <reconcileId>`.

- [ ] **Step 1: Write the failing behavioral test**

Client — in `test/unit/client/components/App.reconcile-adoption.test.tsx` (existing harness drives ready frames + reconcile result frames; follow its conventions):

```ts
it('falls back to the legacy census when no reconcile result arrives within 10s', async () => {
  // ... boot a ready frame with paneReconcileV1 acknowledged and one live-terminal-less pane;
  await vi.advanceTimersByTimeAsync(10_000)
  // assert: pane no longer reconcile-pending and the census cleared its dead handle:
  const paneContent = /* select the pane */
  expect(paneContent.pendingReconcile).toBeUndefined()
  expect(paneContent.terminalId).toBeUndefined() // census wiped the stale handle
  expect(paneContent.status).toBe('creating')    // census re-armed the create path
})

it('does NOT run the census when the result folds before the wait expires', async () => {
  // ... fold a normal attach verdict at t=2s; advance past 10s; assert no census ran
  // (pane keeps its verdict-written terminalId; clearDeadTerminals never fired).
})

it('cancels the result wait on disconnect (no offline census)', async () => {
  // ... ready + pending request, then deliver the ws disconnect path;
  await vi.advanceTimersByTimeAsync(15_000)
  // assert: NO census ran while disconnected (pane content unchanged, no clearDeadTerminals fold)
})
```

Server — in the `terminal.rs` test module (follow its existing `handle_client_text` harness conventions):

```rust
#[tokio::test]
async fn pane_reconcile_request_without_capability_gets_explicit_error() {
    // Arrange a connection state with pane_reconcile_v1 = false, feed a
    // PaneReconcileRequest frame with reconcile_id "r1".
    // Assert the captured outgoing frame is error{code:"RECONCILE_NOT_NEGOTIATED",
    // request_id:"r1"} — previously the arm returned true with no frame.
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/App.reconcile-adoption.test.tsx`

Expected: FAIL because the pending pane never resolves without a result (new timeout behavior missing).

Run: `cargo test -p freshell-ws pane_reconcile_request_without_capability_gets_explicit_error`

Expected: FAIL because no error frame is emitted (accept-and-strip today), not a compile/setup accident (the new `ErrorCode` variant will not exist yet — add the variant first if the red run needs compilation; that edit alone does not change behavior).

- [ ] **Step 3: Add the minimal production implementation**

`src/lib/pane-reconcile.ts` top: `export const RECONCILE_RESULT_WAIT_MS = 10_000 // > the server's single 2s warming deferral + round-trip margin`.

`src/App.tsx`:

```ts
const reconcileResultTimerRef = useRef<number | null>(null)
const clearReconcileResultWait = () => {
  if (reconcileResultTimerRef.current !== null) {
    window.clearTimeout(reconcileResultTimerRef.current)
    reconcileResultTimerRef.current = null
  }
}
```

In the ready branch, immediately after `ws.send(req)`:

```ts
clearReconcileResultWait()
reconcileResultTimerRef.current = window.setTimeout(() => {
  reconcileResultTimerRef.current = null
  if (!pendingReconcileRef.current) return
  // The result is unicast to THIS socket; if it was lost with a dying socket,
  // only ANOTHER ready would heal the wedge (gray panes, zero chrome). Bound
  // the wait and degrade to the legacy census instead. This supersedes the
  // earlier deliberate no-timeout decision: the wedge it permits is the
  // reported gray-and-dead shape.
  log.warn('[reconcile] result wait expired — falling back to legacy census')
  pendingReconcileRef.current = null
  dispatch(clearAllReconcilePendingPanes())
  ws.clearReconcileCreateHold()
  fallBackToLegacyCensus()
}, RECONCILE_RESULT_WAIT_MS)
```

In the `pane.reconcile.result` branch: call `clearReconcileResultWait()` right where `pendingReconcileRef.current = null` runs (fold and malformed paths alike). In the correlated `error` branch: same. In App's disconnect handling (where connection status flips away): `clearReconcileResultWait(); pendingReconcileRef.current = null` — the next ready re-sends the request; never census from stale inventory while offline.

`crates/freshell-protocol/src/common.rs` (:74) — add to `ErrorCode`:

```rust
/// pane.reconcile.request arrived on a connection that did not negotiate
/// paneReconcileV1: terminal for that request (the client falls back to the
/// legacy inventory census). Never emitted to pre-reconcile clients — they
/// never send the request.
#[serde(rename = "RECONCILE_NOT_NEGOTIATED")]
ReconcileNotNegotiated,
```

`crates/freshell-ws/src/terminal.rs` (:1232-1243 arm):

```rust
ClientMessage::PaneReconcileRequest(request) => {
    if pane_reconcile_v1 {
        return handle_pane_reconcile(request, ws_tx, state, pane_reconcile_fresh_agent_v1)
            .await;
    }
    // Capability not negotiated on THIS connection: answer explicitly so the
    // client falls back to the legacy census NOW instead of wedging every
    // pane pending-verdict until the next reconnect.
    send(
        ws_tx,
        &ServerMessage::Error(ErrorMsg {
            code: ErrorCode::ReconcileNotNegotiated,
            message: "pane.reconcile was not negotiated on this connection; fall back to the inventory census.".to_string(),
            timestamp: crate::now_iso(),
            actual_session_ref: None,
            expected_session_ref: None,
            request_id: Some(request.reconcile_id.clone()),
            retry_after_ms: None,
            terminal_exit_code: None,
            terminal_id: None,
        }),
    )
    .await;
    true
}
```

(`PaneReconcileRequest.reconcile_id` confirmed at `crates/freshell-protocol/src/client_messages.rs:447-453`; `send`/`ws_tx` usage mirrors the adjacent `Ping` arm.)

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/App.reconcile-adoption.test.tsx && cargo test -p freshell-ws pane_reconcile_request_without_capability_gets_explicit_error`

Expected: PASS

- [ ] **Step 5: Refactor while green**

None beyond the shared `clearReconcileResultWait` helper — the three teardown call sites stay inline (they read as one deliberate sequence).

- [ ] **Step 6: Run impacted-test verification**

Reconcile adoption/waiting, census fallback, restart signals, and the verdict-wait pane gate are the collision surface; the ErrorCode enum grow touches the port-oracle enum pins.

Run: `npm run test:vitest -- run test/unit/client/components/App.reconcile-adoption.test.tsx test/unit/client/components/App.restart-signals.test.tsx test/unit/client/components/TerminalView.verdict-wait.test.tsx test/e2e/terminal-restart-recovery.test.tsx test/unit/port/oracle/t2-invariants.test.ts test/unit/port/oracle/mutation-validation.test.ts && cargo test -p freshell-ws reconcile && cargo test -p freshell-protocol`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add src/lib/pane-reconcile.ts src/App.tsx crates/freshell-protocol/src/common.rs crates/freshell-ws/src/terminal.rs test/unit/client/components/App.reconcile-adoption.test.tsx
git commit -m "fix(reconcile): bound the boot-result wait and answer non-negotiated requests explicitly"
```

### Task 3: Hidden terminal panes pump their reconnect rehydration

On reconnect, a hidden terminal pane whose parser checkpoint is unusable registers with the hydration queue with `queueIfStarted:false`, so with the queue already started it sits registered-but-never-pumped until reveal — a gray background tab that looks exactly like the bug. Mirror the proven three-step re-register of the `terminal.created`-while-hidden path (`TerminalView.tsx:4506-4508`).

**Files:**
- Modify: `src/components/TerminalView.tsx` (:5191-5208 `onReconnect` hidden branch)
- Test: `test/unit/client/components/TerminalView.hidden-rebind.test.tsx` and/or `TerminalView.lifecycle.test.tsx` (add cases; the lifecycle :7942 region already covers reconnect-before-first-hidden-attach)

**Interfaces:**
- Consumes: `getHydrationQueue().onHydrationComplete`, `hydrationRegisteredRef`, `registerForBackgroundHydration({ queueIfStarted })`.
- Produces: none new (behavioral parity).

- [ ] **Step 1: Write the failing behavioral test**

Add to the hidden-rebind/lifecycle suite:

```ts
it('pumps the hydration queue for a hidden pane on reconnect even without a usable parser checkpoint', async () => {
  // Arrange: hidden pane with a live terminalId; hydration queue already STARTED
  // (active tab hydrated first); NO parser-applied checkpoint for the terminal,
  // so getCheckpointDeltaReplayDecision(tid) is not ok.
  simulateReconnect()
  // Act: let the hydration pump run (the queue drives one pane at a time).
  // Assert: a terminal.attach left the client for the hidden pane WITHOUT a
  // reveal, intent 'viewport_hydrate' (checkpoint-missing branch), and the
  // queue advanced past this pane (subsequent registered hidden pane also pumped).
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/TerminalView.hidden-rebind.test.tsx`

Expected: FAIL because no attach is sent for the hidden pane until reveal (today's `queueIfStarted:false` path), not a harness error.

- [ ] **Step 3: Add the minimal production implementation**

`TerminalView.tsx` :5191-5208 — in the `onReconnect` hidden branch, replace the bare register call with the same three-step preflight the `terminal.created` hidden branch uses:

```ts
// Same three-step re-register as the terminal.created hidden path
// (~:4506): a stale active slot or a consumed registration guard
// otherwise wedges this pane out of the post-reconnect pump entirely.
getHydrationQueue().onHydrationComplete(paneIdRef.current)
hydrationRegisteredRef.current = false
// Always queueIfStarted: a hidden pane's reattach must not wait for reveal.
// The deferred intent chosen above (transport_reconnect vs viewport_hydrate)
// still governs WHAT the attach asks for; this only governs THAT it runs.
registerForBackgroundHydration({ queueIfStarted: true })
```

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/TerminalView.hidden-rebind.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Factor the three-line re-register into one local helper used by both the `terminal.created` hidden branch and the reconnect hidden branch if the reviewer prefers DRY over deliberate duplication; either is acceptable — state the choice in the commit.

- [ ] **Step 6: Run impacted-test verification**

Hidden rebind, visibility transitions, hydration queue consumers, attach policy:

Run: `npm run test:vitest -- run test/unit/client/components/TerminalView.hidden-rebind.test.tsx test/unit/client/components/TerminalView.visibility.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/lib/hydration-queue.rebind.test.ts test/unit/client/lib/terminal-attach-policy.test.ts test/e2e/terminal-create-attach-ordering.test.tsx`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add src/components/TerminalView.tsx test/unit/client/components/TerminalView.hidden-rebind.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "fix(terminal): pump hidden-pane rehydration on reconnect instead of waiting for reveal"
```

### Task 4: Fresh-agent `lost` revokes on truth-bearing reconnect evidence

A codex (or claude) fresh-agent pane whose session slice entry got `lost=true` (spurious `INVALID_SESSION_ID` from a transient attach-resume race during the dead window) wedges forever: the snapshot fetch is suppressed (`FreshAgentView.tsx:1726`) and no reconnect path clears the flag. Three moves, all on the reconnect path: (a) a truth-bearing server answer revokes `lost`, (b) the server-authoritative `Live → attach` verdict fold revokes it, (c) the `.lost` recovery effect re-fires on a fresh reconnect even when its other deps are unchanged.

**Files:**
- Modify: `src/store/freshAgentSlice.ts` (`sessionSnapshotReceived` :293-328; `freshAgentSnapshotReceived` :374-399)
- Modify: `src/lib/pane-reconcile.ts` (fresh-agent attach-verdict fold, ~:300)
- Modify: `src/components/fresh-agent/FreshAgentView.tsx` (`.lost` recovery effect deps :2045-2077)
- Test: `test/unit/client/store/freshAgentSlice.test.ts` (add cases; create the file only if absent — check first)
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx` (add cases)

**Interfaces:**
- Consumes: existing `clearSessionLost` reducer (`freshAgentSlice.ts:475-481`), `applyFreshAgentReconcileAttach` fold, `state.connection.status`.
- Produces: none new.

- [ ] **Step 1: Write the failing behavioral test**

Slice: `sessionSnapshotReceived` and `freshAgentSnapshotReceived` each clear `lost` on the addressed session (a snapshot answer is positive evidence the session exists — the 404 `FRESH_AGENT_LOST_SESSION` path never dispatches these).

View fold: with a codex pane `lost=true`, no sessionId change possible (durable id already), delivering a fresh-agent `attach` verdict via the boot reconcile fold clears `lost` in the freshAgent slice and the next snapshot-fetch effect run issues the HTTP GET (spy on `fetch`).

Reconnect re-drive: with the pane still `lost=true` and NO verdict (reconcile absent), flipping `connection.status` `'disconnected' → 'ready'` re-runs the `.lost` recovery effect (spy `reconcileLostPane`/`triggerRecovery`). Negative case (fresh-eyes F4): flipping `'ready' → 'disconnected'` does NOT run recovery (no offline session-id clearing / create minting — recovery only acts on post-reconnect evidence).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/store/freshAgentSlice.test.ts test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx`

Expected: FAIL because `lost` stays true through all three paths (today's behavior), not a harness mistake.

- [ ] **Step 3: Add the minimal production implementation**

`freshAgentSlice.ts` — in `sessionSnapshotReceived` after `resolveOrEnsureSession` succeeds, and in `freshAgentSnapshotReceived` after `ensureSession`:

```ts
// Truth-bearing frame: a snapshot answer proves the session exists — revoke a
// stale `lost` flag from a transient dead-window race (reconnect unwedge).
session.lost = false
```

`pane-reconcile.ts` — in the fresh-agent `attach` verdict fold, immediately after dispatching `applyFreshAgentReconcileAttach`:

```ts
// Server said Live: the verdict itself is positive existence evidence.
dispatch(clearSessionLost({ sessionId: <verdict locator sessionId>, sessionType: <…>, provider: <…> }))
```

(Locator fields come from the verdict's `sessionRef` / pane entry following the adjacent `applyFreshAgentReconcileAttach` payload shape; import `clearSessionLost` from the slice.)

`FreshAgentView.tsx` — add a selector `const connectionStatus = useAppSelector((s) => s.connection.status)`, add `connectionStatus` to the `.lost` recovery effect's dep array (:2069-2077 region), AND gate the effect body: `if (connectionStatus !== 'ready') return` immediately after the provider/lost guards (fresh-eyes F4: without the gate the dep also fires on ready→disconnected, and `triggerRecovery()` could clear the pane's session id / mint a create request while offline — before any post-reconnect evidence exists).

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/store/freshAgentSlice.test.ts test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx`

Expected: PASS

- [ ] **Step 5: Refactor while green**

None — three one-line/one-call changes at the exact seams; any dedup would hide intent.

- [ ] **Step 6: Run impacted-test verification**

Fresh-agent slice contracts, reconcile folds, hidden rebind (its Test 2 pins `.lost` re-create), snapshot scheduler consumers:

Run: `npm run test:vitest -- run test/unit/client/store/freshAgentSlice.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.hidden-rebind.test.tsx test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/lib/pane-reconcile.test.ts`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add src/store/freshAgentSlice.ts src/lib/pane-reconcile.ts src/components/fresh-agent/FreshAgentView.tsx test/unit/client/store/freshAgentSlice.test.ts test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx
git commit -m "fix(fresh-agent): revoke stale session-lost flags on truth-bearing reconnect evidence"
```

### Task 5: Opencode placeholder-addressed attach ack re-keys the pane

Opencode's tracked-attach ack is stamped with the materialized `ses_*` id (`opencode_ws.rs:1394-1397`). A pane still addressed by its placeholder id cannot correlate that ack (its `locatorMatchesPane` filter drops it), keeps the placeholder identity, and its next snapshot GET 404s into a false `durable_artifact_missing` against a live session. The server already has the `freshAgent.session.materialized` wire event and the client already folds it into BOTH the slice and pane content (`fresh-agent-ws.ts:154-176`, `materializeFreshAgentPaneSession`) — emit it on this path too.

**Files:**
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs` (`handle_attach` tracked arm :1394-1410)
- Test: `crates/freshell-freshagent/src/opencode_ws.rs` `#[cfg(test)]` (add rust test)
- Test: `test/unit/client/lib/fresh-agent-ws.test.ts` (add a fold case)

**Interfaces:**
- Consumes: existing `FreshAgentSessionMaterialized` protocol struct and the send-path emitter shape at `opencode_ws.rs:716-730`.
- Produces: on a tracked `freshAgent.attach` whose request `session_id` is a placeholder alias (differs from the session's real/materialized id), the server broadcasts `freshAgent.session.materialized{previousSessionId, sessionId: real, sessionType, provider, sessionRef}` immediately BEFORE the ack snapshot (stamped real id).

- [ ] **Step 1: Write the failing behavioral test**

Rust: attach a tracked session by its placeholder id → assert the broadcast sequence includes `freshAgent.session.materialized{previousSessionId: <placeholder>, sessionId: <ses_*>}` followed by `freshAgent.session.snapshot` stamped with `<ses_*>`; and that attaching by the real id emits NO materialized frame (regression guard against spam when identity already matches).

Client (fresh-agent-ws.test.ts): feeding a `freshAgent.session.materialized` frame for a placeholder-keyed pane dispatches both the slice `materializeSession` and the pane-content sessionId re-key (this may already pass — keep as the fold pin proving Task 5 needs no client change).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-freshagent attach_placeholder_addressed_session_emits_materialized_first`

Expected: FAIL because no materialized frame is emitted on the attach ack arm today, not a compile accident.

- [ ] **Step 3: Add the minimal production implementation**

In `handle_attach`'s tracked arm, before the snapshot broadcast:

```rust
// Attach addressed by the PLACEHOLDER id of an already-materialized session:
// the requesting pane cannot correlate frames stamped with the real ses_* id
// (locatorMatchesPane), so its snapshot fetch would 404 into a false
// restore-error. Re-key it first via the same wire event the send path uses
// (:716-730) — the client fold updates slice AND pane content.
if let Some(real_id) = session_real_id.as_ref() {        // existing real_session_id source
    if real_id != &msg.session_id {
        self.broadcast(&ServerMessage::FreshAgentSessionMaterialized(
            FreshAgentSessionMaterialized {
                previous_session_id: msg.session_id.clone(),
                provider: PROVIDER.to_string(),
                session_id: real_id.clone(),
                session_type: SESSION_TYPE.to_string(),
                session_ref: Some(SessionLocator {
                    provider: PROVIDER.to_string(),
                    session_id: real_id.clone(),
                }),
            },
        ));
    }
}
```

(Use the variable the tracked arm already holds for the real/placeholder pair; the ack snapshot itself stays stamped per the existing `real_session_id ?? placeholder` rule.)

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-freshagent attach_placeholder && npm run test:vitest -- run test/unit/client/lib/fresh-agent-ws.test.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

If the send-path materialized construction and this one now duplicate, extract one `materialized_frame(previous, real) -> ServerMessage` helper in `opencode_ws.rs` and use both call sites.

- [ ] **Step 6: Run impacted-test verification**

The opencode attach/ack pins and the materialization-once pins:

Run: `cargo test -p freshell-freshagent && npm run test:vitest -- run test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/store/freshAgentSlice.test.ts test/unit/port/oracle/t2-opencode-equivalence-rust.test.ts`

Expected: PASS. LB-6 validation settled the pin surface: the only exactly-once pin (`opencode_ws.rs:2688`) covers the send path; no attach-arm test pins the emitted sequence for opencode; the differential oracle never drives an opencode attach addressed by a placeholder id and its baseline projection is duplicate-insensitive. **Constraint recorded by validation: this task must stay OPENCODE-arm-only** — codex's attach arm IS sequence-pinned by the wireshape differential and must not gain any new frame.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/opencode_ws.rs test/unit/client/lib/fresh-agent-ws.test.ts
git commit -m "fix(opencode): re-key placeholder-addressed panes on attach ack via the materialized event"
```

### Task 6: Claude attach ack carries the session's real status

Both claude attach-ack emit sites broadcast a hardcoded `"idle"` snapshot (`claude.rs:1200-1205` rebind arm, `:1370-1375` resume-for-attach arm). Attaching while a turn is actually running flips the pane to idle (composer mode churn), and — because claude never adopts HTTP snapshot status — a turn that completed in the dead window can leave the pane stale-busy forever when the ack path is the rescuer. Track the last announced status per session and speak it truthfully.

**Files:**
- Modify: `crates/freshell-freshagent/src/claude.rs` (`ClaudeSession` struct :186-210; both ack sites :1200-1205,:1370-1375; `spawn_consumer` :1414+ status fold)
- Test: `crates/freshell-freshagent/src/claude.rs` `#[cfg(test)]` (adjust/extend around the existing :2344/:2431 ack assertions)

**Interfaces:**
- Consumes: the stdout consumer's existing `sdk.status → freshAgent.status` translation (where `normalize_sdk_type`-renamed frames are folded per session).
- Produces: `ClaudeSession.last_status: Arc<std::sync::Mutex<String>>` (default `"idle"`), written on every `sdk.status` fold and read by both attach-ack sites.

- [ ] **Step 1: Write the failing behavioral test**

```rust
#[tokio::test]
async fn attach_rebind_ack_stamps_the_tracked_live_status_not_hardcoded_idle() {
    // Arrange a tracked live claude session; drive an sdk.status { status: "running" }
    // through the consumer; then attach addressing the durable id (rebind arm).
    // Assert the ack snapshot's event.status == "running" (not "idle").
}

#[tokio::test]
async fn attach_ack_stays_idle_for_a_freshly_resumed_session() {
    // No sdk.status ever folded → ack still "idle" (pins the default).
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-freshagent attach_rebind_ack_stamps_the_tracked_live_status_not_hardcoded_idle`

Expected: FAIL because the ack carries the hardcoded `"idle"` while the session status is `"running"`, not a harness mistake.

- [ ] **Step 3: Add the minimal production implementation**

```rust
struct ClaudeSession {
    // ...existing fields...
    /// Last status the sidecar announced for this session (sdk.status fold).
    /// Read by the attach-ack sites so a reconnect ack tells the truth instead
    /// of the hardcoded "idle" that used to wedge stale-busy/stale-idle panes.
    last_status: Arc<std::sync::Mutex<String>>,
}
```

Initialize `"idle"` at every `ClaudeSession` construction site. In `spawn_consumer`'s event fold (where `sdk.status` frames are handled for broadcast): `*session.last_status.lock().expect("…") = status_value.clone()`. At both `status_snapshot_frame(..., "idle", ...)` call sites, substitute `session.last_status.lock().expect("…").as_str()` (or clone). Fresh resume (`resume_for_attach`) starts at `"idle"` — correct, and this arm's ack remains truthful by construction.

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-freshagent attach_ack && cargo test -p freshell-freshagent status_snapshot`

Expected: PASS

- [ ] **Step 5: Refactor while green**

If locking ceremony repeats, add `fn current_status(&self) -> String` on `ClaudeSession`.

- [ ] **Step 6: Run impacted-test verification**

The claude provider suite and the differential captures that pin ack CONTENT for these arms:

Run: `cargo test -p freshell-freshagent claude && npm run test:vitest -- run test/unit/port/oracle/t2-invariants.test.ts test/unit/client/lib/fresh-agent-ws.test.ts`

Expected: PASS (if the oracle pins a hardcoded-idle capture on an arm whose tracked status changed, update per the oracle refresh procedure and record it).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/claude.rs
git commit -m "fix(claude): attach ack announces the session's real last status"
```

### Task 7: Disarm the residual D7 refusal lanes (REST doors + non-negotiated windows)

Load-bearing LB-1 (falsified; `reports/load-bearing-validator-LB-1.md`): on negotiated WS connections, close→reopen already ADOPTS via the keyed/D8 arms — the D7 guard only fires on the REST spawn doors (no adopt arm), on non-negotiated WS connections, and on the fresh-agent cross-kind owner arm. So no client routing change is made (it would duplicate the adopt arms' semantics behind a staler cache — dropped under the scope rule). What remains: (a) every refusal that CAN name a live terminal carries its id, and (b) the client's create-error fold reattaches via that id instead of dead-ending — and the reattach MUST go through an epoch-bumping reducer (LB-5: plain `updateContent` does not re-fire the lifecycle effect; deps exclude `terminalId`/`status` by design, TerminalView.tsx:5349-5392).

**Files:**
- Modify: `crates/freshell-protocol/src/server_messages.rs` (`ErrorMsg` optional `live_terminal_id` field — next to `terminal_id`)
- Modify: `crates/freshell-ws/src/terminal.rs` (D7 guard ~:2580-2623: include `live_terminal_id`; `send_create_error` :4464-4482 sets `live_terminal_id: None`)
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs` (REST 409 :1223-1235: include `liveTerminalId` in the JSON body when a terminal owns the session)
- Modify: `shared/ws-protocol.ts` (error-message schema gains optional `liveTerminalId`)
- Modify: `src/store/panesSlice.ts` (new reducer next to `applyReconcileAttach` :1948-1985)
- Modify: `src/components/TerminalView.tsx` (create-error handler :4872-4901)
- Test: `test/unit/client/store/panesSlice.reconnect.test.ts` (or the slice's existing test home — check before creating)
- Test: `test/unit/client/components/TerminalView.lifecycle.test.tsx` (revive fold cases)
- Test: `test/e2e/terminal-create-attach-ordering.test.tsx` (jsdom full-pipeline revival fold — see Step 1 item 2b)
- Test: `crates/freshell-ws/src/terminal.rs` tests; `crates/freshell-freshagent/src/terminal_tabs.rs` tests

**Interfaces:**
- Consumes: `live_session_owner(...) -> Option<String>` (owner terminal id) at both guard sites; zod error schema in `shared/ws-protocol.ts`.
- Produces: wire `error.liveTerminalId?: string` (omitted when absent — frozen clients byte-identical); REST 409 body gains `liveTerminalId` only when a terminal owns the session; `applyReattachToLiveTerminal({ tabId, paneId, terminalId })` — panesSlice reducer that sets `terminalId`, `status:'running'`, clears `restoreError`, and bumps `reconcileEpoch` (mirroring `applyReconcileAttach`'s proven fold shape).

- [ ] **Step 1: Write the failing behavioral test**

1. panesSlice: `applyReattachToLiveTerminal` writes terminalId/status, clears restoreError, and bumps reconcileEpoch; it is a no-op for an unknown paneKey.
2. TerminalView revive fold: create-error `{code:'RESTORE_UNAVAILABLE', liveTerminalId:'t1', requestId}` → the pane's store state gains `terminalId:'t1'`/`status:'running'` via the new reducer, its bumped `reconcileEpoch` re-fires the lifecycle effect so a `terminal.attach` for `t1` leaves the client, and the pane shows a `Reconnected to the still-running session.` notice — never `[Restore failed]`; a SECOND RESTORE_UNAVAILABLE for the same createRequestId does NOT revive again (one-shot bound) and falls through to the existing error write.
2b. Full-pipeline proof (fresh-eyes F2-4): a jsdom-e2e case in `test/e2e/terminal-create-attach-ordering.test.tsx`'s real-App harness — a mounted TerminalView pane whose create draws the enriched refusal frame from the (mock-transport) wire → observe the reducer fold, the fresh `terminal.attach` for the named id, and the notice. A Playwright browser test cannot reach this fold: on negotiated WS connections the adopt arms absorb the create (LB-1) and the cross-kind arm correctly refuses without an id — so this jsdom full-pipeline level is the highest tier that can exercise the revival, and it joins the browser-side REST contract test (Task 8) that proves the server emits the field.
3. Rust WS: the D7 refusal frame carries `live_terminal_id: Some(<owner>)` when `registry_row_live` (owner known), and `None` on the fresh-agent cross-kind arm (no terminal id exists there — the refusal stands, the revival arm stays inert by design). Rust REST — note the REST door has NO cross-kind refusal at all (`rest_gate_skips_sidecar_live_candidate_create_proceeds_unchanged`, terminal_tabs.rs:5400-5443, pins cross-kind → 200 OK; do not add one — fresh-eyes F2-3): its two reachable refusals are D7-terminal-owner and D8-BoundElsewhere, and BOTH carry `liveTerminalId` (the latter from the claim's `terminal_id`).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/store/panesSlice.reconnect.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/terminal-create-attach-ordering.test.tsx` and `cargo test -p freshell-ws d7 && cargo test -p freshell-freshagent terminal_tabs`

Expected: FAIL because the reducer/revive/payload do not exist yet (`applyReattachToLiveTerminal` undefined; refusal payload lacks the id), not harness noise.

- [ ] **Step 3: Add the minimal production implementation**

Wire (`server_messages.rs`, next to `terminal_id`):

```rust
/// D7 (`RESTORE_UNAVAILABLE` only): the live terminal that owns the refused
/// session, so the client can reattach instead of dead-ending. Additive and
/// omitted everywhere else.
#[serde(skip_serializing_if = "Option::is_none")]
pub live_terminal_id: Option<String>,
```

Add `live_terminal_id: None` to EVERY other `ErrorMsg` literal — the complete site list (compile-checked): `crates/freshell-ws/src/terminal.rs` (incl. `send_create_error` :4464-4482), `crates/freshell-ws/src/create_dedupe.rs`, `crates/freshell-ws/src/lib.rs`, `crates/freshell-freshagent/src/claude.rs`, `crates/freshell-freshagent/src/codex.rs`, `crates/freshell-freshagent/src/opencode_ws.rs`. Omitting any fails compilation; the commit below stages every one of them. WS guard: capture `let owner = state.registry.live_session_owner(...)` once, set `registry_row_live = owner.is_some()`, and emit `live_terminal_id: owner` on the refusal. REST guard: put `liveTerminalId` in the D7 409 JSON body from the same owner. ALSO the REST door's D8 arm: `SessionRefClaim::BoundElsewhere { terminal_id }` currently maps to a nameless 409 discarding the id (`terminal_tabs.rs:1267-1281`) — carry `liveTerminalId: terminal_id` there too, so the claim-race refusal is equally attachable (fresh-eyes F5). `shared/ws-protocol.ts`: error schema gains `liveTerminalId: z.string().optional()`.

panesSlice (next to `applyReconcileAttach`):

```ts
/** Close→reopen revival: a D7 refusal named the live owner terminal — reattach
 * the pane to it. The reconcileEpoch bump is the lifecycle effect's ONLY
 * re-fire signal (createRequestId is preserved), mirroring applyReconcileAttach. */
applyReattachToLiveTerminal(state, action: PayloadAction<{ tabId: string; paneId: string; terminalId: string }>) {
  // ...same lookup/defensive shape as applyReconcileAttach: find the pane in
  // layouts, bail when absent; set content.terminalId, content.status='running',
  // content.restoreError=undefined, content.reconcileEpoch = (content.reconcileEpoch ?? 0) + 1
},
```

TerminalView fold (create-error handler, before the dead-end arms):

```ts
if (msg.code === 'RESTORE_UNAVAILABLE' && typeof msg.liveTerminalId === 'string') {
  // One revival per createRequestId: if the live handle died in the race, the
  // follow-on create lands the existing [Restore failed] path — never loop.
  if (reviveAttemptedRef.current !== reqId) {
    reviveAttemptedRef.current = reqId
    dispatch(applyReattachToLiveTerminal({ tabId, paneId: paneIdRef.current, terminalId: msg.liveTerminalId }))
    writeLocalXtermNotice(term, `\r\nReconnected to the still-running session.\r\n`)
    return
  }
}
```

(`reviveAttemptedRef: useRef<string | null>(null)`, reset when a new createRequestId is minted alongside the existing launch-attempt bookkeeping.)

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/store/panesSlice.reconnect.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/terminal-create-attach-ordering.test.tsx && cargo test -p freshell-ws d7 && cargo test -p freshell-freshagent terminal_tabs && npm run typecheck`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Keep the refusals' "still running on the server." message text byte-identical (client regexes and user muscle memory depend on it); all novelty rides the additive id field. If `applyReattachToLiveTerminal` and `applyReconcileAttach` share lookup/fold boilerplate, extract one private helper inside panesSlice rather than exporting a new utility.

- [ ] **Step 6: Run impacted-test verification**

Create-error handling (incl. `fresh_after_restore_unavailable`), restore/launch ladders, REST doors, oracle/error-contract pins:

Run: `npm run test:vitest -- run test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/lib/terminal-restore.test.ts test/unit/client/store/panesSlice.reconnect.test.ts test/unit/port/oracle/t2-invariants.test.ts && cargo test -p freshell-ws && cargo test -p freshell-freshagent && cargo test -p freshell-protocol`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add shared/ws-protocol.ts src/store/panesSlice.ts src/components/TerminalView.tsx crates/freshell-protocol/src/server_messages.rs crates/freshell-ws/src/terminal.rs crates/freshell-ws/src/create_dedupe.rs crates/freshell-ws/src/lib.rs crates/freshell-freshagent/src/terminal_tabs.rs crates/freshell-freshagent/src/claude.rs crates/freshell-freshagent/src/codex.rs crates/freshell-freshagent/src/opencode_ws.rs test/unit/client/store/panesSlice.reconnect.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/terminal-create-attach-ordering.test.tsx
git commit -m "fix(reopen): D7 refusals name the live owner; the pane reattaches instead of dead-ending"
```

### Task 8: E2E acceptance — reconnect revives (Rust server)

First-class browser proof of the user-visible acceptance shape on the production server stack, closing the named coverage gaps (rust-side plain socket drop; "stops being gray/dead" assertions; the refusal-lane disarm; sequential drops mid-reattach; a fresh-agent in-place socket drop). Load-bearing adjustments folded in (LB-1/LB-4): negotiated close→reopen already adopts on base, so the red-first refusal coverage lives at the REST door; the foreground-recycle window is unit-covered only (real visibilitytransition is not drivable in headless Playwright); server-SIGSTOP is the e2e dead-peer shape.

**Files:**
- Create: `test/e2e-browser/specs/reconnect-revive-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (register `/reconnect-revive-rust\.spec\.ts$/` in BOTH `RUST_ONLY_SPECS` :176 and the `rust-chromium` project `testMatch` list, matching the convention of the neighboring entries) and confirm it is NOT in `CLOUD_SKIP_SPECS` (`playwright.cloud.config.ts`)
- Test: (the spec IS the test)

**Interfaces:**
- Consumes: fixtures `freshellPage`, `harness` (`forceDisconnect()`, `waitForConnection()`, `getConnectionStatus()`), `terminal` (`waitForTerminal()`, `waitForPrompt()`, `executeCommand()`, `waitForOutput()`), `RustServer`; `TestServerInfo.pid` (`helpers/test-server.ts:23`) for the SIGSTOP test; default `recoveryOfferHandling: 'auto-decline'` (fixtures.ts:94) — no override needed since the spec owns no panel assertions; fake-claude-sidecar fixture idioms from `hidden-pane-rebind-rust.spec.ts` for the fresh-agent test.
- Produces: none.

- [ ] **Step 1: Write the failing (or coverage-missing) behavioral test**

```ts
import { test, expect } from '../helpers/fixtures.js'

const noDeadEndText = /still running on the server|\[Restore failed\]/
// Playwright signature: waitForFunction(pageFunction, arg, options) — the
// options object must be the THIRD argument or the timeout is ignored
// (fresh-eyes F3-4).
const waitReady = (page: any) => page.waitForFunction(
  () => window.__FRESHELL_TEST_HARNESS__?.getState()?.connection?.status === 'ready',
  undefined,
  { timeout: 20_000 },
)

test.describe('reconnect revive (rust)', () => {
  test('terminal pane reattaches and repaints after a bare socket drop', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await terminal.waitForPrompt()
    await terminal.executeCommand('echo "rr-marker-one"')
    await terminal.waitForOutput('rr-marker-one')

    await harness.forceDisconnect()
    await harness.waitForConnection()
    await waitReady(page)

    // Settled end state, not just "ready": backlog visible again, chips gone.
    await terminal.waitForOutput('rr-marker-one', { timeout: 20_000 })
    await expect(page.getByText('Offline: input will queue until reconnected.')).toHaveCount(0)
    await expect(page.getByText('Recovering terminal output...')).toHaveCount(0)
    await expect(page.getByText(noDeadEndText)).toHaveCount(0)

    // Live, not a frozen repaint: the PTY still answers input AFTER reconnect.
    await terminal.executeCommand('echo "rr-marker-two"')
    await terminal.waitForOutput('rr-marker-two', { timeout: 10_000 })
  })

  test('REST resume door names the live owner in its refusal (red-first contract)', async ({ freshellPage, page, harness, terminal }) => {
    // Shell panes never reach D7 (create_session_locator → None for shell):
    // use a provider-mode (claude) terminal pane, hermetically seeded with a
    // known session id, per the opencode-terminal-restore / session-directory
    // donor idioms. Close it (detach-only), then drive the REST door:
    //   POST /api/tabs { mode:'claude', sessionRef:{provider:'claude', sessionId:<id>}, ... }
    // via page.evaluate(fetch). Assert on base-vs-after behavior:
    //   - status is STILL 409 (D7 stays in force — doctrine),
    //   - body.code === 'RESTORE_UNAVAILABLE',
    //   - body.liveTerminalId === the still-running terminal's id   ← red on base
    //     (reopen in the same client adopts namelessly via WS; this field is
    //     what lets any refused caller reattach).
  })

  test('sidebar close -> reopen of a live session converges (regression pin)', async ({ freshellPage, page, harness, terminal }) => {
    // LB-1 proved the negotiated WS door adopts on base: this test is GREEN on
    // base and after — it pins the adopt arm so the Task 7 refusal-lane work
    // never regresses it. Provider-mode pane with a known session id; close tab
    // (detach-only); reopen from the sidebar session row; assert no dead-end
    // text and output continuity (marker + post-reopen input round-trip).
    await expect(page.getByText(noDeadEndText)).toHaveCount(0)
  })

  test('two sequential drops mid-reattach converge to a live pane', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await terminal.waitForPrompt()
    await terminal.executeCommand('echo "rr-double"')
    await terminal.waitForOutput('rr-double')
    await harness.forceDisconnect()
    await harness.waitForConnection()
    await harness.forceDisconnect() // drop again before reattach could settle
    await harness.waitForConnection()
    await waitReady(page)
    await terminal.executeCommand('echo "rr-double-after"')
    await terminal.waitForOutput('rr-double-after', { timeout: 20_000 })
    await expect(page.getByText(noDeadEndText)).toHaveCount(0)
  })

  test('server-process freeze forces client-side abandonment before thaw', async ({ freshellPage, page, harness, terminal, testServer }) => {
    test.slow() // freeze window must cover the 30s probe + 10s pong timeout
    test.skip(process.platform === 'win32', 'SIGSTOP/SIGCONT are POSIX-only (freeze-spec gate)')
    await terminal.waitForTerminal()
    await terminal.waitForPrompt()
    await terminal.executeCommand('echo "rr-freeze"')
    await terminal.waitForOutput('rr-freeze')

    // Fresh-eyes F3 discrimination: a stalled socket that merely RESUMES after
    // SIGCONT passes every old assertion (ready + input), so they cannot be the
    // discriminator. The one thing only the Task 1 watchdog produces is a
    // client-driven status transition while NO close frame exists. Start an
    // in-page status sampler FIRST (the browser is not frozen — only the
    // server is), then freeze the server, then require a non-'ready' sample
    // BEFORE thaw.
    await page.evaluate(() => {
      ;(window as any).__rrStatuses = []
      ;(window as any).__rrTimer = setInterval(() => {
        ;(window as any).__rrStatuses.push(window.__FRESHELL_TEST_HARNESS__?.getState()?.connection?.status)
      }, 1_000)
    })
    const pid = testServer.info.pid
    try {
      process.kill(pid, 'SIGSTOP')
      // Base behavior: no inbound traffic ever forces a state change — the
      // sampler never leaves 'ready' and this wait times out (true red-first).
      // With Task 1: t=30s probe → no pong → t=40s abandon → status flips.
      await page.waitForFunction(
        () => (window as any).__rrStatuses?.some((s: string | undefined) => s !== undefined && s !== 'ready'),
        undefined,
        { timeout: 50_000 },
      )
    } finally {
      process.kill(pid, 'SIGCONT') // never leave the fixture server stopped
      await page.evaluate(() => clearInterval((window as any).__rrTimer)).catch(() => {})
    }
    await harness.waitForConnection()
    await waitReady(page)
    await terminal.executeCommand('echo "rr-thawed"')
    await terminal.waitForOutput('rr-thawed', { timeout: 30_000 })
    await expect(page.getByText(noDeadEndText)).toHaveCount(0)
  })

  test('fresh-agent pane reattaches and round-trips after a bare socket drop', async ({ freshellPage, page, harness }) => {
    // Donor: hidden-pane-rebind-rust.spec.ts + its fake-claude-sidecar fixture
    // (FAKE_CLAUDE_SIDECAR_SOURCE + scripted sidecar protocol). Arrange a
    // VISIBLE freshclaude pane with one completed turn. forceDisconnect().
    // THEN, while the client is down, drive the fake sidecar to emit a
    // server-side-only marker event (the fixture's scripted mechanism — e.g.
    // its control hook / next scripted turn) so post-reconnect rendering of
    // the marker CANNOT come from pre-drop local state. Reconnect; assert the
    // marker turn renders (reattach + snapshot/event pulled fresh state).
    // FINALLY send a new prompt from the pane's composer and assert the fake
    // sidecar's scripted reply renders — a post-reconnect send/response round
    // trip, which only a genuinely reattached WS session can produce
    // (fresh-eyes F3-2: render-only assertions can pass on surviving local
    // React/Redux state with a fully broken reattach).
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run (against BASE, order-independently — fresh-eyes F3-3: Task 8 executes last, so "red on base" evidence CANNOT come from the current worktree; use a scratch worktree pinned at base_ref `530f5f3530dd660209fae11a81fc028827cdeb2e`, the same pattern `scripts/base-gate.sh` uses):

```bash
git worktree add /tmp/rr-base 530f5f3530dd660209fae11a81fc028827cdeb2e
cd /tmp/rr-base && npm ci --no-audit --no-fund
# copy the NEW spec + its playwright.config registration into the base tree
cp <worktree>/test/e2e-browser/specs/reconnect-revive-rust.spec.ts /tmp/rr-base/test/e2e-browser/specs/
# apply the same RUST_ONLY_SPECS/testMatch registration edit in /tmp/rr-base's playwright.config.ts
cd /tmp/rr-base && npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium test/e2e-browser/specs/reconnect-revive-rust.spec.ts
# remove the scratch worktree after capturing the table
```

Expected against base (record this per-test base-status table in the task's execution notes — it is the LB-2 evidence): the REST-door contract test FAILS on the missing `liveTerminalId` field; the freeze test's during-freeze sampler times out (on base nothing flips the status while no close frame exists — true red-first per fresh-eyes F3); the fresh-agent round-trip test FAILS against the Task 4/5 wedge (no fresh state can land while its reattach is suppressed) or passes as a documented pin if base already covers it (attribute per-test); the sidebar-adoption pin may already pass on base (documented pin). Any test still red after Tasks 1-7 is the LB-2 completeness signal — stop and attribute it before proceeding.

- [ ] **Step 3: Add the minimal production implementation**

Register the spec in `RUST_ONLY_SPECS` and the `rust-chromium` `testMatch` list with a one-line comment (socket-drop/freeze revival; drives RustServer + forceDisconnect + SIGSTOP). Production code is Tasks 1-7; this task adds no other production change.

- [ ] **Step 4: Run the focused test**

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium test/e2e-browser/specs/reconnect-revive-rust.spec.ts`

Expected: PASS (6/6). Also run once on the CLOUD backend before the PR per repo rule: `bash scripts/e2e-cloud.sh run --project=rust-chromium reconnect-revive-rust` (or the documented shard filter form) — a spec sitting in CLOUD_SKIP_SPECS is not coverage.

- [ ] **Step 5: Refactor while green**

Extract a tiny shared `expectLivePaneAfterReconnect(page, terminal)` helper if the four terminal tests' tails get noisy; keep assertions explicit. Do not parameterize the freeze window — flakiness hides there.

- [ ] **Step 6: Run impacted-test verification**

The spec registration edits touch project gating; run the neighboring rust reconnect family:

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium test/e2e-browser/specs/reconnect-revive-rust.spec.ts test/e2e-browser/specs/hidden-pane-rebind-rust.spec.ts test/e2e-browser/specs/server-restart-recovery.spec.ts`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/reconnect-revive-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): prove reconnect revives panes on the rust server (drop, freeze, close-reopen, fresh-agent)"
```

## Cross-Cutting Notes

- **Load-bearing resolution record (stage 2):** ledger at `.worktrees/.the-usual-logs/reconnect-revive/load-bearing-ledger.md`; validator reports under `reports/load-bearing-validator-*.md`. LB-1 falsified (WS negotiated close→reopen already adopts — retargeted Task 7, dropped its client-routing arm under the scope rule). LB-3 confirmed → Task 1 uses abandon-and-reconnect with generation guards. LB-4 substantiated → dead-peer e2e shape is server-SIGSTOP; the 65s foreground recycle is unit-covered only (headless Playwright cannot drive real visibility transitions; recorded tradeoff). LB-5 confirmed → Task 7's revive goes through the epoch-bumping `applyReattachToLiveTerminal` reducer. LB-6 confirmed (opencode attach arm only; codex's attach arm stays untouched — it is sequence-pinned by the wireshape differential). LB-7 confirmed → the 30s liveness interval needs no suite guards. LB-2 (completeness) is deferred to Stage 4 by design: Task 8's per-test base-status table plus attribution rubric is its evidence vehicle.
- **Deferred residue (out of scope by the User Request):** multi-view/multi-device attach and adopt/view policies (#4/#2/#3); server-side retention-overflow signaling (`replayResetReason`) beyond what existing replay-gap handling surfaces; broadcast-bus replay across the dead window (all recovery here is pull/re-ask based, per the existing architecture).
- **Frozen clients:** pre-reconcile clients never send `pane.reconcile.request` and never receive the new error code; all additive wire fields are omitted when absent. Old client + new server converges via the census. New client + old server: the watchdog/poke never needs the server to know about it; the reconcile wait expires into the census; the D7 revival only fires when the server sends the id (absent → today's `[Restore failed]` path, unchanged).
- **Perf/visible-first audits:** liveness pings fire only on ≥30s inbound silence and never before ready; no new pre-ready HTTP traffic is introduced.
