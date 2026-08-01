# Codex Attention-Bell Cause Semantics Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Ring the `terminal.idle` bell for every non-human-requested stop of a codex terminal pane — failed turns, unknown-reason aborts, spontaneous process death while working, and approval-request pauses — while keeping human-requested stops (Esc/interrupt, tab close, `terminal.close`, shutdown) silent, with zero wire-shape changes.

**Architecture:** All new causes are internal representations inside the existing server-side tracker/gate machinery (`crates/freshell-activity` + `crates/freshell-ws` on Rust; `server/coding-cli/*` on Node). Every cause emits the SAME `terminal.idle` frame and maps to the SAME not-busy public phase. The codex app-server proxy gains server→client request sniffing (approvals); the rollout parser gains `turn_aborted.reason` plumbing; the registry exit event gains a spontaneous-vs-requested discriminator.

**Tech Stack:** Rust (freshell-activity, freshell-ws, freshell-codex, freshell-terminal, freshell-sessions crates), TypeScript Node server (server/coding-cli, server/terminal-registry.ts, shared/ws-protocol.ts), cargo test, vitest.

## Global Constraints

- Base branch: this worktree (`/home/dan/code/freshell/.worktrees/codex-attention-bell`, branch `feat/codex-attention-bell`) is branched FROM `fix/codex-turn-thread-scope` (head 911fa4cdc). Do NOT rebase onto or branch from `origin/main`.
- ZERO wire-shape changes: the `terminal.idle` frame stays exactly `{ terminalId, at, reason: 'grace' | 'queue-empty' }`. All new causes reuse `reason: 'grace'`. The contract freeze (`npm run test:port`, `port/contract/*.json`) must stay green with NO regenerated contract files.
- The bell (`terminal.idle`) is the ONLY client bell/attention trigger; the not-busy icon is the only indication. NO new user-facing signals, NO new public phase enum values.
- Never emit `terminal.idle` for a HUMAN-REQUESTED stop: Esc/interrupt (`turn.status='interrupted'`, abort reason `interrupted`/`replaced`), tab close / `terminal.close` API / server shutdown kills.
- Busy-deadman/unknown (120s silence) stays silent — uncertainty is not a stop signal; no heuristic bells.
- Strict Red-Green-Refactor TDD: write the failing test, see it fail, implement minimally, see it pass, commit.
- Test coordination (AGENTS.md): run vitest ONLY via `npm run test:vitest -- <paths>` (never raw `npx vitest`). `test:unit` covers `test/unit`, `test:integration` covers `test/server`.
- Rust gates: `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings` must pass.
- Do NOT create/open a PR (needs explicit user approval). Never restart the self-hosted server (build ok, deploy not). Do not touch the running production server (port 3002) or live codex sidecars.
- Commit `.kata.toml` if modified (we do not expect to modify it).
- README.md is the only end-user markdown doc; this plan under `docs/plans/` is a working doc.

## Locked design decisions (read before any task)

1. **`turn/completed status='failed'` rings** by flipping the record predicate — failed takes EXACTLY the same code path as completed, so queued-submit suppression and the 2s IdleGate grace apply naturally. `interrupted` stays a silent clear.
2. **`turn_aborted` reason policy:** reason `interrupted` or `replaced` → silent (human-requested). Reason MISSING → silent (legacy rollout lines carry no reason; the 400-rollout corpus shows `interrupted` is the only real value; an absent reason is uncertainty, and per constraint above uncertainty is not a stop signal). Any OTHER present reason string → ring.
3. **Spontaneous exit while engaged rings immediately** (no grace — a dead process produces no more events; nothing can cancel). "Engaged" = the IdleGate's per-terminal `busy` flag OR an armed grace deadline (a completion bell that was pending when the process died still rings). Queue evidence does NOT suppress death bells. Freshell-initiated kills (`kill`/`kill_all`, by `api`/`idle`/`shutdown`) are silent. Exit while idle is silent. Rust covers claude/codex/amplifier uniformly via the shared hub Exit arm + gate (opencode has no Rust tracker — N/A). Node covers codex/claude/amplifier via the shared `TrulyIdleEmitter`; Node opencode is a documented follow-up (its "record exists ⇔ busy" signal is a noisy busy proxy and would produce heuristic bells).
4. **Auto-resume interaction:** we still ring on spontaneous death even when auto-resume will respawn the process — the respawned codex does not re-run the interrupted turn, so attention IS needed. (Node's codex durable-recovery path that swallows the pty exit entirely — `finishTerminalPtyExit` never runs — emits no exit event, hence no bell; that is correct and stays.)
5. **Approval-request pause:** managed (`--remote`) codex only. The proxy sniffs server→client JSON-RPC REQUESTS (frames with BOTH `id` and `method`) whose method is in the approval set below; the response passing back through the proxy (client→server frame with that `id`, no `method`) resolves it. Internal waiting state maps to the EXISTING not-busy public phase; the same IdleGate boundary arms the bell (2s grace suppresses auto-answered approvals, e.g. `auto_review`). Queued input does NOT suppress approval bells. Unmanaged/PTY-only codex has no approval signal — acceptable, documented.
6. **Approval method set** (from `test/fixtures/coding-cli/codex-app-server/schema-inventory.ts:84-94`, codex 0.129.0 inventory; `item/tool/call` and `account/chatgptAuthTokens/refresh` are automated, NOT human-attention):
   `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`, `applyPatchApproval`, `execCommandApproval`.
7. **Approval thread scoping:** approval request params have no documented shape in this repo (spike logs contain zero approval frames). Sniff by method name with opaque params; best-effort extract `params.threadId` when the frame is small enough to fully parse (`<= MAX_FULL_PARSE_BYTES`); when present and the tracker has a bound thread that differs → ignore (sub-agent approval must not ring the parent pane); when absent → accept (the proxy is per-terminal).
8. **Gate arming for approvals uses a NEW internal tracker effect** (`AttentionBoundary` / Node tracker event `attention.boundary`) that arms the IdleGate WITHOUT emitting a `terminal.turn.complete` frame (an approval pause is not a turn end).
9. **Deferred minors:** (a) clear the in-flight proxy turn id at accepted completion on BOTH servers; (b) Node `lastSeenTaskCompletedAt` only advances for genuine completed status (`undefined` or `'completed'`) — failed/interrupted turns do not bump it (the field name means "task COMPLETED").

## File structure (what each touched file is responsible for)

| File | Responsibility in this plan |
|---|---|
| `crates/freshell-activity/src/codex.rs` | Codex tracker state machine: record predicate, abort-reason policy, approval state, turn-id clear |
| `crates/freshell-activity/src/idle.rs` | IdleGate: new `is_engaged` read accessor |
| `crates/freshell-activity/src/ledger.rs` (or wherever `TrackerEffect` lives) | New `TrackerEffect::AttentionBoundary` variant |
| `crates/freshell-ws/src/activity.rs` | Hub: exit-bell emission, approval HubEvent routing, effect→gate mapping |
| `crates/freshell-ws/src/codex_reconcile.rs` | Rollout fold: capture `turn_aborted.reason` |
| `crates/freshell-ws/src/codex_proxy_route.rs` | Route new proxy approval events into the hub |
| `crates/freshell-codex/src/remote_proxy.rs` | Proxy: approval request sniff + response matching, new event variants |
| `crates/freshell-terminal/src/registry.rs` | `ActivityEvent::Exit` gains `spontaneous: bool` |
| `crates/freshell-sessions/src/parse/codex.rs`, `src/meta.rs` | Rollout parser + snapshot: `latest_turn_aborted_reason` |
| `server/coding-cli/codex-activity-tracker.ts` | Node codex tracker: record predicate, abort policy, approval state, turn-id clear, timestamp fix |
| `server/coding-cli/truly-idle-emitter.ts` | Node gate: spontaneous-exit bell, attention-boundary arming |
| `server/coding-cli/codex-activity-wiring.ts` (+ claude/amplifier wirings) | Thread exit discriminator + approval events into trackers |
| `server/coding-cli/codex-app-server/remote-proxy.ts` | Node proxy approval sniff + response matching |
| `server/coding-cli/providers/codex.ts`, `server/coding-cli/types.ts` | Node rollout parser + snapshot: aborted reason |
| `server/terminal-registry.ts` | Internal `terminal.exit` emissions carry `spontaneous`; sidecar approval subscriptions |
| `server/terminal-stream/registry-events.ts` | New approval event types |
| `shared/ws-protocol.ts` | Doc-comment-only update of `terminal.idle` semantics (schema untouched) |

Run all commands from the worktree root `/home/dan/code/freshell/.worktrees/codex-attention-bell` unless stated otherwise.

---

### Task 1: Rust — failed `turn/completed` records a completion (rings, with queue suppression)

**Files:**
- Modify: `crates/freshell-activity/src/codex.rs:641` (record predicate), `:601-613` (guard-order doc), tests `:1794-1866`
- Modify: `crates/freshell-ws/src/activity.rs` tests (new hub-level test mirroring `:2291`)

**Interfaces:**
- Consumes: `note_proxy_turn_completed(&mut self, terminal_id: &str, thread_id: &str, turn_id: Option<&str>, status: Option<&str>, at: i64) -> Vec<CodexEffect>` (`codex.rs:614-677`); test helpers `phases(&[CodexEffect]) -> Vec<CodexPhase>` (`:962`), `completions(&[CodexEffect]) -> Vec<i64>` (`:975`).
- Produces: `status == Some("failed")` now yields `record = true` (a `TrackerEffect::TurnComplete`, gate armed). `interrupted` unchanged (silent claim). Later tasks rely on failed being routed through the same `record` machinery.

- [ ] **Step 1: Rewrite the pinned test that freezes old behavior (deliberate semantic change) + add the queued-parity test**

In `crates/freshell-activity/src/codex.rs` tests, find `failed_status_clears_busy_without_completion` (`:1814`). Replace it (keep the sibling `interrupted_status_clears_busy_without_completion` at `:1796` untouched):

```rust
/// SEMANTIC CHANGE (attention-bell plan 2026-08-01): a failed turn is a
/// non-human stopping cause — it records a completion so the IdleGate rings.
/// Failed takes EXACTLY the completed path, so queue suppression + grace
/// apply naturally. (Previously pinned as clears-without-completion.)
#[test]
fn failed_status_records_a_completion() {
    // Mirror the setup of `absent_status_still_completes_for_the_bound_thread`
    // (codex.rs:1843): track, bind thread, proxy turn started, then complete.
    let mut tracker = CodexActivityTracker::new();
    tracker.track_terminal("t1", Some("thread-1"), 1_000);
    tracker.note_proxy_turn_started("t1", "thread-1", Some("turn-1"), 2_000);
    let effects =
        tracker.note_proxy_turn_completed("t1", "thread-1", Some("turn-1"), Some("failed"), 5_000);
    assert_eq!(phases(&effects), vec![CodexPhase::Idle]);
    assert_eq!(completions(&effects).len(), 1, "failed must mint a completion");
}

/// Failed must be indistinguishable from completed in effect shape — that is
/// what makes queued-submit suppression and the 2s grace apply for free.
#[test]
fn failed_with_queued_submit_behaves_exactly_like_completed_with_queued_submit() {
    let run = |status: &str| {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 1_000);
        tracker.note_proxy_turn_started("t1", "thread-1", Some("turn-1"), 2_000);
        // Queue a submit while busy (mirror the input used by
        // `queued_submit_rearms_pending_after_the_bel_and_completes_each_turn`, codex.rs:1039).
        tracker.note_input("t1", "do the next thing\r", 3_000);
        let effects = tracker.note_proxy_turn_completed(
            "t1", "thread-1", Some("turn-1"), Some(status), 5_000,
        );
        (phases(&effects), completions(&effects).len())
    };
    assert_eq!(run("failed"), run("completed"));
}
```

Adapt constructor/helper calls to the exact signatures used by the neighboring tests in the same `mod tests` (e.g. if `track_terminal` takes different args there, copy that file's local idiom — the assertions above are the contract).

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cargo test -p freshell-activity failed_status -- --nocapture` and `cargo test -p freshell-activity failed_with_queued_submit`
Expected: FAIL — `completions(&effects).len()` is 0 for failed (old predicate).

- [ ] **Step 3: Flip the record predicate**

At `crates/freshell-activity/src/codex.rs:641` change:

```rust
let record = matches!(status, None | Some("completed"));
```

to:

```rust
// Attention-bell policy: completed AND failed are non-human stopping causes
// and record a completion (=> gate arms => terminal.idle). `interrupted`
// (and only it) is human-requested and stays a silent claim. If a queued
// submit exists the shared transition machinery re-arms instead of ringing —
// the queued message auto-submits and work continues.
let record = matches!(status, None | Some("completed") | Some("failed"));
```

Update the guard-order doc block at `codex.rs:601-613` (item 6, the status decision) to say `completed | failed | absent ⇒ record; interrupted ⇒ silent claim`.

- [ ] **Step 4: Run the crate suite**

Run: `cargo test -p freshell-activity`
Expected: PASS (including the two new tests). If any other test pinned failed-is-silent, update it with the same SEMANTIC CHANGE comment.

- [ ] **Step 5: Add the hub-level bell test (failed rings; failed+queued drains to a single idle)**

In `crates/freshell-ws/src/activity.rs` `mod tests`, copy the body of `codex_queued_rearm_drains_to_a_single_grace_idle` (`:2291`) into a new test `codex_failed_turn_rings_and_queued_failed_drains_to_a_single_idle`, changing the final proxy completion's status argument from `"completed"` to `"failed"` (the hub entry is `hub.note_codex_proxy_turn(terminal_id, thread_id, turn_id, Some("failed"), true)` — see `activity.rs:280-287`). Assert the identical frame outcome the original asserts (exactly one `terminal.idle` via `next_frame_matching(rx, "terminal.idle", ..)`, `:1345`). Also add a plain (no queue) variant mirroring `proxy_turn_events_reach_the_codex_tracker_and_emit_turn_complete` (`:2533`) with status `"failed"`, asserting one `terminal.idle` arrives.

- [ ] **Step 6: Run and verify**

Run: `cargo test -p freshell-ws codex_failed`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/freshell-activity/src/codex.rs crates/freshell-ws/src/activity.rs
git commit -m "feat(activity): failed codex turns record a completion and ring terminal.idle"
```

---

### Task 2: Rust — clear the in-flight proxy turn id at accepted completion (deferred minor a)

**Files:**
- Modify: `crates/freshell-activity/src/codex.rs` (`note_proxy_turn_completed` `:614-677`; field doc `:143-148`)

**Interfaces:**
- Consumes: `current_proxy_turn_id: Option<String>` — set at `codex.rs:588`, today cleared only on rebind (`:247`, `:306`).
- Produces: `current_proxy_turn_id == None` after ANY accepted terminal-status completion (completed/failed/interrupted). `inProgress` and guard-rejected events leave it untouched.

- [ ] **Step 1: Write the failing test**

```rust
/// Deferred minor from the thread-scope plan: the in-flight proxy turn id
/// must not survive the turn it belongs to. A NEW turn id arriving after a
/// completed one must not be rejected by the stale-turn-id guard.
#[test]
fn accepted_completion_clears_the_in_flight_proxy_turn_id() {
    let mut tracker = CodexActivityTracker::new();
    tracker.track_terminal("t1", Some("thread-1"), 1_000);
    tracker.note_proxy_turn_started("t1", "thread-1", Some("turn-1"), 2_000);
    tracker.note_proxy_turn_completed("t1", "thread-1", Some("turn-1"), Some("completed"), 3_000);
    // With the id cleared, a follow-up turn with a new id starts cleanly and
    // its completion is NOT swallowed by the turn-id-mismatch guard.
    tracker.note_proxy_turn_started("t1", "thread-1", Some("turn-2"), 4_000);
    let effects = tracker.note_proxy_turn_completed(
        "t1", "thread-1", Some("turn-2"), Some("completed"), 6_000,
    );
    assert_eq!(completions(&effects).len(), 1);
}
```

Additionally, if the tracker exposes no direct state read, prove the clear via the mismatch guard: after the first completion, send a completion for `Some("turn-1")` again — with the id cleared AND `swallow_next_proxy_complete` consumed, dedupe must come from `last_emitted_turn_key`, not guard 4. Keep the test above as the primary contract.

- [ ] **Step 2: Run to verify it fails (or passes only by accident)**

Run: `cargo test -p freshell-activity accepted_completion_clears`
Expected: compile+run. If it passes already (turn-2 path may survive via other guards), strengthen: assert via a `#[cfg(test)]` accessor `fn current_proxy_turn_id_for(&self, terminal_id: &str) -> Option<String>` added to the tracker, asserting `None` after the first completion. Expected: FAIL.

- [ ] **Step 3: Implement the clear**

In `note_proxy_turn_completed`, in BOTH accepted arms — the `Pending` arm (after `codex.rs:652-654`) and the `Busy | Unknown` arm (after `:670-672`) — add:

```rust
state.current_proxy_turn_id = None;
```

Update the field doc at `codex.rs:143-148` to say: set on TurnStarted, cleared on rebind AND at every accepted terminal-status completion.

- [ ] **Step 4: Run tests**

Run: `cargo test -p freshell-activity`
Expected: PASS (existing turn-id-dedupe tests `:1867-1903` must still pass — the stale-id guard still works for a completion arriving BEFORE the in-flight turn ends).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-activity/src/codex.rs
git commit -m "fix(activity): clear the in-flight codex proxy turn id at accepted completion"
```

---

### Task 3: Rust — plumb `turn_aborted.reason` and ring on non-human abort reasons

**Files:**
- Modify: `crates/freshell-sessions/src/parse/codex.rs` (`:294` area, output struct fill `:449-450`)
- Modify: `crates/freshell-sessions/src/meta.rs:30` (snapshot struct)
- Modify: `crates/freshell-activity/src/codex.rs:86-99` (`CodexTaskEvents`), `:341-348` + `:400`/`:419` (abort policy), tests `:1237`, `:1260`
- Modify: `crates/freshell-ws/src/codex_reconcile.rs:117-140` (fold), fixture tests near `:238`

**Interfaces:**
- Consumes: `CodexTaskEvents { latest_task_started_at, latest_task_completed_at, latest_turn_aborted_at: Option<i64> }`; `reconcile_rollout(&mut self, terminal_id: &str, events: &CodexTaskEvents, at: i64) -> Vec<CodexEffect>` (`codex.rs:320-429`).
- Produces: `CodexTaskEvents` and the freshell-sessions snapshot gain `pub latest_turn_aborted_reason: Option<String>` (the reason paired with the winning `latest_turn_aborted_at`). Policy helper `fn abort_reason_is_human(reason: Option<&str>) -> bool` in `codex.rs`. Task 10 mirrors the same field/policy names on Node (`latestTurnAbortedReason`, `abortReasonIsHuman`).

- [ ] **Step 1: Write failing tracker tests (policy)**

In `crates/freshell-activity/src/codex.rs` tests, next to `reconcile_turn_aborted_clears_without_completing` (`:1237`) — which stays valid for reason-less aborts but should be renamed/documented — add. Use the local `CodexTaskEvents` construction idiom (helpers `started(at)`/`completed(at)` at `:1183`/`:1189`; extend or inline with the new field):

```rust
fn aborted(at: i64, reason: Option<&str>) -> CodexTaskEvents {
    CodexTaskEvents {
        latest_task_started_at: Some(at - 1_000),
        latest_task_completed_at: None,
        latest_turn_aborted_at: Some(at),
        latest_turn_aborted_reason: reason.map(str::to_string),
    }
}

/// Human-requested abort (Esc) — silent, unchanged behavior.
#[test]
fn reconcile_abort_with_interrupted_reason_clears_without_completing() {
    let mut tracker = CodexActivityTracker::new();
    tracker.track_terminal("t1", Some("sess-1"), 1_000);
    tracker.reconcile_rollout("t1", &started(2_000), 2_000);
    let effects = tracker.reconcile_rollout("t1", &aborted(5_000, Some("interrupted")), 5_000);
    assert_eq!(completions(&effects).len(), 0);
}

/// 'replaced' = human submitted new input — silent.
#[test]
fn reconcile_abort_with_replaced_reason_clears_without_completing() {
    let mut tracker = CodexActivityTracker::new();
    tracker.track_terminal("t1", Some("sess-1"), 1_000);
    tracker.reconcile_rollout("t1", &started(2_000), 2_000);
    let effects = tracker.reconcile_rollout("t1", &aborted(5_000, Some("replaced")), 5_000);
    assert_eq!(completions(&effects).len(), 0);
}

/// Missing reason = legacy rollout line / uncertainty — no heuristic bells.
#[test]
fn reconcile_abort_without_reason_clears_without_completing() {
    let mut tracker = CodexActivityTracker::new();
    tracker.track_terminal("t1", Some("sess-1"), 1_000);
    tracker.reconcile_rollout("t1", &started(2_000), 2_000);
    let effects = tracker.reconcile_rollout("t1", &aborted(5_000, None), 5_000);
    assert_eq!(completions(&effects).len(), 0);
}

/// Any OTHER present reason is not human-attributed — it records (rings).
#[test]
fn reconcile_abort_with_unknown_reason_records_a_completion() {
    let mut tracker = CodexActivityTracker::new();
    tracker.track_terminal("t1", Some("sess-1"), 1_000);
    tracker.reconcile_rollout("t1", &started(2_000), 2_000);
    let effects = tracker.reconcile_rollout("t1", &aborted(5_000, Some("token_budget_exceeded")), 5_000);
    assert_eq!(completions(&effects).len(), 1);
}
```

- [ ] **Step 2: Verify they fail to compile (no `latest_turn_aborted_reason` field yet)**

Run: `cargo test -p freshell-activity reconcile_abort`
Expected: COMPILE ERROR — missing field. That is the red state.

- [ ] **Step 3: Widen the carriers and implement the policy**

1. `crates/freshell-activity/src/codex.rs:86-99` — add to `CodexTaskEvents`:

```rust
/// Reason string paired with `latest_turn_aborted_at` (e.g. "interrupted").
/// None on legacy rollout lines that carry no reason.
pub latest_turn_aborted_reason: Option<String>,
```

2. Same file, next to `has_queued_submit` (`:822-830`), add:

```rust
/// Human-attributed abort reasons stay silent. A MISSING reason is treated
/// as human/uncertain (legacy rollouts omit it; the real-world corpus shows
/// 'interrupted' is the only observed value; uncertainty never rings).
fn abort_reason_is_human(reason: Option<&str>) -> bool {
    matches!(reason, None | Some("interrupted") | Some("replaced"))
}
```

3. In `reconcile_rollout`, the tie-break at `:341-348` stays; where `!clear_is_abort` is passed as `record` (`:400`, `:419`), change both to:

```rust
let record = !clear_is_abort
    || !abort_reason_is_human(events.latest_turn_aborted_reason.as_deref());
```

(bind once above the two call sites and pass `record`). Update the rationale comment at `codex.rs:336-340` — see Task 13 for the exact new doc language; here just make it not lie (aborts with a non-human reason DO record).

4. `crates/freshell-ws/src/codex_reconcile.rs:117-140` — in `fold_task_events`, the `Some("turn_aborted")` arm currently only maxes the timestamp. Capture the reason WITH the winning timestamp (only overwrite the reason when this event's timestamp becomes the new max):

```rust
Some("turn_aborted") => {
    if timestamp_beats(events.latest_turn_aborted_at, at) {
        events.latest_turn_aborted_at = Some(at);
        events.latest_turn_aborted_reason = payload
            .get("reason")
            .and_then(|v| v.as_str())
            .map(str::to_string);
    }
}
```

Adapt to the fold's existing max-assign idiom (it may use a helper; the invariant is: reason always corresponds to the newest abort, and is `None` when that abort had no reason).

5. `crates/freshell-sessions/src/meta.rs:30` — add the same `pub latest_turn_aborted_reason: Option<String>` to the snapshot struct; `crates/freshell-sessions/src/parse/codex.rs` (`:294` and struct fill around `:449-450`) — track and emit the reason alongside the timestamp with the same newest-wins pairing. Fix all struct-literal construction sites the compiler flags (tests included) with `latest_turn_aborted_reason: None` where behavior is not under test.

- [ ] **Step 4: Add fold + parser tests**

In `codex_reconcile.rs` tests (fixture literal near `:238`), add a line with a reason and assert extraction:

```rust
// payload: {"type":"turn_aborted","turn_id":"x","reason":"interrupted"}
// assert events.latest_turn_aborted_reason == Some("interrupted".into())
// and a reason-less legacy line yields None.
```

Mirror the existing fold test structure exactly. Add the equivalent parser test in `freshell-sessions` next to its existing `turn_aborted` coverage.

- [ ] **Step 5: Run all three crates**

Run: `cargo test -p freshell-activity -p freshell-ws -p freshell-sessions`
Expected: PASS. The pre-existing `reconcile_turn_aborted_clears_without_completing` (`:1237`) must still pass (its fixture has no reason → silent); update its doc comment to note the refinement.

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-activity/src/codex.rs crates/freshell-ws/src/codex_reconcile.rs crates/freshell-sessions/src/meta.rs crates/freshell-sessions/src/parse/codex.rs
git commit -m "feat(activity): ring on non-human turn_aborted reasons via end-to-end reason plumbing"
```

---

### Task 4: Rust — exit-cause discriminator on `ActivityEvent::Exit`

**Files:**
- Modify: `crates/freshell-terminal/src/registry.rs` (`:407-410` enum, `:1507-1510` kill emit, `:1625-1628` natural emit; tests `:4260`, `:4342`)
- Modify: every `ActivityEvent::Exit` construction/match site the compiler flags (notably `crates/freshell-ws/src/activity.rs` tests, which construct Exit via `observer_send`)

**Interfaces:**
- Consumes: `ActivityEvent::Exit { terminal_id: String, at: i64 }`; `kill_internal(&self, terminal_id, by: &'static str)` (`:1444`); `finish_pty_exit(&self, terminal_id, exit_code)` (`:1567`).
- Produces: `ActivityEvent::Exit { terminal_id: String, at: i64, spontaneous: bool }` — `false` from `kill_internal` (freshell-initiated: api/idle/shutdown), `true` from `finish_pty_exit` (spontaneous PTY/process death). Task 5 consumes `spontaneous`.

- [ ] **Step 1: Write the failing registry tests**

Next to the existing exit-event tests (`registry.rs:4260`, `:4342`), add assertions on the new field (mirror their observer-capture harness):

```rust
// kill() path: captured ActivityEvent::Exit must have spontaneous == false.
// finish_pty_exit() path: captured ActivityEvent::Exit must have spontaneous == true.
```

Write them as two tests, `kill_emits_a_non_spontaneous_exit_event` and `natural_pty_exit_emits_a_spontaneous_exit_event`, copying the setup of the nearest existing test that captures activity events.

- [ ] **Step 2: Verify compile failure (red)**

Run: `cargo test -p freshell-terminal kill_emits_a_non_spontaneous`
Expected: COMPILE ERROR — no such field.

- [ ] **Step 3: Implement**

`registry.rs:407-410`:

```rust
Exit {
    terminal_id: String,
    at: i64,
    /// true = the process died on its own (finish_pty_exit); false = a
    /// freshell-initiated kill (api / idle reaper / shutdown). Human-requested
    /// closes must never ring the attention bell.
    spontaneous: bool,
},
```

`kill_internal` emit (`:1507-1510`): add `spontaneous: false,`. `finish_pty_exit` emit (`:1625-1628`): add `spontaneous: true,`. Fix every other construction site the compiler flags: in `crates/freshell-ws/src/activity.rs` tests and anywhere else, use `spontaneous: false` (preserves prior silent expectations) unless the test is specifically about death bells (Task 5 adds those).

- [ ] **Step 4: Run**

Run: `cargo test -p freshell-terminal && cargo test -p freshell-ws`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-terminal/src/registry.rs crates/freshell-ws/src/activity.rs
git commit -m "feat(terminal): carry a spontaneous-vs-requested discriminator on exit activity events"
```

---

### Task 5: Rust — spontaneous exit while engaged rings `terminal.idle` (claude/codex/amplifier)

**Files:**
- Modify: `crates/freshell-activity/src/idle.rs` (new accessor; tests `:182-416`)
- Modify: `crates/freshell-ws/src/activity.rs` Exit arm (`:724-753`) + tests

**Interfaces:**
- Consumes: `ActivityEvent::Exit { terminal_id, at, spontaneous }` (Task 4); `IdleGate` internals `TerminalIdleState { busy, pending, saw_queue_evidence, deadline }` (`idle.rs:49-60`); frame shape `ServerMessage::TerminalIdle(TerminalIdle { terminal_id, at, reason })` as built at `activity.rs:1039-1045`.
- Produces: `IdleGate::is_engaged(&self, terminal_id: &str) -> bool` (busy OR armed deadline). Hub emits exactly one `terminal.idle` (reason `Grace`) for a spontaneous exit while engaged, for all three hub trackers.

- [ ] **Step 1: Write the failing IdleGate accessor test**

In `idle.rs` `mod tests`:

```rust
#[test]
fn is_engaged_reflects_busy_and_armed_deadlines() {
    let mut gate = IdleGate::with_grace_ms(2_000);
    assert!(!gate.is_engaged("t1"), "unknown terminal is not engaged");
    gate.note_phase("t1", IdleGatePhase::Busy);
    assert!(gate.is_engaged("t1"), "busy is engaged");
    gate.note_phase("t1", IdleGatePhase::Idle);
    assert!(!gate.is_engaged("t1"), "idle with no pending window is not engaged");
    gate.note_turn_boundary("t1", 10_000); // arms deadline
    assert!(gate.is_engaged("t1"), "an armed grace window is engaged (a pending bell must survive death)");
    gate.expire(20_000);
    assert!(!gate.is_engaged("t1"), "after emission nothing is engaged");
}
```

- [ ] **Step 2: Red, then implement the accessor**

Run: `cargo test -p freshell-activity is_engaged` → COMPILE ERROR. Then add to `impl IdleGate` next to `note_exit` (`idle.rs:142-144`):

```rust
/// True while the tracker reports busy-or-pending OR a grace window is
/// armed. Read by the hub's exit arm BEFORE `note_exit` drops the state:
/// a spontaneous process death while engaged rings the attention bell.
pub fn is_engaged(&self, terminal_id: &str) -> bool {
    self.states
        .get(terminal_id)
        .map(|s| s.busy || s.deadline.is_some())
        .unwrap_or(false)
}
```

Run: `cargo test -p freshell-activity is_engaged` → PASS.

- [ ] **Step 3: Write the failing hub tests**

In `activity.rs` `mod tests` (use `hub()` `:1331`, `observer_send` `:1337`, `next_frame_matching`/`next_frame_of_type` `:1345`/`:1369`; mirror `exit_broadcasts_remove_and_clears_state` `:1564` for setup — codex mode terminal driven to Busy via the proxy lane or rollout fixture):

```rust
// 1. spontaneous_exit_while_busy_rings_terminal_idle_once
//    Drive t1 (codex) to Busy; observer_send(Exit { spontaneous: true, at });
//    assert exactly one terminal.idle frame for t1 (and then no second one —
//    mirror the no-second-idle assertion style of :2778-2789).
// 2. freshell_initiated_kill_while_busy_stays_silent
//    Same setup; Exit { spontaneous: false }; assert NO terminal.idle
//    (bounded wait, mirror existing negative-assertion helpers).
// 3. spontaneous_exit_while_idle_stays_silent
//    Track t1 but leave it Idle; Exit { spontaneous: true }; no frame.
// 4. queued_submit_does_not_suppress_the_death_bell
//    Busy + queued submit input, then Exit { spontaneous: true };
//    terminal.idle STILL emitted (a dead process never runs the queue).
// 5. claude_spontaneous_exit_while_busy_rings — same as (1) with a claude-mode
//    terminal driven Busy via the claude lane (mirror
//    claude_submit_bel_turn_complete_and_terminal_idle_flow :1450 setup).
```

Write all five as real tests with the file's local harness idioms.

- [ ] **Step 4: Red**

Run: `cargo test -p freshell-ws spontaneous_exit`
Expected: FAIL — no frame emitted (exit is currently silent).

- [ ] **Step 5: Implement the hub exit-bell**

Rewrite the Exit arm (`activity.rs:724-753`) — bind `at` and `spontaneous`, read engagement BEFORE any state is dropped (`note_exit` at `:730` and each tracker's `note_exit` both destroy the evidence):

```rust
ActivityEvent::Exit { terminal_id, at, spontaneous } => {
    let frames = {
        let mut inner = self.inner.lock().expect("activity hub lock");
        let Some(mode) = inner.modes.remove(&terminal_id) else {
            return;
        };
        // Read BEFORE note_exit drops gate state. Engaged = busy/pending
        // OR an armed grace window (a pending completion bell must still
        // ring if the process dies during the grace).
        let ring_death_bell = spontaneous && inner.idle.is_engaged(&terminal_id);
        inner.idle.note_exit(&terminal_id);
        inner.lanes.remove(&terminal_id);
        inner.lane_retries.remove(&terminal_id);
        inner.codex_lanes.remove(&terminal_id);
        let mut frames = match mode.as_str() {
            "claude" => {
                let effects = inner.claude.note_exit(&terminal_id);
                claude_frames(&mut inner.idle, effects)
            }
            "codex" => {
                let effects = inner.codex.note_exit(&terminal_id);
                let (frames, _force_reads) = codex_frames(&mut inner.idle, effects);
                frames
            }
            "amplifier" => {
                let effects = inner.amplifier.note_exit(&terminal_id);
                let (frames, _force) = amplifier_frames(&mut inner.idle, effects);
                frames
            }
            _ => Vec::new(),
        };
        if ring_death_bell {
            // Spontaneous death while working: same frame, same reason —
            // no wire change. Immediate (no grace): a dead process emits
            // nothing further, so nothing could ever cancel it. Exactly
            // once per terminal: modes.remove above guarantees the arm
            // runs once (a later shutdown sweep of a retained exited row
            // arrives with spontaneous=false AND finds no mode).
            frames.push(ServerMessage::TerminalIdle(TerminalIdle {
                terminal_id: terminal_id.clone(),
                at,
                reason: TerminalIdleReason::Grace,
            }));
        }
        frames
    };
    self.emit(frames);
}
```

- [ ] **Step 6: Run**

Run: `cargo test -p freshell-ws && cargo test -p freshell-activity`
Expected: PASS, including pre-existing exit tests (`exit_broadcasts_remove_and_clears_state`, `codex_lane_is_torn_down_on_exit`) which now pass `spontaneous: false` (or are idle at exit).

- [ ] **Step 7: Commit**

```bash
git add crates/freshell-activity/src/idle.rs crates/freshell-ws/src/activity.rs
git commit -m "feat(ws): ring terminal.idle on spontaneous process death while engaged"
```

---

### Task 6: Rust — proxy sniffs approval requests and matches their responses

**Files:**
- Modify: `crates/freshell-codex/src/remote_proxy.rs` (const set near `:74-81`; `handle_upstream_frame` `:1085-1139`; `forward_client_frame` `:1017-1032`; `RemoteProxyEvent` `:199-207`; per-connection state alongside `pending_methods`)

**Interfaces:**
- Consumes: `scan_json_rpc_envelope` → `JsonRpcEnvelope { id: Option<JsonRpcEnvelopeId>, method: Option<String>, .. }` (`remote_proxy_envelope.rs:55-59`); existing `MAX_FULL_PARSE_BYTES` full-parse gating pattern (`turn_notification_effects` `:1326-1399`).
- Produces (Task 7 consumes):

```rust
pub struct ApprovalRequestParams {
    /// Canonicalized request id (string form of the JSON-RPC id).
    pub request_id: String,
    pub method: String,
    /// Best-effort params.threadId — None for oversized/opaque frames.
    pub thread_id: Option<String>,
}
// New RemoteProxyEvent variants:
ApprovalRequested(ApprovalRequestParams),
ApprovalResolved { request_id: String },
```

- [ ] **Step 1: Write the failing proxy tests**

Locate the existing `mod tests` in `remote_proxy.rs` (the branch added upstream-notification tests — find the test that feeds a synthetic upstream `turn/completed` frame through the hub/connection harness and mirror its setup exactly). Add:

```rust
// 1. approval_request_frame_emits_approval_requested_and_relays_verbatim
//    Feed upstream frame: {"jsonrpc":"2.0","id":41,"method":"item/commandExecution/requestApproval",
//                          "params":{"threadId":"thread-1","command":"rm -rf /tmp/x"}}
//    Assert: RemoteProxyEvent::ApprovalRequested { request_id: "41", method: ".../requestApproval",
//    thread_id: Some("thread-1") } is emitted AND the exact bytes reach the client side.
// 2. non_approval_server_request_is_relayed_without_events
//    Same with method "item/tool/call" — no event, bytes relayed.
// 3. approval_response_emits_approval_resolved_and_forwards_upstream
//    After (1), feed CLIENT frame {"jsonrpc":"2.0","id":41,"result":{"decision":"approved"}}.
//    Assert ApprovalResolved { request_id: "41" } emitted AND frame forwarded upstream.
// 4. client_response_with_unknown_id_emits_nothing
//    Client frame {"id":999,"result":{}} — no ApprovalResolved (it may be a
//    response to OUR own pending client request; untouched behavior).
// 5. approval_request_without_thread_id_yields_none
//    Frame like (1) but params lacks threadId — thread_id == None.
```

- [ ] **Step 2: Red**

Run: `cargo test -p freshell-codex approval`
Expected: COMPILE ERROR (no variants) — red.

- [ ] **Step 3: Implement**

1. Const next to `STATEFUL_NOTIFICATION_METHODS` (`:74-81`):

```rust
/// Server→client JSON-RPC REQUEST methods that block on a human. Sourced
/// from the codex 0.129.0 schema inventory
/// (test/fixtures/coding-cli/codex-app-server/schema-inventory.ts:84-94);
/// `item/tool/call` and `account/chatgptAuthTokens/refresh` are automated
/// and deliberately excluded.
const APPROVAL_REQUEST_METHODS: &[&str] = &[
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "item/tool/requestUserInput",
    "mcpServer/elicitation/request",
    "applyPatchApproval",
    "execCommandApproval",
];
```

2. Per-connection state: alongside `pending_methods` / `pending_fork_requests` add `pending_server_approvals: HashSet<RequestId>` (use the same `RequestId` type `pending_methods` keys on; add a small `fn envelope_id_to_string(id: &JsonRpcEnvelopeId) -> String` for the event payload — string ids verbatim, numeric ids via their canonical integer formatting).

3. In `handle_upstream_frame`, at the TOP of the with-id branch (`:1099`), BEFORE the `pending_methods.remove` lookup:

```rust
if let Some(method) = envelope.method.as_deref() {
    // id + method ⇒ a server→client REQUEST (our own responses never
    // reach this path). Never consult pending_methods for these — the
    // server's id space is not ours.
    if APPROVAL_REQUEST_METHODS.contains(&method) {
        if let Some(req_id) = envelope_id_to_request_id(&id) {
            let thread_id = (data.len() <= MAX_FULL_PARSE_BYTES)
                .then(|| serde_json::from_slice::<serde_json::Value>(&data).ok())
                .flatten()
                .and_then(|v| v.pointer("/params/threadId").and_then(|t| t.as_str()).map(str::to_string));
            if let Some(conn) = self.connections.get_mut(&conn_id) {
                conn.pending_server_approvals.insert(req_id);
            }
            self.emit(RemoteProxyEvent::ApprovalRequested(ApprovalRequestParams {
                request_id: envelope_id_to_string(&id),
                method: method.to_string(),
                thread_id,
            }));
        }
    }
    self.send_to_client(conn_id, data, binary);
    return;
}
```

(Reuse the existing `envelope_id_to_request_id` helper visible at `:1017`; keep relay-verbatim semantics for ALL server requests, approval or not.)

4. In `forward_client_frame` (`:1017-1032`), when `id` is Some and `method` is None (a response):

```rust
if method.is_none() {
    if let Some(req_id) = id.as_ref().and_then(envelope_id_to_request_id) {
        if let Some(conn) = self.connections.get_mut(&conn_id) {
            if conn.pending_server_approvals.remove(&req_id) {
                self.emit(RemoteProxyEvent::ApprovalResolved {
                    request_id: envelope_id_to_string(id.as_ref().unwrap()),
                });
            }
        }
    }
}
```

Restructure to fit the existing `if let (Some(id), Some(method))` shape without double-borrowing; forward the frame upstream unchanged in all cases.

5. Add the two variants + struct to `RemoteProxyEvent` (`:199-207`).

- [ ] **Step 4: Run**

Run: `cargo test -p freshell-codex`
Expected: PASS (all five new tests + no regression in the notification tests).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-codex/src/remote_proxy.rs
git commit -m "feat(codex): sniff app-server approval requests and match their responses in the proxy"
```

---

### Task 7: Rust — approval pause rings once; response returns to busy

**Files:**
- Modify: `crates/freshell-activity/src/ledger.rs` (or the file defining `TrackerEffect` — locate with `grep -rn "enum TrackerEffect" crates/freshell-activity/src/`): new variant
- Modify: `crates/freshell-activity/src/codex.rs` (new state fields + `note_approval_requested`/`note_approval_resolved`; clears in completion/rebind paths)
- Modify: `crates/freshell-ws/src/activity.rs` (`codex_frames` `:1195-1242`; `claude_frames` `:1146-1191`; `amplifier_frames` `:1246-1292`; new `HubEvent::CodexApproval` + public entry; hub tests)
- Modify: `crates/freshell-ws/src/codex_proxy_route.rs` (`route_proxy_event` `:46-95`)

**Interfaces:**
- Consumes: `RemoteProxyEvent::ApprovalRequested(ApprovalRequestParams)` / `ApprovalResolved { request_id }` (Task 6); `IdleGate::note_turn_boundary` (`idle.rs:109-119`), `note_phase` (`:91-104`).
- Produces:

```rust
// freshell-activity (TrackerEffect definition):
/// Arms the truly-idle gate WITHOUT minting a turn completion or a
/// terminal.turn.complete frame. Used for attention causes that are not
/// turn ends (approval-request pauses).
AttentionBoundary { terminal_id: String, at: i64 },

// CodexActivityTracker:
pub fn note_approval_requested(&mut self, terminal_id: &str, thread_id: Option<&str>, request_id: &str, at: i64) -> Vec<CodexEffect>;
pub fn note_approval_resolved(&mut self, terminal_id: &str, request_id: &str, at: i64) -> Vec<CodexEffect>;

// ActivityHub:
pub fn note_codex_approval(&self, terminal_id: &str, thread_id: Option<&str>, request_id: &str, requested: bool);
```

- [ ] **Step 1: Write the failing tracker tests**

```rust
/// Approval pause: internal waiting state, public phase flips to the
/// EXISTING not-busy value, and the gate boundary arms (no completion).
#[test]
fn approval_request_pauses_busy_to_idle_and_arms_a_boundary() {
    let mut tracker = CodexActivityTracker::new();
    tracker.track_terminal("t1", Some("thread-1"), 1_000);
    tracker.note_proxy_turn_started("t1", "thread-1", Some("turn-1"), 2_000);
    let effects = tracker.note_approval_requested("t1", Some("thread-1"), "41", 3_000);
    assert_eq!(phases(&effects), vec![CodexPhase::Idle]);
    assert_eq!(completions(&effects).len(), 0, "an approval pause is not a turn end");
    assert!(
        effects.iter().any(|e| matches!(e, TrackerEffect::AttentionBoundary { at: 3_000, .. })),
        "the gate boundary must arm"
    );
}

#[test]
fn approval_resolved_returns_to_busy() {
    let mut tracker = CodexActivityTracker::new();
    tracker.track_terminal("t1", Some("thread-1"), 1_000);
    tracker.note_proxy_turn_started("t1", "thread-1", Some("turn-1"), 2_000);
    tracker.note_approval_requested("t1", Some("thread-1"), "41", 3_000);
    let effects = tracker.note_approval_resolved("t1", "41", 4_000);
    assert_eq!(phases(&effects), vec![CodexPhase::Busy], "the turn resumes");
}

#[test]
fn approval_resolved_with_no_prior_busy_stays_idle() {
    let mut tracker = CodexActivityTracker::new();
    tracker.track_terminal("t1", Some("thread-1"), 1_000);
    tracker.note_approval_requested("t1", Some("thread-1"), "41", 3_000); // pane was idle
    let effects = tracker.note_approval_resolved("t1", "41", 4_000);
    assert_eq!(phases(&effects), Vec::<CodexPhase>::new(), "nothing to resume");
}

#[test]
fn foreign_thread_approval_request_is_ignored() {
    let mut tracker = CodexActivityTracker::new();
    tracker.track_terminal("t1", Some("thread-1"), 1_000);
    tracker.note_proxy_turn_started("t1", "thread-1", Some("turn-1"), 2_000);
    let effects = tracker.note_approval_requested("t1", Some("subagent-thread"), "41", 3_000);
    assert!(effects.is_empty(), "a sub-agent approval must not ring the parent pane");
}

#[test]
fn approval_request_without_thread_id_is_accepted() {
    let mut tracker = CodexActivityTracker::new();
    tracker.track_terminal("t1", Some("thread-1"), 1_000);
    tracker.note_proxy_turn_started("t1", "thread-1", Some("turn-1"), 2_000);
    let effects = tracker.note_approval_requested("t1", None, "41", 3_000);
    assert_eq!(phases(&effects), vec![CodexPhase::Idle]);
}

#[test]
fn queued_submit_does_not_block_the_approval_boundary() {
    let mut tracker = CodexActivityTracker::new();
    tracker.track_terminal("t1", Some("thread-1"), 1_000);
    tracker.note_proxy_turn_started("t1", "thread-1", Some("turn-1"), 2_000);
    tracker.note_input("t1", "queued message\r", 2_500); // still blocked on the human
    let effects = tracker.note_approval_requested("t1", Some("thread-1"), "41", 3_000);
    assert!(effects.iter().any(|e| matches!(e, TrackerEffect::AttentionBoundary { .. })));
}

#[test]
fn turn_completion_clears_pending_approvals() {
    let mut tracker = CodexActivityTracker::new();
    tracker.track_terminal("t1", Some("thread-1"), 1_000);
    tracker.note_proxy_turn_started("t1", "thread-1", Some("turn-1"), 2_000);
    tracker.note_approval_requested("t1", Some("thread-1"), "41", 3_000);
    tracker.note_proxy_turn_completed("t1", "thread-1", Some("turn-1"), Some("completed"), 5_000);
    // A late response to the stale approval must not flip the pane busy.
    let effects = tracker.note_approval_resolved("t1", "41", 6_000);
    assert!(effects.is_empty());
}
```

- [ ] **Step 2: Red**

Run: `cargo test -p freshell-activity approval`
Expected: COMPILE ERROR — red.

- [ ] **Step 3: Implement tracker + effect variant**

1. Add to the `TrackerEffect` enum (generic, shared): the `AttentionBoundary { terminal_id: String, at: i64 }` variant with the doc comment from Interfaces above.
2. `TerminalActivity` gains:

```rust
/// Outstanding server→client approval request ids (managed proxy lane).
pending_approvals: std::collections::HashSet<String>,
/// True when the approval pause demoted a working phase; the resolve
/// restores Busy. False when the approval arrived while already idle.
resume_busy_after_approval: bool,
```

(init empty/false everywhere `TerminalActivity` is constructed).
3. Methods (place near the other proxy-lane methods):

```rust
/// Approval-request pause (managed lane). Thread-scoped like turn events;
/// requests without a threadId are accepted (the proxy is per-terminal).
/// Public phase maps to the EXISTING not-busy value — no new wire phase.
/// Queued input never suppresses approval bells: still blocked on a human.
pub fn note_approval_requested(
    &mut self,
    terminal_id: &str,
    thread_id: Option<&str>,
    request_id: &str,
    at: i64,
) -> Vec<CodexEffect> {
    let Some(state) = self.states.get_mut(terminal_id) else {
        return Vec::new();
    };
    if let (Some(thread), Some(bound)) = (thread_id, state.session_id.as_deref()) {
        if thread != bound {
            return Vec::new();
        }
    }
    state.pending_approvals.insert(request_id.to_string());
    let previous = state.to_record();
    if matches!(state.phase, CodexPhase::Busy | CodexPhase::Pending | CodexPhase::Unknown) {
        state.resume_busy_after_approval = true;
        state.phase = CodexPhase::Idle;
    }
    state.updated_at = at;
    let mut effects = Vec::new();
    if state.has_public_change(&previous) {
        effects.push(TrackerEffect::Changed {
            upsert: vec![state.to_record()],
            remove: Vec::new(),
        });
    }
    effects.push(TrackerEffect::AttentionBoundary {
        terminal_id: terminal_id.to_string(),
        at,
    });
    effects
}

/// The approval response passed back through the proxy: the turn resumes.
/// Cancels a pending bell within the grace (gate sees Busy); un-greens the
/// pane. Stale/unknown request ids are no-ops.
pub fn note_approval_resolved(
    &mut self,
    terminal_id: &str,
    request_id: &str,
    at: i64,
) -> Vec<CodexEffect> {
    let Some(state) = self.states.get_mut(terminal_id) else {
        return Vec::new();
    };
    if !state.pending_approvals.remove(request_id) {
        return Vec::new();
    }
    if !state.pending_approvals.is_empty() || !state.resume_busy_after_approval {
        return Vec::new();
    }
    state.resume_busy_after_approval = false;
    let previous = state.to_record();
    state.phase = CodexPhase::Busy;
    state.updated_at = at;
    state.last_observed_at = at;
    if state.has_public_change(&previous) {
        vec![TrackerEffect::Changed {
            upsert: vec![state.to_record()],
            remove: Vec::new(),
        }]
    } else {
        Vec::new()
    }
}
```

Adapt the `to_record`/`has_public_change` usage to the file's existing effect-emission idiom (see `note_proxy_turn_started` `:571-599` for the canonical pattern).
4. Clear approval state at turn end and rebind: in both accepted arms of `note_proxy_turn_completed` (same spots as Task 2's clear) add `state.pending_approvals.clear(); state.resume_busy_after_approval = false;`; likewise in the rebind branches (`track_terminal` `:247` area, `bind_session` `:306` area).
5. Match-arm fallout: add `TrackerEffect::AttentionBoundary { .. } => {}` arms wherever the compiler demands (claude/amplifier frame mappers, ledger, etc.).

Run: `cargo test -p freshell-activity approval` → PASS.

- [ ] **Step 4: Wire hub + router (failing hub tests first)**

Hub tests in `activity.rs` `mod tests` (grace is 2s in production — mirror how existing idle tests wait; they already emit real `terminal.idle` frames, e.g. `:2291`):

```rust
// 1. approval_request_rings_once_after_grace
//    Codex terminal Busy via proxy lane; hub.note_codex_approval("t1", Some("thread-1"), "41", true);
//    expect exactly one terminal.idle for t1 (and a codex.activity.updated frame
//    showing the not-busy phase); assert no SECOND idle.
// 2. approval_answered_within_grace_stays_silent
//    Same, then hub.note_codex_approval("t1", None, "41", false) immediately;
//    assert NO terminal.idle within a bounded wait, and the activity frame is Busy again.
// 3. queued_input_does_not_suppress_the_approval_bell
//    Busy + submit-shaped input first, then approval request; still one terminal.idle.
```

Implementation:
1. `HubEvent` (`activity.rs:140-146` area): add

```rust
CodexApproval {
    terminal_id: String,
    thread_id: Option<String>,
    request_id: String,
    requested: bool,
},
```

2. Public entry next to `note_codex_proxy_turn` (`:280-295`):

```rust
pub fn note_codex_approval(&self, terminal_id: &str, thread_id: Option<&str>, request_id: &str, requested: bool)
```

(channel-defer exactly like `note_codex_proxy_turn`).
3. Hub-task arm (next to the `CodexProxyTurn` arm at `:528-558`): call `inner.codex.note_approval_requested(...)` or `note_approval_resolved(...)`, map through `codex_frames`, emit.
4. `codex_frames` (`:1195-1242`): add

```rust
TrackerEffect::AttentionBoundary { terminal_id, at } => {
    // Arm the gate WITHOUT a terminal.turn.complete frame — an approval
    // pause is not a turn end. Effect order guarantees the Idle phase
    // Changed was processed first, so the boundary arms.
    idle.note_turn_boundary(&terminal_id, at);
}
```

Add ignore-arms in `claude_frames`/`amplifier_frames`.
5. `codex_proxy_route.rs` `route_proxy_event`: add arms

```rust
RemoteProxyEvent::ApprovalRequested(params) => {
    hub.note_codex_approval(&terminal_id, params.thread_id.as_deref(), &params.request_id, true);
}
RemoteProxyEvent::ApprovalResolved { request_id } => {
    hub.note_codex_approval(&terminal_id, None, &request_id, false);
}
```

- [ ] **Step 5: Run**

Run: `cargo test -p freshell-ws && cargo test -p freshell-activity && cargo test -p freshell-codex`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-activity crates/freshell-ws/src/activity.rs crates/freshell-ws/src/codex_proxy_route.rs
git commit -m "feat(activity): approval-request pauses ring once and resolve back to busy"
```

---

### Task 8: Node — failed rings + `lastSeenTaskCompletedAt` gating (deferred minor b)

**Files:**
- Modify: `server/coding-cli/codex-activity-tracker.ts` (`onTurnCompleted` `:263-291`; record predicate `:278`; timestamp bump `:281`)
- Test: `test/unit/server/coding-cli/codex-activity-tracker.test.ts` (existing pins at `:1197` interrupted, `:1214` failed, `:1231` inProgress; timestamp reads `:1040`, `:1074`)

**Interfaces:**
- Consumes: `onTurnCompleted(event: CodexTurnCompletedEvent)` with `status?: string`; guard order at `:266-278`.
- Produces: `status === 'failed'` records (mirrors Rust Task 1); `lastSeenTaskCompletedAt` advances ONLY when `status === undefined || status === 'completed'`.

- [ ] **Step 1: Update the pinned failed test + add queued-parity + timestamp tests**

In `codex-activity-tracker.test.ts`, rewrite the failed pin at `:1214` (mirror the file's local setup helpers — the interrupted test at `:1197` shows the idiom):

```ts
// SEMANTIC CHANGE (attention-bell plan 2026-08-01): failed is a non-human
// stopping cause — it records a completion (rings). Parity with Rust.
it('records a completion when the bound thread turn fails', () => {
  // setup identical to the interrupted test, but status: 'failed'
  // assert: one 'turn.complete' emission / recorded completion (whatever the
  // sibling completed-status test asserts), and phase flips to idle.
})

it('failed with a queued submit behaves exactly like completed with a queued submit', () => {
  // run the same sequence twice (queued input while busy, then completion),
  // once status 'completed', once 'failed'; assert identical emissions.
})

it('does not advance lastSeenTaskCompletedAt on interrupted or failed turns', () => {
  // drive an interrupted completion and a failed completion; read the state
  // the way the existing tests at :1040/:1074 do; assert the diagnostics
  // timestamp did NOT move. Then a completed turn DOES move it.
})
```

Write full bodies using the file's existing factory/assertion helpers.

- [ ] **Step 2: Red**

Run: `npm run test:vitest -- test/unit/server/coding-cli/codex-activity-tracker.test.ts`
Expected: FAIL — failed currently claims silently, and the timestamp bumps unconditionally.

- [ ] **Step 3: Implement**

At `:278`, change the record predicate to:

```ts
// Attention-bell policy: completed AND failed record (ring); interrupted is
// the human-requested silent clear. Mirrors Rust codex.rs record predicate.
const record = status === undefined || status === 'completed' || status === 'failed'
```

At `:281`, gate the diagnostics bump on GENUINE completion (deliberately narrower than `record` — the field means "task COMPLETED"; deferred minor from the delta review):

```ts
if (status === undefined || status === 'completed') {
  state.lastSeenTaskCompletedAt = maxDefined(state.lastSeenTaskCompletedAt, event.at)
}
```

(keep the exact `maxDefined(...)` expression currently on that line).

- [ ] **Step 4: Green**

Run: `npm run test:vitest -- test/unit/server/coding-cli/codex-activity-tracker.test.ts`
Expected: PASS. Update the reads at `:1040`/`:1074` if their expectations depended on the unconditional bump (comment why).

- [ ] **Step 5: Commit**

```bash
git add server/coding-cli/codex-activity-tracker.ts test/unit/server/coding-cli/codex-activity-tracker.test.ts
git commit -m "feat(server): failed codex turns ring; gate the completed-at diagnostics timestamp"
```

---

### Task 9: Node — clear `currentTurnId` at accepted completion (minor a parity)

**Files:**
- Modify: `server/coding-cli/codex-activity-tracker.ts` (`onTurnCompleted`; field decl `:54`, set `:257`, guard `:272-275`)
- Test: `test/unit/server/coding-cli/codex-activity-tracker.test.ts`

**Interfaces:**
- Consumes/Produces: mirrors Rust Task 2 — `state.currentTurnId = undefined` after any ACCEPTED terminal-status completion; untouched on `inProgress`/guard rejections.

- [ ] **Step 1: Write the failing test**

```ts
it('clears the in-flight turn id at accepted completion so the next turn is not swallowed', () => {
  // start turn-1, complete it (status 'completed'); start turn-2, complete
  // turn-2 — assert the second completion records (not rejected as stale).
  // Mirror the stale-turn-id test's setup in this file and invert it.
})
```

- [ ] **Step 2: Red → implement**

Run the file's suite (expected FAIL or vacuous-pass; if vacuous, assert `state.currentTurnId === undefined` via the tracker's test-visible state access used elsewhere in this suite). Then in `onTurnCompleted`, in the accepted path (right where the phase transition happens, after the guards at `:266-278`), add:

```ts
state.currentTurnId = undefined
```

- [ ] **Step 3: Green + commit**

Run: `npm run test:vitest -- test/unit/server/coding-cli/codex-activity-tracker.test.ts`
Expected: PASS.

```bash
git add server/coding-cli/codex-activity-tracker.ts test/unit/server/coding-cli/codex-activity-tracker.test.ts
git commit -m "fix(server): clear the in-flight codex turn id at accepted completion"
```

---

### Task 10: Node — `turn_aborted.reason` plumbing + abort bell policy

**Files:**
- Modify: `server/coding-cli/providers/codex.ts` (`:362` case, snapshot build `:376-384`)
- Modify: `server/coding-cli/types.ts` (`CodexTaskEventSnapshot`)
- Modify: `server/coding-cli/codex-activity-tracker.ts` (`reconcileProjects` `:293`, `clearIsAbort` `:306-313`)
- Test: `test/unit/server/coding-cli/codex-activity-tracker.test.ts` (abort pins `:1288`, `:1318`), plus the providers/codex parser test file (locate with `grep -rl "turn_aborted" test/unit/server/coding-cli`)

**Interfaces:**
- Consumes: rollout payload `{"type":"turn_aborted","turn_id":"...","reason":"interrupted"}` (reason may be absent on legacy lines).
- Produces: `CodexTaskEventSnapshot.latestTurnAbortedReason?: string` (paired newest-wins with `latestTurnAbortedAt`); tracker helper `abortReasonIsHuman(reason: string | undefined): boolean` mirroring Rust (`undefined | 'interrupted' | 'replaced'` → true).

- [ ] **Step 1: Write failing tests (parser + tracker policy)**

Parser: a rollout line with `reason` populates `latestTurnAbortedReason`; a legacy line leaves it `undefined`; newest abort wins the pairing.
Tracker (mirror Rust Task 3's four policy tests): interrupted-reason silent, replaced-reason silent, missing-reason silent (update the existing pin at `:1288` with a comment noting the refinement), unknown-reason records/rings.

- [ ] **Step 2: Red**

Run: `npm run test:vitest -- test/unit/server/coding-cli/codex-activity-tracker.test.ts` (+ the parser test file)
Expected: FAIL / type errors.

- [ ] **Step 3: Implement**

1. `types.ts`: add `latestTurnAbortedReason?: string` to `CodexTaskEventSnapshot`.
2. `providers/codex.ts:362`: capture the reason with the winning timestamp:

```ts
case 'turn_aborted': {
  const at = extractTimestamp(entry) // keep the file's existing extraction
  if (at !== undefined && (latestTurnAbortedAt === undefined || at > latestTurnAbortedAt)) {
    latestTurnAbortedAt = at
    latestTurnAbortedReason =
      typeof payload.reason === 'string' ? payload.reason : undefined
  }
  break
}
```

(adapt to the file's existing `maxTimestamp(...)` idiom while preserving the pairing invariant), and emit it in the snapshot build at `:376-384`.
3. Tracker: add

```ts
// Mirrors Rust abort_reason_is_human: missing reason = legacy/uncertainty →
// silent; 'interrupted'/'replaced' = human-requested → silent; anything else
// is not human-attributed and records (rings).
function abortReasonIsHuman(reason: string | undefined): boolean {
  return reason === undefined || reason === 'interrupted' || reason === 'replaced'
}
```

and where `clearIsAbort` (`:306-313`) feeds the record decision, change it to `record = !clearIsAbort || !abortReasonIsHuman(nextTurnAbortedReason)` following the Rust shape.

- [ ] **Step 4: Green + commit**

Run: `npm run test:vitest -- test/unit/server/coding-cli/codex-activity-tracker.test.ts` (+ parser test file)
Expected: PASS.

```bash
git add server/coding-cli/providers/codex.ts server/coding-cli/types.ts server/coding-cli/codex-activity-tracker.ts test/unit/server/coding-cli
git commit -m "feat(server): ring on non-human codex turn_aborted reasons (Node parity)"
```

---

### Task 11: Node — spontaneous-exit bell (codex/claude/amplifier)

**Files:**
- Modify: `server/terminal-registry.ts` (internal emits at `:1527-1531` and `:4091-4095` — NOT the client `safeSend` wire frames at `:1520`/`:4084`)
- Modify: `server/coding-cli/codex-activity-wiring.ts:82-92` and the claude/amplifier equivalents (locate: `grep -rn "registry.on('terminal.exit'" server/coding-cli/`)
- Modify: `server/coding-cli/codex-activity-tracker.ts` (`noteExit` `:176-179`, `removeState` `:640-645`), `claude-activity-tracker.ts` (`noteExit` `:169`, `removeState` `:200`), `amplifier-activity-tracker.ts` (`noteExit` `:343`, `removeState` `:387`)
- Modify: `server/coding-cli/truly-idle-emitter.ts` (remove loop `:102-109`; change type; doc `:57-58`)
- Test: `test/unit/server/coding-cli/truly-idle-emitter.test.ts` (update the never-emit pin at `:110`), tracker test files

**Interfaces:**
- Consumes: registry internal event `'terminal.exit'` payload; `TrulyIdleActivityChange` ('changed' event payload `{ upsert, remove }`).
- Produces: internal `'terminal.exit'` payload gains `spontaneous: boolean` (`finishTerminalPtyExit` → `true`; `kill` → `false`). Tracker `noteExit(input: { terminalId: string; at: number; spontaneous?: boolean })`; `removeState(terminalId, opts?: { spontaneousExit?: boolean })`; `'changed'` payload gains optional `spontaneousExitRemovals?: string[]`. Emitter emits `{ terminalId, at: now(), reason: 'grace' }` immediately for a spontaneous removal while engaged (`state.busy || state.graceTimer !== undefined`). `unbindTerminal` never passes the flag (requested).

- [ ] **Step 1: Write the failing emitter tests**

In `truly-idle-emitter.test.ts` (fake timers; mirror existing patterns). Update the pin at `:110` to scope it to REQUESTED removals with a comment, and add:

```ts
it('emits terminal.idle immediately when a busy terminal is removed by a spontaneous exit', () => {
  // drive t1 busy via noteActivityChanged({ upsert: [busyRecord('t1')] })
  // then noteActivityChanged({ upsert: [], remove: ['t1'], spontaneousExitRemovals: ['t1'] })
  // assert exactly one 'idle' emission { terminalId: 't1', reason: 'grace' }, no timers pending.
})

it('stays silent when a busy terminal is removed by a requested close', () => {
  // remove without spontaneousExitRemovals → no emission (old pin, scoped).
})

it('stays silent when an idle terminal exits spontaneously', () => {})

it('rings when a spontaneous exit lands during an armed grace window', () => {
  // busy → turn complete (arms grace) → spontaneous removal before expiry
  // → one immediate idle emission (the pending bell survives death).
})

it('queue evidence does not suppress the death bell', () => {
  // busy + queue evidence, then spontaneous removal → one emission.
})
```

- [ ] **Step 2: Red**

Run: `npm run test:vitest -- test/unit/server/coding-cli/truly-idle-emitter.test.ts`
Expected: FAIL (type + behavior).

- [ ] **Step 3: Implement the emitter + threading**

1. `truly-idle-emitter.ts` remove loop (`:102-109`) becomes:

```ts
const spontaneous = new Set(change.spontaneousExitRemovals ?? [])
for (const terminalId of change.remove ?? []) {
  const state = this.states.get(terminalId)
  if (!state) continue
  const engaged = state.busy || state.graceTimer !== undefined
  this.cancelGrace(state)
  this.states.delete(terminalId)
  if (spontaneous.has(terminalId) && engaged) {
    // Spontaneous process death while working: ring immediately — a dead
    // process emits nothing further, and a queued prompt will never run.
    // Requested closes (tab close / terminal.close / shutdown) never ring.
    this.emit('idle', { terminalId, at: this.now(), reason: 'grace' } satisfies TrulyIdleEvent)
  }
}
```

Extend the `TrulyIdleActivityChange` type with `spontaneousExitRemovals?: string[]` and update the doc comment at `:57-58` (see Task 13 language).
2. `terminal-registry.ts`: add `spontaneous: true` to the internal emit at `:1527-1531` and `spontaneous: false` at `:4091-4095` (internal registry EventEmitter only — the client-facing `safeSend({ type: 'terminal.exit', ... })` payloads are wire frames and MUST NOT change).
3. Wirings: widen `onExit` to `(event: { terminalId: string; spontaneous?: boolean })` and pass through: `tracker.noteExit({ terminalId: event.terminalId, at: now(), spontaneous: event.spontaneous === true })` — codex wiring at `codex-activity-wiring.ts:82-84`, and the claude/amplifier wirings' identical handlers.
4. Trackers (codex `:176-179`/`:640`, claude `:169`/`:200`, amplifier `:343`/`:387`): `noteExit` forwards to `removeState(terminalId, { spontaneousExit: input.spontaneous === true })`; `removeState` includes `spontaneousExitRemovals: [terminalId]` on the emitted `'changed'` payload when the flag is set. `unbindTerminal` (and every other `removeState` caller) stays flag-less. Opencode tracker: DELIBERATELY unchanged (decision 3) — its record-exists⇔busy signal would over-ring; noted as follow-up in Task 13.

- [ ] **Step 4: Add tracker-level tests + integration check**

One test per tracker (codex/claude/amplifier): `noteExit({ spontaneous: true })` emits `'changed'` carrying `spontaneousExitRemovals`; `unbindTerminal` does not. Then run the integration suite that exercises the real WsHandler idle path:

Run: `npm run test:vitest -- test/unit/server/coding-cli test/server/ws-terminal-idle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/terminal-registry.ts server/coding-cli test/unit/server/coding-cli test/server/ws-terminal-idle.test.ts
git commit -m "feat(server): ring terminal.idle on spontaneous process death while engaged (Node)"
```

---

### Task 12: Node — approval sniffing + approval pause semantics

**Files:**
- Modify: `server/coding-cli/codex-app-server/remote-proxy.ts` (`handleUpstreamMessage` `:457-511`; `forwardClientFrame` `:831-840`; handler sets `:126-131` + `on*` subscribers `:263-273`; connection state)
- Modify: `server/terminal-registry.ts` (sidecar subscriptions next to `:1935`/`:1949`)
- Modify: `server/terminal-stream/registry-events.ts` (new event types next to `:38-62`)
- Modify: `server/coding-cli/codex-activity-wiring.ts` (subscribe next to `:90-91`)
- Modify: `server/coding-cli/codex-activity-tracker.ts` (approval state + methods, `attention.boundary` event)
- Modify: `server/coding-cli/truly-idle-emitter.ts` `wireTrulyIdleEmitter` (`:182-202`)
- Tests: remote-proxy test file (locate: `grep -rl "handleUpstreamMessage\|CodexRemoteProxy" test/unit/server/coding-cli`), tracker + emitter test files

**Interfaces:**
- Consumes: Rust Task 6/7 designs (mirror them); `scanJsonRpcEnvelope` (`json-rpc-envelope.ts:6-23`).
- Produces:

```ts
// remote-proxy.ts
export type CodexApprovalRequestEvent = { requestId: string; method: string; threadId?: string }
onApprovalRequested(handler: (event: CodexApprovalRequestEvent) => void): () => void
onApprovalResolved(handler: (event: { requestId: string }) => void): () => void

// registry-events.ts
export type CodexApprovalRequestedEvent = { terminalId: string; threadId?: string; requestId: string; at: number }
export type CodexApprovalResolvedEvent = { terminalId: string; requestId: string; at: number }
// registry event names: 'codex.approval.requested' / 'codex.approval.resolved'

// codex-activity-tracker.ts
onApprovalRequested(event: CodexApprovalRequestedEvent): void
onApprovalResolved(event: CodexApprovalResolvedEvent): void
// emits 'attention.boundary' { terminalId, at } (arms the gate, no turn.complete)
```

- [ ] **Step 1: Write failing proxy tests (mirror Task 6's five cases)**

In the existing remote-proxy vitest suite, using its synthetic-frame harness: approval request (id+method in set) → `onApprovalRequested` fires with `{ requestId: '41', method, threadId: 'thread-1' }` AND the frame relays to the client verbatim; `item/tool/call` → no event; client response `{id: 41, result}` → `onApprovalResolved` + forwarded upstream; unknown response id → nothing; missing `params.threadId` → `threadId: undefined`. Const set `CODEX_APPROVAL_REQUEST_METHODS` = the same 7 methods as Rust (decision 6).

- [ ] **Step 2: Red → implement the proxy**

In `handleUpstreamMessage`'s `if (id !== undefined)` branch (`:471`), FIRST read `envelope.method`; if present → it is a server→client request: if in the approval set, record `connection.pendingServerApprovals.set(id, true)` (new `Map`/`Set` beside `pendingMethods`), best-effort parse `params.threadId` when `frame.data.length <= MAX_FULL_PARSE_BYTES`, emit via the new handler set (canonicalize `requestId = String(id)`), then relay verbatim and return. In `forwardClientFrame` (`:831-840`): when `request.id !== undefined && request.method === undefined && connection.pendingServerApprovals.delete(request.id)` → emit resolved. Add the two handler sets + `on*` subscription methods mirroring `:263-273`.

Run: `npm run test:vitest -- <remote-proxy test file>` → PASS.

- [ ] **Step 3: Write failing tracker tests (mirror Task 7's seven cases)**

`onApprovalRequested` while busy → phase idle + one `'attention.boundary'` emission, zero `'turn.complete'`; resolved → busy again; resolved with no prior busy → stays idle; foreign-thread request ignored; missing threadId accepted; queued submit does not block the boundary; turn completion clears pending approvals (late resolve is a no-op).

- [ ] **Step 4: Red → implement tracker + wiring + emitter arm**

1. Tracker: add `pendingApprovals: Set<string>` + `resumeBusyAfterApproval: boolean` to `CodexTerminalActivity` (`:32-56` area); implement the two methods mirroring the Rust bodies in Task 7 Step 3 (thread guard against `state.sessionId`; phase demotion to `'idle'`; `this.emit('changed', ...)` + `this.emit('attention.boundary', { terminalId, at })`; resolve restores `'busy'` when the set empties and the flag is set). Clear both in the accepted paths of `onTurnCompleted`, in `noteExit`, and on rebind.
2. `terminal-registry.ts`: next to the turn subscriptions (`:1935`/`:1949`) add

```ts
sidecar.onApprovalRequested?.((event) => {
  this.emit('codex.approval.requested', {
    terminalId: record.terminalId,
    threadId: event.threadId,
    requestId: event.requestId,
    at: Date.now(),
  } satisfies CodexApprovalRequestedEvent)
})
sidecar.onApprovalResolved?.((event) => {
  this.emit('codex.approval.resolved', {
    terminalId: record.terminalId,
    requestId: event.requestId,
    at: Date.now(),
  } satisfies CodexApprovalResolvedEvent)
})
```

(adapt `record`/subscription-disposal to the local idiom of the turn subscriptions; widen the sidecar type where `codexAppServer.sidecar` is declared).
3. `codex-activity-wiring.ts`: subscribe `'codex.approval.requested'`/`'codex.approval.resolved'` → `tracker.onApprovalRequested`/`onApprovalResolved` (register + dispose like `:90-91`).
4. `wireTrulyIdleEmitter` (`truly-idle-emitter.ts:182-202`): also bridge the boundary —

```ts
const onAttentionBoundary = (event: { terminalId: string; at: number }) => {
  emitter.noteTurnComplete(event) // arms the same grace window; no turn.complete frame is involved
}
tracker.on('attention.boundary', onAttentionBoundary)
// + matching tracker.off in dispose()
```

(All four trackers pass through this wiring; only the codex tracker ever emits the event — a no-op for the rest.)
5. Emitter-level test: approval boundary arms grace → after `TERMINAL_IDLE_GRACE_MS` one `'idle'`; a `'changed'` busy upsert within the grace (the resolve path) cancels it → silent.

- [ ] **Step 5: Green + commit**

Run: `npm run test:vitest -- test/unit/server/coding-cli`
Expected: PASS.

```bash
git add server/coding-cli server/terminal-registry.ts server/terminal-stream/registry-events.ts test/unit/server/coding-cli
git commit -m "feat(server): codex approval-request pauses ring once and resolve back to busy (Node)"
```

---

### Task 13: Docs — deliberately update the `terminal.idle` semantics contract

**Files:**
- Modify: `shared/ws-protocol.ts:199-209` (doc comment ONLY — `TerminalIdleSchema` at `:210-215` must be byte-identical)
- Modify: `crates/freshell-activity/src/codex.rs:336-340`, `:943-949` (and the test doc at `:1237-1244` if not already updated in Task 3), `crates/freshell-activity/src/idle.rs:1-24` (module doc), `server/coding-cli/truly-idle-emitter.ts:57-58` (if not already updated in Task 11)

**Interfaces:**
- Consumes: the final behavior from Tasks 1–12.
- Produces: documentation that states the NEW policy: never after HUMAN-REQUESTED stops; emitted on all other stopping causes.

- [ ] **Step 1: Replace the ws-protocol doc comment**

Replace `shared/ws-protocol.ts:199-209` (keep the schema untouched):

```ts
/**
 * Attention edge for terminal-mode CLI panes (claude/codex/opencode/amplifier):
 * "the agent stopped making progress and you don't already know". Emitted once
 * per attention transition. Rings for: completed turns (after a grace window
 * with no new activity and no detectable queued prompt), FAILED turns,
 * non-human rollout abort reasons, spontaneous process death while working
 * (immediate — no grace), and approval-request pauses (managed codex only;
 * unmanaged/PTY-only codex has no approval signal). NEVER emitted after a
 * HUMAN-REQUESTED stop: Esc/interrupt (turn.status 'interrupted', abort
 * reason 'interrupted'/'replaced'), tab close, terminal.close, or server
 * shutdown. Subagent completions inside a running turn never produce it.
 * Queued input suppresses completion bells (work continues) but NOT death
 * bells (a dead process never runs the queue) and NOT approval bells (still
 * blocked on the human). This is the ONLY edge the client rings/shades on
 * for terminal CLI panes ('terminal.turn.complete' stays informational).
 *
 * Pinned wire contract shared with the Rust server port - do not change
 * unilaterally: { terminalId, at (server epoch ms), reason: 'grace' | 'queue-empty' }.
 */
```

- [ ] **Step 2: Update the Rust doc anchors**

Rewrite the three `codex.rs` comments and the `idle.rs:1-24` module doc so no comment still claims "never emitted after crash/interrupt/exit". The canonical sentence to use: *"terminal.idle is never emitted after a HUMAN-REQUESTED stop; it IS emitted for failed turns, non-human abort reasons, spontaneous death while working, and approval pauses (shared/ws-protocol.ts terminal.idle doc)."* In `idle.rs` note that the exit-death bell is emitted by the HUB directly (the gate itself still never emits for a removed terminal). Also note the two scoped follow-ups where the docs discuss coverage: Node opencode death bells (noisy busy proxy — deliberately excluded) and Rust opencode (no hub tracker exists).

- [ ] **Step 3: Verify contract freeze is untouched and everything compiles**

Run: `npm run test:port`
Expected: PASS with NO changes under `port/contract/` (`git status --short port/contract/` prints nothing).
Run: `cargo test -p freshell-activity --doc 2>/dev/null; cargo build -p freshell-activity`
Expected: builds clean.

- [ ] **Step 4: Commit**

```bash
git add shared/ws-protocol.ts crates/freshell-activity/src/codex.rs crates/freshell-activity/src/idle.rs server/coding-cli/truly-idle-emitter.ts
git commit -m "docs: terminal.idle rings on all non-human stops (contract comment update)"
```

---

### Task 14: Full verification sweep

**Files:**
- No new files; fixes only if gates fail.

**Interfaces:**
- Consumes: everything above.
- Produces: green gates proving the branch is review-ready.

- [ ] **Step 1: Rust gates**

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test -p freshell-activity -p freshell-ws -p freshell-codex -p freshell-terminal -p freshell-sessions
```

Expected: all PASS. Fix `cargo fmt --all` / clippy findings and re-run.

- [ ] **Step 2: Node gates**

```bash
npm run test:vitest -- test/unit/server/coding-cli test/server/ws-terminal-idle.test.ts
npm run test:port
npm run check
```

Expected: all PASS; `git status --short port/contract/` prints nothing (wire shape unchanged).

- [ ] **Step 3: Behavior spot-audit (read-only)**

Re-read the policy matrix in this plan's header against the test names now in the tree — every row must map to at least one green test on each server:
1 completed rings / queued suppresses (pre-existing), 2 failed rings + failed+queued silent, 3 interrupted silent, 4 abort reasons, 5 death bells (spontaneous busy rings once / requested silent / idle silent / queue no-suppress), 6 approvals (rings once / auto-answer silent / resolve→busy / queue no-suppress), 7 deadman untouched (pre-existing tests still green).

- [ ] **Step 4: Final commit (only if fixes were needed)**

```bash
git add -A ':!docs/plans'
git commit -m "test: verification sweep fixes for the attention-bell causes"
```

Do NOT open a PR — that requires explicit user approval.

---

## Self-review record

- **Spec coverage:** matrix rows → tasks: (1) keep = untouched + re-verified in Task 14; (2) failed → Tasks 1, 8; (3) interrupted keep = pinned tests retained; (4) abort reason → Tasks 3, 10; (5) death bells → Tasks 4, 5, 11 (Rust claude/codex/amplifier via shared gate; Node codex/claude/amplifier via shared emitter; Rust opencode N/A — no tracker; Node opencode deliberately excluded per decision 3, documented in Task 13); (6) approvals → Tasks 6, 7, 12 (unmanaged limitation documented in Task 13); (7) deadman unchanged. Minors: (a) Tasks 2, 9; (b) Task 8. Docs: Task 13. Checks/freeze: Task 14.
- **No silent deferrals:** every ringing cause is proven by hub/emitter-level tests emitting the REAL `terminal.idle` frame through production code paths (no stubs standing in for behavior). The two scoped exclusions (Node opencode death bell; unmanaged-codex approvals) are spec-sanctioned decisions ("apply where cheap and testable — otherwise note the follow-up"; "no approval signal — acceptable, document it"), not deferrals of required behavior.
- **Placeholder scan:** no TBDs; steps that modify unseen code bodies cite exact file:line anchors plus the sibling idiom to mirror, with the assertion/behavior contract spelled out in full.
- **Type consistency:** `spontaneous` (Rust field + Node event field), `latest_turn_aborted_reason`/`latestTurnAbortedReason`, `abort_reason_is_human`/`abortReasonIsHuman`, `AttentionBoundary`/`'attention.boundary'`, `is_engaged`, `pending_approvals`/`pendingApprovals`, `note_approval_requested/resolved` ↔ `onApprovalRequested/Resolved`, `spontaneousExitRemovals` are used with the same names and shapes across all tasks.
