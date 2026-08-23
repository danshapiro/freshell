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

**Architecture:** Fix the wedge at each of its four layers, keeping every existing recovery contract intact. (1) Transport liveness — an app-level ping watchdog plus foreground pokes so a half-open socket is recycled into the normal reconnect path. (2) Reconcile loss — a bounded client-side wait that falls back to the legacy inventory census, plus an explicit server error instead of accept-and-strip silence on non-negotiated connections. (3) Per-pane reattach gaps — hidden-pane hydration parity on reconnect, fresh-agent `lost` revocation on truth-bearing evidence, opencode placeholder re-keying on attach ack, and a truthful claude attach-ack status. (4) Close→reopen — route reopen to the live terminal, carry the live terminal id in the D7 refusal, and fold that refusal into an attach instead of a dead-end.

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
4. **Close→reopen dead-ends.** Sidebar close is detach-only; reopen issues `terminal.create{sessionRef}` which meets the D7 live-guard → `error{RESTORE_UNAVAILABLE,"Session {sid} is still running on the server."}` (`crates/freshell-ws/src/terminal.rs:2615-2621`; REST twin `crates/freshell-freshagent/src/terminal_tabs.rs:1223-1235`) → a terminal `[Restore failed]` write (`TerminalView.tsx:4897-4901`).

Existing reconnect machinery that MUST stay intact (regression surface): the per-connection revival trio (re-attach on `onReconnect` with generation-tagged `terminal.attach`; boot reconcile + verdict folds; legacy census fallback), the sender-level pre-verdict create hold (`RECONCILE_VERDICT_WAIT_MS`), RebindQueue flap safety for hidden fresh-agent panes, the ws-oracle parity pins, and PR #532 launch-retry semantics.

---

### Task 1: WS transport liveness — app-level ping watchdog + foreground reconnect poke

The client recycles a silently-dead socket into the existing reconnect machinery instead of waiting forever for `onclose`. Server-side WS pings are invisible to JS, so liveness is proven by an app-level `{type:'ping'}`→`{type:'pong'}` round trip that both servers already implement (`crates/freshell-ws/src/terminal.rs` Ping dispatch; legacy `server/ws-handler.ts:1832-1835`; pinned by `test/e2e-browser/specs/ws-ping-pong-matrix.spec.ts`).

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
    // Ready traffic itself was inbound activity; 30s of silence triggers the probe.
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

  it('closes a socket whose probe goes unanswered past the pong timeout, entering the reconnect path', async () => {
    const { socket } = await connectReady(new WsClient('ws://test/ws'))
    await vi.advanceTimersByTimeAsync(30_000)          // probe sent
    expect(socket.sent.some((s) => JSON.parse(s).type === 'ping')).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000)          // no pong → stale
    expect(MockWebSocket.instances.length).toBe(1)
    await vi.advanceTimersByTimeAsync(5_000)           // reconnect backoff lands a NEW socket
    expect(MockWebSocket.instances.length).toBe(2)
  })

  it('clears the outstanding probe on any inbound message (no close)', async () => {
    const { socket } = await connectReady(new WsClient('ws://test/ws'))
    await vi.advanceTimersByTimeAsync(30_000)
    socket._message({ type: 'pong', timestamp: 'x' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(MockWebSocket.instances.length).toBe(1)     // socket never recycled
  })

  it('poke() while ready and recently active sends an immediate probe', async () => {
    const { client, socket } = await connectReady(new WsClient('ws://test/ws'))
    client.poke()
    expect(socket.sent.some((s) => JSON.parse(s).type === 'ping')).toBe(true)
  })

  it('poke() after 65s+ of silence recycles immediately instead of waiting out the probe', async () => {
    const { client, socket } = await connectReady(new WsClient('ws://test/ws'))
    // Simulate a frozen tab: no timers ran (background clamp) but the wall
    // clock jumped past the recycle threshold.
    vi.setSystemTime(Date.now() + 65_000)
    client.poke()
    await vi.advanceTimersByTimeAsync(2_000)           // reconnect backoff lands
    expect(socket.sent.some((s) => JSON.parse(s).type === 'ping')).toBe(false) // no probe wait
    expect(MockWebSocket.instances.length).toBe(2)     // recycled into a fresh socket
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

(Redraft note: the 65s-silence case is exercised more directly by setting `vi.setSystemTime` forward past the recycle threshold with the liveness interval temporarily stopped — assert `poke()` closes the socket immediately with no preceding `ping` in `socket.sent`.)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/lib/ws-client.liveness.test.ts`

Expected: FAIL because `'ping'` frames are never sent, `client.poke is not a function`, and no recycle occurs — the missing behavior, not a setup accident.

- [ ] **Step 3: Add the minimal production implementation**

`src/lib/ws-client.ts`:

```ts
// Constants (top of file, next to CONNECTION_TIMEOUT_MS):
// Liveness probe cadence matches both servers' 30s keepalive; the pong timeout
// bounds "half-open" detection; the foreground recycle threshold is >2 server
// keepalive windows — past it the server may already have reaped the peer.
const LIVENESS_INTERVAL_MS = 30_000
const PONG_TIMEOUT_MS = 10_000
const FOREGROUND_RECYCLE_SILENCE_MS = 65_000

// Class state:
private lastInboundAt = 0
private probeSentAt: number | null = null
private livenessTimer: number | null = null
```

In `handleIncomingMessage` (top): `this.lastInboundAt = Date.now(); this.probeSentAt = null` — any parsed inbound frame is liveness evidence (a socket relaying traffic is not half-open).

In `onopen`: `this.lastInboundAt = Date.now(); this.probeSentAt = null; this.startLivenessWatch()`.

New methods:

```ts
private startLivenessWatch(): void {
  this.clearLivenessWatch()
  this.livenessTimer = window.setInterval(() => this.tickLiveness(), LIVENESS_INTERVAL_MS)
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
      // Half-open socket: the peer (or the path) is dead but the browser never
      // delivered onclose. Recycling enters the NORMAL onclose → scheduleReconnect
      // path; every pane-recovery mechanism keys off that.
      log.warn('liveness probe unanswered; recycling stale socket')
      this.ws.close()
    }
    return
  }
  if (now - this.lastInboundAt < LIVENESS_INTERVAL_MS) return
  this.probeSentAt = now
  this.sendNow({ type: 'ping' })
}

/**
 * Foreground poke: re-assert connectivity when the page becomes visible/online.
 * - ready + recently active   → probe immediately (fast failure discovery).
 * - ready + silent past two server keepalive windows → recycle: the peer may
 *   already be reaped, and reconnect convergence is cheaper than the probe wait.
 * - down with a (possibly background-clamped) backoff timer pending → connect now.
 */
poke(): void {
  if (this.intentionalClose) return
  if (this._state === 'ready') {
    if (Date.now() - this.lastInboundAt >= FOREGROUND_RECYCLE_SILENCE_MS) {
      log.info('foreground poke: silent past keepalive windows; recycling socket')
      this.ws?.close()
      return
    }
    this.tickLiveness()
    return
  }
  if (this.connectPromise) return
  if (this._state === 'connecting') return
  this.clearReconnectTimer()
  this.connect().catch((err) => log.debug('poke reconnect failed', err))
}
```

Call `this.clearLivenessWatch()` in `onclose` (with the other clears) and in `disconnect()`.

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

Run: `npm run test:vitest -- run test/unit/client/lib/ws-client.test.ts test/unit/client/lib/ws-client.reconnect-noise.test.ts test/unit/client/lib/ws-client.reconcile.test.ts test/unit/client/lib/ws-client.liveness.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/App.restart-signals.test.tsx test/e2e/turn-complete-notification-flow.test.tsx test/unit/client/activity-callbacks.test.ts`

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
- Modify: `crates/freshell-protocol/src/server_messages.rs` (new `ErrorCode` variant, ~:enum ErrorCode)
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

`crates/freshell-protocol/src/server_messages.rs` — add to `ErrorCode`:

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
git add src/lib/pane-reconcile.ts src/App.tsx crates/freshell-protocol/src/server_messages.rs crates/freshell-ws/src/terminal.rs test/unit/client/components/App.reconcile-adoption.test.tsx
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

Run: `npm run test:vitest -- run test/unit/client/components/TerminalView.hidden-rebind.test.tsx test/unit/client/components/TerminalView.visibility.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/lib/hydration-queue.test.ts test/unit/client/lib/terminal-attach-policy.test.ts test/e2e/terminal-create-attach-ordering.test.tsx`

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

Reconnect re-drive: with the pane still `lost=true` and NO verdict (reconcile absent), flipping `connection.status` `'disconnected' → 'ready'` re-runs the `.lost` recovery effect (spy `reconcileLostPane`/`triggerRecovery`).

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

`FreshAgentView.tsx` — add a selector `const connectionStatus = useAppSelector((s) => s.connection.status)` and add `connectionStatus` to the `.lost` recovery effect's dep array (:2069-2077 region), with a short comment: a fresh reconnect re-drives recovery even when lost/sessionId are unchanged.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/store/freshAgentSlice.test.ts test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx`

Expected: PASS

- [ ] **Step 5: Refactor while green**

None — three one-line/one-call changes at the exact seams; any dedup would hide intent.

- [ ] **Step 6: Run impacted-test verification**

Fresh-agent slice contracts, reconcile folds, hidden rebind (its Test 2 pins `.lost` re-create), snapshot scheduler consumers:

Run: `npm run test:vitest -- run test/unit/client/store/freshAgentSlice.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.hidden-rebind.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.waiting-edge.test.tsx test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/lib/pane-reconcile.test.ts`

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

Run: `cargo test -p freshell-freshagent attach_placeholder` && `npm run test:vitest -- run test/unit/client/lib/fresh-agent-ws.test.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

If the send-path materialized construction and this one now duplicate, extract one `materialized_frame(previous, real) -> ServerMessage` helper in `opencode_ws.rs` and use both call sites.

- [ ] **Step 6: Run impacted-test verification**

The opencode attach/ack pins and the materialization-once pins:

Run: `cargo test -p freshell-freshagent && npm run test:vitest -- run test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/store/freshAgentSlice.test.ts && npm run test:vitest -- run test/integration/port/oracle/t2-opencode-equivalence-rust.test.ts`

Expected: PASS (the oracle equivalence run checks the attach-ack capture families; the new frame appears only on placeholder-addressed tracked attach — if a frozen capture pins that path, update the oracle per its documented procedure and note it in the commit).

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

Run: `cargo test -p freshell-freshagent claude && npm run test:vitest -- run test/integration/port/oracle/t2-invariants.test.ts test/unit/client/lib/fresh-agent-ws.test.ts`

Expected: PASS (if the oracle pins a hardcoded-idle capture on an arm whose tracked status changed, update per the oracle refresh procedure and record it).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/claude.rs
git commit -m "fix(claude): attach ack announces the session's real last status"
```

### Task 7: Close→reopen revives the still-running session (no more D7 dead-end)

Close is detach-only, so the session's PTY often keeps running; reopening issues `terminal.create{sessionRef}` which the D7 live-guard correctly refuses — and the pane dead-ends at `[Restore failed]`. Disarm the trap three ways, keeping D7/D8 fully in force: (a) the reopen path routes to the live terminal when the client already knows one, (b) the refusal carries the live terminal's id on both lanes, (c) the client folds an id-carrying refusal into an attach instead of a dead-end.

**Files:**
- Modify: `src/store/terminalMetaSlice.ts` (new selector)
- Modify: `src/store/tabsSlice.ts` (`openSessionTab` :569+, new-pane arm)
- Modify: `crates/freshell-protocol/src/server_messages.rs` (`ErrorMsg` optional field)
- Modify: `crates/freshell-ws/src/terminal.rs` (D7 guard ~:2580-2623: include `live_terminal_id`)
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs` (REST 409 :1223-1235: include `liveTerminalId` in the JSON body)
- Modify: `src/components/TerminalView.tsx` (create-error handler :4872-4901)
- Modify: `shared/ws-protocol.ts` (error-message schema gains optional `liveTerminalId`)
- Test: `test/unit/client/store/terminalMetaSlice.test.ts` (add/extend)
- Test: `test/unit/client/store/tabsSlice.test.ts` (reopen routing case)
- Test: `test/unit/client/components/TerminalView.lifecycle.test.tsx` (revive fold cases)
- Test: `crates/freshell-ws/src/terminal.rs` tests; `crates/freshell-freshagent/src/terminal_tabs.rs` tests

**Interfaces:**
- Consumes: `TerminalMetaRecord{terminalId, provider, sessionId}` + `connection.liveTerminalIds`; `live_session_owner(...) -> Option<String>` (terminal id of the owner) at both guard sites.
- Produces: `selectLiveTerminalIdForSession(state, provider, sessionId): string | undefined`; wire `error.liveTerminalId?: string`; REST 409 body gains `liveTerminalId` only when a terminal owns the session.

- [ ] **Step 1: Write the failing behavioral test**

1. Selector: meta rows + live ids → the live owner id; dead id excluded; provider mismatch excluded.
2. `openSessionTab` new-pane arm: with a live owner in state, the created pane content carries `terminalId: <owner>`, `status: 'running'`, and NO resume-create follows (spy on the WS send: no `terminal.create` for that pane).
3. TerminalView revive fold: create-error `{code:'RESTORE_UNAVAILABLE', liveTerminalId:'t1', requestId}` → content gains `terminalId:'t1'`, `status:'running'`, a `terminal.attach` for `t1` is sent, and the pane shows a `Reconnected to the still-running session.` notice — never `[Restore failed]`; a SECOND RESTORE_UNAVAILABLE for the same createRequestId does not revive again (bound the loop) and falls through to the existing error write.
4. Rust WS: the D7 refusal frame carries `live_terminal_id: Some(<owner>)`. Rust REST: the 409 body carries `liveTerminalId` when a terminal owns the session and omits it for the fresh-agent-cross-kind arm (no terminal id exists there).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/store/terminalMetaSlice.test.ts test/unit/client/store/tabsSlice.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx` and `cargo test -p freshell-ws d7 && cargo test -p freshell-freshagent terminal_tabs`

Expected: FAIL because no selector/revive/payload exists yet (`selectLiveTerminalIdForSession` undefined; refusal payload lacks the id), not harness noise.

- [ ] **Step 3: Add the minimal production implementation**

Selector (`terminalMetaSlice.ts`):

```ts
export const selectLiveTerminalIdForSession = (
  state: { terminalMeta: TerminalMetaState; connection: { liveTerminalIds: string[] | null } },
  provider: string,
  sessionId: string,
): string | undefined => {
  const live = state.connection.liveTerminalIds
  if (!live) return undefined
  for (const meta of Object.values(state.terminalMeta.byTerminalId)) {
    if (meta.provider === provider && meta.sessionId === sessionId && live.includes(meta.terminalId)) {
      return meta.terminalId
    }
  }
  return undefined
}
```

`openSessionTab` new-pane arm (`tabsSlice.ts`, in the branch that builds fresh resume content):

```ts
const liveTerminalId = selectLiveTerminalIdForSession(state, resolvedProvider, sessionId)
// ... when minting the new terminal pane content:
//   liveTerminalId ? { terminalId: liveTerminalId, status: 'running', sessionRef: {provider, sessionId}, createRequestId: <fresh id> }
//   : <existing resume content>
```

(Attach needs no create: TerminalView's create-or-attach effect takes the attach branch when `terminalId` is set — same shape the reconcile-adopt fold writes.)

Wire (`server_messages.rs`):

```rust
/// D7 (`RESTORE_UNAVAILABLE` only): the live terminal that owns the refused
/// session, so the client can reattach instead of dead-ending. Additive and
/// omitted everywhere else.
#[serde(skip_serializing_if = "Option::is_none")]
pub live_terminal_id: Option<String>,
```

Add it to every `ErrorMsg` literal (`send_create_error` at `terminal.rs:4464-4482` sets `live_terminal_id: None`); WS guard: capture `let owner = state.registry.live_session_owner(...)` and emit `live_terminal_id: owner.clone() when registry_row_live`; REST: put `liveTerminalId` in the 409 JSON body from the same owner; `shared/ws-protocol.ts`: error schema gains `liveTerminalId: z.string().optional()`.

TerminalView fold (create-error handler, before the dead-end arms):

```ts
if (msg.code === 'RESTORE_UNAVAILABLE' && typeof (msg as { liveTerminalId?: unknown }).liveTerminalId === 'string') {
  const liveId = (msg as { liveTerminalId: string }).liveTerminalId
  // One revival per createRequestId: if the live handle died in the race, the
  // follow-on create lands the existing [Restore failed] path — never loop.
  if (reviveAttemptedRef.current !== reqId) {
    reviveAttemptedRef.current = reqId
    updateContent({ status: 'running', terminalId: liveId, streamId: undefined, restoreError: undefined })
    writeLocalXtermNotice(term, `\r\nReconnected to the still-running session.\r\n`)
    return
  }
}
```

(`reviveAttemptedRef: useRef<string | null>(null)`, reset when a new createRequestId is minted alongside the existing launch-attempt bookkeeping.)

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/store/terminalMetaSlice.test.ts test/unit/client/store/tabsSlice.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx && cargo test -p freshell-ws d7 && cargo test -p freshell-freshagent terminal_tabs && npm run typecheck`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Keep the refusals' "still running on the server." message text byte-identical (client regexes and user muscle memory depend on it); all novelty rides the additive id field.

- [ ] **Step 6: Run impacted-test verification**

Create-error handling (incl. `fresh_after_restore_unavailable`), restore/launch ladders, REST doors, oracle/error-contract pins:

Run: `npm run test:vitest -- run test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/lib/terminal-restore.test.ts test/unit/client/store/tabsSlice.test.ts test/unit/client/store/terminalMetaSlice.test.ts test/unit/port/oracle/t2-invariants.test.ts && cargo test -p freshell-ws && cargo test -p freshell-freshagent && cargo test -p freshell-protocol`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add src/store/terminalMetaSlice.ts src/store/tabsSlice.ts shared/ws-protocol.ts src/components/TerminalView.tsx crates/freshell-protocol/src/server_messages.rs crates/freshell-ws/src/terminal.rs crates/freshell-freshagent/src/terminal_tabs.rs test/unit/client/store/terminalMetaSlice.test.ts test/unit/client/store/tabsSlice.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "fix(reopen): reattach to the still-running session instead of dead-ending on D7"
```

### Task 8: E2E acceptance — reconnect revives (Rust server)

First-class browser proof of the user-visible acceptance shape on the production server stack, closing the named coverage gaps (rust-side plain socket drop; "stops being gray/dead" assertions; the close→reopen revival; sequential drops mid-reattach).

**Files:**
- Create: `test/e2e-browser/specs/reconnect-revive-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (register the spec in `RUST_ONLY_SPECS` :176 list AND the `rust-chromium` project `testMatch` — both, matching the convention of the neighboring entries) and confirm it is NOT in `CLOUD_SKIP_SPECS` (`playwright.cloud.config.ts`)
- Test: (the spec IS the test)

**Interfaces:**
- Consumes: fixtures `freshellPage`, `harness` (`forceDisconnect()`, `waitForConnection()`, `getConnectionStatus()`), `terminal` (`waitForTerminal()`, `waitForPrompt()`, `executeCommand()`, `waitForOutput()`), `RustServer`; default `recoveryOfferHandling: 'auto-decline'` (fixtures.ts:94) — no override needed since the spec owns no panel assertions.
- Produces: none.

- [ ] **Step 1: Write the failing (or coverage-missing) behavioral test**

```ts
import { test, expect } from '../helpers/fixtures.js'

const noDeadEndText = /still running on the server|\[Restore failed\]/

test.describe('reconnect revive (rust)', () => {
  test('terminal pane reattaches and repaints after a bare socket drop', async ({ page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await terminal.waitForPrompt()
    await terminal.executeCommand('echo "rr-marker-one"')
    await terminal.waitForOutput('rr-marker-one')

    await harness.forceDisconnect()
    await harness.waitForConnection()
    await page.waitForFunction(
      () => window.__FRESHELL_TEST_HARNESS__?.getState()?.connection?.status === 'ready',
      { timeout: 20_000 },
    )

    // Settled end state, not just "ready": backlog visible again, chips gone.
    await terminal.waitForOutput('rr-marker-one', { timeout: 20_000 })
    await expect(page.getByText('Offline: input will queue until reconnected.')).toHaveCount(0)
    await expect(page.getByText('Recovering terminal output...')).toHaveCount(0)
    await expect(page.getByText(noDeadEndText)).toHaveCount(0)

    // Live, not a frozen repaint: the PTY still answers input AFTER reconnect.
    await terminal.executeCommand('echo "rr-marker-two"')
    await terminal.waitForOutput('rr-marker-two', { timeout: 10_000 })
  })

  test('close -> reopen revives the still-running session instead of the "still running" refusal', async ({ page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await terminal.waitForPrompt()
    await terminal.executeCommand('echo "rr-close-marker"')
    await terminal.waitForOutput('rr-close-marker')
    // Close the tab (detach-only), then reopen the same session from the
    // sidebar session list (the exact user workaround that dead-ended).
    // ... drive close via the tab's close button (aria-label per the a11y
    // contract) and reopen via the session row; assert:
    await expect(page.getByText(noDeadEndText)).toHaveCount(0)
    await terminal.waitForOutput('rr-close-marker', { timeout: 20_000 })
    await terminal.executeCommand('echo "rr-after-reopen"')
    await terminal.waitForOutput('rr-after-reopen', { timeout: 10_000 })
  })

  test('two sequential drops mid-reattach converge to a live pane', async ({ page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await terminal.waitForPrompt()
    await terminal.executeCommand('echo "rr-double"')
    await terminal.waitForOutput('rr-double')
    await harness.forceDisconnect()
    await harness.waitForConnection()
    await harness.forceDisconnect() // drop again before reattach could settle
    await harness.waitForConnection()
    await page.waitForFunction(
      () => window.__FRESHELL_TEST_HARNESS__?.getState()?.connection?.status === 'ready',
      { timeout: 20_000 },
    )
    await terminal.executeCommand('echo "rr-double-after"')
    await terminal.waitForOutput('rr-double-after', { timeout: 20_000 })
    await expect(page.getByText(noDeadEndText)).toHaveCount(0)
  })
})
```

(The close/reopen test's exact sidebar driving idioms come from the session-directory specs; the assertions above are the contract. A flaky-looking first red run is acceptable evidence of the missing behavior; a selector error is not.)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium test/e2e-browser/specs/reconnect-revive-rust.spec.ts`

Expected (before Tasks 1-7 land, or when run against base): the close→reopen test FAILS with the "still running on the server" text; sequential-drop may already pass with Tasks 1-3 landed. In plan order this task runs last, so record the residual failure evidence if any test still cannot go green.

- [ ] **Step 3: Add the minimal production implementation**

Register the spec (`/reconnect-revive-rust\.spec\.ts$/`) in `RUST_ONLY_SPECS` and the `rust-chromium` `testMatch` list with a one-line comment (socket-drop revival, not restartAbrupt-shaped). Production code is Tasks 1-7; this task adds no other production change.

- [ ] **Step 4: Run the focused test**

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium test/e2e-browser/specs/reconnect-revive-rust.spec.ts`

Expected: PASS (3/3)

- [ ] **Step 5: Refactor while green**

Extract a tiny shared `expectNoDeadEnd(page)` local helper if the triple-reading gets noisy; keep assertions explicit.

- [ ] **Step 6: Run impacted-test verification**

The spec registration edits touch project gating; run the neighboring rust reconnect family plus the config's own consumers:

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium test/e2e-browser/specs/reconnect-revive-rust.spec.ts test/e2e-browser/specs/hidden-pane-rebind-rust.spec.ts test/e2e-browser/specs/server-restart-recovery.spec.ts` and `npm run test:vitest -- run test/e2e/vitest.config consumers` (only if such a config test exists; otherwise omit)

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/reconnect-revive-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): prove reconnect revives terminal panes on the rust server"
```

## Cross-Cutting Notes

- **Deferred residue (out of scope by the User Request):** multi-view/multi-device attach and adopt/view policies (#4/#2/#3); server-side retention-overflow signaling (`replayResetReason`) beyond what existing replay-gap handling surfaces; broadcast-bus replay across the dead window (all recovery here is pull/re-ask based, per the existing architecture).
- **Frozen clients:** pre-reconcile clients never send `pane.reconcile.request` and never receive the new error code; all additive wire fields are omitted when absent. Old client + new server converges via the census. New client + old server: the watchdog/poke never needs the server to know about it; the reconcile wait expires into the census; the D7 revival only fires when the server sends the id (absent → today's `[Restore failed]` path, unchanged).
- **Perf/visible-first audits:** liveness pings fire only on ≥30s inbound silence and never before ready; no new pre-ready HTTP traffic is introduced.
