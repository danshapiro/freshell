# Codex Attention-Bell Cause Semantics Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Ring the `terminal.idle` bell for every non-human-requested stop of a codex terminal pane — failed turns, spontaneous process death while engaged, and approval-request pauses, plus forward-compatible policy plumbing for non-human `turn_aborted` reasons (NO live producer emits a ring-worthy abort reason at codex 0.129.0–0.147.0-alpha; today's real failures surface as `turn/completed status='failed'`, covered by Tasks 1/8) — while keeping human-requested stops (Esc/interrupt, `/quit`/`/exit`, tab close, `terminal.close`, server shutdown) silent, with zero wire-shape changes. Deployed codex is pinned at **0.146.0** (`codex --version`; the fixture inventory is 0.129.0 — both were source-audited by the load-bearing-assumption audit).

**Architecture:** All new causes are internal representations inside the existing server-side tracker/gate machinery (`crates/freshell-activity` + `crates/freshell-ws` on Rust; `server/coding-cli/*` on Node). Every cause emits the SAME `terminal.idle` frame and maps to the SAME not-busy public phase. The codex app-server proxy gains server→client request sniffing (approvals); the rollout parser gains `turn_aborted.reason` plumbing (forward-compatible policy — see decision 2); the registry exit event gains a spontaneous-vs-requested discriminator.

**Tech Stack:** Rust (freshell-activity, freshell-ws, freshell-codex, freshell-terminal, freshell-sessions crates), TypeScript Node server (server/coding-cli, server/terminal-registry.ts, shared/ws-protocol.ts), cargo test, vitest.

## Global Constraints

- Base branch: this worktree (`/home/dan/code/freshell/.worktrees/codex-attention-bell`, branch `feat/codex-attention-bell`) is branched FROM `fix/codex-turn-thread-scope` (head 911fa4cdc). Do NOT rebase onto or branch from `origin/main`.
- ZERO wire-shape changes: the `terminal.idle` frame stays exactly `{ terminalId, at, reason: 'grace' | 'queue-empty' }`. All new causes reuse `reason: 'grace'`. The contract freeze (`npm run test:port`, `port/contract/*.json`) must stay green with NO regenerated contract files.
- The bell (`terminal.idle`) is the ONLY client bell/attention trigger; the not-busy icon is the only indication. NO new user-facing signals, NO new public phase enum values.
- Never emit `terminal.idle` for a HUMAN-REQUESTED stop: Esc/interrupt (`turn.status='interrupted'`, abort reason `interrupted`/`replaced`), slash-command quits (`/quit`/`/exit` from an idle pane — the executing Enter looks like a prompt submit to the input lane; see decision 3), tab close / `terminal.close` API / server shutdown kills (including `shutdownGracefully()`'s direct SIGTERMs — Task 11).
- Baseline repair first: the branch base ships a red `cargo test` gate (freshell-ws `tests/auto_resume_e2e.rs`) — Task 0 fixes it before ANY feature work. `npm install` inside the worktree is allowed during execution (node_modules is missing).
- Busy-deadman/unknown (120s silence) stays silent — uncertainty is not a stop signal; no heuristic bells.
- Strict Red-Green-Refactor TDD: write the failing test, see it fail, implement minimally, see it pass, commit.
- Test coordination (AGENTS.md): run vitest ONLY via `npm run test:vitest -- <paths>` (never raw `npx vitest`). `test:unit` covers `test/unit`, `test:integration` covers `test/server`.
- Rust gates: `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings` must pass.
- Do NOT create/open a PR (needs explicit user approval). Never restart the self-hosted server (build ok, deploy not). Do not touch the running production server (port 3002) or live codex sidecars.
- Commit `.kata.toml` if modified (we do not expect to modify it).
- README.md is the only end-user markdown doc; this plan under `docs/plans/` is a working doc.

## Locked design decisions (read before any task)

1. **`turn/completed status='failed'` rings** by flipping the record predicate — failed takes EXACTLY the same code path as completed, so queued-submit suppression and the 2s IdleGate grace apply naturally. `interrupted` stays a silent clear.
2. **`turn_aborted` reason policy:** reason `interrupted` or `replaced` → silent (human-requested). Reason MISSING → silent (legacy rollout lines carry no reason; an absent reason is uncertainty, and per constraint above uncertainty is not a stop signal). Any OTHER present reason string → ring. **Corrected rationale (audit A11/A12):** this is FORWARD-COMPATIBLE POLICY, not a live bell cause — at codex 0.129.0–0.147.0-alpha the `TurnAbortReason` enum is exactly `{interrupted, replaced, review_ended, budget_limited}` and only `interrupted`/`replaced` have construction sites (codex-rs protocol.rs:4207-4214 @0.146.0); a 5,114-file rollout corpus (2,527 `turn_aborted` lines) is 100% `"interrupted"`. NO ring-worthy abort writes a reasoned `turn_aborted` line today; today's real non-human failures surface as `turn/completed status='failed'` / rollout `turn_complete{error}` — covered by Tasks 1/8. Known false negative (accepted): codex's guardian automation aborts write `"interrupted"` and stay silent.
3. **Spontaneous exit while engaged rings immediately** (no grace — a dead process produces no more events; nothing can cancel). **"Engaged" for the death bell (corrected by audit A6/A10):** busy from a CONFIRMED turn (codex: accepted proxy turn started / accepted rollout `task_started`) OR an armed grace deadline (a completion bell that was pending when the process died still rings) OR a NON-EMPTY pending-approval set (a pane blocked on an approval whose process dies must ring — it is not busy, and its 2s boundary may already have rung; Tasks 5/7/11/12). **Input-only pending state NEVER counts as engagement:** the canonical human quit — `/quit`/`/exit` typed into an IDLE pane — is read by the input lane as a prompt submit (the CR: Rust `signal.rs:36-38` `is_submit_input` → `codex.rs:443-490` `note_input` → Pending; Node `codex-activity-tracker.ts:181-209` `noteInput`), drives the gate busy, and the pty exits <2s later; ringing there would bell the canonical human quit and violate the hard silence constraint. Queue evidence does NOT suppress death bells. Freshell-initiated kills (`kill`/`kill_all`, by `api`/`idle`/`shutdown` — including `shutdownGracefully()`'s direct SIGTERMs, which flow through the normal pty-exit finalizer; Task 11) are silent. Exit while idle is silent. Rust covers claude/codex/amplifier uniformly via the shared hub Exit arm + gate (opencode has no Rust tracker — N/A). Node covers codex/claude/amplifier via the shared `TrulyIdleEmitter`; Node opencode is a documented follow-up (its "record exists ⇔ busy" signal is a noisy busy proxy and would produce heuristic bells). **Accepted residuals (documented in Task 13):** mid-turn `/quit`/Ctrl+D (codex sends NO `Op::Interrupt` on Ctrl+D; the TUI's ~2s shutdown budget may skip the abort write) and out-of-band `kill -9` by the user may still ring — no in-band discriminator exists; claude/amplifier Enter-executed quits are the same family (input-driven Busy is those trackers' ONLY turn evidence, so it stays engagement); Node's 120s busy-deadman can demote busy→unknown during long recovery windows and swallow the bell (missed bell, never a false ring).
4. **Auto-resume interaction (rationale corrected by audit A15):** successful durable recovery swallows the pty exit entirely — `finishTerminalPtyExit` never runs, no internal exit event is emitted, hence no bell — and the resumed backend turn may CONTINUE where it left off: codex `thread/resume` re-attaches to a still-running backend thread via `resume_running_thread` (codex-rs thread_processor.rs:3426/:3528 @0.146.0 — "rejoin semantics"); freshell's clean-exit recovery gate recovers precisely when the backend turn is `inProgress` (`terminal-registry.ts:3362`). The death bell therefore fires only when recovery FAILS or is ABANDONED and the exit event is actually emitted — which is exactly when attention is needed. (When the app-server itself died, resume is a pure history restore, the interrupted turn is dead, and the bell is equally justified.)
5. **Approval-request pause:** managed (`--remote`) codex only. The proxy sniffs server→client JSON-RPC REQUESTS (frames with BOTH `id` and `method`) whose method is in the approval set below; a resolution clears it. Internal waiting state maps to the EXISTING not-busy public phase; the same IdleGate boundary arms the bell (2s grace suppresses a SENT request answered quickly). Queued input does NOT suppress approval bells. Unmanaged/PTY-only codex has no approval signal — acceptable, documented. **Resolution signals (audit A4/A5 — ALL of these must resolve, with tests, Tasks 6/12):** (a) a client `{id, result}` response frame; (b) a client `{id, error}` response frame — errors resolve identically (codex handles them via `process_error`, message_processor.rs:756-758 @0.146.0); (c) the server-side notification **`serverRequest/resolved`** with params `{threadId, requestId}` (common.rs:1701, v2/notification.rs:53-56 @0.146.0) — codex 0.146.0 can resolve a SENT request server-side with NO client response frame (`auto_resolution_ms` on `item/tool/requestUserInput`; turn cancel via `cancel_requests_for_thread`); (d) sidecar/upstream restart or reconnect clears ALL pending approvals (emitting resolutions) — the app-server's request-id allocator is a per-process monotonic `AtomicI64` starting at 0 (outgoing_message.rs:283 @0.146.0), so stale ids from a previous incarnation would collide. Response matching REQUIRES `method` ABSENT on the frame — an id alone is not enough (client requests always carry `method`; server and client request ids are independent integer spaces both starting near 0). Note: policy-auto-approvals (allowlisted commands; `auto_review`, served by a server-side subagent — v2/shared.rs:224-247 @0.146.0) never emit wire frames at all and cannot ring by construction; a SENT request auto-resolved slower than ~2s rings once (accepted residual, low severity).
6. **Approval method set** (from `test/fixtures/coding-cli/codex-app-server/schema-inventory.ts:84-94`, codex 0.129.0 inventory; verified EXACT against the codex `ServerRequest` enum at BOTH 0.129.0 and the deployed 0.146.0 — audit A2):
   `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, `mcpServer/elicitation/request`, `applyPatchApproval`, `execCommandApproval`.
   Machine-serviced server→client requests are deliberately EXCLUDED: `item/tool/call`, `account/chatgptAuthTokens/refresh` (both tags), plus `attestation/generate` and `currentTime/read` (new at 0.146.0 — both machine-serviced, correctly excluded). The set is version-fluid: both proxies DEBUG-LOG any unrecognized server→client request method (no bell, just logging — catches future drift; Tasks 6/12).
7. **Approval thread scoping (corrected by audit A3):** the five v2 methods carry `params.threadId`; the two LEGACY methods (`applyPatchApproval`, `execCommandApproval`) carry `params.conversationId` instead (codex-rs v1.rs:126-158 — reading only `threadId` would misread every legacy approval as thread-less). Sniff by method name with opaque params; best-effort extract `params.threadId` OR, for the legacy methods, `params.conversationId`, when the frame is small enough to fully parse (`<= MAX_FULL_PARSE_BYTES`); when present and the tracker has a bound thread that differs → ignore (BEST-EFFORT heuristic: codex gives no guarantee about how child-thread approvals present on the wire, so mismatch⇒sub-agent is a safe-direction bet, not a verified fact); when absent → accept (the proxy is per-terminal).
8. **Gate arming for approvals uses a NEW internal tracker effect** (`AttentionBoundary` / Node tracker event `attention.boundary`) that arms the IdleGate WITHOUT emitting a `terminal.turn.complete` frame (an approval pause is not a turn end). **Lane interference guard (audit A9):** while `pending_approvals` is non-empty, OTHER lanes' busy promotions — the rollout reconcile's first fold of the turn's own `task_started` (codex.rs:352-368 passes the edge-trigger and would call `idle.note_phase(Busy)`, clearing the armed deadline and silently cancelling the bell), and Node's `reconcileProjects`/`refreshExistingBinding` promotions — must fold their anchors as usual but set the resume-busy flag (`resume_busy_after_approval` / `resumeBusyAfterApproval`) INSTEAD of flipping the public phase or feeding Busy to the gate (both servers, Tasks 7/12). Approval resolve restores Busy and normalizes any pending-submit input state planted during the pause.
9. **Deferred minors:** (a) clear the in-flight proxy turn id at accepted completion on BOTH servers; (b) Node `lastSeenTaskCompletedAt` only advances for genuine completed status (`undefined` or `'completed'`) — failed/interrupted turns do not bump it (the field name means "task COMPLETED").

## File structure (what each touched file is responsible for)

| File | Responsibility in this plan |
|---|---|
| `crates/freshell-activity/src/codex.rs` | Codex tracker state machine: record predicate, abort-reason policy, approval state, turn-id clear |
| `crates/freshell-activity/src/idle.rs` | IdleGate: new `is_engaged` read accessor (confirmed busy or armed deadline; input-only pending excluded) |
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

### Task 0: Baseline repair — inherited `cargo test` regression + worktree npm install (audit A20)

**Files:**
- Possibly modify: base-branch production code under `crates/freshell-ws/src/` (`activity.rs`, `codex_proxy_route.rs`) and/or `crates/freshell-activity/src/codex.rs` — OR, only with evidence of an intentional behavior change, `crates/freshell-ws/tests/auto_resume_e2e.rs`
- No plan-feature code in this task.

**Interfaces:**
- Consumes: the inherited branch head (911fa4cdc + the plan-doc commit). The audit (V8 report) established: `cargo test -p freshell-activity -p freshell-ws` FAILS (exit 101) — `crates/freshell-ws/tests/auto_resume_e2e.rs` tests `reconcile_after_replacement_attaches_to_the_new_terminal` and `crashing_agent_is_resumed_twice_then_settles_exited` both time out at `tests/common/mod.rs:959` ("timed out waiting for a terminal.created frame"); deterministic (2/2 reruns); the SAME test binary passes on main (c7badcbef); the test files are byte-identical between merge-base 35fbf1357 and 911fa4cdc ⇒ the regression lives in the base-branch production changes (941ad584e..911fa4cdc: `freshell-ws/src/activity.rs` +116, `freshell-ws/src/codex_proxy_route.rs` +205, `freshell-activity/src/codex.rs` +426).
- Produces: ALL five gates green before Task 1 begins. Every later task assumes a green baseline.

- [ ] **Step 1: Reproduce**

Run: `cargo test -p freshell-ws --test auto_resume_e2e`
Expected: both tests FAIL with the terminal.created timeout. If they pass, record the environment difference and re-run twice before proceeding (the audit observed determinism).

- [ ] **Step 2: Diagnose the regression**

Diff the base-branch production changes: `git diff 35fbf1357..911fa4cdc -- crates/freshell-ws/src/activity.rs crates/freshell-ws/src/codex_proxy_route.rs crates/freshell-activity/src/codex.rs`. Bisect within the five branch commits (941ad584e, e039320b8, f740b1722, d2341c999, 911fa4cdc) if the diff read is not conclusive: `git bisect start 911fa4cdc 35fbf1357` running the two tests as the predicate.

- [ ] **Step 3: Fix**

Fix the production regression so the tests pass unmodified. ONLY if the diff proves the base branch intentionally changed the behavior these e2e tests pin (decide from the commit messages + code evidence, not convenience) may the tests be updated instead — cite the intentional change in the test doc comment.

- [ ] **Step 4: Worktree npm install**

Run: `npm install` (from the worktree root — allowed during execution). Do NOT rely on the parent repo's `/home/dan/code/freshell/node_modules`: running `npm run` against it silently resolves main-branch dependency versions and yields misleading signal.

- [ ] **Step 5: Verify ALL five gates green**

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test -p freshell-activity -p freshell-ws
npm run test:vitest -- test/unit/server/coding-cli
npm run test:port
```

Expected: all PASS. Do not start Task 1 until they do.

- [ ] **Step 6: Commit separately**

```bash
git add -A ':!docs/plans'
git commit -m "fix(ws): repair auto_resume_e2e regression inherited from the base branch"
```

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

**Rationale (corrected by audit A12 — read before implementing):** this task is forward-compatible policy plumbing, NOT a live bell cause. At codex 0.129.0–0.147.0-alpha, `TurnAbortReason` = `{interrupted, replaced, review_ended, budget_limited}`; only `interrupted`/`replaced` have construction sites, and a 5,114-file rollout corpus (2,527 `turn_aborted` lines) is 100% `"interrupted"` — NO ring-worthy abort writes a reasoned `turn_aborted` line today. Today's real failures surface as `turn/completed status='failed'` (Tasks 1/8). Keep the tasks and tests exactly as specified: they pin the default-ring policy for reasons a future codex may emit.

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
- Produces: `ActivityEvent::Exit { terminal_id: String, at: i64, spontaneous: bool }` — `false` from `kill_internal` (freshell-initiated: api/idle/shutdown), `true` from `finish_pty_exit` (spontaneous PTY/process death). Task 5 consumes `spontaneous` and MUST read gate engagement BEFORE any hub state teardown (`modes.remove` / `idle.note_exit` both destroy the evidence — audit A17; the ordering is spelled out and test-pinned in Task 5 Step 5).

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
- Produces: `IdleGate::is_engaged(&self, terminal_id: &str) -> bool` — CONFIRMED busy (`busy && !pending`) OR an armed deadline. The codex input-only submit gate (`pending`, set by `note_phase(Pending)`) is deliberately NOT engagement: the Enter that executes a human `/quit`/`/exit` from an idle pane is indistinguishable from a prompt submit in the input lane (decision 3, audit A6). Hub emits exactly one `terminal.idle` (reason `Grace`) for a spontaneous exit while engaged, for all three hub trackers. Task 7 extends the hub's engagement read with `codex.has_pending_approvals(..)` once approval state exists.

- [ ] **Step 1: Write the failing IdleGate accessor test**

In `idle.rs` `mod tests`:

```rust
#[test]
fn is_engaged_reflects_confirmed_busy_and_armed_deadlines_but_never_input_pending() {
    let mut gate = IdleGate::with_grace_ms(2_000);
    assert!(!gate.is_engaged("t1"), "unknown terminal is not engaged");
    gate.note_phase("t1", IdleGatePhase::Pending);
    assert!(
        !gate.is_engaged("t1"),
        "input-only pending is NOT death-bell engagement: the Enter that \
         executes /quit looks like a prompt submit (signal.rs:36-38) and \
         must not ring when the pty then exits (decision 3, audit A6)"
    );
    gate.note_phase("t1", IdleGatePhase::Busy);
    assert!(gate.is_engaged("t1"), "confirmed busy is engaged");
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
/// Engagement for the DEATH BELL (decision 3): true only for a CONFIRMED
/// busy phase or an armed grace window. The codex input-only Pending
/// submit gate is excluded — the Enter that executes a human /quit//exit
/// is indistinguishable from a prompt submit in the input lane
/// (signal.rs:36-38), so ringing on pending would bell the canonical
/// human quit. Read by the hub's exit arm BEFORE `note_exit` drops the
/// state: a spontaneous process death while engaged rings the bell.
pub fn is_engaged(&self, terminal_id: &str) -> bool {
    self.states
        .get(terminal_id)
        .map(|s| (s.busy && !s.pending) || s.deadline.is_some())
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
// 6. slash_command_quit_from_an_idle_pane_does_not_ring  (audit A6 red test)
//    Track t1 (codex) and leave it Idle; feed a lone-CR PTY input ("\r") the
//    way existing hub tests drive the input lane (locate a test that sends
//    ActivityEvent::Input / the hub's input entry and mirror it) — the input
//    lane promotes Idle→Pending (codex.rs:443-490) and the gate goes
//    busy+pending; then observer_send(Exit { spontaneous: true, at });
//    assert NO terminal.idle (bounded negative wait). This is exactly what
//    `/quit`/`/exit` typed into an idle pane looks like to the tracker: the
//    slash-command Enter is indistinguishable from a prompt submit.
```

Write all six as real tests with the file's local harness idioms. Test 1 doubles as the audit-A17 ordering pin: if the implementation reads `is_engaged` AFTER `idle.note_exit` (which deletes the per-terminal state), the read is always false and test 1 fails.

- [ ] **Step 4: Red**

Run: `cargo test -p freshell-ws spontaneous_exit`
Expected: FAIL — no frame emitted (exit is currently silent).

- [ ] **Step 5: Implement the hub exit-bell**

Rewrite the Exit arm (`activity.rs:724-753`) — bind `at` and `spontaneous`. ORDERING IS LOAD-BEARING (audits A17/A8): the engagement read AND the bell decision happen FIRST, before the `modes.remove` early-return and before `idle.note_exit` — both destroy the evidence.

```rust
ActivityEvent::Exit { terminal_id, at, spontaneous } => {
    let frames = {
        let mut inner = self.inner.lock().expect("activity hub lock");
        // Read engagement BEFORE any teardown: `idle.note_exit` deletes the
        // per-terminal gate state and `modes.remove` would early-return.
        // Task 7 extends this read with
        // `|| inner.codex.has_pending_approvals(&terminal_id)` (a pane
        // blocked on an approval whose process dies must ring even after
        // its 2s boundary already rang).
        let ring_death_bell = spontaneous && inner.idle.is_engaged(&terminal_id);
        let mut frames = Vec::new();
        if ring_death_bell {
            // Spontaneous death while engaged: same frame, same reason —
            // no wire change. reason MUST be Grace: the client zod enum
            // (shared/ws-protocol.ts:210-215) and the Rust enum
            // (freshell-protocol server_messages.rs:397-402) allow ONLY
            // grace|queue-empty — a novel reason is silently dropped by
            // the Node schema and unrepresentable here. `at` is the fresh
            // exit timestamp (client dedupe is per-terminal monotonic
            // `at`). Immediate (no grace): a dead process emits nothing
            // further, so nothing could ever cancel it. Exactly once per
            // terminal: the modes.remove below guarantees the teardown
            // runs once, and a later shutdown sweep of a retained exited
            // row arrives with spontaneous=false.
            frames.push(ServerMessage::TerminalIdle(TerminalIdle {
                terminal_id: terminal_id.clone(),
                at,
                reason: TerminalIdleReason::Grace,
            }));
        }
        if let Some(mode) = inner.modes.remove(&terminal_id) {
            inner.idle.note_exit(&terminal_id);
            inner.lanes.remove(&terminal_id);
            inner.lane_retries.remove(&terminal_id);
            inner.codex_lanes.remove(&terminal_id);
            let tracker_frames = match mode.as_str() {
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
            frames.extend(tracker_frames);
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
// 6. legacy_approval_reads_conversation_id  (decision 7 / audit A3)
//    Upstream frame {"id":42,"method":"execCommandApproval",
//    "params":{"conversationId":"thread-1","command":"..."}} →
//    ApprovalRequested { thread_id: Some("thread-1"), .. } (legacy methods
//    carry params.conversationId, codex-rs v1.rs:126-158).
// 7. error_response_also_resolves  (decision 5a / audit A5)
//    After (1), CLIENT frame {"id":41,"error":{"code":-1,"message":"denied"}}
//    → ApprovalResolved { request_id: "41" } AND forwarded upstream.
// 8. client_frame_with_id_and_method_never_resolves  (decision 5d)
//    After (1), CLIENT frame {"id":41,"method":"thread/start","params":{}}
//    (a REQUEST whose id happens to collide) → NO ApprovalResolved; the
//    frame forwards upstream unchanged.
// 9. server_request_resolved_notification_resolves  (decision 5c)
//    After (1), UPSTREAM notification (no id)
//    {"method":"serverRequest/resolved","params":{"threadId":"thread-1","requestId":"41"}}
//    → ApprovalResolved { request_id: "41" } AND the notification relays to
//    the client verbatim. (Verify the exact wire field casing against the
//    cached codex source v2/notification.rs:53-56 @0.146.0 — the struct is
//    {thread_id, request_id} under camelCase serde rename.)
// 10. upstream_reconnect_clears_pending_approvals  (decision 5b)
//    After (1), tear down / re-dial the upstream connection the way the
//    harness simulates disconnects → ApprovalResolved { request_id: "41" }
//    is emitted for every drained pending id (the app-server id counter is
//    per-process and restarts at 0 — stale ids would collide).
// 11. unknown_server_request_method_is_logged_not_belled  (decision 6)
//    Upstream frame {"id":43,"method":"some/future/method","params":{}} →
//    no ApprovalRequested, bytes relayed verbatim (assert relay; the debug
//    log itself needs no assertion — keep it a tracing::debug!).
```

- [ ] **Step 2: Red**

Run: `cargo test -p freshell-codex approval`
Expected: COMPILE ERROR (no variants) — red.

- [ ] **Step 3: Implement**

1. Const next to `STATEFUL_NOTIFICATION_METHODS` (`:74-81`):

```rust
/// Server→client JSON-RPC REQUEST methods that block on a human. Sourced
/// from the codex 0.129.0 schema inventory
/// (test/fixtures/coding-cli/codex-app-server/schema-inventory.ts:84-94)
/// and verified EXACT against the codex `ServerRequest` enum at both
/// 0.129.0 and the deployed 0.146.0.
const APPROVAL_REQUEST_METHODS: &[&str] = &[
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "item/tool/requestUserInput",
    "mcpServer/elicitation/request",
    "applyPatchApproval",
    "execCommandApproval",
];

/// Machine-serviced server→client requests — never human-attention.
/// (`attestation/generate` and `currentTime/read` are new at 0.146.0.)
/// Anything outside BOTH lists is debug-logged to catch future drift
/// (decision 6) — no bell, just logging.
const AUTOMATED_SERVER_REQUEST_METHODS: &[&str] = &[
    "item/tool/call",
    "account/chatgptAuthTokens/refresh",
    "attestation/generate",
    "currentTime/read",
];

/// Legacy approval methods carry `params.conversationId` instead of
/// `params.threadId` (codex-rs v1.rs:126-158).
const LEGACY_APPROVAL_REQUEST_METHODS: &[&str] = &["applyPatchApproval", "execCommandApproval"];
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
            // v2 methods carry params.threadId; legacy methods carry
            // params.conversationId (decision 7, codex-rs v1.rs:126-158).
            let thread_pointer = if LEGACY_APPROVAL_REQUEST_METHODS.contains(&method) {
                "/params/conversationId"
            } else {
                "/params/threadId"
            };
            let thread_id = (data.len() <= MAX_FULL_PARSE_BYTES)
                .then(|| serde_json::from_slice::<serde_json::Value>(&data).ok())
                .flatten()
                .and_then(|v| v.pointer(thread_pointer).and_then(|t| t.as_str()).map(str::to_string));
            if let Some(conn) = self.connections.get_mut(&conn_id) {
                conn.pending_server_approvals.insert(req_id);
            }
            self.emit(RemoteProxyEvent::ApprovalRequested(ApprovalRequestParams {
                request_id: envelope_id_to_string(&id),
                method: method.to_string(),
                thread_id,
            }));
        }
    } else if !AUTOMATED_SERVER_REQUEST_METHODS.contains(&method) {
        // Decision 6: the method set is version-fluid — surface drift.
        tracing::debug!(method, "unrecognized codex server->client request method (not treated as an approval)");
    }
    self.send_to_client(conn_id, data, binary);
    return;
}
```

(Reuse the existing `envelope_id_to_request_id` helper visible at `:1017`; keep relay-verbatim semantics for ALL server requests, approval or not.)

4. In `forward_client_frame` (`:1017-1032`), when `id` is Some and `method` is None (a response — the `method.is_none()` check is MANDATORY, decision 5d: a client REQUEST whose id numerically collides with a pending server approval must not resolve it):

```rust
if method.is_none() {
    // A response frame: {id, result} OR {id, error} — BOTH resolve
    // (decision 5a; codex handles errors via process_error). No need to
    // inspect the payload beyond id+method-absence.
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

6. **Server-side resolution (decision 5c):** in the upstream NOTIFICATION path (frames with `method` and NO `id` — the same branch that handles `STATEFUL_NOTIFICATION_METHODS`), when `envelope.method.as_deref() == Some("serverRequest/resolved")` and `data.len() <= MAX_FULL_PARSE_BYTES`, parse `params.requestId` (verify the exact wire casing against the cached codex source `v2/notification.rs:53-56` @0.146.0 — struct fields `{thread_id, request_id}` under camelCase serde rename), remove it from `pending_server_approvals` (search ALL connections' pending sets — the request went out on this proxy's single upstream), and emit `ApprovalResolved` when it was pending. Relay the notification to the client verbatim regardless.

7. **Restart hygiene (decision 5b):** wherever the proxy tears down or re-dials the upstream connection (mirror how `pending_methods`/`pending_fork_requests` are handled on connection teardown — locate with `grep -n "pending_methods" crates/freshell-codex/src/remote_proxy.rs`), drain `pending_server_approvals` and emit `ApprovalResolved` for EVERY drained id, so trackers never stay paused across an incarnation whose fresh id counter (per-process `AtomicI64` from 0) would collide with stale ids.

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
- Modify: `crates/freshell-activity/src/codex.rs` (new state fields + `note_approval_requested`/`note_approval_resolved` + `has_pending_approvals`; clears in completion/rebind paths; reconcile promotion guard at `:352-368`)
- Modify: `crates/freshell-ws/src/activity.rs` (`codex_frames` `:1195-1242`; `claude_frames` `:1146-1191`; `amplifier_frames` `:1246-1292`; new `HubEvent::CodexApproval` + public entry; Exit-arm engagement extension from Task 5; hub tests)
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
/// Death-bell engagement extension (decision 3): a pane blocked on an
/// approval whose process dies spontaneously must ring. Read by the hub's
/// Exit arm alongside IdleGate::is_engaged, BEFORE any teardown.
pub fn has_pending_approvals(&self, terminal_id: &str) -> bool;

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

/// Audit A9: the FIRST rollout fold of the turn's own task_started passes
/// the reconcile edge-trigger (codex.rs:352-368) — landing mid-pause it
/// would flip phase Busy, feed the gate, and silently cancel the armed
/// approval bell. Mid-pause promotions must fold anchors but defer the
/// phase flip to the resolve.
#[test]
fn reconcile_task_started_during_pending_approval_does_not_flip_busy() {
    let mut tracker = CodexActivityTracker::new();
    tracker.track_terminal("t1", Some("thread-1"), 1_000);
    tracker.note_proxy_turn_started("t1", "thread-1", Some("turn-1"), 2_000);
    tracker.note_approval_requested("t1", Some("thread-1"), "41", 3_000);
    // Reuse Task 3's `started(at)` CodexTaskEvents helper (codex.rs:1183).
    let effects = tracker.reconcile_rollout("t1", &started(3_500), 3_500);
    assert_eq!(phases(&effects), Vec::<CodexPhase>::new(), "no Busy upsert mid-pause");
    // The deferred promotion resumes at resolve.
    let effects = tracker.note_approval_resolved("t1", "41", 4_000);
    assert_eq!(phases(&effects), vec![CodexPhase::Busy]);
}

/// Audit A9 hazard 2: a mid-pause Enter (the human answering the approval
/// in the TUI) plants PTY pending-submit state; resolve must normalize it
/// so the NEXT turn clear is not misclassified as a queued re-arm (which
/// would suppress a legitimate later bell).
#[test]
fn approval_resolve_normalizes_pending_submit_input_state() {
    let mut tracker = CodexActivityTracker::new();
    tracker.track_terminal("t1", Some("thread-1"), 1_000);
    tracker.note_proxy_turn_started("t1", "thread-1", Some("turn-1"), 2_000);
    tracker.note_approval_requested("t1", Some("thread-1"), "41", 3_000);
    tracker.note_input("t1", "\r", 3_500); // answering the approval prompt
    tracker.note_approval_resolved("t1", "41", 4_000);
    let effects =
        tracker.note_proxy_turn_completed("t1", "thread-1", Some("turn-1"), Some("completed"), 6_000);
    assert_eq!(phases(&effects), vec![CodexPhase::Idle], "no Pending re-arm from the pause keystroke");
    assert_eq!(completions(&effects).len(), 1, "the completion bell must not be swallowed");
}

/// Decision 3 / audit A10: a pane blocked on an approval counts as engaged
/// for the death bell.
#[test]
fn has_pending_approvals_tracks_the_pending_set() {
    let mut tracker = CodexActivityTracker::new();
    tracker.track_terminal("t1", Some("thread-1"), 1_000);
    assert!(!tracker.has_pending_approvals("t1"));
    tracker.note_approval_requested("t1", Some("thread-1"), "41", 3_000);
    assert!(tracker.has_pending_approvals("t1"));
    tracker.note_approval_resolved("t1", "41", 4_000);
    assert!(!tracker.has_pending_approvals("t1"));
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
4. Clear approval state at turn end and rebind: in `note_proxy_turn_completed`, add `state.pending_approvals.clear(); state.resume_busy_after_approval = false;` ONCE on the accepted completion path (same acceptance/terminal-status gating as Task 2's clear) but placed BEFORE the phase match — NOT inside individual match arms. Placement rationale: a turn that completes during an approval pause routes through the `CodexPhase::Idle => {}` arm (the approval request itself demoted the phase to Idle), so arm-local clears in the Pending and Busy|Unknown arms would never run there and the `turn_completion_clears_pending_approvals` test above could not pass — the stale approval's later resolve would find `resume_busy_after_approval == true`, flip the pane Busy, and emit a `Changed` effect. Clearing before the match covers every accepted arm, including Idle. Likewise clear both fields in the rebind branches (`track_terminal` `:247` area, `bind_session` `:306` area).
5. Match-arm fallout: add `TrackerEffect::AttentionBoundary { .. } => {}` arms wherever the compiler demands (claude/amplifier frame mappers, ledger, etc.).
6. Accessor:

```rust
pub fn has_pending_approvals(&self, terminal_id: &str) -> bool {
    self.states
        .get(terminal_id)
        .map(|s| !s.pending_approvals.is_empty())
        .unwrap_or(false)
}
```

7. **Reconcile promotion guard (decision 8 / audit A9):** in `reconcile_rollout`'s promotion branch (`codex.rs:352-368` — the arm that sets `state.phase = CodexPhase::Busy` at `:368`), when `!state.pending_approvals.is_empty()`: still fold the anchors exactly as the branch does today (`last_seen_task_started_at`, `accepted_start_at`) but set `state.resume_busy_after_approval = true` INSTEAD of assigning the phase (and emit no Busy `Changed` upsert). The resolve path already restores Busy via the flag.
8. **Resolve normalization (audit A9 hazard 2):** in `note_approval_resolved`, when the pending set empties, also clear the PTY pending-submit state a mid-pause Enter may have planted (`pending_submit_at` and the disarmed-swallow flags set at `codex.rs:480-489` — mirror how the rebind path resets them) so the next turn clear is not misread as a queued re-arm.

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
// 4. reconcile_tick_during_a_pending_approval_does_not_cancel_the_armed_bell  (audit A9)
//    Busy via proxy lane; approval requested (deadline armed); BEFORE the 2s
//    grace elapses, drive a rollout reconcile whose newest event is the
//    turn's task_started (mirror how existing tests feed rollout fixtures /
//    CodexFsChange); assert the terminal.idle STILL arrives after the grace
//    AND no Busy-phase codex.activity.updated frame was emitted mid-pause;
//    then resolve → the activity frame shows Busy again.
// 5. spontaneous_exit_during_a_pending_approval_rings  (decision 3 / audit A10)
//    Busy via proxy lane; approval requested; let the 2s grace elapse and the
//    approval bell ring (deadline now spent, phase not busy); then
//    observer_send(Exit { spontaneous: true, at }); assert a SECOND
//    terminal.idle arrives — pending_approvals counts as death-bell
//    engagement even after the armed deadline has already rung.
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

**Rationale (corrected by audit A12):** as in Task 3, this is forward-compatible policy plumbing — no live codex (0.129.0–0.147.0-alpha) writes a ring-worthy `turn_aborted` reason (a 5,114-file corpus is 100% `"interrupted"`); today's real failures ring via `status='failed'` (Tasks 1/8). Keep the tests as specified.

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
- Modify: `server/terminal-registry.ts` (`finishTerminalPtyExit` `:1504-1535`; internal emits at `:1527-1531` and `:4091-4095` — NOT the client `safeSend` wire frames at `:1520`/`:4084`)
- Modify: `server/coding-cli/codex-activity-wiring.ts:82-92` and the claude/amplifier equivalents (locate: `grep -rn "registry.on('terminal.exit'" server/coding-cli/`)
- Modify: `server/coding-cli/codex-activity-tracker.ts` (`noteExit` `:176-179`, `removeState` `:640-645`), `claude-activity-tracker.ts` (`noteExit` `:169`, `removeState` `:200`), `amplifier-activity-tracker.ts` (`noteExit` `:343`, `removeState` `:387`)
- Modify: `server/coding-cli/truly-idle-emitter.ts` (remove loop `:102-109`; change type; doc `:57-58`)
- Test: `test/unit/server/coding-cli/truly-idle-emitter.test.ts` (update the never-emit pin at `:110`), tracker test files

**Interfaces:**
- Consumes: registry internal event `'terminal.exit'` payload; `TrulyIdleActivityChange` ('changed' event payload `{ upsert, remove }`).
- Produces: internal `'terminal.exit'` payload gains `spontaneous: boolean` — `finishTerminalPtyExit` computes it as `!requestedClose` where `requestedClose` is `record.codexRecoveryFinalClose === true` captured at function ENTRY (see Step 3; a blanket `true` would ring on server shutdown — audit A7); the `kill` path (`:4091-4095`) emits `false`. Tracker `noteExit(input: { terminalId: string; at: number; spontaneous?: boolean })`; `removeState(terminalId, opts?: { spontaneousExit?: boolean })`; `'changed'` payload gains optional `spontaneousExitRemovals?: string[]`. Emitter emits `{ terminalId, at: now(), reason: 'grace' }` immediately for a spontaneous removal while engaged: `(state.busy && !state.pending) || state.graceTimer !== undefined` — input-only pending is NOT engagement (decision 3: `/quit` from an idle pane arrives as phase `'pending'`). Task 12 extends engagement with approval waits (`approvalPendingRemovals`). `unbindTerminal` never passes the flag (requested). **Accepted residual (audit A17, document in Task 13):** the 120s busy-deadman (`BUSY_DEADMAN_MS`, `codex-activity-tracker.ts:20`, demotion `:624-628`) can flip busy→unknown during recovery windows longer than 120s, and `unknown` never arms the death bell — a missed bell, never a false ring; no death-time snapshot is threaded.

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

it('stays silent when an input-pending terminal exits spontaneously (slash-command quit)', () => {
  // decision 3 / audit A6 red test: /quit typed into an idle pane arrives as
  // phase 'pending' (the executing Enter looks like a prompt submit —
  // codex-activity-tracker.ts:181-209). Drive:
  //   noteActivityChanged({ upsert: [{ terminalId: 't1', phase: 'pending' }] })
  //   noteActivityChanged({ upsert: [], remove: ['t1'], spontaneousExitRemovals: ['t1'] })
  // assert ZERO 'idle' emissions — input-only pending is never engagement.
})

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
  // Engagement for the death bell (decision 3): CONFIRMED busy or an armed
  // grace window. phase 'pending' is input-only (the Enter that executes a
  // human /quit looks like a prompt submit) and NEVER counts. Task 12 ORs
  // in approval waits via change.approvalPendingRemovals.
  const engaged = (state.busy && !state.pending) || state.graceTimer !== undefined
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
2. `terminal-registry.ts` (internal registry EventEmitter only — the client-facing `safeSend({ type: 'terminal.exit', ... })` payloads are wire frames and MUST NOT change). A blanket `spontaneous: true` at `:1527` is WRONG (audit A7): `shutdownGracefully()` (`:4908`) SIGTERMs ptys directly WITHOUT setting `status='exited'` (`:4955-4964`), so its exits flow through `finishTerminalPtyExit` normally and would ring death bells on server shutdown — a requested stop that must stay silent. Instead:
   - In `finishTerminalPtyExit` (`:1504-1535`), capture `const requestedClose = record.codexRecoveryFinalClose === true` as the FIRST statement — it must be read BEFORE the function's own `this.markCodexRecoveryFinalClose(record)` call at `:1509`, which marks EVERY finishing record and would erase the signal. Then add `spontaneous: !requestedClose` to the internal emit at `:1527-1531`.
   - Add `spontaneous: false` to the kill-path emit at `:4091-4095`.
   - Why this flag works: `markCodexRecoveryFinalClose` (`:3574-3576`, field `codexRecoveryFinalClose?: boolean` on `TerminalRecord` at `:644`) is set by every REQUESTED close BEFORE exit dispatch — `kill()` at `:4069` (tab close, `terminal.close`, `remove()`, idle reaper, `killAndWait`) and `shutdownGracefully()` at `:4957` — and, despite the codex-prefixed name, both call it unconditionally on ANY record, so claude/amplifier terminals are covered too.
   - VERIFY at implementation time: `grep -n markCodexRecoveryFinalClose server/terminal-registry.ts` must show only `:1509` (the finalizer itself), `:4069`, and `:4957` as callers — i.e. no genuinely-spontaneous path sets the flag before exit dispatch. If a new caller has appeared that breaks this invariant, introduce a dedicated `requestedClose` record flag set at `:4069`/`:4957` instead and emit `spontaneous: !record.requestedClose`.
3. Wirings: widen `onExit` to `(event: { terminalId: string; spontaneous?: boolean })` and pass through: `tracker.noteExit({ terminalId: event.terminalId, at: now(), spontaneous: event.spontaneous === true })` — codex wiring at `codex-activity-wiring.ts:82-84`, and the claude/amplifier wirings' identical handlers.
4. Trackers (codex `:176-179`/`:640`, claude `:169`/`:200`, amplifier `:343`/`:387`): `noteExit` forwards to `removeState(terminalId, { spontaneousExit: input.spontaneous === true })`; `removeState` includes `spontaneousExitRemovals: [terminalId]` on the emitted `'changed'` payload when the flag is set. `unbindTerminal` (and every other `removeState` caller) stays flag-less. Opencode tracker: DELIBERATELY unchanged (decision 3) — its record-exists⇔busy signal would over-ring; noted as follow-up in Task 13.

- [ ] **Step 4: Add tracker-level tests + integration check**

One test per tracker (codex/claude/amplifier): `noteExit({ spontaneous: true })` emits `'changed'` carrying `spontaneousExitRemovals`; `unbindTerminal` does not.

Add the registry-level shutdown-silence red test (audit A7 — write it RED first, mirror the existing terminal-registry vitest harness; locate with `grep -rl "shutdownGracefully" test/`): create a fake-pty terminal, subscribe to the internal `'terminal.exit'` event, call `shutdownGracefully()`, and assert every emitted exit payload carries `spontaneous: false` (server shutdown is a requested stop — no death bell may ring for it). Then run the integration suite that exercises the real WsHandler idle path:

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

// truly-idle-emitter.ts — death-bell engagement extension (decision 3,
// Node mirror of Rust has_pending_approvals):
// TrulyIdleActivityChange gains approvalPendingRemovals?: string[] —
// terminals removed while their pending-approval set was non-empty. The
// emitter's spontaneous-removal ring condition becomes:
//   spontaneous && (engaged || approvalPending.has(terminalId))
// so a pane blocked on an approval whose process dies rings even after its
// 2s boundary already rang (busy=false, no armed timer).
```

- [ ] **Step 1: Write failing proxy tests (mirror Task 6's ELEVEN cases)**

In the existing remote-proxy vitest suite, using its synthetic-frame harness: (1) approval request (id+method in set) → `onApprovalRequested` fires with `{ requestId: '41', method, threadId: 'thread-1' }` AND the frame relays to the client verbatim; (2) `item/tool/call` → no event; (3) client response `{id: 41, result}` → `onApprovalResolved` + forwarded upstream; (4) unknown response id → nothing; (5) missing `params.threadId` → `threadId: undefined`; (6) legacy `execCommandApproval` with `params.conversationId` → `threadId` populated from it (decision 7); (7) client `{id: 41, error}` also resolves (decision 5a); (8) a client frame with BOTH id and method never resolves (decision 5d); (9) upstream notification `serverRequest/resolved` `{threadId, requestId}` resolves and relays (decision 5c); (10) upstream connection teardown/restart emits `onApprovalResolved` for every pending id (decision 5b); (11) an unrecognized server→client request method (e.g. `some/future/method`) emits no event and relays (decision 6 — debug log only). Const set `CODEX_APPROVAL_REQUEST_METHODS` = the same 7 methods as Rust, plus the same `AUTOMATED`/`LEGACY` companion sets (decision 6/7).

- [ ] **Step 2: Red → implement the proxy**

In `handleUpstreamMessage`'s `if (id !== undefined)` branch (`:471`), FIRST read `envelope.method`; if present → it is a server→client request: if in the approval set, record `connection.pendingServerApprovals.set(id, true)` (new `Map`/`Set` beside `pendingMethods`), best-effort parse `params.threadId` — or `params.conversationId` for the legacy methods — when `frame.data.length <= MAX_FULL_PARSE_BYTES`, emit via the new handler set (canonicalize `requestId = String(id)`), then relay verbatim and return; if the method is in NEITHER the approval set nor the automated set, `log.debug({ method }, 'unrecognized codex server->client request method')` and relay. In `forwardClientFrame` (`:831-840`): when `request.id !== undefined && request.method === undefined && connection.pendingServerApprovals.delete(request.id)` → emit resolved (`method === undefined` is MANDATORY — decision 5d; the frame may carry `result` OR `error`, both resolve). In the upstream NOTIFICATION path (method, no id): `serverRequest/resolved` → parse `params.requestId` (bounded by `MAX_FULL_PARSE_BYTES`), delete from `pendingServerApprovals`, emit resolved when it was pending, relay verbatim. On upstream connection close/teardown/re-dial (mirror how `pendingMethods` is drained there): drain `pendingServerApprovals` and emit resolved for every id — the restarted app-server's id counter begins at 0 again and stale ids would collide. Add the two handler sets + `on*` subscription methods mirroring `:263-273`.

Run: `npm run test:vitest -- <remote-proxy test file>` → PASS.

- [ ] **Step 3: Write failing tracker tests (mirror Task 7's cases)**

`onApprovalRequested` while busy → phase idle + one `'attention.boundary'` emission, zero `'turn.complete'`; resolved → busy again; resolved with no prior busy → stays idle; foreign-thread request ignored; missing threadId accepted; queued submit does not block the boundary; turn completion clears pending approvals (late resolve is a no-op). Plus the audit-A9 lane-interference cases (mirror Task 7's Rust tests): a `reconcileProjects` sweep whose newest snapshot event is the turn's `task_started`, landing during a pending approval, does NOT flip the public phase to `'busy'` (anchors still fold; `resumeBusyAfterApproval` set; resolve restores `'busy'`); a `refreshExistingBinding` `reason === 'resume'` re-announce during a pending approval likewise does not promote (`:549-556` promotes idle→busy with no edge-trigger today); resolve normalizes pending-submit input state planted by a mid-pause Enter (a following completed turn records normally, no `'pending'` re-arm). And the death-engagement case: `removeState` with a non-empty pending-approval set emits `'changed'` carrying `approvalPendingRemovals: [terminalId]` (read BEFORE the state is deleted).

- [ ] **Step 4: Red → implement tracker + wiring + emitter arm**

1. Tracker: add `pendingApprovals: Set<string>` + `resumeBusyAfterApproval: boolean` to `CodexTerminalActivity` (`:32-56` area); implement the two methods mirroring the Rust bodies in Task 7 Step 3 (thread guard against `state.sessionId`; phase demotion to `'idle'`; `this.emit('changed', ...)` + `this.emit('attention.boundary', { terminalId, at })`; resolve restores `'busy'` when the set empties and the flag is set, and normalizes pending-submit input state planted mid-pause — mirror Rust Task 7 Step 3.8). Clear both in the accepted paths of `onTurnCompleted`, in `noteExit`, and on rebind — in `noteExit`/`removeState` read the pending set BEFORE deleting state and include `approvalPendingRemovals: [terminalId]` on the emitted `'changed'` payload when it was non-empty (death-bell engagement, decision 3). Lane-interference guards (decision 8 / audit A9): in `reconcileProjects`' busy promotion (the newest-`task_started` compare at `:317-325`) and in `refreshExistingBinding`'s idle→busy promote (`:549-556`), when `state.pendingApprovals.size > 0`, fold the anchors but set `resumeBusyAfterApproval = true` instead of flipping `state.phase` to `'busy'` (no busy upsert reaches the emitter mid-pause).
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
5. Emitter death-engagement extension: `TrulyIdleActivityChange` gains `approvalPendingRemovals?: string[]`; in the Task 11 remove loop, ring when `spontaneous.has(terminalId) && (engaged || approvalPending.has(terminalId))` (where `approvalPending = new Set(change.approvalPendingRemovals ?? [])`).
6. Emitter-level tests: approval boundary arms grace → after `TERMINAL_IDLE_GRACE_MS` one `'idle'`; a `'changed'` busy upsert within the grace (the resolve path) cancels it → silent; a spontaneous removal carrying `approvalPendingRemovals` rings once even when the terminal is not busy and no timer is armed (the approval bell already rang — the pane was still blocked on a human when it died).

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
 * non-human rollout abort reasons (forward-compatible policy — no live codex
 * <= 0.147 emits one), spontaneous process death while ENGAGED (confirmed
 * turn, armed grace window, or pending approval; immediate — no grace), and
 * approval-request pauses (managed codex only; unmanaged/PTY-only codex has
 * no approval signal). NEVER emitted after a HUMAN-REQUESTED stop:
 * Esc/interrupt (turn.status 'interrupted', abort reason
 * 'interrupted'/'replaced'), slash-command quits from an idle pane
 * (input-only pending state never counts as death-bell engagement), tab
 * close, terminal.close, or server shutdown (including graceful-shutdown
 * SIGTERMs). Subagent completions inside a running turn never produce it.
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

Rewrite the three `codex.rs` comments and the `idle.rs:1-24` module doc so no comment still claims "never emitted after crash/interrupt/exit". The canonical sentence to use: *"terminal.idle is never emitted after a HUMAN-REQUESTED stop; it IS emitted for failed turns, non-human abort reasons (forward-compatible — none emitted at codex <= 0.147), spontaneous death while engaged, and approval pauses (shared/ws-protocol.ts terminal.idle doc)."* In `idle.rs` note that the exit-death bell is emitted by the HUB directly (the gate itself still never emits for a removed terminal) and that `is_engaged` deliberately excludes the input-only Pending state.

Also record the ACCEPTED RESIDUALS + scoped follow-ups where the docs discuss coverage (these are decisions, not deferrals — audit dispositions):
1. Mid-turn `/quit`/Ctrl+D: codex sends NO `Op::Interrupt` on Ctrl+D, and the TUI's ~2s shutdown budget can exit before the abort evidence lands — may ring on a human force-quit of a visibly-working pane. No in-band discriminator exists; accepted.
2. Out-of-band `kill -9`/SIGTERM of the CLI by the user: observationally identical to a crash — rings; accepted.
3. Claude/amplifier Enter-executed quits (`/exit`): input-driven Busy is those trackers' ONLY turn evidence, so it stays death-bell engagement; same residual family as (1); accepted.
4. Node 120s busy-deadman swallow (audit A17): a recovery window longer than `BUSY_DEADMAN_MS` demotes busy→unknown and `unknown` never arms the death bell — a MISSED bell (never a false ring); accepted.
5. A SENT approval request auto-resolved server-side slower than ~2s rings once (decision 5); accepted.
6. Node opencode death bells: deliberately excluded (noisy busy proxy) — follow-up. Rust opencode: no hub tracker exists — N/A.
7. Unmanaged/PTY-only codex has no approval signal — documented limitation.

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

Re-read the goal + locked decisions in this plan's header against the test names now in the tree — every row must map to at least one green test on each server:
1 completed rings / queued suppresses (pre-existing), 2 failed rings + failed+queued silent, 3 interrupted silent, 4 abort reasons (forward-compatible policy — unknown reason rings, interrupted/replaced/missing silent), 5 death bells (spontaneous CONFIRMED-busy rings once / input-pending slash-quit silent / requested kill silent / shutdownGracefully silent / idle silent / queue no-suppress / pending-approval death rings), 6 approvals (rings once / result AND error responses resolve / serverRequest-resolved resolves / restart clears pendings / method-present frames never resolve / resolve→busy / reconcile-mid-pause does not cancel / queue no-suppress / legacy conversationId scoping), 7 deadman untouched (pre-existing tests still green; the >120s recovery swallow is a documented residual, not a test target).

- [ ] **Step 4: Final commit (only if fixes were needed)**

```bash
git add -A ':!docs/plans'
git commit -m "test: verification sweep fixes for the attention-bell causes"
```

Do NOT open a PR — that requires explicit user approval.

---

## Self-review record

(Re-run 2026-08-01 after folding in the load-bearing-assumption audit — ledger + V1–V8 reports under `.worktrees/.the-usual-logs/codex-attention-bell/`.)

- **Spec coverage:** cause rows → tasks: (0) baseline repair → Task 0 (inherited auto_resume_e2e regression — audit A20 — fixed before any feature work); (1) completed keep = untouched + re-verified in Task 14; (2) failed → Tasks 1, 8 (today's ONLY live failure cause — audit A12/A14); (3) interrupted keep = pinned tests retained; (4) abort reason → Tasks 3, 10 (forward-compatible policy plumbing, rationale corrected — no live producer); (5) death bells → Tasks 4, 5, 7, 11, 12 with the corrected engagement ontology (confirmed busy OR armed deadline OR pending approvals; input-only pending excluded — audit A6/A10/A17), requested-close discrimination via `codexRecoveryFinalClose` captured at finalizer entry (audit A7), and read-before-teardown ordering pinned by test (audit A17/A8); (6) approvals → Tasks 6, 7, 12 with the full resolution set (result|error responses, `serverRequest/resolved`, restart clears — audit A4/A5), legacy `conversationId` scoping (audit A3), lane-interference guards + resume-busy flag (audit A9), and unknown-method drift logging (audit A2); (7) deadman unchanged. Minors: (a) Tasks 2, 9; (b) Task 8. Docs incl. residuals: Task 13. Checks/freeze: Task 14. Every ringing cause AND every mandated silence (slash-quit, shutdown, requested kill, interrupted, mid-pause reconcile) maps to at least one named red test per server.
- **No silent deferrals:** every ringing cause is proven by hub/emitter-level tests emitting the REAL `terminal.idle` frame through production code paths (no stubs standing in for behavior). All exclusions are recorded DECISIONS with audit dispositions, listed in Task 13: mid-turn `/quit`/Ctrl+D and out-of-band `kill -9` (no in-band discriminator — accepted false-ring residual), claude/amplifier Enter-quits (same family), Node 120s busy-deadman swallow (missed bell only, never false — audit A17), slow (`>2s`) server-side auto-resolutions (one bell, low severity — audit A4), Node opencode death bell (noisy busy proxy — follow-up), unmanaged-codex approvals (no signal — documented).
- **Placeholder scan:** no TBDs; steps that modify unseen code bodies cite exact file:line anchors plus the sibling idiom to mirror, with the assertion/behavior contract spelled out in full; new audit-sourced anchors were re-verified against the worktree (`terminal-registry.ts:1504/:1509/:1527/:3574/:4069/:4908/:4955-4964/:4957/:644`; `idle.rs:49-60/:91-104/:124-128/:142-144`; `truly-idle-emitter.ts:20-42/:86-110`) or cited to the exact codex tag (v1.rs:126-158, common.rs:1701, v2/notification.rs:53-56, thread_processor.rs:3426/:3528, outgoing_message.rs:283, message_processor.rs:756-758 — all @0.146.0 unless noted).
- **Type consistency:** `spontaneous` (Rust field + Node event field), `latest_turn_aborted_reason`/`latestTurnAbortedReason`, `abort_reason_is_human`/`abortReasonIsHuman`, `AttentionBoundary`/`'attention.boundary'`, `is_engaged` (same exclusion semantics both sides: Rust `(busy && !pending) || deadline`, Node `(busy && !pending) || graceTimer`), `pending_approvals`/`pendingApprovals`, `resume_busy_after_approval`/`resumeBusyAfterApproval` (the lane-deferral flag), `has_pending_approvals` (Rust accessor) ↔ `approvalPendingRemovals` (Node changed-payload field — the emitter is event-fed, so the set membership travels on the removal payload instead of an accessor), `note_approval_requested/resolved` ↔ `onApprovalRequested/Resolved`, `APPROVAL_REQUEST_METHODS`/`CODEX_APPROVAL_REQUEST_METHODS` with matching `AUTOMATED_*`/`LEGACY_*` companion sets, `ApprovalResolved`/`'codex.approval.resolved'` (also emitted for error responses, `serverRequest/resolved`, and restart drains), `spontaneousExitRemovals` are used with the same names and shapes across all tasks.
