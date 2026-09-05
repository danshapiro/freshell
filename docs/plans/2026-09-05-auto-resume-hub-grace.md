# Auto-Resume Hub Identity Grace + Waiver-Classifier Removal Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Fix the auto-resume hub "mechanism-B" production defect (kata `kmbs`): under load, when a crashed fresh-agent terminal has no resolvable resume identity at crash-decision time, the hub settles it `exited` with reason `no_resumable_identity` in a single decision and never reconsidered, producing a permanently dead pane — even when the identity becomes resolvable seconds later. Replace the one-shot settle with a bounded, loud identity-grace re-check so identity landing within the grace converts the settle into a normal resume. Then remove the waiver-classifier machinery (`scripts/classify-resume-waiver.ts` + `test/unit/scripts/classify-resume-waiver.test.ts`): with the bug fixed, no certification waiver path should remain. Keep the previous run's deadline hardening (`FRAME_BUDGET`) and diagnostic ring (`wait_frame_matching`) intact and behavior-identical.

### Explicit constraints
- Red/green/refactor TDD; unit and integration (e2e) coverage of the new behavior.
- Certification is strict from this branch onward: the auto_resume e2e binaries must pass a repeated (10x) certification campaign with ZERO waivers — the classifier is deleted in this same branch, so no waiver path exists.
- Keep existing ws harness semantics: no relaxed assertions, no silent retry-masking. Grace is bounded via HubConfig (default plus env escape hatch), never infinite waiting.
- Rust workspace: server code in `crates/freshell-ws/` / `crates/freshell-server/`. NodeNext rules apply to the deleted TS only — no new TS is introduced.
- Do not touch unrelated production code (`pane_ledger.rs` etc. owned by in-flight darkforge lanes).
- Land via PR targeting main only after explicit user approval.
- Existing katas 38cm, e08g, 1xyw stay open (separate flakes); this run does not fix them.

### Accepted tradeoffs and residuals
- Grace delays other panes' resume processing by up to the grace total (5s default worst case) when a crash lands in front of them — in-family with the existing in-loop 2s/10s backoff sleeps (serialization is deliberate anti-storm discipline).
- A truly-identitiless crashing pane now waits ~5s before the exited settle — strictly better than a permanently dead pane.
- The adjacent CrashEvent-loss-on-driver-panic window (auto_resume.rs:233-279) is a separate pre-existing gap; it stays logged as a residual (not fixed here).
- The grace-success e2e's "grace was engaged" log-capture assertion can false-red (never silently green) under a pathological multi-second hub stall racing the fixed upsert instant; the certification campaign watches the rate.

**Goal:** A fresh-agent pane whose identity legitimately arrives seconds after its generation crashes is auto-resumed instead of permanently dead, and the waiver classifier that existed only to tolerate that defect is deleted along with its certification passes.

**Architecture:** One bounded grace loop inserted at the single decision choke point (`run_hub_body` in `crates/freshell-ws/src/auto_resume.rs`), before the crash-context construction: when the just-queried session-ref is `None` and the arresting settle reason would be `no_resumable_identity`, sleep-and-recheck through a bounded `HubConfig.identity_grace_delays` schedule; identity arriving in grace falls through to the unchanged `decide` path (normal Resume), cancel-during-grace settles loudly, exhaustion settles `no_resumable_identity` exactly as before. The crash-invariant that a dead terminal's identity is retired is restored whenever the grace path observed a late revival (an upsert un-retires per identity.rs:123): the hub re-retires the old terminal's identity after the grace block and BEFORE the `decide` match — covering the Resume arm AND every settle tail (flap breaker, respawn cap, retries exhausted) that could otherwise leave the dead terminal in live-only identity lookups. Classifier removal is a two-file deletion plus a comment scrub and historical-doc supersede notes.

**Tech Stack:** Rust 2021 workspace (tokio, axum), cargo; Vitest/TS only for verification of the deletion (no new TS).

## Global Constraints

- Never silently fall back from cloud test backends; use repo-coordinated test commands (`npm run test:vitest`, `cargo test`).
- Repo doctrine: bounded-and-loud, never infinite-and-silent; no silent retry-masking. The `wait_frame_matching` ring, FRAME_BUDGET, and both `#[should_panic]` ring-pin tests in `auto_resume_e2e.rs` stay byte-equivalent in behavior (comments may drop classifier references; assertions must not change).
- Process safety: never restart the production server; never push to main; PR only after explicit approval.
- All new code structured logs with severity (tracing).
- Commits focused, conventional, single-task.

---

### Task 1: Identity-grace in the hub (unit-tested, deterministic virtual time)

**Files:**
- Modify: `crates/freshell-ws/src/auto_resume.rs` (HubConfig + schedules constructor, new const, new env fn, `run_hub_body` grace block + Resume-arm re-retire, `AutoResumeDriver` trait + impls, spawn helper, unit tests in the same file)

**Interfaces:**
- Consumes: existing `HubConfig`, `run_hub_body`, `decide`, `AutoResumeDriver`, `FakeDriver` (same-file test module), `parse_delays_env`, `TerminalIdentityRegistry::retire` (identity.rs:205).
- Produces: `pub(crate) const AUTO_RESUME_DEFAULT_IDENTITY_GRACE_DELAYS_MS: [u64; 2] = [2_500, 2_500]`; `HubConfig { identity_grace_delays: Vec<u64>, .. }`; `pub(crate) fn HubConfig::with_schedules(delays, identity_grace_delays) -> Self`; `pub(crate) fn auto_resume_identity_grace_delays() -> Vec<u64>`; `pub fn spawn_auto_resume_hub_with_schedules(state, rx, delays, identity_grace_delays) -> JoinHandle<()>`; `AutoResumeDriver::retire_identity(&self, terminal_id)`; two tracing info lines `terminal.auto_resume.identity_grace_entered` and `...identity_grace_resolved` (terminal_id field on both).

- [ ] **Step 1: Write the failing behavioral tests** (in `crates/freshell-ws/src/auto_resume.rs` `mod tests`)

(a) The primary RED test — identity landing mid-grace converts settle into resume (per-step `advance` + `drain`: paused-clock `advance` wakes only timers ALREADY scheduled, so each grace step gets its own advance):

```rust
#[tokio::test(start_paused = true)]
async fn identity_arriving_during_grace_converts_no_identity_settle_into_resume() {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let fake = FakeDriver::healthy();
    fake.set_session(None); // identity absent at crash-decision time
    let cfg = HubConfig::with_schedules(vec![2_000, 10_000], vec![500, 500]);
    let _hub = spawn_hub_with_driver(fake.clone(), rx, cfg);

    tx.send(crash("t1", 1, "claude", Some("cr-1"), 5_000)).unwrap();
    drain().await;
    assert!(fake.settled_frames().is_empty(), "no settle during grace");
    assert!(fake.recovering_calls().is_empty(), "no recover before identity");

    // Grace step 1 elapses with no identity: re-check sees None, loop holds.
    tokio::time::advance(std::time::Duration::from_millis(500)).await;
    drain().await;
    assert!(fake.settled_frames().is_empty());
    assert!(fake.recovering_calls().is_empty());

    // Identity lands before grace step 2 completes.
    fake.set_session(Some(("claude".into(), "sess-1".into(), None)));
    tokio::time::advance(std::time::Duration::from_millis(500)).await;
    drain().await;
    assert_eq!(fake.recovering_calls(), vec![("t1".into(), 1u32, 2u32)]);
    assert!(fake.respawn_calls().is_empty(), "resume backoff still respected");
    tokio::time::advance(std::time::Duration::from_millis(2_000)).await;
    drain().await;
    assert_eq!(
        fake.replaced_calls(),
        vec![("t1".into(), "t-new".into(), 1u32)]
    );
    assert!(fake.settled_frames().is_empty(), "no exited settle at all");
    // The crash invariant — dead terminal's identity retired — is restored:
    assert!(fake.retired().contains(&"t1".to_string()));
}
```

(b) Grace exhaustion still settles loudly:

```rust
#[tokio::test(start_paused = true)]
async fn no_identity_after_grace_exhaustion_settles_exited_loudly() {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let fake = FakeDriver::healthy();
    fake.set_session(None); // stays None for the whole grace
    let cfg = HubConfig::with_schedules(vec![2_000, 10_000], vec![500, 500]);
    let _hub = spawn_hub_with_driver(fake.clone(), rx, cfg);

    tx.send(crash("t2", 1, "claude", Some("cr-2"), 1_000)).unwrap();
    drain().await;
    assert!(fake.settled_frames().is_empty(), "grace must run first");
    tokio::time::advance(std::time::Duration::from_millis(500)).await;
    drain().await;
    assert!(fake.settled_frames().is_empty(), "second grace step pending");
    tokio::time::advance(std::time::Duration::from_millis(500)).await;
    drain().await;
    assert_eq!(
        fake.settled_frames(),
        vec![("t2".to_string(), "no_resumable_identity".to_string(), None)]
    );
    assert!(fake.respawn_calls().is_empty());
}
```

(c) Grace eligibility gate — clean exit, shell mode, AND missing create_request_id all settle IMMEDIATELY (no grace sleeps):

```rust
#[tokio::test(start_paused = true)]
async fn non_identity_settles_skip_the_grace_entirely() {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let fake = FakeDriver::healthy();
    let cfg = HubConfig::with_schedules(vec![2_000, 10_000], vec![500, 500]);
    let _hub = spawn_hub_with_driver(fake.clone(), rx, cfg);

    tx.send(crash("t3", 0, "claude", Some("cr-3"), 1_000)).unwrap(); // clean_exit
    tx.send(crash("t4", 1, "shell", Some("cr-4"), 1_000)).unwrap();  // not_agent_mode (silent)
    tx.send(crash("t5", 1, "claude", None, 1_000)).unwrap();         // no_create_request_id
    drain().await; // NO time advance — ineligible settles must already have happened
    assert_eq!(
        fake.settled_frames(),
        vec![
            ("t3".to_string(), "clean_exit".to_string(), None),
            ("t5".to_string(), "no_create_request_id".to_string(), None),
        ],
        "shell settles silently; both non-identity settles are grace-free"
    );
}
```

(d) Cancel during grace settles loudly at a grace-step boundary (ordering under paused time: the crash event must be drained into the hub BEFORE the cancel is seeded, so the hub is parked inside its first grace sleep):

```rust
#[tokio::test(start_paused = true)]
async fn cancel_during_grace_settles_cancelled_and_skips_further_rechecks() {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let fake = FakeDriver::healthy();
    fake.set_session(None);
    let cfg = HubConfig::with_schedules(vec![2_000, 10_000], vec![500, 500]);
    let _hub = spawn_hub_with_driver(fake.clone(), rx, cfg);

    tx.send(crash("t6", 1, "claude", Some("cr-6"), 1_000)).unwrap();
    drain().await; // hub is now parked in grace sleep #1
    fake.set_cancelled("t6"); // user clicks abort during the grace
    tokio::time::advance(std::time::Duration::from_millis(500)).await;
    drain().await;
    assert_eq!(
        fake.settled_frames(),
        vec![(
            "t6".to_string(),
            super::SETTLE_REASON_CANCELLED.to_string(),
            None
        )]
    );
    // Neither a later identity nor further steps resurrect anything:
    fake.set_session(Some(("claude".into(), "sess-1".into(), None)));
    tokio::time::advance(std::time::Duration::from_millis(5_000)).await;
    drain().await;
    assert!(fake.recovering_calls().is_empty());
    assert!(fake.respawn_calls().is_empty());
}
```

(f) Review-round-2 pin: a grace-revived identity is re-retired even when the decision is a SETTLE (cap exhausted at decision time):

```rust
#[tokio::test(start_paused = true)]
async fn grace_revived_identity_is_re_retired_even_on_settle_outcomes() {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let fake = FakeDriver::healthy();
    fake.set_cap_exhausted(true); // settle, not resume, after revival
    fake.set_session(None);
    let cfg = HubConfig::with_schedules(vec![2_000, 10_000], vec![500, 500]);
    let _hub = spawn_hub_with_driver(fake.clone(), rx, cfg);

    tx.send(crash("t7", 1, "claude", Some("cr-7"), 5_000)).unwrap();
    drain().await;
    tokio::time::advance(std::time::Duration::from_millis(500)).await;
    drain().await;
    fake.set_session(Some(("claude".into(), "sess-1".into(), None)));
    tokio::time::advance(std::time::Duration::from_millis(500)).await;
    drain().await;
    assert!(fake.respawn_calls().is_empty(), "cap was exhausted");
    assert_eq!(
        fake.settled_frames(),
        vec![("t7".to_string(), "respawn_cap_exhausted".to_string(), None)]
    );
    // The revived identity did NOT leak into live-only registry lookups:
    assert!(fake.retired().contains(&"t7".to_string()));
}
```

(e) Existing test RESTRUCTURE (review-driven): `cap_exhausted_and_no_identity_and_clean_and_shell_settle_without_respawn` keeps session None through t2's WHOLE grace before restoring Some for t3/t4 — set the cfg grace to `vec![500, 500]`, and after the t2 send advance 500+drain twice (2-step grace), assert t2's settle, THEN `fake.set_session(Some(...))` before the t3/t4 leg. All four final settle-frame assertions unchanged in content (order t1, t2, t3 as today). Do NOT touch the `decide()`-level pin in `missing_identity_settles_exited_immediately` — `decide` still returns `no_resumable_identity`; the grace lives in the loop, not in `decide`.

- [ ] **Step 2: Run the new tests and verify the intended failures**

Run: `cargo test -p freshell-ws --lib auto_resume::tests`

Expected: FAIL — first at compile (no `HubConfig::with_schedules`, no `identity_grace_delays` field, no `retire_identity` trait method); after the type-level pieces exist but the loop doesn't, (a) fails with empty `recovering_calls` where `attempt 1` is asserted, (d) fails on the cancelled-frames assertion, and (e)'s t2 leg settles immediately rather than after the two advances.

- [ ] **Step 3: Add the minimal production implementation** (all in `crates/freshell-ws/src/auto_resume.rs`)

(i) After `AUTO_RESUME_DEFAULT_DELAYS_MS`:

```rust
/// Grace before settling `no_resumable_identity` (kata kmbs): identity can
/// legitimately land SECONDS after the crash decision — codex/opencode
/// locator adoption windows are 2s (`codex_locator.rs` /
/// `opencode_locator.rs`), and a claude instant-crash races the create-path
/// identity upsert. Total 5s sits inside the repo's own unresolved-identity
/// alarm budget (`IDENTITY_RESOLUTION_GRACE_MS = 10_000`, invariants.rs).
/// Empty via env = grace disabled (escape hatch). Bounded and LOUD:
/// exhaustion still settles `no_resumable_identity`.
pub(crate) const AUTO_RESUME_DEFAULT_IDENTITY_GRACE_DELAYS_MS: [u64; 2] = [2_500, 2_500];
```

(ii) `HubConfig` gains the field, a `pub(crate) fn with_schedules(delays: Vec<u64>, identity_grace_delays: Vec<u64>) -> Self` harness constructor (`..HubConfig::from_env()` for the rest), and `from_env` populates via a new env fn reusing `parse_delays_env` (zero/invalid values fall back loudly; explicit empty string disables grace):

```rust
pub(crate) fn with_schedules(delays: Vec<u64>, identity_grace_delays: Vec<u64>) -> Self {
    Self { delays, identity_grace_delays, ..HubConfig::from_env() }
}

pub(crate) fn auto_resume_identity_grace_delays() -> Vec<u64> {
    match std::env::var("FRESHELL_AUTO_RESUME_IDENTITY_GRACE_MS") {
        Ok(raw) if raw.trim().is_empty() => Vec::new(),
        Ok(raw) => parse_delays_env(&raw).unwrap_or_else(|| {
            tracing::warn!(
                raw,
                "FRESHELL_AUTO_RESUME_IDENTITY_GRACE_MS is set but unparseable — falling back to default grace delays"
            );
            AUTO_RESUME_DEFAULT_IDENTITY_GRACE_DELAYS_MS.to_vec()
        }),
        Err(_) => AUTO_RESUME_DEFAULT_IDENTITY_GRACE_DELAYS_MS.to_vec(),
    }
}
```

(iii) `AutoResumeDriver` gains one method; `WsAutoResumeDriver` implements it via `state.identity.retire(terminal_id)` (returns bool, ignore the value — idempotent); `FakeDriver` records into a `retired: Vec<String>` with a `retired()` accessor:

```rust
/// Restore the crash invariant after a grace-revived identity: the exit
/// hook retires before the CrashEvent is sent, but a grace-resolved identity
/// landed via upsert AFTER the hook — and upsert un-retires (identity.rs:123)
/// — so the hub re-retires before the decision match. Called only when the
/// grace path observed the revival; idempotent regardless.
fn retire_identity(&self, terminal_id: &str);
```

(iv) The grace block at the top of the event loop. Add the `'events:` label to the outer `while let Some(ev) = rx.recv().await`, track late-revival, and re-retire before the match:

```rust
'events: while let Some(ev) = rx.recv().await {
            let mut sref = driver.resumable_session_ref(&ev.terminal_id);
            // True iff the identity was absent at the first query but
            // present after the grace — i.e. an upsert REVIVED the retired
            // entry (upsert un-retires, identity.rs:123) while the pane was
            // dead. Such identities must be re-retired before the decision
            // match or the dead terminal stays in live-only lookups
            // (identity.list()/find_by_session filter retired) no matter
            // whether the outcome is Resume or a settle.
            let mut identity_revived = false;
            // Identity grace (kata kmbs): `no_resumable_identity` used to be
            // a one-shot, never-reconsidered settle — a permanently dead pane
            // when identity legitimately landed seconds later (locator
            // adoption windows, load-race upsert lag). Re-check here, at the
            // single decision choke point, through a BOUNDED schedule before
            // deciding: identity arriving in grace converts the settle into
            // the normal Resume path with zero special-casing below. Skipped
            // unless no_resumable_identity is the reason `decide` WOULD
            // settle on — same predicate order: clean_exit / not_agent_mode /
            // no_create_request_id settle immediately, grace-free.
            if sref.is_none()
                && ev.exit_code != 0
                && AUTO_RESUME_MODES.contains(&ev.mode.as_str())
                && ev.create_request_id.is_some()
                && cfg.identity_grace_delays.iter().any(|s| *s > 0)
            {
                tracing::info!(
                    terminal_id = %ev.terminal_id,
                    "terminal.auto_resume.identity_grace_entered"
                );
                for step in &cfg.identity_grace_delays {
                    if *step == 0 {
                        continue;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(*step)).await;
                    // Cancel during grace stays LOUD (mirrors the Resume
                    // arm's post-sleep take_cancel) — never consumed
                    // silently by the settle tail's hygiene cleanup.
                    if driver.take_cancel(&ev.terminal_id) {
                        driver.emit_settled(&ev.terminal_id, SETTLE_REASON_CANCELLED, None);
                        driver.log_settled(&ev.terminal_id, "user_cancelled");
                        continue 'events;
                    }
                    sref = driver.resumable_session_ref(&ev.terminal_id);
                    if sref.is_some() {
                        identity_revived = true;
                        tracing::info!(
                            terminal_id = %ev.terminal_id,
                            "terminal.auto_resume.identity_grace_resolved"
                        );
                        break;
                    }
                }
            }
            if identity_revived {
                driver.retire_identity(&ev.terminal_id);
            }
```

The remaining loop body is untouched (the ordinary Resume path never sets `identity_revived` — its identity was retired by the exit hook before the CrashEvent was sent — so no separate Resume-arm retire is needed; the conditional retire covers Resume AND every settle tail uniformly).

(v) Public harness entry point (no pub visibility change on HubConfig — the schedule constructor is pub(crate) and the spawn fn takes plain Vecs):

```rust
/// [`spawn_auto_resume_hub`] with explicit backoff AND identity-grace
/// schedules. The harness injects tiny values: it is in-process, so env
/// writes would leak across parallel tests in one binary.
pub fn spawn_auto_resume_hub_with_schedules(
    state: crate::WsState,
    rx: tokio::sync::mpsc::UnboundedReceiver<CrashEvent>,
    delays: Vec<u64>,
    identity_grace_delays: Vec<u64>,
) -> tokio::task::JoinHandle<()> {
    spawn_hub_with_driver(
        WsAutoResumeDriver { state },
        rx,
        HubConfig::with_schedules(delays, identity_grace_delays),
    )
}
```

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-ws --lib auto_resume::tests`

Expected: PASS — the four new tests, the restructured four-event test, and every pre-existing module test.

- [ ] **Step 5: Refactor while green**

Extract the grace-eligibility predicate into `fn identity_grace_applies(ev: &CrashEvent, sref_absent: bool, cfg: &HubConfig) -> bool` ONLY if the inline block reads cleaner with it; the predicate-order comment must survive either way. No other refactors.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-ws auto_resume` AND `cargo test -p freshell-ws --test auto_resume_e2e`

Expected: PASS (the claude-driven e2e tests carry preallocated identity present before the crash decision — grace never engages for them — and the two `#[should_panic]` ring-pin tests are untouched).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ws/src/auto_resume.rs
git commit -m "fix(auto-resume): bounded identity grace replaces one-shot no_resumable_identity settle (kata kmbs)"
```

---

### Task 2: E2e pins — grace success + grace exhaustion over the real WS surface

**Files:**
- Test/Modify: `crates/freshell-ws/tests/auto_resume_e2e.rs`
- Modify: `crates/freshell-ws/tests/common/mod.rs` (harness helper only)

**Interfaces:**
- Consumes: Task 1's `spawn_auto_resume_hub_with_schedules` + the `identity_grace_entered` info log; existing `wait_frame_matching`, `connect_and_capture_inventory`; `WsState.identity` (pub `upsert` identity.rs:102, pub retired field :43).
- Produces: `spawn_server_with_specs_hub_and_state(cli_commands, delays, identity_grace_delays) -> (String, TerminalRegistry, WsState)` in tests/common/mod.rs; e2e-local helpers `crash_once_codex_spec(marker)`, `create_codex_terminal`, `wait_recovered_or_fail_on_exited`, `assert_no_exited_settle_for`, `grace_event_capture`; two new e2e tests.

- [ ] **Step 1: Harness helper (tests/common/mod.rs)** — add `spawn_server_with_specs_hub_and_state` (clone of the existing hub helper's body, hub spawned via `freshell_ws::auto_resume::spawn_auto_resume_hub_with_schedules(state.clone(), auto_resume_rx, delays, identity_grace_delays)`, returning `(url, registry, state)`); refactor `spawn_server_with_specs_and_auto_resume_hub` to delegate to it with harness-default grace `vec![25, 25]` (drops the returned state) so ALL hub-harness tests exercise the grace path cheaply. Claude-driven tests never engage grace (identity present at decision), so delays stay cheap.

- [ ] **Step 2: Write the e2e tests**

Shared scaffolding at the top of auto_resume_e2e.rs:

```rust
/// Process-global tracing capture for the grace-entry proof — the hub task
/// runs on tokio workers, where a thread-local default dispatcher is blind
/// (kata e08g's cross-thread miss). Same OnceLock-install semantics as
/// diag01_lifecycle_events.rs:163-184: first caller installs; every event
/// in the binary lands in the shared vec, so reads MUST filter by the
/// freshly-minted terminal id (captured start-index + tid field).
/// This binary installs no other global subscriber; a future second
/// installer panics loudly instead of silently capturing nothing.
fn grace_event_capture() -> (Arc<Mutex<Vec<CapturedEvent>>>, usize) { /* global_capture convention copied from diag01_lifecycle_events.rs, CaptureLayer/CapturedEvent shaped like pane_ledger_tests.rs's */ }
```

```rust
/// Codex-mode crash-once shim — caller passes a PER-TEST marker path
/// (tests in one binary share std::process::id()). Protocol: absent marker
/// -> touch marker, sleep 1200ms, exit 1 (the sleep window lets the test
/// synchronize its upsert INSIDE the grace reliably); marker present ->
/// `exec sleep 30` (the respawned generation survives). No
/// create_session_args: codex has no preallocation, so the identity
/// registry starts EMPTY for the created terminal (mechanism-B
/// precondition). resume_args follow codex_session_ref_resume.rs's
/// codex_cli_spec shape (["resume", "{{sessionId}}"]).
fn crash_once_codex_spec(marker: &std::path::Path) -> freshell_platform::CliCommandSpec { /* shim: "#!/bin/sh\nif [ -e \"{m}\" ]; then exec sleep 30; fi\n: > \"{m}\"\nsleep 1.2\nexit 1\n" */ }
```

```rust
/// Fresh codex `terminal.create` — like `create_claude_terminal` but codex
/// carries NO preallocated sessionRef; only the terminalId is returned.
async fn create_codex_terminal(ws: &mut common::TestWs, request_id: &str) -> String { /* mode: "codex" create; return created["terminalId"] */ }
```

```rust
/// Wait for the replaced frame for `old_tid` while enforcing the in-flight
/// contract: ANY terminal.status{exited} naming old_tid fails the test with
/// the offending frame quoted, and the replaced frame is only accepted after
/// a recovering frame for old_tid has been seen (both frames carry
/// terminalId per terminal.rs emit_recovering/broadcast_settled_frame).
/// Returns the replaced frame. Never discards silently: every consumed
/// frame is either matched, asserted-against, or the deadline expires with
/// the same ring-style dump idiom this file already uses.
async fn wait_recovered_or_fail_on_exited(
    ws: &mut common::TestWs,
    old_tid: &str,
    deadline: tokio::time::Instant,
) -> serde_json::Value { /* loop with tokio::time::timeout slices; panic on exited(old_tid); track recovering(old_tid); on replaced old->any: require recovering-seen, return frame */ }
```

```rust
/// Explicit negative assertion: read frames for `dur`; FAIL with the frame
/// quoted if any terminal.status{exited} names `tid`. Consumes and inspects
/// every frame in the window — this is not a silent sleep.
async fn assert_no_exited_settle_for(ws: &mut common::TestWs, tid: &str, dur: Duration) { /* timeout_at loop as in the rejected draft */ }
```

Test (i) — grace success:

```rust
/// Mechanism-B regression pin (kata kmbs): identity landing DURING the
/// grace converts the no_resumable_identity settle into a normal resume.
/// Synchronization: the shim touches its marker then sleeps 1.2s before
/// exiting; the test polls the marker, then upserts 250ms after the shim's
/// own exit instant — comfortably inside the 2s-first grace step, with the
/// grace-entry log assertion proving (never silently vacating) engagement.
#[tokio::test(flavor = "multi_thread")]
#[cfg(unix)]
async fn crash_with_identity_arriving_during_grace_is_resumed() {
    let marker = std::env::temp_dir().join(format!(
        "freshell-e2e-grace-resume-marker-{}.txt",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&marker); // stale-marker absorb (PID reuse)
    let (events, capture_start) = grace_event_capture();
    let (url, _registry, state) = common::spawn_server_with_specs_hub_and_state(
        vec![crash_once_codex_spec(&marker)],
        vec![50, 100],
        vec![2_000, 2_000],
    )
    .await;
    let (mut ws, _inv) = common::connect_and_capture_inventory(&url).await;

    let create_request_id = "req-e2e-grace-resume";
    let old_tid = create_codex_terminal(&mut ws, create_request_id).await;

    // Poll for the shim marker (crash imminent), then upsert INSIDE the
    // grace: query#1 happens at the shim's exit (~marker+1.2s); the upsert
    // lands at ~marker+1.45s — inside the first 2s grace step with ~1.75s
    // of headroom both directions against ordinary load skew.
    let marker_seen = {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !marker.exists() {
            assert!(std::time::Instant::now() < deadline, "shim marker never appeared");
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        tokio::time::Instant::now()
    };
    tokio::time::sleep_until(
        marker_seen + Duration::from_millis(1_200) + Duration::from_millis(250),
    )
    .await;
    // NoIndexProbe::default() -> Unknown for codex -> respawn gate fails
    // open (resume_validation passthrough), so this fabricated thread id is
    // sufficient — the same authority the locator-adoption path upserts.
    state.identity.upsert(&old_tid, Some("codex"), Some("thread-grace-1"), None, now_ms());

    // Engagement proof (the anti-vacuity gate): the hub logged grace entry
    // for THIS terminal. A pathological stall that let the upsert beat
    // query#1 makes THIS assertion fail loudly — never a silent green.
    {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            let found = {
                let evs = events.lock().expect("capture lock");
                evs[capture_start..].iter().any(|e| {
                    e.message.contains("identity_grace_entered")
                        && e.fields.get("terminal_id").map(|v| v.contains(&old_tid)).unwrap_or(false)
                })
            };
            if found { break; }
            assert!(std::time::Instant::now() < deadline, "grace-entry log never captured for {old_tid}");
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    wait_recovered_or_fail_on_exited(
        &mut ws,
        &old_tid,
        tokio::time::Instant::now() + common::FRAME_BUDGET,
    )
    .await;
    assert_no_exited_settle_for(&mut ws, &old_tid, Duration::from_millis(500)).await;
}

/// Local millisecond clock (mirror of resume_validation_gate.rs:79);
/// freshell_ws::terminal::now_ms is pub(crate), unreachable from tests.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("wall clock")
        .as_millis() as i64
}
```

Test (ii) — grace exhaustion (the loud-settle regression contract):

```rust
/// Grace exhaustion: identity never resolves — the SAME loud settle frame
/// as pre-grace behavior, bounded-late. The pre-boundary negative window
/// fails RED if the fix regresses to an immediate settle.
#[tokio::test(flavor = "multi_thread")]
#[cfg(unix)]
async fn crash_with_identity_never_arriving_settles_exited_after_grace() {
    let marker = std::env::temp_dir().join(format!(
        "freshell-e2e-grace-exhaust-marker-{}.txt",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&marker);
    let (url, _registry, _state) = common::spawn_server_with_specs_hub_and_state(
        vec![crash_once_codex_spec(&marker)],
        vec![50, 100],
        vec![2_000, 2_000],
    )
    .await;
    let (mut ws, _inv) = common::connect_and_capture_inventory(&url).await;

    let create_request_id = "req-e2e-grace-exhaust";
    let old_tid = create_codex_terminal(&mut ws, create_request_id).await;

    // Pre-boundary negative: with a 2s+2s grace and the shim's 1.2s exit
    // sleep, no legal settle can exist inside the first 2s after create.
    // An immediate-settle regression is caught here, not just "eventually".
    assert_no_exited_settle_for(&mut ws, &old_tid, Duration::from_millis(2_000)).await;

    wait_frame_matching(
        &mut ws,
        "terminal.status{status:exited, reason:no_resumable_identity}",
        tokio::time::Instant::now() + common::FRAME_BUDGET,
        |v| {
            v["type"] == "terminal.status"
                && v["status"] == "exited"
                && v["reason"] == "no_resumable_identity"
                && v["terminalId"] == old_tid
        },
    )
    .await;
}
```

- [ ] **Step 3: Verify intended failure shape (vacuity check) + focused run**

The grace-success test cannot go RED in the classic order here (Task 1 already landed the fix), so verify non-vacuity empirically instead: temporarily edit the harness call in THIS test only to pass grace `vec![]`, run the test, expect FAIL (no replaced; an immediate exited settle fails the waiter). Restore `vec![2_000, 2_000]`. Record the vacuity-check output in the task commit message body.

Run: `cargo test -p freshell-ws --test auto_resume_e2e crash_with_identity`

Expected: PASS with the restored schedule.

- [ ] **Step 4: Run the full binary**

Run: `cargo test -p freshell-ws --test auto_resume_e2e`

Expected: PASS — both new tests plus both pre-existing claude tests and both `#[should_panic]` ring-pin tests.

- [ ] **Step 5: Refactor while green**

None planned beyond keeping the two tests self-contained for readability (repo test style).

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-ws --test auto_resume_e2e --test restore_spawn_gate` AND `cargo test -p freshell-ws auto_resume` (lib)

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ws/tests/auto_resume_e2e.rs crates/freshell-ws/tests/common/mod.rs
git commit -m "test(auto-resume): e2e pins for identity grace (success-in-grace + loud exhaustion)"
```

---

### Task 3: Delete the waiver classifier and scrub references

**Files:**
- Delete: `scripts/classify-resume-waiver.ts`
- Delete: `test/unit/scripts/classify-resume-waiver.test.ts`
- Modify: `crates/freshell-ws/tests/auto_resume_e2e.rs` (comment-only scrub — classifier mentions around the ring comments; ring and assertions untouched)
- Modify: `docs/plans/2026-09-02-test-flake-hardening.md` (supersede note at the top; mark Task 2 Step 6's certification-loop snippet superseded by "any FAIL blocks"; addition #5's "follow-up task" now references kmbs as FIXED by this plan)
- Modify: `docs/plans/2026-07-27-agent-crash-resilience.md` (the D-5 "correct degraded behavior" note → superseded-by-grace one-liner)

**Interfaces:** none beyond Task 1/2 having landed (the classifier is only safe to delete BECAUSE the defect no longer produces the waived shape).

- [ ] **Step 1: Deletion pre-check (read-only)**

Run: `grep -rn "classify-resume-waiver\|classifyResumeWaiver" --exclude-dir=node_modules --exclude-dir=target --exclude-dir=.git --exclude-dir=.worktrees . | grep -v "/docs/plans/"`

Expected: hits ONLY in `scripts/classify-resume-waiver.ts`, `test/unit/scripts/classify-resume-waiver.test.ts`, and the auto_resume_e2e.rs comments. (`docs/plans/` is excluded by design: historical plans may keep the tokens as ORIGINAL narrative — including THIS plan and the flake-hardening plan; the supersede notes explain the removal.)

- [ ] **Step 2: Delete + scrub + supersede notes**

```bash
git rm scripts/classify-resume-waiver.ts test/unit/scripts/classify-resume-waiver.test.ts
```

Scrub: remove classifier/waiver sentences from the ring's doc comment block in auto_resume_e2e.rs (keep every field enumeration and every assertion). Supersede notes: one line each, dated, referencing kata kmbs and this plan.

- [ ] **Step 3: Verify zero residue + unit lane green**

Run: the same grep as Step 1 — expected NO output. Then: `npm run test:vitest -- run test/unit/scripts --config config/vitest/vitest.config.ts` — expected PASS with amplifier-backfill-bundle.test.ts still present and green, and `classify-resume-waiver` absent from its output (note: test/unit/scripts is NOT emptied by the deletion — amplifier-backfill-bundle.test.ts remains).

- [ ] **Step 4: Run impacted-test verification**

Run: `npm run test:unit` AND `cargo test -p freshell-ws --test auto_resume_e2e`

Expected: PASS (comment-only rust change cannot shift behavior).

- [ ] **Step 5: Commit the task**

```bash
git add scripts/classify-resume-waiver.ts test/unit/scripts/classify-resume-waiver.test.ts crates/freshell-ws/tests/auto_resume_e2e.rs docs/plans/2026-09-02-test-flake-hardening.md docs/plans/2026-07-27-agent-crash-resilience.md
git commit -m "chore(tests): remove waiver classifier — mechanism-B fixed, certification strict again"
```

(Explicit pathspecs only — `git add <path>` stages the deletions for the two removed files; no broad `git add -A <dir>` in a concurrent repo.)

---

### Task 4: Strict certification campaign (waivers impossible by construction)

**Files:** none (receipts under `<logs_dir>/reports/cert/`, untracked)

- [ ] **Step 1: Campaign** — failure counts MUST aggregate; `|| echo` alone would mask ten failures:

```bash
mkdir -p /home/dan/code/freshell/.worktrees/.the-usual-logs/auto-resume-hub-grace/reports/cert
fails=""
for i in $(seq 1 10); do
  if cargo test -p freshell-ws --locked --test auto_resume_e2e \
      > "/home/dan/code/freshell/.worktrees/.the-usual-logs/auto-resume-hub-grace/reports/cert/auto-resume-run-${i}.log" 2>&1; then
    echo "run ${i}: PASS"
  else
    echo "run ${i}: FAIL"
    fails="${fails} ${i}"
  fi
done
echo "aggregate failures:${fails:-none}"
test -z "$fails"
```

Expected: ten PASS lines, aggregate `none`, exit 0. Additionally: `grep -l "no_resumable_identity" /home/dan/code/freshell/.worktrees/.the-usual-logs/auto-resume-hub-grace/reports/cert/auto-resume-run-*.log` must exit nonzero with NO output — a passing run prints no settle frames anywhere (the exhaustion test asserts on receipt silently; the string appears only in ring dumps on failure).

- [ ] **Step 2: Campaign report** — write `reports/cert/certification.md` (per-run rows + grep result); append the ledger entry to the run progress ledger.

---

## Verification summary (gate inputs)

1. Per-task: `cargo test -p freshell-ws auto_resume`, `--test auto_resume_e2e`, `--test restore_spawn_gate`, `npm run test:vitest -- run test/unit/scripts`, `npm run test:unit`.
2. Task 4 campaign: 10/10 with aggregate exit 0 + zero `no_resumable_identity` occurrences in any log.
3. Full-suite gate at end of execution: `npm test` (coordinated) + `cargo test --workspace --locked`, green excluding ledger-recorded pre-existing flakes (katas 38cm/e08g/1xyw families require base_ref reproduction receipts if they fire).
4. Grep-verified classifier absence (Task 3 Step 3).
