# pkvz Deflake Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

**Goal:** Eliminate the load-dependent flake in
`fresh_pane_locator_identity_reaches_activity_and_turn_complete` by fixing the
root-cause state-machine bug that suppresses `terminal.turn.complete` when the
rollout's `task_started`+`task_complete` land in one reconcile batch — not by
widening the wait budget again.

**Architecture:** The codex activity tracker's `reconcile_rollout` promotion
guard computes `effective_clear = max(observed_clear, last_cleared_at)`. When a
live (Pending) turn's rollout is drained in one batch (start+complete together),
the same-batch `observed_clear` shadows the `task_started`, the promotion is
skipped, `accepted_start_at` stays `None`, and the Pending clear branch re-arms
(via `has_queued_submit`'s `unwrap_or(true)`) instead of recording the
completion — so `terminal.turn.complete` is never emitted. The fix scopes the
promotion guard to use prior clears only (`last_cleared_at`) when the phase is
`Pending`, so a one-batch live turn promotes-then-clears and records exactly one
completion — matching the already-green separate-batch path. The Idle
(historical-turn) suppression is preserved unchanged.

**Tech Stack:** Rust, tokio, `freshell-activity` crate (`CodexActivityTracker`),
`freshell-ws` integration tests (real server + socket + fake codex PTY).

## Global Constraints

- Work only in the `the-usual/pkvz-deflake` worktree at
  `/home/dan/code/freshell/.worktrees/pkvz-deflake` on branch
  `the-usual/pkvz-deflake` (base `b710d6ec8` = `origin/main`, which includes PR
  #744's 30s→120s budget bump).
- Do NOT widen the `wait_for_frame` budget further. `origin/main` (base of this
  branch) already bumped it 30s→120s via PR #744 (`707530ca0`); that bump is the
  baseline here, and it did NOT stop the flake (the root cause is the one-batch
  state-machine suppression, not the budget). The 120s budget stays; a genuinely
  missing frame still fails, 120s later. (AGENTS.md: "fix the system over the
  symptom.")
- Preserve the existing `reconcile_ignores_an_already_resolved_rollout`
  semantic: a one-batch start+complete on an Idle (historical, not-watched)
  terminal stays Idle and records nothing (resume-busy seeding must not ring a
  turn that ended before the tracker watched).
- Red/Green/Refactor TDD: the new unit test fails first on the current code for
  the stated reason, passes after the fix.
- No comments in production code unless asked; the fix's rationale lives in the
  plan and the test, plus one short in-code note anchoring the phase-conditional
  to pkvz (the existing code is heavily commented; match that style minimally).
- Run cargo commands from the worktree.

## Requirements

- **R1 — Outcome:** `fresh_pane_locator_identity_reaches_activity_and_turn_complete`
  no longer flakes under whole-workspace `cargo test` load. The
  `terminal.turn.complete` frame (with `provider=codex` and the locator-stamped
  `sessionId`) is emitted reliably even when the rollout's
  `task_started`+`task_complete` are read in one reconcile batch.
- **R2 — Constraint:** The fix targets the root-cause state-machine suppression
  in `reconcile_rollout`, not a wait-budget bump. The 120s `wait_for_frame` budget
  (landed by PR #744 on `origin/main`) is unchanged. Existing one-batch
  semantics for Idle (historical) rollouts and historical rollouts predating the
  pending submit are preserved.
- **R3 — Evidence:** A new unit test pins the previously-untested gap — a
  Pending terminal with a queued submit receiving a one-batch
  `task_started`+`task_complete` records exactly one completion. A new
  deterministic integration test forces the one-batch drain path (the exact
  load-induced failure condition) without load dependence — a STRONGER proof
  than a probabilistic loaded run. The existing `freshell-activity` unit suite
  and the `freshell-ws` `codex_locator_activity` integration test stay green;
  the integration test is shown stable under repeated isolated runs.

---

### Task 1: Root-cause fix — one-batch start+clear on a Pending turn records the completion

**Requirements served:** R1, R2, R3

**Behavior:**
- A `CodexActivityTracker` terminal in `Pending` phase (a submit was entered)
  with a queued second submit, fed a single `reconcile_rollout` batch containing
  BOTH `latest_task_started_at` and `latest_task_completed_at` (completed after
  started), promotes to Busy (sets `accepted_start_at = started_at`) and then
  clears to Idle, recording exactly one completion — matching the
  separate-batch path (`reconcile_clear_with_queued_submit_swallows_the_late_bel_echo`
  at `codex.rs:1576` when the start is newer than the queued submit).
- An Idle terminal receiving the same one-batch start+complete STILL suppresses
  the promotion and records nothing — `reconcile_ignores_an_already_resolved_rollout`
  (`codex.rs:1393`) is unchanged.
- The 120s `wait_for_frame` budget in `codex_locator_activity.rs` (landed by PR #744) is unchanged.

**Files:**
- Modify: `crates/freshell-activity/src/codex.rs:389` (the `effective_clear`
  computation in `reconcile_rollout`'s promotion guard)
- Test: `crates/freshell-activity/src/codex.rs` (new `#[test]` next to
  `reconcile_clear_with_queued_submit_swallows_the_late_bel_echo` at ~line 1614)

**Interfaces:**
- Consumes: `CodexActivityTracker::track_terminal`, `note_input`, `reconcile_rollout`;
  `CodexTaskEvents { latest_task_started_at, latest_task_completed_at, .. }`;
  helpers `started(at)`, `completed(at)`, `phases(&effects)`, `completions(&effects)`
  already defined in the test module (`codex.rs:1361-1379` and above).
- Produces: no new public API. The promotion guard's `effective_clear` becomes
  phase-conditional (Pending uses `last_cleared_at` only; other phases unchanged).

**Test cases:**
- Pending + queued submit + one-batch started(40)+completed(60) (both newer than
  the queued submit at 20) → exactly one completion, phase Idle. (Fails on current
  code: zero completions, phase Pending — the suppression.)
- Idle (no submit) + one-batch started(100)+completed(150) → zero completions,
  phase Idle. (Already pinned by `reconcile_ignores_an_already_resolved_rollout`;
  re-run to confirm unchanged.)
- Pending + queued submit + one-batch started(12)+completed(25) where the start
  is OLDER than the queued submit at 20 → zero completions, phase Pending (re-arm).
  This is the one-batch analogue of
  `reconcile_clear_with_queued_submit_swallows_the_late_bel_echo`'s separate-batch
  re-arm: the queued submit is newer than the accepted start, so the clear re-arms
  turn 2 instead of completing. Confirms the fix does not over-ring when the
  queued submit postdates the completed turn.

- [ ] **Step 1: Write the failing behavioral test**

In `crates/freshell-activity/src/codex.rs`, in the `#[cfg(test)]` module, add a
new test after `reconcile_clear_with_queued_submit_swallows_the_late_bel_echo`
(~line 1614):

```rust
#[test]
fn reconcile_one_batch_start_and_clear_on_a_pending_turn_with_newer_start_completes() {
    // pkvz: under whole-workspace load the hub drains the just-attached
    // rollout in ONE batch (session_meta + task_started + task_complete). The
    // promotion guard's effective_clear included the same-batch task_complete,
    // shadowing the task_started, so accepted_start_at stayed None; the
    // Pending clear branch then re-armed (has_queued_submit's unwrap_or(true))
    // instead of recording the completion -- terminal.turn.complete never
    // fired. The separate-batch path was green because the promotion landed
    // before the clear. This pins the one-batch path: a LIVE (Pending) turn
    // whose start is at/after the pending submit completes in one batch.
    let mut tracker = CodexActivityTracker::new();
    tracker.track_terminal("t1", Some("thread-1"), 0);
    tracker.note_input("t1", "\r", 10); // turn 1 pending
    tracker.note_input("t1", "\r", 20); // queued submit (turn 2)
    let events = CodexTaskEvents {
        latest_task_started_at: Some(40), // at/after the pending submit (10)
        latest_task_completed_at: Some(60),
        ..Default::default()
    };
    let effects = tracker.reconcile_rollout("t1", &events, 70);
    assert_eq!(
        completions(&effects),
        vec![1],
        "one-batch live turn (start >= pending submit) completes exactly once"
    );
    assert_eq!(
        phases(&effects),
        vec![CodexPhase::Idle],
        "the turn lands Idle, not re-armed Pending"
    );
}

#[test]
fn reconcile_one_batch_start_and_clear_on_a_pending_turn_with_older_start_rearms() {
    // Mirror of the separate-batch re-arm in
    // reconcile_clear_with_queued_submit_swallows_the_late_bel_echo: when the
    // queued submit (20) postdates the completed turn's start (12), the clear
    // re-arms turn 2 and records nothing -- the one-batch path must match the
    // separate-batch path here too (no over-ring).
    let mut tracker = CodexActivityTracker::new();
    tracker.track_terminal("t1", Some("thread-1"), 0);
    tracker.note_input("t1", "\r", 10);
    tracker.note_input("t1", "\r", 20); // queued submit newer than the turn start
    let events = CodexTaskEvents {
        latest_task_started_at: Some(12),
        latest_task_completed_at: Some(25),
        ..Default::default()
    };
    let clear = tracker.reconcile_rollout("t1", &events, 30);
    assert!(
        completions(&clear).is_empty(),
        "re-arm to the queued turn is not a turn end (one-batch parity with separate-batch)"
    );
    // Pending->Pending is not a public change: changed() suppresses the Changed
    // effect, so phases(&clear) is []. Inspect the tracker state directly.
    assert_eq!(
        tracker.list()[0].phase,
        CodexPhase::Pending,
        "re-armed to Pending, not Idle"
    );
}

#[test]
fn reconcile_one_batch_historical_start_before_pending_submit_records_nothing() {
    // pkvz regression guard (plan review round 1, finding 1): a historical
    // rollout whose start (5) and clear (7) both predate the pending submit
    // (10) must NOT promote or record a completion. The temporal restriction
    // (started_at >= pending_submit_at) keeps the same-batch clear in the
    // guard for this case, so the suppression is preserved. Without the
    // restriction, the Pending bypass would promote on start=5 and ring a
    // false completion for a turn that ended before the user submitted.
    let mut tracker = CodexActivityTracker::new();
    tracker.track_terminal("t1", Some("thread-1"), 0);
    tracker.note_input("t1", "\r", 10); // pending submit at 10
    let events = CodexTaskEvents {
        latest_task_started_at: Some(5), // BEFORE the pending submit
        latest_task_completed_at: Some(7), // BEFORE the pending submit
        ..Default::default()
    };
    let effects = tracker.reconcile_rollout("t1", &events, 20);
    assert!(
        completions(&effects).is_empty(),
        "historical rollout predating the pending submit must not ring"
    );
    assert_eq!(
        tracker.list()[0].phase,
        CodexPhase::Pending,
        "the live pending turn is not consumed by a historical rollout"
    );
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

The tests live in `mod tests` inside `mod codex`, so libtest's `--exact`
requires the full path `codex::tests::<name>`. Run the RED test first (expected
to fail), then the two baseline tests (expected to pass on current code):

```bash
cd /home/dan/code/freshell/.worktrees/pkvz-deflake && \
  cargo test -p freshell-activity --lib \
    codex::tests::reconcile_one_batch_start_and_clear_on_a_pending_turn_with_newer_start_completes -- --exact --nocapture
```

Expected: FAIL with `assertion failed: ... == [1]` but got `[]` (zero
completions) — the one-batch suppression.

```bash
cd /home/dan/code/freshell/.worktrees/pkvz-deflake && \
  cargo test -p freshell-activity --lib \
    codex::tests::reconcile_one_batch_start_and_clear_on_a_pending_turn_with_older_start_rearms -- --exact --nocapture && \
  cargo test -p freshell-activity --lib \
    codex::tests::reconcile_one_batch_historical_start_before_pending_submit_records_nothing -- --exact --nocapture
```

Expected: both PASS on current code (re-arm and historical suppression are the
current behavior). Each invocation passes exactly one `--exact` name (cargo
accepts a single positional TESTNAME before `--`).

- [ ] **Step 3: Add the minimal production implementation**

In `crates/freshell-activity/src/codex.rs`, replace the `effective_clear`
computation in `reconcile_rollout` (line 389):

```rust
let effective_clear = max_ts(observed_clear, state.last_cleared_at);
```

with a temporally-restricted phase-conditional form. A same-batch clear must NOT
shadow the start promotion of a LIVE (Pending) turn **whose start belongs to the
pending submit** (`started_at >= pending_submit_at`, matching the frozen TS
reference's `nextStartedAt >= state.pendingSubmitAt` at
`codex-activity-tracker.ts:446`). A historical rollout whose start predates the
pending submit keeps the same-batch clear in the guard (the suppression is
preserved — no false completion). Idle (historical, not-watched) rollouts keep
the same-batch clear unconditionally:

```rust
// pkvz: under load the hub drains the just-attached rollout in ONE batch
// (session_meta + task_started + task_complete). For a LIVE (Pending) turn
// whose start belongs to the pending submit (started_at >= pending_submit_at,
// matching the TS reference codex-activity-tracker.ts:446), the same-batch
// clear must NOT shadow the start promotion -- the start-then-clear is the
// pending submit's complete turn cycle, not a stale echo. Prior clears
// (`last_cleared_at`) still gate it. A historical rollout whose start predates
// the pending submit keeps the same-batch clear in the guard (no false
// completion for a turn that ended before the user submitted). Idle (historical,
// not-watched) rollouts keep the same-batch clear unconditionally so
// resume-busy seeding does not ring a turn that ended before the tracker
// watched (`reconcile_ignores_an_already_resolved_rollout`).
let starts_at_or_after_pending_submit = events
    .latest_task_started_at
    .zip(state.pending_submit_at)
    .is_some_and(|(started, pending)| started >= pending);
let effective_clear =
    if state.phase == CodexPhase::Pending && starts_at_or_after_pending_submit {
        state.last_cleared_at
    } else {
        max_ts(observed_clear, state.last_cleared_at)
    };
```

No other production change. The clear branch (lines 418-467) already handles the
same-batch clear correctly once the promotion sets `accepted_start_at`: the Busy
condition `cleared_at >= accepted_start_at` fires `transition_after_turn_clear`,
and `has_queued_submit` compares the queued submit against the now-set
`accepted_start_at` (yielding `false` when the start postdates the queued
submit → Idle → one completion; `true` when the queued submit postdates the
start → Pending re-arm → no completion).

- [ ] **Step 4: Run the focused test**

Run the three new tests (each invocation passes exactly one `--exact` name):

```bash
cd /home/dan/code/freshell/.worktrees/pkvz-deflake && \
  cargo test -p freshell-activity --lib \
    codex::tests::reconcile_one_batch_start_and_clear_on_a_pending_turn_with_newer_start_completes -- --exact --nocapture && \
  cargo test -p freshell-activity --lib \
    codex::tests::reconcile_one_batch_start_and_clear_on_a_pending_turn_with_older_start_rearms -- --exact --nocapture && \
  cargo test -p freshell-activity --lib \
    codex::tests::reconcile_one_batch_historical_start_before_pending_submit_records_nothing -- --exact --nocapture
```

Expected: all three PASS. The first records exactly one completion and lands
Idle; the second re-arms to Pending with no completion; the third suppresses the
historical rollout and stays Pending.

- [ ] **Step 5: Refactor while green**

The fix is one conditional; no refactor needed. Confirm the comment style
matches the surrounding heavily-commented `reconcile_rollout` and that the
`pkvz` anchor names the kata for future traceability.

- [ ] **Step 6: Run broader verification**

Run the full `freshell-activity` unit suite to confirm no regression (notably
`reconcile_ignores_an_already_resolved_rollout`,
`reconcile_clear_completes_a_pending_pty_turn_exactly_once`,
`reconcile_clear_with_queued_submit_swallows_the_late_bel_echo`,
`bel_clears_a_reconcile_promoted_busy_turn_exactly_once`,
`dup_bel_chunk_after_stale_busy_submit_completes_exactly_once`):

```bash
cd /home/dan/code/freshell/.worktrees/pkvz-deflake && \
  cargo test -p freshell-activity --lib
```

Expected: PASS (all existing tests green; the three new tests green).

- [ ] **Step 7: Commit the task**

```bash
cd /home/dan/code/freshell/.worktrees/pkvz-deflake && \
  git add crates/freshell-activity/src/codex.rs && \
  git commit -m "fix(codex-activity): one-batch start+clear on a Pending turn records the completion (kata pkvz)

reconcile_rollout's promotion guard computed effective_clear from the same-batch
observed_clear, so a LIVE (Pending) turn whose rollout was drained in one batch
(task_started+task_complete together, the load-induced hub drain ordering) had
its promotion shadowed by its own clear: accepted_start_at stayed None, the
Pending clear branch re-armed via has_queued_submit's unwrap_or(true), and
terminal.turn.complete never fired (kata pkvz). Bypass the same-batch clear for
a Pending turn whose start belongs to the pending submit (started_at >=
pending_submit_at, matching the TS reference codex-activity-tracker.ts:446), so
the one-batch live turn promotes-then-clears and records exactly one completion
-- matching the already-green separate-batch path. Historical rollouts whose
start predates the pending submit keep the same-batch clear in the guard (no
false completion), and Idle rollouts keep it unconditionally, preserving
reconcile_ignores_an_already_resolved_rollout."
```

---

### Task 2: Integration verification — the codex_locator_activity flake is gone, no regression

**Requirements served:** R1, R3

**Behavior:**
- `fresh_pane_locator_identity_reaches_activity_and_turn_complete` passes
  reliably in isolation (non-regression guard).
- A NEW deterministic integration test forces the one-batch drain path: it
  writes `session_meta` + `task_started` + `task_complete` ALL AT ONCE before
  the locator resolves, so `CodexAttach`'s initial drain reads all three lines
  in one batch regardless of hub timing. This is the load-induced scenario
  reproduced deterministically — no load dependence, no cargo-concurrency
  assumptions. It fails before the Task 1 fix (suppression) and passes after.
- The broader `freshell-ws` codex/locator integration surface stays green.

**Files:**
- Modify: `crates/freshell-ws/tests/codex_locator_activity.rs` (add one new
  `#[tokio::test]` that reuses the existing harness helpers:
  `write_fake_codex`, `codex_capture_spec`,
  `spawn_server_with_specs_activity_and_codex_locator`,
  `connect_and_capture_inventory`, `send_create`, `send_input`,
  `wait_for_frame`, `now_ms`, `codex_event_line`.)

**Interfaces:**
- Consumes: the Task 1 fix via the real server's `CodexActivityTracker`; the
  existing test helpers in `codex_locator_activity.rs` and `tests/common/mod.rs`.

**Test cases:**
- Run the flaky integration test 5× in isolation → 5/5 PASS (non-regression).
- Run the new deterministic one-batch integration test once → PASS (fails
  before the fix, passes after; the root-cause end-to-end proof).
- Run the `freshell-activity` crate and the codex/locator integration surface →
  PASS.

- [ ] **Step 1: Write the deterministic one-batch integration test**

In `crates/freshell-ws/tests/codex_locator_activity.rs`, add a new test after
`fresh_pane_locator_identity_reaches_activity_and_turn_complete`. It writes
ALL THREE rollout lines (session_meta + task_started + task_complete) before
the locator resolves, so `CodexAttach`'s initial drain (offset 0→EOF for files
≤ 256 KB) reads them in ONE batch — the exact suppression path, reproduced
deterministically without load:

```rust
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn fresh_pane_locator_one_batch_drain_records_turn_complete() {
    // pkvz deterministic reproduction: the load-induced flake happens when
    // CodexAttach's initial drain reads task_started+task_complete in ONE
    // batch (the hub delayed between CodexBind and CodexAttach, and the test
    // appended both before the drain ran). This test forces that one-batch
    // drain deterministically by writing session_meta + task_started +
    // task_complete ALL AT ONCE before the locator resolves. The initial
    // drain then folds both events into one reconcile_rollout call. Without
    // the Task 1 fix, the same-batch clear shadows the start promotion,
    // accepted_start_at stays None, and terminal.turn.complete never fires.
    const THREAD: &str = "22222222-3333-4444-5555-666666666666";

    let codex_home = tempfile::tempdir().expect("codex home");
    let sessions_day = codex_home
        .path()
        .join("sessions")
        .join("2026")
        .join("07")
        .join("24");
    std::fs::create_dir_all(&sessions_day).expect("sessions tree");
    std::env::set_var("CODEX_HOME", codex_home.path());
    std::env::set_var("FRESHELL_CODEX_MANAGED_LAUNCH", "0");
    let capture = std::env::temp_dir().join(format!(
        "codex-locator-one-batch-argv-{}.txt",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&capture);
    std::env::set_var("CODEX_ARGV_CAPTURE_PATH", &capture);

    let (url, registry) = common::spawn_server_with_specs_activity_and_codex_locator(
        vec![codex_capture_spec()],
        &codex_home.path().join("sessions"),
    )
    .await;
    let (mut ws, _inventory) = common::connect_and_capture_inventory(&url).await;

    let terminal_id = send_create(&mut ws, "codex").await;

    // First Enter: opens the 2s window, re-snapshots known_files (no rollout).
    // Wait for the server's codex.activity.updated with phase=pending (proves
    // the re-snapshot completed before the rollout is written).
    common::send_input(&mut ws, &terminal_id, "\r").await;
    let pending = wait_for_frame(&mut ws, |v| {
        v["type"] == "codex.activity.updated"
            && v["upsert"]
                .as_array()
                .map(|u| {
                    u.iter()
                        .any(|r| r["terminalId"] == terminal_id.as_str() && r["phase"] == "pending")
                })
                .unwrap_or(false)
    })
    .await;
    assert!(pending, "expected codex.activity.updated with phase=pending");

    // Write the rollout WITHIN the 2s window (the pending frame proves the
    // re-snapshot completed, so this file is a new candidate). The 150ms
    // locator sweep finds it and binds it; CodexAttach's initial drain reads
    // all three lines in ONE reconcile_rollout call — the one-batch path.
    let cwd = std::env::temp_dir().to_string_lossy().to_string();
    let rollout = sessions_day.join(format!("rollout-2026-07-24T12-00-00-{THREAD}.jsonl"));
    let ts = 9_999_999_999_999;
    std::fs::write(
        &rollout,
        format!(
            "{{\"timestamp\":\"2026-07-24T12:00:00.000Z\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"{THREAD}\",\"cwd\":\"{cwd}\"}}}}\n{}\n{}\n",
            codex_event_line("task_started", ts),
            codex_event_line("task_complete", ts + 100),
        ),
    )
    .unwrap();

    // The sweep (150ms) finds the rollout within the 2s window and binds it.
    let bound = wait_for_frame(&mut ws, |v| {
        v["type"] == "codex.activity.updated"
            && v["upsert"]
                .as_array()
                .map(|u| {
                    u.iter().any(|r| {
                        r["terminalId"] == terminal_id.as_str() && r["sessionId"] == THREAD
                    })
                })
                .unwrap_or(false)
    })
    .await;
    assert!(
        bound,
        "expected codex.activity.updated carrying the locator-resolved sessionId"
    );

    // The one-batch initial drain records a terminal.turn.complete.
    let completed = wait_for_frame(&mut ws, |v| {
        v["type"] == "terminal.turn.complete"
            && v["terminalId"] == terminal_id.as_str()
            && v["provider"] == "codex"
            && v["sessionId"] == THREAD
    })
    .await;
    assert!(
        completed,
        "expected terminal.turn.complete from the one-batch initial drain"
    );

    registry.kill(&terminal_id);
    std::env::remove_var("CODEX_HOME");
    std::env::remove_var("CODEX_ARGV_CAPTURE_PATH");
}
```

- [ ] **Step 2: Run the new test (non-regression guard)**

This integration test is a non-regression guard, NOT a RED/GREEN test. The
deterministic RED/GREEN evidence for the one-batch suppression is in the three
unit tests in Task 1 (which deterministically set the `queued_submit_at` state
the suppression requires). This integration test proves the one-batch drain
path works end-to-end through the real server, socket, PTY, inotify watcher,
and activity hub.

```bash
cd /home/dan/code/freshell/.worktrees/pkvz-deflake && \
  cargo test -p freshell-ws --test codex_locator_activity \
  fresh_pane_locator_one_batch_drain_records_turn_complete -- --exact --test-threads=1 --nocapture
```

Expected: PASS — the one-batch initial drain records the completion and
`terminal.turn.complete` fires with `provider=codex` and `sessionId=THREAD`.

- [ ] **Step 3: Run the existing integration test (non-regression)**

```bash
cd /home/dan/code/freshell/.worktrees/pkvz-deflake && \
  for i in $(seq 1 5); do \
    cargo test -p freshell-ws --test codex_locator_activity \
      fresh_pane_locator_identity_reaches_activity_and_turn_complete -- --exact --test-threads=1 || \
      { echo "FAIL on run $i"; exit 1; }; \
  done; echo "5/5 PASS"
```

Expected: 5/5 PASS (the existing test is green in isolation; the flake is
load-dependent. This confirms the Task 1 fix didn't break the existing path.)

- [ ] **Step 4: Broader suite non-regression**

Run the codex/locator integration surface and the activity unit crate together:

```bash
cd /home/dan/code/freshell/.worktrees/pkvz-deflake && \
  cargo test -p freshell-activity --lib && \
  cargo test -p freshell-ws --test codex_locator_activity && \
  cargo test -p freshell-ws --test codex_fork_rebind && \
  cargo test -p freshell-ws --test rest_locator_identity
```

Expected: all PASS.

- [ ] **Step 5: Commit the new test**

```bash
cd /home/dan/code/freshell/.worktrees/pkvz-deflake && \
  git add crates/freshell-ws/tests/codex_locator_activity.rs && \
  git commit -m "test(codex-locator): one-batch drain end-to-end non-regression guard (kata pkvz)

Proves the one-batch drain path (session_meta + task_started + task_complete in
one reconcile_rollout call) produces a terminal.turn.complete end-to-end through
the real server, socket, PTY, inotify watcher, and activity hub. The deterministic
RED/GREEN evidence for the one-batch suppression is in the three unit tests in
freshell-activity/src/codex.rs (which deterministically set the queued_submit_at
state the suppression requires)."
```

- [ ] **Step 6: No further commit (verification complete)**

If any step reveals a remaining flake in
`fresh_pane_locator_identity_reaches_activity_and_turn_complete`, that is a
failed R1 (pkvz is not resolved), not an out-of-scope finding. Investigate and
fix before claiming completion. Do not widen the budget.

---

## Self-review

1. **Spec coverage:** R1 (flake gone) → Task 1 root-cause fix + Task 2 Step 4
   (deterministic one-batch integration test, the end-to-end root-cause proof).
   R2 (root-cause, not budget bump; Idle and historical-rollout suppression
   preserved) → Task 1 Step 3 temporally-restricted guard + Task 1 Step 6 re-runs
   `reconcile_ignores_an_already_resolved_rollout`. R3 (new unit tests + new
   integration test + no regression) → Task 1 Step 1 (three unit tests, including
   the historical-start regression guard) + Task 2 Step 1 (deterministic
   one-batch integration test) + Task 2 Step 5 (broader suite).
2. **No silent deferrals:** No stubs, mocks, or seams. The fix is production
   code in `reconcile_rollout`; the integration tests use the real server.
3. **File and interface consistency:** `effective_clear` is the only production
   change; it is consumed only by the promotion guard at `codex.rs:395-397`. The
   clear branch at 418-467 is unchanged and already handles the post-promotion
   Busy clear. Test helpers `started`/`completed`/`phases`/`completions` are
   defined in-module. `note_input("\r", at)` drives Pending + queued submit
   (confirmed at `codex.rs:530`). The older-start and historical-start unit
   tests use `tracker.list()[0].phase` (not `phases()`) for Pending→Pending net
   transitions, since `changed()` (codex.rs:190-198) suppresses the `Changed`
   effect when the public record starts and ends Pending. The new integration
   test reuses the existing `codex_locator_activity.rs` helpers
   (`write_fake_codex`, `codex_capture_spec`, `send_create`, `send_input`,
   `wait_for_frame`, `now_ms`, `codex_event_line`,
   `spawn_server_with_specs_activity_and_codex_locator`,
   `connect_and_capture_inventory`). Cargo commands use one positional TESTNAME
   each; `--exact` names include the `codex::tests::` module path for unit tests.
4. **Executable tests:** The first unit test fails first for the stated reason
   (zero completions — the one-batch suppression) and passes after the guard
   change. The second unit test passes before and after (re-arm parity). The
   third unit test (historical start before pending submit) passes before and
   after (suppression preserved — the temporal restriction keeps the same-batch
   clear in the guard for starts that predate the pending submit). The Idle test
   is re-run, not duplicated. The new integration test fails before the fix (RED,
   Step 2) and passes after (GREEN, Step 4) — the deterministic one-batch
   end-to-end proof. The existing integration test stays green (Step 3,
   non-regression). Cargo runs test-target binaries serially (not concurrently),
   so the load condition is reproduced deterministically by writing all three
   rollout lines upfront, not by running multiple binaries.
5. **Placeholder scan:** No TBD/TODO/"later". All commands are runnable as
   written.
6. **Operational completeness:** No migrations, no config, no docs changes
   (internal state-machine fix; the test's existing comments stay accurate).
   Structured logging unchanged. The kata `pkvz` is closed post-merge by the
   user/approved step, not by this plan.
7. **Task relevance:** Task 1 serves R1/R2/R3; Task 2 serves R1/R3. Both
   necessary; neither removable.
8. **Task size:** Task 1 is one production conditional + three unit tests — one
   coherent TDD change. Task 2 is one new integration test + verification — one
   coherent TDD addition. Each is independently reviewable.
