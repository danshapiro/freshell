# Automatic Pane Restoration After Index Readiness Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
After a Freshell server restart or browser reconnect, panes that were parked waiting for session indexing must restore automatically once the index is ready. Routine startup and reconnect recovery completes with no manual "Retry now" click, no reload, no tab visit, and no manual reattachment.

### Explicit constraints
- Reattach surviving processes immediately using existing authoritative ownership and live-terminal checks; where possible resolve a known provider/session identity directly instead of requiring a full history scan; preserve existing managed-owner and ledger precedence.
- Treat a cold index as pending background recovery: resume affected panes automatically when readiness is published; bounded, deduplicated retry/backoff is allowed for transient races; never hold the WebSocket message loop waiting for the full scan.
- Provide a reliable initial-readiness signal, including when the index is empty or publishes contents identical to its persisted cache; reconnect and already-ready subscription races must converge; missed or duplicate notifications must resolve correctly.
- Remove the manual Retry requirement for routine warming; if recovery is slow, show nonblocking progress that clears automatically; distinguish genuine unreadable-store/provider failures from normal warming; preserve the recoverable identity; explain actual unresolved failures.
- Preserve canonical provider/session identity, saved resume settings, and existing single-flight protections across multiple clients; never replace an unresolved conversation with a new one; never infer a session is missing solely because the index is cold; never create a duplicate writer; never automatically replay an interrupted user prompt.
- Only genuine open panes justify restoration: closing a pane cancels its pending recovery; stale responses cannot restore a closed or rebound pane; inactive tabs and temporarily disconnected clients remain legitimate references; do not reopen historical closed views or restart processes with no open-pane references (related kata freshell#7fen stays separate).
- Successful automatic recovery clears waiting state/progress; real provider/index failures remain accurately distinguished from waiting and from confirmed session absence; recovery information is retained.
- Log recovery state transitions with structured severity, pane/session/request identifiers, duration, and failure cause; do not log the same unchanged wait/failure on every poll.
- Add meaningful red/green/refactor coverage: unit and integration tests plus an actually executed affected browser e2e spec on the configured backend, exercising slow indexing with zero user interaction, initial empty/unchanged publication, reconnect races, multi-client dedup, live-process attachment, pane closure/rebinding, and genuine index/provider errors; destructive restart/process-kill scenarios run only inside the documented disposable sandbox.
- Update agent-facing architecture documentation to supersede the July manual-retry decision (docs/plans/2026-07-24-restart-resilience-architecture-analysis.md section 4.3) and describe automatic recovery; no extra end-user recovery instructions for routine indexing.
- Scope is automatic pane restoration/attachment after index readiness only: the OOM kill cause, resource limits/process isolation, and recovery/replay of killed in-flight agent turns are separate work. No production restart is authorized; the repo's explicit APPROVED requirement still applies to any later live restart.
- Repo rules apply: work in a worktree under .worktrees/, pnpm 10.34.5 with frozen installs, TypeScript NodeNext/ESM relative imports with .js extensions, TDD, PR to main only after explicit user approval.

### Accepted tradeoffs and residuals
- Destructive restart/process-kill testing happens only inside the disposable sandbox; slower but safe.
- Out-of-scope residuals (separate work): OOM investigation/mitigation, resource limits/process isolation, in-flight agent turn recovery/replay (kata freshell#7fen).
- Cloud test backends stay unset (local backend) unless the user directs otherwise.
- User direction (2026-11-02, mid-run): the recorded baseline failures — the seven enumerated environment-class test files at base_ref 520626c46 (missing external Codex artifact, runtime-build manifest collisions, the Windows-labeled harness test, Docker/hosted parity flakes; see the run's baseline ledger) — are pre-approved to continue past and waived by the user. The run's full-suite gate passes when green excluding those waived failures; failures introduced by this change itself remain fix-and-required.

**Goal:** Parked panes waiting for the session index restore themselves automatically when the index finishes its first sweep — no click, no reload, no tab visit — while genuine unreadable-store failures surface honest per-pane errors instead of a lying "waiting" banner.

**Architecture:** The `SessionIndex` gains a one-way readiness watch that fires on its first publish (even when that publish is empty or content-identical). The server broadcasts a capability-gated `sessions.index.ready` frame once per boot and carries the current readiness state on the `ready` frame. A connection-layer client driver re-issues the existing `pane.reconcile.request` for exactly the warming panes when readiness is observed — reusing the idempotent pure derivation, the banner's proven Retry round-trip, the fold-ownership rule, and all existing single-writer/ownership precedence. A new `SessionExistence::Unreadable` answer distinguishes a genuinely unreadable store (after the index published) from normal warming, mapping to a new honest `session_store_unreadable` error. Cheap cold-index by-id locators for opencode and antigravity resolve known identities immediately instead of parking them.

**Tech Stack:** Rust (tokio watch channels, axum WS, tracing) for the server; TypeScript/React (Redux Toolkit, Zod) for the client; Vitest + cargo tests + Playwright (local backend) for verification.

## Global Constraints

- Package manager pnpm 10.34.5 (exact pin), `pnpm install --frozen-lockfile` only; never `npm ci`/`npm install` in this tree. Relative TS imports carry `.js` extensions (NodeNext/ESM).
- WS protocol version stays 10. All wire changes are additive and capability-gated: a client that does not opt into `sessionIndexReadyV1` keeps the exact legacy wire behavior (frozen-client doctrine, shared/ws-protocol.ts:460-478 strip-hazard comments).
- All existing pins stay green, including: `warming_never_completes_yields_error_index_warming`, `provider_unavailable_is_immediate_and_honest`, `warming_resolves_during_deferral_rederives` (crates/freshell-ws/tests/pane_reconcile.rs:691-770), `content_identical_rewrite_reparses_without_bumping_generation`, `opencode_content_identical_relist_does_not_bump_generation` (crates/freshell-sessions/src/directory_index.rs:3448, :5882), `subscribe_changes_wakes_on_new_snapshot` (:8309), `boot_snapshot_gate_covers_window_raced_writes` (session_watcher_tests.rs:1062), the unchanged-refresh-silent pin (session_directory.rs:5146-5162), the ReconcileWarmingBanner test trio, the App.reconcile-adoption set, ws-client.reconcile held-creates set, and `warming_deferral_rederivation_burns_the_respawn_counter_once`.
- The single 2s bounded deferral in `handle_pane_reconcile` (crates/freshell-ws/src/terminal.rs:8826-8861) is NOT changed: one bounded sleep, one re-derivation, then answer — exactly as today.
- Persisted `restoreError` vocabulary changes must land on both sides in one task: `RestoreErrorReasonSchema` (shared/session-contract.ts:17-23), the Rust model allowlist (crates/freshell-ws/src/tabs_store_model.rs:364 "five legal reasons" + `read_restore_error`), and `tabs_persist_validation.rs:437-455`.
- Destructive restart/process-kill Rust suites run only inside `scripts/sandbox-test.sh`. Agent-launched broad gates set `FRESHELL_RUST_TEST_SANDBOX=1`. Narrowed non-destructive cargo selectors run directly from the worktree.
- E2E runs on the local backend (`FRESHELL_E2E_BACKEND` unset). Never loosen ready assertions, skip specs, or raise retries to fix flakes; use the `freshellPage` fixture and generous explicit per-wait timeouts; reuse the stable-count settle pattern (two samples ≥5s apart) for count assertions.
- Structured logging: server events use `tracing` with an `event = "..."` dotted name and identifier fields (house contract crates/freshell-server/src/logging.rs:4-66; precedent `pane_reconcile.dead_session` at terminal.rs:8868-8880); client logs use src/lib/client-logger.ts with identifiers inline. Never log the same unchanged wait/failure per poll; log transitions only.
- Baseline: the full suite at base_ref 520626c46 is red in 7 environment-class files recorded in the run's baseline ledger (see `<logs_dir>/reports/baseline-receipts.md`). The final full-suite gate passes when green excluding those ledger-recorded pre-existing failures. Any NEW failure is attributable to this run and must be fixed.
- No production restart, deploy, push, or PR creation in this run; commits land on `the-usual/auto-restore-warming` only.

---

### Task 1: SessionIndex readiness watch

**Files:**
- Modify: `crates/freshell-sessions/src/directory_index.rs` (struct fields + constructors :1298 area; `perform_refresh_once` publish tail :2084-2109; new `subscribe_ready`/`is_ready` beside `subscribe_changes` :1508; inline tests beside :8309)
- Test: `crates/freshell-sessions/src/directory_index.rs` (inline `#[cfg(test)]` module)

**Interfaces:**
- Consumes: the existing first-publish paths (`run_refresh_inline` :1725-1751 and `spawn_background_refresh` :1760-1802, both funnelling through `perform_refresh_once` under `refresh_lock`).
- Produces: `pub fn subscribe_ready(&self) -> tokio::sync::watch::Receiver<bool>` (clone inherits current value semantics) and `pub fn is_ready(&self) -> bool`. The channel starts `false` at construction and transitions to `true` exactly once, inside `perform_refresh_once`, immediately after the snapshot is published (before the lock release) — for every publish including `changed == 0` (empty corpus, cache-identical) and publishes carrying `scan_failures`.

- [ ] **Step 1: Write the failing behavioral test**

Add to the inline tests module in `directory_index.rs`, modeled on the harness of `subscribe_changes_wakes_on_new_snapshot` (:8309) and the persisted-cache tests (:6235):

```rust
// Readiness watch: readiness is "the first sweep completed and published",
// INDEPENDENT of whether content changed. The change generation
// (:2107-2109) deliberately stays silent on empty or cache-identical
// publications; the readiness watch must not inherit that silence —
// those are exactly the parked-pane recovery cases (kata vnpc).
#[tokio::test]
async fn readiness_watch_fires_on_first_publish_even_when_nothing_changed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let index = SessionIndex::new(vec![/* a file source with zero parseable sessions */]);
    let mut ready = index.subscribe_ready();
    assert!(!*ready.borrow(), "cold index must not be ready");
    let _ = index.snapshot().await; // first sweep: changed == 0, still publishes
    assert!(*ready.borrow(), "empty publication must mark readiness");
    // Readiness-before-subscription race: a LATE subscriber sees the current
    // value immediately — watch channels store the value, no replay needed.
    let late = index.subscribe_ready();
    assert!(*late.borrow());
    assert!(index.is_ready());
}

#[tokio::test]
async fn readiness_watch_fires_on_cache_identical_first_publication() {
    // Build an index with a persisted parse cache whose files are unchanged
    // on disk (persisted_cache_round_trip_avoids_reparse_on_reload :6235 is
    // the harness donor): the first sweep re-parses nothing, changed == 0,
    // the generation does NOT bump — readiness must still fire.
    // ...construct with_ttl_and_cache_path + seeded cache per the donor test...
    let mut ready = index.subscribe_ready();
    let _ = index.snapshot().await;
    assert!(*ready.borrow(), "cache-identical publication must mark readiness");
}

#[tokio::test]
async fn readiness_subscriber_wakes_from_false_on_first_publish() {
    // NOTE (ledger F1): SessionIndex is NOT Clone — hold it in an
    // Arc<SessionIndex> (production's own shape) and clone the Arc for the
    // sweeper task.
    let index = std::sync::Arc::new(/* cold index with one real seeded session (changed > 0) */);
    let mut ready = index.subscribe_ready();
    let sweeper = tokio::spawn({ let index = std::sync::Arc::clone(&index); async move { index.snapshot().await } });
    ready.changed().await.expect("watch sender alive");
    assert!(*ready.borrow());
    let _ = sweeper.await;
    // Exactly one transition: a second publish does not re-notify, because
    // the flip uses send_if_modified with an idempotence guard (tokio's
    // send_modify would notify unconditionally — ledger C1d).
}
```

(Adapt construction helpers to the actual test-module fixtures; the three behavioral assertions are the contract.)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-sessions readiness_watch -- --nocapture`

Expected: FAIL — compile error (`subscribe_ready`/`is_ready` do not exist) is acceptable as the intended missing-behavior failure for a new API; the cache-identical and empty-publish cases must be the asserted behavior (not skipped).

- [ ] **Step 3: Add the minimal production implementation**

```rust
// struct SessionIndex — add beside the change_rx field (:1298 area):
ready_tx: tokio::sync::watch::Sender<bool>,
ready_rx: tokio::sync::watch::Receiver<bool>,

// constructors (both `new` and `with_ttl_and_cache_path`):
let (ready_tx, ready_rx) = tokio::sync::watch::channel(false);

// beside subscribe_changes (:1508):
/// One-way readiness: false until the first sweep completes and publishes,
/// then true for the rest of the process lifetime. Fires for EVERY first
/// publish — including empty, content-identical (changed == 0), and
/// scan-failure publishes — unlike the change generation, which is
/// deliberately silent on unchanged content. A late subscriber sees the
/// current value immediately (watch channels store it), so the
/// readiness-before-subscription race converges by construction.
pub fn subscribe_ready(&self) -> tokio::sync::watch::Receiver<bool> {
    self.ready_rx.clone()
}

pub fn is_ready(&self) -> bool {
    *self.ready_rx.borrow()
}

// in perform_refresh_once, immediately after the snapshot publish (the
// store into self.snapshot, before the `if changed > 0` generation bump),
// still under refresh_lock:
// First sweep completed: publish readiness regardless of content delta.
// send_if_modified (NOT send_modify — tokio notifies unconditionally on
// send_modify, verified at the pinned 1.52.3): only the false->true
// transition notifies, so later publishes never re-wake readiness
// watchers. (Load-bearing ledger C1d.)
self.ready_tx.send_if_modified(|r| if *r { false } else { *r = true; true });
```

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-sessions readiness -- --nocapture`

Expected: PASS (all three new tests).

- [ ] **Step 5: Refactor while green**

Keep the readiness transition co-located with the publish; no extraction needed unless the tests revealed duplication. Confirm no other publish site exists (both refresh entries funnel through `perform_refresh_once`).

- [ ] **Step 6: Run impacted-test verification**

Impacted set: the whole `freshell-sessions` crate (index internals changed) — `cargo test -p freshell-sessions` (non-destructive tempdir suite; direct narrowed lane is delegated/uncoordinated). Also rerun the two generation-silence pins explicitly.

Run: `cargo test -p freshell-sessions`

Expected: PASS (including `content_identical_rewrite_reparses_without_bumping_generation`, `opencode_content_identical_relist_does_not_bump_generation`, `subscribe_changes_wakes_on_new_snapshot`, `boot_snapshot_gate_covers_window_raced_writes` via the crate's watcher tests if co-located).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-sessions/src/directory_index.rs
git commit -m "feat(sessions): add one-way SessionIndex readiness watch firing on every first publish"
```

---

### Task 2: Wire protocol — `sessionIndexReadyV1` capability, ready state, gated readiness broadcast

**Files:**
- Modify: `crates/freshell-protocol/src/client_messages.rs` (hello capabilities declaration/parse, :289 area)
- Modify: `crates/freshell-protocol/src/server_messages.rs` (Ready struct :1298-1329 + capabilities echo; new `SessionsIndexReady` variant; `SERVER_MESSAGE_TYPES` :219-290; `PaneVerdict::Error` reason doc :1195-1206)
- Modify: `crates/freshell-ws/src/lib.rs` (hello capability parse beside :937-955; thread the per-connection flag into the connection handler)
- Modify: `crates/freshell-ws/src/terminal.rs` (connection loop signature :285-361 + the broadcast forward site :715-723; `broadcast_sessions_index_ready` beside `broadcast_sessions_changed` :8693-8700; `WsState.session_index_ready` field beside `broadcast_tx` :168)
- Modify: **the ~65 exhaustive `WsState { ... }` struct literals across ~35+ files** (ledger C10b — the repo's own >~6-site sweep rule, lib.rs:262-264): every literal gains exactly one `session_index_ready: None,` arm. Sweep sites: `crates/freshell-ws/tests/common/mod.rs`, every `crates/freshell-ws/tests/*.rs` harness building a state (`pane_reconcile.rs`, `hello_capabilities.rs`, `resume_validation_gate.rs`, and the rest — grep `WsState {`), `crates/freshell-ws/src/terminal.rs` inline tests, `crates/freshell-server/src/main.rs` (:2324 and :4775 literals — the production site gets `Some(index.subscribe_ready())`).
- Test: `crates/freshell-protocol/tests/roundtrip.rs` (new-frame roundtrip) + `crates/freshell-protocol/tests/pane_reconcile.rs` (reason serialization, extended in Task 4) + `crates/freshell-ws/tests/hello_capabilities.rs` (capability parse pins — note: this file lives in freshell-ws/tests, NOT freshell-protocol; ledger F3) + new `crates/freshell-ws/tests/session_index_ready.rs`

**Interfaces:**
- Consumes: Task 1's `subscribe_ready()` (the WsState field holds the receiver; hand-built test states default `None`).
- Produces (wire contract, referenced by Tasks 3/5/6):
  - hello capability name: `sessionIndexReadyV1` (boolean opt-in; Zod-strict client schema must DECLARE it or it is stripped).
  - `ready.capabilities.sessionIndexReadyV1` echo (negotiating connections only).
  - `ready.sessionIndexReady: bool` — additive top-level state field, present iff the connection negotiated the capability; value = `*state.session_index_ready.borrow()` at handshake time (false when the field is `None`).
  - server broadcast frame `{"type":"sessions.index.ready"}` — sent once per boot by the Task 3 wiring, delivered ONLY to connections that negotiated the capability (forward-site gate).
  - `WsState.session_index_ready: Option<tokio::sync::watch::Receiver<bool>>` (pub; `None` in hand-built test states).
  - `pub fn broadcast_sessions_index_ready(state: &WsState)` in freshell-ws.

- [ ] **Step 1: Write the failing behavioral test**

New file `crates/freshell-ws/tests/session_index_ready.rs`, using the `spawn_server_with` harness from `tests/pane_reconcile.rs:64-118` (raw tokio-tungstenite client, ephemeral port; the harness's `Server` handle exposes only `{url, registry, identity}` — ledger F4 — so this test file owns a thin local spawn wrapper that ALSO retains an `Arc<WsState>` handle for calling `broadcast_sessions_index_ready(&state)` directly):

```rust
// Three contracts, one file: (1) a negotiating client's ready frame carries
// the CURRENT readiness state; (2) the readiness broadcast reaches exactly
// the negotiating connections; (3) a frozen client's wire stays byte-for-byte
// legacy — it never receives the new frame.
#[tokio::test]
async fn ready_frame_carries_current_readiness_state_for_negotiating_clients() {
    let (ready_tx, ready_rx) = tokio::sync::watch::channel(false);
    let server = spawn_server_with(|state| state.session_index_ready = Some(ready_rx));
    let ws = connect_hello(&server, /* capabilities */ &["sessionIndexReadyV1"]).await;
    let ready = ws.next_frame("ready").await;
    assert_eq!(ready["sessionIndexReady"], false);
    assert_eq!(ready["capabilities"]["sessionIndexReadyV1"], true);
    ready_tx.send(true).expect("watch alive");
    // reconnect after readiness: the new ready reports true (already-ready race)
    let ws2 = connect_hello(&server, &["sessionIndexReadyV1"]).await;
    let ready2 = ws2.next_frame("ready").await;
    assert_eq!(ready2["sessionIndexReady"], true);
}

#[tokio::test]
async fn readiness_broadcast_reaches_only_negotiating_connections() {
    let (ready_tx, ready_rx) = tokio::sync::watch::channel(false);
    let server = spawn_server_with(|state| state.session_index_ready = Some(ready_rx));
    let negotiated = connect_hello(&server, &["sessionIndexReadyV1"]).await;
    let frozen = connect_hello(&server, &[]).await;
    ready_tx.send(true).expect("watch alive");
    broadcast_sessions_index_ready(server.state()); // the production spawn calls exactly this
    let frame = negotiated.next_frame("sessions.index.ready").await;
    assert_eq!(frame["type"], "sessions.index.ready");
    assert!(frozen.expect_silence(std::time::Duration::from_millis(300), "sessions.index.ready").await);
    // frozen ready carries NO sessionIndexReady field at all
    let frozen_ready = /* captured handshake frame */;
    assert!(frozen_ready.get("sessionIndexReady").is_none());
}
```

Protocol crate additions (extend `crates/freshell-protocol/tests/hello_capabilities.rs` + the roundtrip test):

```rust
#[test]
fn sessions_index_ready_frame_roundtrips() {
    let msg = ServerMessage::SessionsIndexReady(SessionsIndexReady {});
    let json = serde_json::to_value(&msg).unwrap();
    assert_eq!(json, serde_json::json!({"type": "sessions.index.ready"}));
    let back: ServerMessage = serde_json::from_value(json).unwrap();
    assert!(matches!(back, ServerMessage::SessionsIndexReady(_)));
    // The freshell-ws forward-site gate matches on this exact serialized
    // marker; pin it so a serialization change fails HERE, not in prod.
    assert!(serde_json::to_string(&msg).unwrap().contains(r#""type":"sessions.index.ready""#));
}

#[test]
fn ready_serializes_session_index_ready_state_additively() {
    // Ready { session_index_ready: Some(true), .. } serializes the field;
    // None (frozen shape) omits it entirely.
}

#[test]
fn hello_capabilities_parse_session_index_ready_v1() { /* opt-in flag parses; absent = false */ }
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-ws --test session_index_ready -- --nocapture`

Expected: FAIL — compile error on `broadcast_sessions_index_ready`/`state.session_index_ready` (the missing API), which is the intended failure for a new wire surface.

- [ ] **Step 3: Add the minimal production implementation**

```rust
// crates/freshell-protocol/src/server_messages.rs
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionsIndexReady {}
// enum ServerMessage (internally tagged "type"), beside SessionsChanged (:1460):
#[serde(rename = "sessions.index.ready")]
SessionsIndexReady(SessionsIndexReady),
// SERVER_MESSAGE_TYPES: add "sessions.index.ready".
// struct Ready: add
/// Session-index readiness at handshake time. Present iff the client's hello
// opted in via capabilities.sessionIndexReadyV1 (frozen shape omits it).
#[serde(skip_serializing_if = "Option::is_none")]
pub session_index_ready: Option<bool>,
// struct ReadyCapabilities: add session_index_ready_v1: Option<bool>
//   (serde rename "sessionIndexReadyV1", skip_serializing_if None).
// PaneVerdict::Error doc comment: extend "reason is one of index_warming |
// provider_unavailable | session_store_unreadable" (Task 4 adds the value).

// crates/freshell-ws/src/lib.rs — hello parse beside pane_reconcile_v1 (:937):
let session_index_ready_v1 = value
    .get("capabilities")
    .and_then(|c| c.get("sessionIndexReadyV1"))
    .and_then(|v| v.as_bool())
    .unwrap_or(false);
// thread into the connection handler alongside the other capability flags.

// crates/freshell-ws/src/terminal.rs — beside broadcast_sessions_changed (:8693):
/// One broadcast per boot: the session index finished its first sweep
/// (crate::ready marker frame). Capability-gated at the forward site —
/// frozen connections never see the frame.
pub fn broadcast_sessions_index_ready(state: &WsState) {
    let frame = json!({ "type": "sessions.index.ready" }).to_string();
    let _ = state.broadcast_tx.send(frame);
}

// WsState (lib.rs, beside broadcast_tx :168):
/// Session-index readiness for the ready-frame state field + the Task 3
/// boot wiring. `None` keeps hand-built test states byte-identical.
pub session_index_ready: Option<tokio::sync::watch::Receiver<bool>>,

// connection loop forward site (:715-723) — gate the new frame:
Ok(json) => {
    // Capability-gated frame: the readiness broadcast goes ONLY to
    // connections whose hello negotiated sessionIndexReadyV1 (frozen
    // wire stays byte-for-byte legacy). Pre-serialized frames make a
    // substring check the cheapest safe gate; the protocol test pins
    // the serialized marker so drift fails there, not silently here.
    if json.contains(r#""type":"sessions.index.ready""#) && !session_index_ready_v1 {
        continue; // (or the loop-equivalent skip for this connection)
    }
    if ws_tx.send(Message::Text(json.into())).await.is_err() { /* unchanged */ }
}

// ready-frame construction site (where Ready is built, capabilities echo):
// include session_index_ready: session_index_ready_v1.then(|| {
//     state.session_index_ready.as_ref().map(|rx| *rx.borrow()).unwrap_or(false)
// }),
```

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-ws --test session_index_ready && cargo test -p freshell-protocol sessions_index_ready hello_capabilities`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Extract the shared `connect_hello` helper inside the new test file if duplicated; keep the forward-site gate expression in one named const or local closure if the loop reads awkwardly.

- [ ] **Step 6: Run impacted-test verification**

Impacted: freshell-ws handshake/negotiation tests + freshell-protocol roundtrips + the reconcile suite (same handler area).

Run: `cargo test -p freshell-protocol && cargo test -p freshell-ws --test hello_capabilities && cargo test -p freshell-ws --test pane_reconcile`

Expected: PASS (no legacy-shape change; frozen-client ready frames byte-identical — add the assertion to the existing frozen-shape test if one exists).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-protocol/src crates/freshell-ws/src crates/freshell-ws/tests crates/freshell-server/src/main.rs
git commit -m "feat(ws): add capability-gated sessions.index.ready wire surface with ready-state handshake field"
```

(The wide `git add` covers the mechanical WsState literal sweep across test harness files; verify with `git status` that only intended files are staged.)

---

### Task 3: Server composition — readiness broadcast spawn + deterministic test hold knob

**Files:**
- Modify: `crates/freshell-server/src/main.rs` (startup-gate wiring :1923 area; WsState constructions :2335 and :4823-4824 area; warm-task area :2667-2694; inline tests near `sessions_sweep_tests` :4409-4880)
- Test: `crates/freshell-server/src/main.rs` (inline tests)

**Interfaces:**
- Consumes: Task 1 `subscribe_ready()`; Task 2 `broadcast_sessions_index_ready(&WsState)` + `WsState.session_index_ready`.
- Produces: `pub(crate) fn delayed_startup_gate(inner: tokio::sync::watch::Receiver<bool>, hold_ms: u64) -> tokio::sync::watch::Receiver<bool>` and `pub(crate) fn spawn_session_index_ready_broadcast(index: &SessionIndex, ws_state: &WsState)`; test-only env knob `FRESHELL_TEST_SESSION_INDEX_STARTUP_HOLD_MS` (u64 millis, unset/0 = disabled — production wiring byte-identical when disabled). The knob is read ONCE at startup; forwarded to e2e servers via `RustServer({env})`.

- [ ] **Step 1: Write the failing behavioral test**

Inline tests in main.rs's test module (same fixtures as `sessions_sweep_tests` — WsState test construction exists at :4823 area):

```rust
// The hold knob composes the startup gate: while held, the first publish is
// delayed by exactly the hold (all first-publish entries await the gate —
// directory_index.rs await_startup_gate), giving e2e a deterministic cold
// window instead of a machine-speed-dependent one.
#[tokio::test]
async fn delayed_startup_gate_holds_then_releases_once() {
    let (inner_tx, inner_rx) = tokio::sync::watch::channel(false);
    let start = std::time::Instant::now();
    let mut gate = delayed_startup_gate(inner_rx, 300);
    inner_tx.send(true).expect("alive");
    assert!(!*gate.borrow(), "hold must keep the gate closed");
    gate.changed().await.expect("gate sender alive");
    assert!(*gate.borrow());
    assert!(start.elapsed() >= std::time::Duration::from_millis(300));
}

#[tokio::test]
async fn delayed_startup_gate_disabled_passes_through() {
    // hold_ms == 0: the gate resolves as soon as the inner watcher is ready
    // (production wiring stays byte-identical; assert fast passthrough).
}

#[tokio::test]
async fn readiness_broadcast_fires_exactly_once_on_first_publish() {
    let index = std::sync::Arc::new(/* tempdir SessionIndex with one seeded session file (sweep completes) */);
    let ws_state = /* test WsState with a real broadcast_tx */;
    let mut rx = ws_state.broadcast_tx.subscribe();
    spawn_session_index_ready_broadcast(&index, &ws_state);
    let _ = index.snapshot().await; // first publish -> readiness
    let frame = tokio::time::timeout(std::time::Duration::from_secs(10), rx.recv())
        .await.expect("broadcast arrives").expect("channel alive");
    assert!(frame.contains(r#""type":"sessions.index.ready""#));
    // exactly once: a second publish must not re-broadcast (the one-shot
    // spawn task has exited; the readiness flip itself is idempotent via
    // send_if_modified). NOTE (ledger F1): use the real scoped-dirty
    // signature — `mark_dirty` takes `&[(PathBuf, String)]` — or call
    // `request_refresh()` to trigger the second publish.
    index.request_refresh();
    let _ = index.snapshot().await;
    assert!(tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv()).await.is_err());
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-server delayed_startup_gate readiness_broadcast -- --nocapture`

Expected: FAIL — compile error on the two new functions (missing API), the intended failure.

- [ ] **Step 3: Add the minimal production implementation**

```rust
// main.rs — beside the watcher wiring (:1923):
let hold_ms: u64 = std::env::var("FRESHELL_TEST_SESSION_INDEX_STARTUP_HOLD_MS")
    .ok()
    .and_then(|v| v.parse().ok())
    .unwrap_or(0);
// Test-only deterministic cold window: holds ALL first-publish paths (both
// refresh entries await the startup gate while nothing is published), so a
// reconcile during the hold answers error{index_warming} and the readiness
// broadcast then fires at a known time. Unset/0 keeps production wiring
// byte-identical (direct watcher gate).
let startup_gate = if hold_ms > 0 {
    delayed_startup_gate(watcher.startup_ready(), hold_ms)
} else {
    watcher.startup_ready()
};
index.set_startup_gate(startup_gate);

/// Test-only: compose the watcher's startup-ready signal with a fixed delay.
pub(crate) fn delayed_startup_gate(
    inner: tokio::sync::watch::Receiver<bool>,
    hold_ms: u64,
) -> tokio::sync::watch::Receiver<bool> {
    let (tx, rx) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        let mut inner = inner;
        let _ = inner.changed().await;
        tokio::time::sleep(std::time::Duration::from_millis(hold_ms)).await;
        let _ = tx.send(true);
    });
    rx
}

// WsState construction sites (:2335 production path and the :4823 area test
// path stays as-is unless it should see readiness — pass
// Some(index.subscribe_ready()) at the production site; leave the test-built
// state at None):
session_index_ready: Some(index.subscribe_ready()),

// warm-task area (:2667-2694) — subscribe BEFORE spawning the warm sweep so
// the transition can never be missed, then broadcast once:
if let Some(index) = &session_index {
    let warm_index = Arc::clone(index);
    spawn_session_index_ready_broadcast(index, &ws_state);   // readiness fan-out
    tokio::spawn(async move { /* unchanged warm task: snapshot + session_index_warm log */ });
    spawn_sessions_sweep(/* unchanged */);
    ...
}

/// One broadcast per boot when the session index completes its first sweep.
/// Subscribing before the warm sweep starts makes the 0->true transition
/// impossible to miss; a late (already-true) state broadcasts immediately.
pub(crate) fn spawn_session_index_ready_broadcast(index: &SessionIndex, ws_state: &WsState) {
    let mut ready = index.subscribe_ready();
    let state = std::sync::Arc::clone(ws_state);
    tokio::spawn(async move {
        if !*ready.borrow() {
            let _ = ready.changed().await; // sender never drops while the index lives
        }
        broadcast_sessions_index_ready(&state);
        tracing::info!(
            event = "session_index_ready_broadcast",
            "session index readiness broadcast sent"
        );
    });
}
```

(Note: the `ws_state` handle available at that point in main may be `Arc<WsState>` or the reference used for `spawn_sessions_sweep` — follow the exact type the surrounding code uses; `spawn_sessions_sweep` at :2689 takes similar state handles.)

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-server delayed_startup_gate readiness_broadcast -- --nocapture`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

If the readiness spawn reads better as a closure next to the warm task, keep it a named function (testability); no other refactor expected.

- [ ] **Step 6: Run impacted-test verification**

Impacted: freshell-server main wiring suites (`cargo test -p freshell-server sessions_sweep` for sweep neighbors) + resolve-route readiness semantics (`cargo test -p freshell-server resolve`) — unchanged expectations.

Run: `cargo test -p freshell-server sessions_sweep resolve session_index`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-server/src/main.rs
git commit -m "feat(server): broadcast session index readiness once per boot + deterministic test hold knob"
```

---

### Task 4: Existence — `Unreadable` variant, honest verdict reason, cold by-id locators

**Files:**
- Modify: `crates/freshell-ws/src/existence.rs` (SessionExistence enum :24-36 + trait docs; NoIndexProbe unchanged semantics)
- Modify: `crates/freshell-ws/src/reconcile.rs` (existence arm :492-510; ladder unit tests :956-980)
- Modify: `crates/freshell-ws/src/resume_validation.rs` (map Unreadable beside Unknown :66-74, :113-127; inline tests :160-389)
- Modify: `crates/freshell-server/src/existence.rs` (warm arms :322-464; cold arms :265-321; AD-4 comment :276-282; inline tests :523+; `unreadable_opencode_db_answers_unknown_never_absent` pin at :1351 area)
- Test: the inline test modules above + `crates/freshell-protocol/tests/pane_reconcile.rs` (reason serialization :234-239 area) + `crates/freshell-ws/tests/pane_reconcile.rs` (a scripted-probe test)

**Interfaces:**
- Consumes: nothing from Tasks 1-3.
- Produces: `SessionExistence::Unreadable` (new variant — "known provider, index PUBLISHED, but this identity's store could not be read"); wire verdict reason string `"session_store_unreadable"`; cold-path by-id resolution for opencode and antigravity (Present/Absent/Unreadable→Unknown-while-cold). Codex stays `Unknown` while cold (AD-4 stands; comment updated to name readiness-driven recovery as the codex path).

- [ ] **Step 1: Write the failing behavioral test**

```rust
// crates/freshell-ws/src/reconcile.rs inline tests (ladder row, beside
// row5_unknown_existence_yields_error_index_warming :956):
#[test]
fn unreadable_existence_yields_session_store_unreadable_error() {
    // probe answers Unreadable => error{reason: "session_store_unreadable"},
    // NEVER index_warming (post-readiness warming would be a lying label)
    // and NEVER dead_session/fresh (an unreadable store may hold the session).
}

// crates/freshell-server/src/existence.rs inline tests:
#[test]
fn warm_unreadable_store_answers_unreadable_not_unknown() {
    // published index (peek Some) + opencode by-id locator hitting an
    // unreadable DB => Unreadable (was Unknown pre-change).
}
#[test]
fn cold_unreadable_locator_stays_unknown_warming_is_honest_pre_readiness() {
    // Cold index + the opencode by-id locator hitting an unreadable store =>
    // Unknown (the scan may still speak; warming is the honest label).
    // Root-proof unreadable seeding (ledger C4a): seed a DIRECTORY at the
    // opencode.db path — SQLite's Connection::open fails on a directory for
    // ANY euid. Do NOT seed a directory at a claude transcript path: the
    // claude locator is metadata-based (claude_snapshot.rs candidate_is_file)
    // and a directory is a clean MISS => Absent (ledger C4b) — a different
    // verdict path, never Unreadable.
}
#[test]
fn cold_opencode_resolves_by_id_without_waiting_for_the_scan() {
    // cold index + opencode session with a seeded opencode.db row =>
    // Present; missing row => Absent (positive, same G28 precedent as the
    // claude cold transcript check).
}
#[test]
fn cold_antigravity_resolves_by_transcript_path_without_waiting_for_the_scan() {
    // cold index + antigravity canonical transcript present => Present;
    // missing => Absent; unreadable => Unknown.
}
#[test]
fn codex_stays_unknown_when_cold_ad4_stands() { /* unchanged expectation, now documented */ }

// update the existing pin `unreadable_opencode_db_answers_unknown_never_absent`
// (existence.rs :1351 area): it becomes
// `unreadable_opencode_db_answers_unreadable_never_absent` — the WARM-path
// expectation flips from Unknown to Unreadable; the never-Absent property is
// the unchanged substance. If the pin exercises the COLD path, keep it and add
// the warm twin; do not delete the never-Absent assertion.

// crates/freshell-protocol/tests/pane_reconcile.rs: extend the error-reason
// serialization pin (:234-239) with "session_store_unreadable".

// crates/freshell-ws/tests/pane_reconcile.rs: scripted-probe test —
// a request whose probe answers Unreadable returns error{reason:
// "session_store_unreadable"} with NO deferral (mirror
// provider_unavailable_is_immediate_and_honest :718).

// crates/freshell-ws/src/resume_validation.rs inline tests: Unreadable maps
// to ResumeExistence::Unknown — fail-open for user creates, blocks managed
// recovery (mirror the existing Unknown rows :160-389).
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-ws unreadable_existence && cargo test -p freshell-server cold_opencode cold_antigravity warm_unreadable`

Expected: FAIL — compile error on `SessionExistence::Unreadable` (missing variant), the intended failure.

- [ ] **Step 3: Add the minimal production implementation**

```rust
// crates/freshell-ws/src/existence.rs (:24-36):
pub enum SessionExistence {
    Present,
    Absent,
    Unknown,
    ProviderUnavailable,
    /// Known provider, index PUBLISHED, but this identity's store could not
    /// be read (locked DB, unreadable transcript/dir). NEVER answered while
    /// the index is cold — pre-readiness uncertainty stays `Unknown`
    /// (warming), because the scan may still speak. Downstream this is the
    /// honest `error{session_store_unreadable}` verdict: not warming (the
    /// banner would lie), not dead_session/fresh (the store may hold the
    /// session; identity is preserved for a later retry).
    Unreadable,
}

// crates/freshell-ws/src/reconcile.rs (:492-510 ladder):
SessionExistence::Unreadable => PaneVerdict {
    reason: Some("session_store_unreadable".to_string()),
    ..base(pane, ReconcileVerdict::Error)
},

// crates/freshell-ws/src/resume_validation.rs (:66-74): map
// SessionExistence::Unreadable beside Unknown => ResumeExistence::Unknown
// (fail-open user creates; managed recovery still requires positive evidence).

// crates/freshell-server/src/existence.rs — WARM arms (:322-464): change the
// Unreadable arms of the claude transcript fallback (:345-364), opencode
// by-id (:378-397), amplifier dir scan (:412-429), and antigravity check
// (:444-461) from `Unknown` to `Unreadable`.
// COLD arm (:265-321): add, beside the claude/amplifier cold locators:
"opencode" => {
    // Cheap cold by-id: the same SQLite locator the warm-miss arm uses
    // (250ms busy timeout) resolves a known session identity without the
    // broad scan. Unreadable stays Unknown while cold (warming is honest
    // pre-readiness).
    match opencode_db_locator(...) {
        ByIdAnswer::Present => SessionExistence::Present,
        ByIdAnswer::Absent => SessionExistence::Absent,
        ByIdAnswer::Unreadable => SessionExistence::Unknown,
    }
}
"antigravity" => {
    // Canonical transcript single-open check, same locator as the warm-miss
    // arm; matches the claude G28 cold-locator precedent.
    match antigravity_transcript_locator(...) {
        ByIdAnswer::Present => SessionExistence::Present,
        ByIdAnswer::Absent => SessionExistence::Absent,
        ByIdAnswer::Unreadable => SessionExistence::Unknown,
    }
}
// codex arm stays Unknown — extend the AD-4 comment (:276-282): the ~1s sync
// rollout walk remains too expensive for the per-pane sync derive path; with
// the readiness-driven recovery (kata vnpc) codex panes park briefly and
// resume automatically when the first sweep publishes.

// every exhaustive `match` on SessionExistence across the workspace gains the
// new arm — grep `SessionExistence::` and handle each (probe impls, gates,
// test stubs like FlippingProbe/StubProbe).
```

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-ws unreadable_existence && cargo test -p freshell-server cold_opencode cold_antigravity warm_unreadable unreadable_opencode && cargo test -p freshell-protocol pane_reconcile`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Fold repeated cold-locator match shapes into a small `by_id_to_existence_cold(...)` helper if the four arms duplicate; keep the warm-miss arms as-is.

- [ ] **Step 6: Run impacted-test verification**

Impacted: the full reconcile/existence/resume-validation surface.

Run: `cargo test -p freshell-ws --test pane_reconcile && cargo test -p freshell-ws --test pane_reconcile_freshagent && cargo test -p freshell-ws --test resume_validation_gate && cargo test -p freshell-server existence && cargo test -p freshell-sessions`

Expected: PASS — including the untouched warming/deferral pins and `row5_unknown_existence_yields_error_index_warming`.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ws/src crates/freshell-server/src crates/freshell-protocol/tests
git commit -m "feat(existence): distinguish unreadable stores from warming post-readiness; resolve cold opencode/antigravity identities by id"
```

---

### Task 5: Client protocol, readiness state, honest fold, shared vocabulary

**Files:**
- Modify: `shared/ws-protocol.ts` (HelloSchema :452-493; ReadyCapabilities :1247-1264; SessionsIndexReadyMessage beside :1791-1794)
- Modify: `src/lib/ready-message-schema.ts` (additive field)
- Modify: `shared/session-contract.ts` (RestoreErrorReasonSchema :17-23)
- Modify: `src/lib/pane-reconcile.ts` (error arms :413-424 fresh-agent, :599-618 terminal)
- Modify: `src/store/connectionSlice.ts` (new state + reducer)
- Modify: `src/components/fresh-agent/FreshAgentView.tsx` (getRestoreErrorMessage :906-921 — the ONLY per-reason copy switch; TerminalView has no twin, ledger C9a)
- Modify: `src/lib/ws-client.ts` (hello capabilities send :553-563)
- Modify Rust persisted model for the vocabulary: `crates/freshell-ws/src/tabs_store_model.rs` (:364 reason list + `read_restore_error`/`restore_error`) and `crates/freshell-ws/src/tabs_persist_validation.rs` (:437-455 allowlist)
- Modify (ledger C9b — two vocabulary allowlists the original file list missed, both required for the atomic vocabulary change): `shared/fresh-agent.ts` (`RESTORE_ERROR_REASONS` Set :71-77 gating `readRestoreError` :268-272 — without it a persisted `session_store_unreadable` latch is silently dropped during legacy-payload migration) and `crates/freshell-freshagent/src/layout_store_content.rs` (`RESTORE_ERROR_REASONS: [&str; 5]` :130-136 gating `read_restore_error` :198-207 — the Rust layout-mirror twin)
- Test: `test/unit/shared/ws-protocol.reconcile.test.ts` (extend), `test/unit/client/lib/pane-reconcile.test.ts` (extend), a connectionSlice test (nearest: search test/unit/client/store for connection tests; else the App wiring test), `test/unit/client/components/App.reconcile-adoption.test.tsx` (extend), Rust `tabs_persist_validation` tests

**Interfaces:**
- Consumes: Task 2 wire contract (capability name, ready field, frame type) and Task 4 reason string.
- Produces (for Task 6): `connectionSlice` state `sessionIndexReady: boolean` (ephemeral, false by default, not persisted — connection slice state is never persisted), reducer `setSessionIndexReady(boolean)`; `SessionsIndexReadySchema`/type; fold mapping verdict reason `session_store_unreadable` → `buildRestoreError('session_store_unreadable')` in both error arms; restore-error reason `'session_store_unreadable'` valid on BOTH the TS schema and the Rust persisted model (same change).

- [ ] **Step 1: Write the failing behavioral test**

```ts
// test/unit/shared/ws-protocol.reconcile.test.ts additions:
it('declares the sessionIndexReadyV1 hello capability (strip hazard)', () => {
  // HelloSchema.safeParse({ ..., capabilities: { sessionIndexReadyV1: true } })
  // must RETAIN the key — undeclared keys are silently stripped by zod.
})
it('parses the sessions.index.ready server frame', () => {
  expect(SessionsIndexReadySchema.safeParse({ type: 'sessions.index.ready' }).success).toBe(true)
})

// test/unit/client/lib/pane-reconcile.test.ts additions (fold, terminal arm):
it('folds error{session_store_unreadable} into an honest per-pane restore error, never warming', () => {
  // foldVerdicts over a verdict { verdict: 'error', reason: 'session_store_unreadable' }
  // => expect setPaneRestoreError with restoreError.reason === 'session_store_unreadable'
  // => expect outcome.warming === 0 and NO setReconcileWarming dispatch.
  // Mirror twin in test/unit/client/lib/pane-reconcile.fresh-agent.test.ts for the fresh-agent arm.
})

// src/lib/ready-message-schema.ts test (find its existing test file —
// grep ready-message-schema in test/unit; else fold into App.reconcile-adoption):
it('parses ready.sessionIndexReady additively and degrades malformed values to undefined', () => {})

// connectionSlice test:
it('setSessionIndexReady stores the per-connection readiness state', () => {})

// App.reconcile-adoption.test.tsx additions (wiring, driven like the existing
// ready-frame tests):
it('dispatches sessionIndexReady from the ready frame state', () => {
  // emit ready with capabilities.sessionIndexReadyV1 + sessionIndexReady: true
  // => store connection.sessionIndexReady === true; a later ready with
  // sessionIndexReady: false resets it.
})
it('dispatches readiness true on the sessions.index.ready broadcast', () => {
  // emit { type: 'sessions.index.ready' } on the mocked socket => state true.
})
```

Rust vocabulary tests (tabs_persist_validation test module): a persisted pane model carrying `restoreError.reason = "session_store_unreadable"` validates; an unknown reason still rejects.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `pnpm run test:vitest run test/unit/shared/ws-protocol.reconcile.test.ts test/unit/client/lib/pane-reconcile.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL — the new fold case fails (current arm maps the reason to `provider_runtime_failed`), the schema cases fail on missing declarations.

- [ ] **Step 3: Add the minimal production implementation**

```ts
// shared/ws-protocol.ts HelloSchema.capabilities (beside paneReconcileV1 :462):
// Session-index readiness (kata vnpc): the client understands the
// sessions.index.ready broadcast and the ready.sessionIndexReady state.
// DECLARED here, not just sent — zod strips undeclared keys.
sessionIndexReadyV1: z.literal(true).optional(),
// ReadyCapabilities (:1247+): sessionIndexReadyV1?: boolean (serde camelCase
// pairs with the Rust rename in Task 2).
// beside SessionsChangedMessage (:1791):
export interface SessionsIndexReadyMessage { type: 'sessions.index.ready' }
export const SessionsIndexReadySchema = z.object({ type: z.literal('sessions.index.ready') })
export type SessionsIndexReady = z.infer<typeof SessionsIndexReadySchema>

// src/lib/ready-message-schema.ts (loose-record doctrine — malformed must
// never fail the whole ready frame):
// Session-index readiness state (additive, Task 2 wire; old servers omit).
// `.catch(undefined)` degrades malformed values to "unknown", never
// disabling restart detection.
sessionIndexReady: z.boolean().optional().catch(undefined),

// shared/session-contract.ts (:17-23): add to RestoreErrorReasonSchema:
'session_store_unreadable',

// src/lib/pane-reconcile.ts terminal error arm (:599-618): before the
// else-branch mapping to provider_runtime_failed:
} else if (verdict.reason === 'session_store_unreadable') {
  // Honest unreadable-store verdict (kata vnpc): the index PUBLISHED but
  // this identity's store could not be read. NOT warming (post-readiness
  // warming would be a lying label) — a per-pane error that preserves the
  // session identity for a later reconnect-driven retry.
  dispatch(setPaneRestoreError({ tabId, paneId, restoreError: buildRestoreError('session_store_unreadable') }))
}
// identical arm in the fresh-agent fold (:413-424).

// src/store/connectionSlice.ts:
sessionIndexReady: boolean  // in ConnectionState (default false)
// reducer:
setSessionIndexReady: (state, action: PayloadAction<boolean>) => {
  state.sessionIndexReady = action.payload
},

// src/lib/ws-client.ts hello send (:553-563): add to the capabilities object:
sessionIndexReadyV1: true,

// src/components/fresh-agent/FreshAgentView.tsx getRestoreErrorMessage (:906-921):
case 'session_store_unreadable':
  return 'This session cannot be resumed because its saved session store could not be read. Reconnecting will retry once the store is readable.'

// src/App.tsx ready handler (with the other ready folds, before the
// reconcile build at :1413):
dispatch(setSessionIndexReady(ready.data.sessionIndexReady === true) as any)
// bootstrap onMessage, beside the sessions.changed arm (:1608-1616):
if (msg.type === 'sessions.index.ready') {
  // Readiness broadcast (capability-gated server-side: receiving it implies
  // this connection negotiated sessionIndexReadyV1). Idempotent state set.
  dispatch(setSessionIndexReady(true) as any)
}

// Rust persisted vocabulary (same commit):
// tabs_store_model.rs :364 — the legal-reason list gains
// "session_store_unreadable" (update the "five legal" doc comment to six and
// the shared/session-contract.ts pointer), read_restore_error accepts it,
// restore_error(reason) constructs it.
// tabs_persist_validation.rs :452-455 — allowlist gains "session_store_unreadable".
// shared/fresh-agent.ts :71-77 — RESTORE_ERROR_REASONS Set gains the reason
// (readRestoreError keeps the persisted latch alive across migration).
// crates/freshell-freshagent/src/layout_store_content.rs :130-136 — the Rust
// RESTORE_ERROR_REASONS array gains the reason ("five" -> six entries).
```

- [ ] **Step 4: Run the focused test**

Run: `pnpm run test:vitest run test/unit/shared/ws-protocol.reconcile.test.ts test/unit/client/lib/pane-reconcile.test.ts test/unit/client/lib/pane-reconcile.fresh-agent.test.ts --config config/vitest/vitest.config.ts && cargo test -p freshell-ws tabs_persist_validation`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

If both error arms duplicate the reason-dispatch chain shape, extract nothing yet — the arms differ in surrounding guards; leave as two explicit arms (fold readability over DRY here).

- [ ] **Step 6: Run impacted-test verification**

Impacted: everything parsing hello/ready/restore errors + Rust persistence validation + the whole reconcile fold surface.

Run: `pnpm run test:vitest run test/unit/client/components/ReconcileWarmingBanner.test.tsx test/unit/client/components/App.reconcile-adoption.test.tsx test/unit/client/store/panesSlice.reconcile.test.ts test/unit/client/lib/ws-client.reconcile.test.ts test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx --config config/vitest/vitest.config.ts && cargo test -p freshell-ws --test pane_reconcile`

Expected: PASS (existing behavior unchanged: `error{index_warming}` still folds warming; `provider_unavailable` still folds `provider_runtime_failed`).

- [ ] **Step 7: Commit the task**

```bash
git add shared/ws-protocol.ts shared/session-contract.ts shared/fresh-agent.ts src/lib/ready-message-schema.ts src/lib/pane-reconcile.ts src/store/connectionSlice.ts src/lib/ws-client.ts src/components/fresh-agent/FreshAgentView.tsx src/App.tsx crates/freshell-ws/src/tabs_store_model.rs crates/freshell-ws/src/tabs_persist_validation.rs crates/freshell-freshagent/src/layout_store_content.rs
git commit -m "feat(client): parse session-index readiness wire state; fold unreadable-store verdicts into honest restore errors"
```

---

### Task 6: The automatic recovery driver

**Files:**
- Create: `src/components/ReconcileWarmingRecoveryDriver.tsx`
- Modify: `src/App.tsx` (mount beside `<ReconcileWarmingBanner />` :2604)
- Modify: `src/components/ReconcileWarmingBanner.tsx` (module doc :9-14 — manual Retry is no longer THE designed recovery path, it stays as the non-routine escape hatch)
- Test: `test/unit/client/components/ReconcileWarmingRecoveryDriver.test.tsx` (new; harness modeled on ReconcileWarmingBanner.test.tsx)

**Interfaces:**
- Consumes: Task 5's `connection.sessionIndexReady`; existing `panes.reconcileWarming` (`{ count, paneRefs }`), `buildReconcileRequestForPanes`, `foldVerdicts` (fold-ownership by reconcileId), `clearReconcileWarming`, `getWsClient()` multi-subscriber `onMessage`, `useAppSelector`/`useAppStore`/`useAppDispatch`, client-logger.
- Produces: `<ReconcileWarmingRecoveryDriver />` (renders null) — the automatic recovery. Constants: `RECOVERY_RETRY_BACKOFF_MS = 2_000`, `RECOVERY_RETRY_LIMIT = 2` (automatic re-drives per readiness observation), `RECOVERY_RESULT_WAIT_MS = 10_000` (in-flight watchdog, mirrors `RECONCILE_RESULT_WAIT_MS`).

**Behavioral contract (test-first):**
1. Effect: when `reconcileWarming` is non-null AND `sessionIndexReady === true` and no drive is in flight → drive once: `buildReconcileRequestForPanes(store.getState(), warming.paneRefs)`; `null` ⇒ `clearReconcileWarming()` (every parked pane closed — "closing a pane cancels its pending recovery") + debug log; else own-reconcileId `ws.onMessage` subscription (fold-ownership: skip foreign `pane.reconcile.result`), `ws.send(request)`, info log `reconcile_warming_recovery drive (paneCount=N, reconcileId=...)`.
2. Result folded: `outcome.warming === 0` ⇒ `clearReconcileWarming()` + info log with duration-since-drive-start; still warming ⇒ bounded backoff: schedule one re-drive after 2s while `attempts < RECOVERY_RETRY_LIMIT` (debug log), else warn `reconcile_warming_recovery gave_up (attempts=N)` and stop (banner + manual Retry remain as the escape hatch — no busy polling).
3. Watchdog: an in-flight drive whose result never arrives (disconnect killed it) is dropped after 10s (subscription unsubscribed; state untouched); a later readiness observation re-drives. `attempts` resets whenever `connection.lastReadyAt` changes (a new handshake = a new readiness observation).
4. Single-flight: a second effect firing while a drive is in flight does not send a second request (dedup).
5. Disconnect: `ws.send` never throws (optional-chained no-op on a dead socket — ledger F2), so there is no send-failure arm; the 10s in-flight watchdog is the disconnect safety net, and the next ready re-evaluates and re-drives. (A `try/catch` around the send is dead code — do not add it; the banner's own Retry does not guard it either.)
6. No drive when `sessionIndexReady === false` (pre-readiness) or when `reconcileWarming` is null.
7. Logs are transition-gated (drive start, settle, retry-scheduled, gave-up, cleared) — nothing per poll/interval; the component runs no timers while idle.

- [ ] **Step 1: Write the failing behavioral test**

`test/unit/client/components/ReconcileWarmingRecoveryDriver.test.tsx` — real `panesReducer` + `connectionReducer` in `configureStore`, mocked `getWsClient` (send capture + multi-subscriber onMessage), fake timers for backoff/watchdog (see `App.reconcile-adoption.test.tsx:676` for the fake-timer pattern). Tests (names are the contract):

```ts
it('drives a reconcile for exactly the warming panes when the index becomes ready — zero interaction')
it('does not drive while the index is not ready')
it('drives when the ready frame reports readiness while panes are already parked (already-ready race)')
it('clears the warming state when its own result resolves every pane')
it('keeps the banner and schedules one bounded backoff retry when a drive still returns warming, then stops at the limit')
it('does not send a second concurrent drive while one is in flight (dedup)')
it('clears the warming state without sending when every parked pane was closed')
it('folds only its own reconcileId, skipping foreign results')
it('drops an unanswered drive after the result watchdog and re-drives on the next readiness observation')
it('resets the retry budget on a new handshake (lastReadyAt change)')
it('leaves restoreError panes out of the warming state (unreadable-store verdicts are not re-parked)')
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `pnpm run test:vitest run test/unit/client/components/ReconcileWarmingRecoveryDriver.test.tsx --config config/vitest/vitest.config.ts`

Expected: FAIL — module does not exist (intended missing behavior).

- [ ] **Step 3: Add the minimal production implementation**

```tsx
// src/components/ReconcileWarmingRecoveryDriver.tsx
// Automatic parked-pane recovery (kata vnpc): when the session index reports
// readiness (ready.sessionIndexReady state or the sessions.index.ready
// broadcast — both folded into connection.sessionIndexReady by App), re-issue
// ONE pane.reconcile.request for exactly the warming panes. This is the
// banner's manual Retry round-trip, automated: same request builder, same
// fold-ownership rule, same clear-on-resolved semantics. The derivation is a
// pure idempotent read server-side; single-writer protection is unchanged.
// Renders null; mounted once beside <ReconcileWarmingBanner />.
const RECOVERY_RETRY_BACKOFF_MS = 2_000
const RECOVERY_RETRY_LIMIT = 2
const RECOVERY_RESULT_WAIT_MS = 10_000

export function ReconcileWarmingRecoveryDriver(): null {
  const warming = useAppSelector((s) => s.panes.reconcileWarming)
  const sessionIndexReady = useAppSelector((s) => s.connection.sessionIndexReady)
  const lastReadyAt = useAppSelector((s) => s.connection.lastReadyAt)
  const store = useAppStore()
  const dispatch = useAppDispatch()
  const pendingRef = useRef<{ request: PaneReconcileRequest; unsubscribe: () => void; watchdog: number; startedAt: number } | null>(null)
  const attemptsRef = useRef(0)
  const lastReadySeenRef = useRef<number>(-1)

  // attempts reset per handshake: a new ready frame is a new readiness
  // observation (reconnect, server restart).
  if (lastReadyAt !== undefined && lastReadyAt !== lastReadySeenRef.current) {
    lastReadySeenRef.current = lastReadyAt
    attemptsRef.current = 0
  }

  const clearPending = useCallback(() => { /* unsubscribe + clearTimeout, null the ref */ }, [])

  useEffect(() => () => clearPending(), [clearPending]) // unmount safety

  useEffect(() => {
    if (!warming || warming.count <= 0 || !sessionIndexReady) return
    if (pendingRef.current) return // single-flight
    if (attemptsRef.current >= RECOVERY_RETRY_LIMIT) return // bounded
    const request = buildReconcileRequestForPanes(store.getState(), warming.paneRefs)
    if (!request) {
      log.info(`[reconcile-warming-recovery] no reconcilable panes remain — clearing (${warming.count} parked)`)
      dispatch(clearReconcileWarming())
      return
    }
    attemptsRef.current += 1
    const startedAt = Date.now()
    log.info(`[reconcile-warming-recovery] drive ${attemptsRef.current}/${RECOVERY_RETRY_LIMIT}: paneCount=${request.panes.length} reconcileId=${request.reconcileId}`)
    const ws = getWsClient()
    const unsubscribe = ws.onMessage((msg) => {
      if (msg.type !== 'pane.reconcile.result') return
      if ((msg as { reconcileId?: unknown }).reconcileId !== request.reconcileId) return // fold-ownership
      clearPending()
      const outcome = foldVerdicts(dispatch, request, msg)
      if (outcome.warming === 0) {
        dispatch(clearReconcileWarming())
        log.info(`[reconcile-warming-recovery] settled: resolved in ${Date.now() - startedAt}ms (reconcileId=${request.reconcileId})`)
      } else if (attemptsRef.current < RECOVERY_RETRY_LIMIT) {
        log.debug(`[reconcile-warming-recovery] still warming after drive — bounded backoff ${RECOVERY_RETRY_BACKOFF_MS}ms`)
        window.setTimeout(() => { /* re-arm: dispatch a no-op tick or directly re-drive via the effect */ }, RECOVERY_RETRY_BACKOFF_MS)
      } else {
        log.warn(`[reconcile-warming-recovery] gave up after ${attemptsRef.current} drives — banner and manual Retry remain`)
      }
    })
    const watchdog = window.setTimeout(() => {
      log.warn(`[reconcile-warming-recovery] result wait expired — dropping drive (reconcileId=${request.reconcileId})`)
      clearPending()
    }, RECOVERY_RESULT_WAIT_MS)
    pendingRef.current = { request, unsubscribe, watchdog, startedAt }
    // ws.send never throws on a dead socket (optional-chained no-op, ledger
    // F2) — the watchdog above is the disconnect safety net, mirroring the
    // banner's own Retry which also does not guard the send.
    ws.send(request)
  }, [warming, sessionIndexReady, dispatch, store])

  return null
}
```

(Implement the backoff re-arm so the effect re-fires — e.g. a `recoveryTick` state bump in the timeout, keeping the single-effect flow; keep the retry path event-driven, no interval.)

Mount in `src/App.tsx` beside the banner (:2604):

```tsx
<ReconcileWarmingBanner />
<ReconcileWarmingRecoveryDriver />
```

Update `src/components/ReconcileWarmingBanner.tsx` module doc (:9-14): warming is EXPECTED on cold boots and now resolves automatically when the index publishes (`ReconcileWarmingRecoveryDriver`); the Retry button remains the non-routine escape hatch (genuine failures, ancient servers) — no longer THE designed recovery path.

- [ ] **Step 4: Run the focused test**

Run: `pnpm run test:vitest run test/unit/client/components/ReconcileWarmingRecoveryDriver.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS (all 11 named tests).

- [ ] **Step 5: Refactor while green**

Extract the drive body into a small pure-ish `driveOnce()` local if the effect grows; keep the component's public surface null-render only.

- [ ] **Step 6: Run impacted-test verification**

Impacted: banner trio, App reconcile lifecycle, fresh-agent reconcile, panesSlice reconcile reducers, persistence stripping.

Run: `pnpm run test:vitest run test/unit/client/components/ReconcileWarmingBanner.test.tsx test/unit/client/components/App.reconcile-adoption.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx test/unit/client/store/panesSlice.reconcile.test.ts test/unit/client/lib --config config/vitest/vitest.config.ts`

Expected: PASS. Also `pnpm run lint` (a11y/plugin rules — the driver renders null; no JSX-a11y surface) and `pnpm run typecheck:client`.

- [ ] **Step 7: Commit the task**

```bash
git add src/components/ReconcileWarmingRecoveryDriver.tsx src/App.tsx src/components/ReconcileWarmingBanner.tsx test/unit/client/components/ReconcileWarmingRecoveryDriver.test.tsx
git commit -m "feat(client): auto-restore parked panes on session-index readiness with bounded dedup retries"
```

---

### Task 7: E2E — zero-interaction slow-index recovery spec + adoption-spec conversion

**Files:**
- Create: `test/e2e-browser/specs/reconcile-auto-restore-warming-rust.spec.ts`
- Modify: `test/e2e-browser/specs/reconcile-client-adoption-rust.spec.ts` (remove `retryWarmingIfVisible` helper :93-109 definition + its 9 poll-body call sites :291, :299, :305, :520, :533, :643, :674, :727, :921 + the doc mention :283)
- Modify: `test/e2e-browser/playwright.cloud.config.ts` (add the new spec to `CLOUD_SKIP_SPECS` with a stated reason)

**Interfaces:**
- Consumes: Task 3's `FRESHELL_TEST_SESSION_INDEX_STARTUP_HOLD_MS` via `RustServer({env})` (helpers/rust-server.ts forwards arbitrary env); the existing donor helpers (per-spec-ownership convention: `seedClaudeHome`-style home seeding incl. provider root — a missing root is `provider_unavailable`, not warming; `writeClaudeTranscript` fixture; `TestHarness` `waitForHarness`/`waitForConnection`/`getState`/`getPaneLayout`/`getSentWsMessages`; `/api/terminals` REST with `x-auth-token`; `installDualRoleCodexCli`/fake CLI fixtures if a codex pane is used; stable-count settle donor from restore-contract-wall).
- Produces: the kata's acceptance e2e — actually executed on the configured (local) backend.

**Spec sketch (four tests; `test.setTimeout(240_000)` matching the donor; all waits generous + explicit):**

```ts
// test/e2e-browser/specs/reconcile-auto-restore-warming-rust.spec.ts
// The kata-vnpc acceptance spec: parked panes restore with ZERO user
// interaction once the session index publishes. The deterministic cold
// window comes from FRESHELL_TEST_SESSION_INDEX_STARTUP_HOLD_MS — the
// server holds every first-publish path behind the startup gate for that
// many ms, so a reconcile during the window answers error{index_warming}
// and readiness then fires at a known time. No page.click anywhere.
const HOLD_MS = 8_000

test('slow index: parked shell and resumed-CLI panes restore automatically with zero interaction', async ({ freshellPage, serverInfo }) => {
  // seed claude home + fixture transcript; boot server with env HOLD_MS;
  // create a shell pane and a fake-CLI claude pane (pre-allocated session id);
  // restart the server (same home/port/token) — the page's WS reconnects
  // during the cold window and the warming banner appears;
  // assert banner visible at least once (role=status, /Waiting for session index/);
  // then WITHOUT ANY CLICK: expect the banner to clear and both panes to
  // restore — shell live with a new terminalId and no restoreError; claude
  // pane resumed with the SAME sessionRef and `--resume <id>` in the
  // post-restart argv; zero dialogs; pane/tab counts unchanged.
})

test('closing a parked pane during warming cancels its recovery', async ({ freshellPage, serverInfo }) => {
  // one claude pane parked behind the banner; close the pane via pane-header
  // Close while the banner is up; after the hold: banner cleared, NO claude
  // terminal respawned (/api/terminals has no claude terminal for that
  // identity), no dialogs, no restoreError anywhere.
})

test('unreadable store: honest per-pane error, banner cleared, identity preserved', async ({ freshellPage, serverInfo }) => {
  // OPENCODE seeding (ledger C4a/C4b): a pane claiming an opencode session,
  // with a DIRECTORY seeded at <isolated data home>/opencode/opencode.db —
  // SQLite open fails on a directory for any euid, so the by-id locator
  // answers Unreadable root-proof. (A claude transcript directory is a
  // clean miss => Absent — the pane would fold fresh/dead_session and never
  // park; do not use it for this scenario.)
  // Parked during the hold (cold Unreadable => Unknown => warming); after
  // readiness the drive folds error{session_store_unreadable}:
  // assert banner cleared, the pane's content.restoreError.reason ===
  // 'session_store_unreadable' (harness getState), sessionRef PRESERVED,
  // no respawn, no dialogs. Warming never returns for this pane.
})

test('two clients parked on one identity auto-restore with exactly one live PTY', async ({ /* two pages, shared context per reconcile-completion test 2 */ }) => {
  // both pages hold the same claude sessionRef pane; restart with HOLD_MS;
  // both park; readiness auto-restores both; stable-count settle on
  // /api/terminals (two samples ≥5s apart): exactly one running claude
  // terminal carrying the sessionRef; both pages' panes attached with no
  // lost/restoreError.
})
```

`CLOUD_SKIP_SPECS` addition (stated reason, honest class): the hold-knob bodies plus the stable-count settle exceed the cloud 120s budget under 2-worker contention (same class as `agent-checkpoint-rewind.spec.ts`). The configured backend is local; the spec is executed there by this task and by the run's gates.

**Conversion** — in `reconcile-client-adoption-rust.spec.ts`: delete `retryWarmingIfVisible` and every call site so the spec's settle polls witness the NEW automatic recovery (a regression in the driver fails this spec instead of being masked by the manual click). Keep every other assertion (verdict folds, notices, /api/terminals, reload shapes) unchanged.

- [ ] **Step 1: Write the failing test**

Write the new spec + the adoption-spec conversion. RED check: before implementation lands this task runs LAST in the client chain — the feature is already implemented by Tasks 1-6, so the spec is expected to PASS; its RED step is against a server WITHOUT the hold knob (Task 3) or client WITHOUT the driver (Task 6). To honor red/green at THIS task's boundary: run the new spec once with the client driver disabled via a temporary `sessionIndexReadyV1` omission in a scratch build is NOT worth it — instead, verify the spec FAILS for the right reason against the pre-Task-3 server binary (stale `target/release/freshell-server` built before the knob): the spec's env var is ignored by a stale binary, the window is machine-speed-dependent, and the banner-visibility assertion may not hold. The honest RED evidence: temporarily set `HOLD_MS = 0` in a scratch run and confirm the "banner appears" assertion is the fragile leg (document the observed output in the task report); with the knob, the GREEN run is deterministic.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `HOLD=0 variant` per Step 1 (record the observed failure mode — cold window racy without the knob).

Expected: FAIL (flaky/absent banner without the deterministic knob) — demonstrating the knob is load-bearing for determinism.

- [ ] **Step 3: Add the minimal production implementation**

The spec itself + the `CLOUD_SKIP_SPECS` entry + the adoption-spec conversion are the implementation (feature code landed in Tasks 1-6). If the spec reveals genuine product defects, fix them under TDD in the owning task's files with focused unit tests first.

- [ ] **Step 4: Run the focused test**

Run: `pnpm run test:e2e:chromium test/e2e-browser/specs/reconcile-auto-restore-warming-rust.spec.ts` (local backend; global-setup builds client + Rust server)

Expected: PASS — all four tests, zero clicks anywhere in the spec.

- [ ] **Step 5: Refactor while green**

Copy-per-spec convention: keep helpers local to the new spec (donor pattern); no shared import.

- [ ] **Step 6: Run impacted-test verification**

Impacted e2e: the converted adoption spec + the reconcile-completion/handshake trio (all reconcile-lane specs), run on the local backend.

Run: `pnpm run test:e2e:chromium test/e2e-browser/specs/reconcile-client-adoption-rust.spec.ts && pnpm run test:e2e:chromium test/e2e-browser/specs/reconcile-completion-rust.spec.ts && pnpm run test:e2e:chromium test/e2e-browser/specs/reconcile-handshake-rust.spec.ts`

Expected: PASS (the adoption spec now converges with zero interaction).

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/reconcile-auto-restore-warming-rust.spec.ts test/e2e-browser/specs/reconcile-client-adoption-rust.spec.ts test/e2e-browser/playwright.cloud.config.ts
git commit -m "test(e2e): zero-interaction slow-index auto-restore spec; adoption specs witness automatic recovery"
```

---

### Task 8: Documentation supersession

**Files:**
- Modify: `docs/plans/2026-07-24-restart-resilience-architecture-analysis.md` (rev-4 supersession note after the existing revision header; surgical bracketed note in §4.3 at :188-191 and §6.1 :250 — the historical text stays legible)
- Modify: `AGENTS.md` (Architecture section: one short paragraph on automatic pane restoration after index readiness, placed near the WebSocket Protocol / PTY Lifecycle paragraphs)
- Modify: `crates/freshell-ws/src/terminal.rs:8826-8836` (the "client's manual retry affordance is the recovery path" comment — now: the readiness-driven client driver is the recovery path; the bounded deferral stays)
- Verify: `docs/index.html` — banner copy is unchanged by this feature, so no mock update is required; confirm by inspection and record that in the task report (repo rule: only major UI changes need mock updates)

**Interfaces:**
- Consumes: the shipped feature (Tasks 1-7).

**Content requirements:**
- July plan note (exact substance): Rev 4 (2026-11-02) — §4.3's "manual retry affordance" is superseded by automatic recovery (kata freshell#vnpc): the server publishes a capability-gated `sessions.index.ready` broadcast plus `ready.sessionIndexReady` state; the client driver re-issues the reconcile for parked panes with bounded dedup retries; the wire half of the decision (no `retry` verdict) stands; the plan's own user ruling #6 ("recovery is automatic, never offered") is the governing principle. Point to `docs/plans/2026-11-02-auto-restore-warming.md`.
- AGENTS.md paragraph (concise, agent-facing): parked pane recovery is automatic on index readiness; `error{index_warming}` remains the honest pre-readiness verdict with one bounded server deferral; readiness = first publish (empty/identical publishes included), broadcast once per boot, carried on `ready` for late/reconnecting clients; `error{session_store_unreadable}` is the honest post-readiness unreadable-store verdict (identity preserved); the banner's Retry remains only as the non-routine escape hatch.
- Pure documentation change: no Red test applies (record why); validation is the repo's doc checks (none are automated for prose) + the full-suite gate remaining green.

- [ ] **Step 1: N/A (documentation)** — record: "Pure documentation change; no meaningful Red step exists (prose is not executable behavior). Validated by typecheck/lint (untouched code) and the full-suite gate."

- [ ] **Step 2: N/A**

- [ ] **Step 3: Apply the edits** exactly as the content requirements above.

- [ ] **Step 4: Verify** — `git diff --stat` shows only the three files; re-read each edit in context; confirm no contradiction with AGENTS.md's existing paragraphs (Negotiated Restore, PTY Lifecycle).

- [ ] **Step 5: Refactor while green** — fold any redundancy between the AGENTS.md paragraph and the July note (each file keeps its own audience-appropriate length).

- [ ] **Step 6: Run impacted-test verification** — code untouched; run `pnpm run typecheck:client` as the cheap tree-wide sanity plus confirm `rg -n "manual retry" docs/plans/2026-07-24-restart-resilience-architecture-analysis.md AGENTS.md src/components/ReconcileWarmingBanner.tsx crates/freshell-ws/src/terminal.rs test/e2e-browser/specs/reconcile-client-adoption-rust.spec.ts` shows only the intended historical/rev-note occurrences.

- [ ] **Step 7: Commit the task**

```bash
git add docs/plans/2026-07-24-restart-resilience-architecture-analysis.md AGENTS.md crates/freshell-ws/src/terminal.rs
git commit -m "docs: supersede the July manual-retry decision with automatic index-readiness recovery"
```

---

## Verification summary (whole-feature)

1. Focused lanes per task (commands above), all green.
2. The affected browser e2e actually executed on the configured local backend (Task 7 Step 4 + Step 6).
3. Full-suite gate at final HEAD: green excluding the seven ledger-recorded pre-existing files (run-state baseline ledger; reproduction receipts in `<logs_dir>/reports/baseline-receipts.md`), with `FRESHELL_RUST_TEST_SANDBOX=1` and `FRESHELL_TEST_SUMMARY` set for the coordinated run.
4. `pnpm run lint` and `pnpm run typecheck` clean.
