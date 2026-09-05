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

**Goal:** A fresh-agent pane whose identity legitimately arrives seconds after its generation crashes is auto-resumed instead of permanently dead, and the waiver classifier that existed only to tolerate that defect is deleted along with its certification passes.

**Architecture:** One bounded grace loop inserted at the single decision choke point (`run_hub_body` in `crates/freshell-ws/src/auto_resume.rs`), before the crash-context construction: when the just-queried session-ref is `None` and the arresting settle reason would be `no_resumable_identity`, sleep-and-recheck through a bounded `HubConfig.identity_grace_delays` schedule; identity arriving in grace falls through to the unchanged `decide` path (normal Resume), cancel-during-grace settles loudly, exhaustion settles `no_resumable_identity` exactly as before. Classifier removal is a two-file deletion plus a comment scrub and historical-doc supersede notes.

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
- Modify: `crates/freshell-ws/src/auto_resume.rs` (HubConfig, new const, new env fn, `run_hub_body` grace block, unit tests in the same file)
- Test: `crates/freshell-ws/src/auto_resume.rs` (module-local `#[cfg(test)]`)

**Interfaces:**
- Consumes: existing `HubConfig`, `run_hub_body`, `decide`, `AutoResumeDriver`, `FakeDriver` (same-file test module), `parse_delays_env`.
- Produces: `pub(crate) const AUTO_RESUME_DEFAULT_IDENTITY_GRACE_DELAYS_MS: [u64; 2] = [2_500, 2_500]`; `HubConfig { identity_grace_delays: Vec<u64>, .. }`; `pub(crate) fn auto_resume_identity_grace_delays() -> Vec<u64>`; grace behavior in `run_hub_body`. Task 2/3 consume none of these beyond compilation (harness injects via a new public helper in Task 2).

- [ ] **Step 1: Write the failing behavioral tests** (in `crates/freshell-ws/src/auto_resume.rs` `mod tests`)

(a) The primary RED test — identity landing mid-grace converts settle into resume:

```rust
#[tokio::test(start_paused = true)]
async fn identity_arriving_during_grace_converts_no_identity_settle_into_resume() {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let fake = FakeDriver::healthy();
    fake.set_session(None); // identity absent at crash-decision time
    let cfg = test_cfg(vec![2_000, 10_000]);
    let cfg = HubConfig { identity_grace_delays: vec![500, 500], ..cfg };
    let _hub = spawn_hub_with_driver(fake.clone(), rx, cfg);

    tx.send(crash("t1", 1, "claude", Some("cr-1"), 5_000)).unwrap();
    drain().await;
    // Grace step 1 elapses with no identity: nothing happens yet (no settle,
    // no recover) — the hub is holding the crash.
    tokio::time::advance(std::time::Duration::from_millis(500)).await;
    drain().await;
    assert!(fake.settled_frames().is_empty(), "no settle during grace");
    assert!(fake.recovering_calls().is_empty(), "no recover before identity");

    // Identity lands during grace step 2 (FakeDriver flips at the re-check).
    fake.set_session(Some(("claude".into(), "sess-1".into(), None)));
    tokio::time::advance(std::time::Duration::from_millis(500)).await;
    drain().await;
    assert_eq!(fake.recovering_calls(), vec![("t1".into(), 1u32, 2u32)]);
    // Resume arm's own backoff still applies before respawn:
    assert!(fake.respawn_calls().is_empty(), "resume backoff still respected");
    tokio::time::advance(std::time::Duration::from_millis(2_000)).await;
    drain().await;
    assert_eq!(
        fake.replaced_calls(),
        vec![("t1".into(), "t-new".into(), 1u32)]
    );
    assert!(fake.settled_frames().is_empty(), "no exited settle at all");
}
```

(b) Grace exhaustion still settles loudly (rewrite of the t2 leg's meaning — keep the existing four-event test but the t2 leg must now survive grace AND only settle after it):

```rust
#[tokio::test(start_paused = true)]
async fn no_identity_after_grace_exhaustion_settles_exited_loudly() {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let fake = FakeDriver::healthy();
    fake.set_session(None);
    let cfg = test_cfg(vec![2_000, 10_000]);
    let cfg = HubConfig { identity_grace_delays: vec![500, 500], ..cfg };
    let _hub = spawn_hub_with_driver(fake.clone(), rx, cfg);

    tx.send(crash("t2", 1, "claude", Some("cr-2"), 1_000)).unwrap();
    drain().await;
    assert!(fake.settled_frames().is_empty(), "grace must run first");
    tokio::time::advance(std::time::Duration::from_millis(1_000)).await;
    drain().await;
    assert_eq!(
        fake.settled_frames(),
        vec![("t2".to_string(), "no_resumable_identity".to_string(), None)]
    );
    assert!(fake.respawn_calls().is_empty());
}
```

(c) Grace eligibility gate — clean exit / shell mode / no create_request_id settle IMMEDIATELY (no grace sleeps):

```rust
#[tokio::test(start_paused = true)]
async fn non_identity_settles_skip_the_grace_entirely() {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let fake = FakeDriver::healthy();
    let cfg = test_cfg(vec![2_000, 10_000]);
    let cfg = HubConfig { identity_grace_delays: vec![500, 500], ..cfg };
    let _hub = spawn_hub_with_driver(fake.clone(), rx, cfg);

    tx.send(crash("t3", 0, "claude", Some("cr-3"), 1_000)).unwrap(); // clean_exit
    tx.send(crash("t4", 1, "shell", Some("cr-4"), 1_000)).unwrap();  // not_agent_mode
    drain().await; // NO time advance — settles must already have happened
    assert_eq!(
        fake.settled_frames(),
        vec![("t3".to_string(), "clean_exit".to_string(), None)],
        "shell settles silently; clean_exit settles immediately, no grace"
    );
}
```

(d) Cancel during grace settles loudly with the shared cancellation frame:

```rust
#[tokio::test(start_paused = true)]
async fn cancel_during_grace_settles_cancelled_and_skips_further_rechecks() {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let fake = FakeDriver::healthy();
    fake.set_session(None);
    let cfg = test_cfg(vec![2_000, 10_000]);
    let cfg = HubConfig { identity_grace_delays: vec![500, 500], ..cfg };
    let _hub = spawn_hub_with_driver(fake.clone(), rx, cfg);

    tx.send(crash("t5", 1, "claude", Some("cr-5"), 1_000)).unwrap();
    tokio::time::advance(std::time::Duration::from_millis(500)).await;
    drain().await;
    fake.set_cancelled("t5"); // user clicks abort mid-grace
    tokio::time::advance(std::time::Duration::from_millis(500)).await;
    drain().await;
    assert_eq!(
        fake.settled_frames(),
        vec![(
            "t5".to_string(),
            super::SETTLE_REASON_CANCELLED.to_string(),
            None
        )]
    );
    // Identity appearing after the cancel must NOT resurrect anything:
    fake.set_session(Some(("claude".into(), "sess-1".into(), None)));
    tokio::time::advance(std::time::Duration::from_millis(5_000)).await;
    drain().await;
    assert!(fake.recovering_calls().is_empty());
    assert!(fake.respawn_calls().is_empty());
}
```

```bash
cargo test -p freshell-ws --lib auto_resume::tests -- --nocapture
```

- [ ] **Step 2: Run the tests and verify the intended failures**

Run: `cargo test -p freshell-ws --lib auto_resume::tests::identity_arriving_during_grace_converts_no_identity_settle_into_resume auto_resume::tests::cancel_during_grace_settles_cancelled_and_skips_further_rechecks`

Expected: FAIL because `run_hub_body` has no grace — (a) lacks the struct field `identity_grace_delays` (compile failure, which is the RED for compile-driven Ts) and the no-identity crash settles immediately with no recovery frames. The (b)/(c) tests as written must initially FAIL on the struct-field compile too; that is the intended RED. After the field exists but before the loop does, (a) must fail on `recovering_calls` empty instead of `vec![...attempt 1...]` and (d) must fail on the cancelled-frames assertion.

- [ ] **Step 3: Add the minimal production implementation**

In `crates/freshell-ws/src/auto_resume.rs`:

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

(ii) `HubConfig` gains the field + `from_env` populates it; new env fn reusing `parse_delays_env`:

```rust
pub(crate) struct HubConfig {
    pub delays: Vec<u64>,
    pub identity_grace_delays: Vec<u64>,
    pub healthy_lifetime_ms: i64,
    pub max_cycles: u32,
    pub cycle_window_ms: i64,
}
// in from_env: identity_grace_delays: auto_resume_identity_grace_delays(),

/// `FRESHELL_AUTO_RESUME_IDENTITY_GRACE_MS="2500,2500"` — same CSV parser
/// as the resume backoff (`parse_delays_env`); zero/invalid values fall
/// back loudly; an explicit empty string DISABLES the grace. Tests inject
/// via `HubConfig` directly (in-process env writes would leak across
/// parallel tests).
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

(iii) New public harness helper next to `spawn_auto_resume_hub_with_delays` (which keeps its signature and delegates):

```rust
/// [`spawn_auto_resume_hub`] with an explicit full [`HubConfig`] — the
/// harness needs to inject the identity-grace schedule as well as the
/// backoff, and `HubConfig::from_env()` would read process-global env.
pub fn spawn_auto_resume_hub_with_config(
    state: crate::WsState,
    rx: tokio::sync::mpsc::UnboundedReceiver<CrashEvent>,
    config: HubConfig,
) -> tokio::task::JoinHandle<()> {
    spawn_hub_with_driver(WsAutoResumeDriver { state }, rx, config)
}
```
(`HubConfig` must become visible to the public fn's signature: make it `pub` — it is currently `pub(crate)`; minimal visibility bump, documented as harness-facing.)

(iv) The grace block at the top of the `while let Some(ev) = rx.recv().await` loop, immediately after the existing first `let sref = ...;` line and before the cycle-pruning/`now` construction:

```rust
            let mut sref = driver.resumable_session_ref(&ev.terminal_id);
            // Identity grace (kata kmbs): `no_resumable_identity` used to be
            // a one-shot, never-reconsidered settle — a permanently dead pane
            // when identity legitimately landed seconds later (locator
            // adoption windows and load-race upsert lag). Re-check here, at
            // the single decision choke point, through a BOUNDED schedule
            // before deciding: identity arriving in grace converts the settle
            // into the normal Resume path with zero special-casing below.
            // Skipped entirely unless no_resumable_identity is the reason
            // decide WOULD settle on — same predicate order as `decide`:
            // clean_exit and not_agent_mode and no_create_request_id must
            // settle immediately, grace-free.
            if sref.is_none()
                && ev.exit_code != 0
                && AUTO_RESUME_MODES.contains(&ev.mode.as_str())
                && ev.create_request_id.is_some()
            {
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
                        tracing::info!(
                            terminal_id = %ev.terminal_id,
                            "terminal.auto_resume.identity_grace_resolved"
                        );
                        break;
                    }
                }
            }
```

Add the `'events:` label on the outer `while let` loop. Existing code below is untouched (the grace fall-through uses the same `sref` via the `mut` binding — update the original declaration to `let mut sref = ...` as shown).

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-ws --lib auto_resume::tests`

Expected: PASS (new four + all pre-existing module tests, including the rewritten-in-meaning multi-event test — its t2 leg asserts the same frames but now only after time advances; if `start_paused` auto-advance quirk makes the old t2 leg pass without changes, leave the assertions verbatim; otherwise advance past the test's grace before asserting).

- [ ] **Step 5: Refactor while green**

- Delete the redundant `no_identity` arm of the old `missing_identity_settles_exited_immediately` unit test only if the new (b) test covers both the `decide`-level assertion AND the loop-level behavior; keep the `decide()`-level pin `no_resumable_identity` decide output (it tests the pure fn in isolation — KEEP it, grace is in the loop not in `decide`). Do NOT change `decide` semantics.
- Deduplicate the grace-eligibility predicate if it shares shape with `decide`'s early arms — extract a tiny helper `fn grace_applies(ev: &CrashEvent, sref: &Option<...>) -> bool` ONLY if it reads cleaner; the inline comment must keep the predicate-order note.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-ws auto_resume` (lib unit tests) and `cargo test -p freshell-ws --test auto_resume_e2e` (e2e — real-time hub behavior; the crashing-claude tests must still pass with grace present because their identity is pre-allocated and present).

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ws/src/auto_resume.rs
git commit -m "fix(auto-resume): bounded identity grace replaces one-shot no_resumable_identity settle (kata kmbs)"
```

---

### Task 2: E2e pins — grace success + grace exhaustion over the real WS surface

**Files:**
- Test/Modify: `crates/freshell-ws/tests/auto_resume_e2e.rs`
- Modify: `crates/freshell-ws/tests/common/mod.rs` (harness helpers)

**Interfaces:**
- Consumes: Task 1's `HubConfig`/`spawn_auto_resume_hub_with_config` (via the new harness helper), existing `wait_frame_matching`, `connect_and_capture_inventory`, `create_claude_terminal`-style helpers, `WsState.identity`.
- Produces: `spawn_server_with_specs_hub_and_state(cli_commands, delays, identity_grace_delays) -> (String, TerminalRegistry, WsState)` in tests/common/mod.rs; two new e2e tests in auto_resume_e2e.rs.

- [ ] **Step 1: Harness helper** (tests/common/mod.rs)

Extend the hub-spawn helper family WITHOUT changing `spawn_server_with_specs_and_auto_resume_hub`'s existing callers' behavior: add

```rust
/// `spawn_server_with_specs_and_auto_resume_hub` that ALSO returns the
/// `WsState` clone and accepts the identity-grace schedule (kata kmbs e2e:
/// tests must upsert identity directly and control grace timing).
pub async fn spawn_server_with_specs_hub_and_state(
    cli_commands: Vec<freshell_platform::CliCommandSpec>,
    delays: Vec<u64>,
    identity_grace_delays: Vec<u64>,
) -> (String, freshell_terminal::TerminalRegistry, WsState) {
    // Same body as spawn_server_with_specs_and_auto_resume_hub up to the hub
    // spawn, then:
    //   let hub_cfg = freshell_ws::auto_resume::HubConfig {
    //       delays,
    //       identity_grace_delays,
    //       ..freshell_ws::auto_resume::HubConfig::from_env()
    //   };
    //   freshell_ws::auto_resume::spawn_auto_resume_hub_with_config(state.clone(), auto_resume_rx, hub_cfg);
    // ...and return (url, registry, state.clone()).
}
```
Note for the implementer: `WsState` in tests/common/mod.rs is already imported (the existing helper builds one); keep the existing `spawn_server_with_specs_and_auto_resume_hub` delegating to this new helper with a default harness grace of `vec![25, 25]` so ALL hub-harness tests exercise the grace path cheaply.

- [ ] **Step 2: Write the failing behavioral tests** (auto_resume_e2e.rs)

(i) Grace success — a codex-mode pane crashes; identity lands within grace via direct registry upsert; assert recovering + replaced arrive and NO exited/no_resumable_identity settle ever names that terminal. Evidence footnote for why the fake thread id survives respawn validation: the harness wires `session_existence: NoIndexProbe::default()` (tests/common/mod.rs), whose `exists_for_gate` answers `Unknown` for all four known providers, and `evaluate_resume_gate` fails OPEN on Unknown (resume_validation.rs passthrough) — the shim then ignores argv.

```rust
/// Mechanism-B regression pin (kata kmbs): identity landing DURING the grace
/// window converts the no_resumable_identity settle into a normal resume.
#[tokio::test(flavor = "multi_thread")]
#[cfg(unix)]
async fn crash_with_identity_arriving_during_grace_is_resumed() {
    let (url, _registry, state) = common::spawn_server_with_specs_hub_and_state(
        vec![crash_once_codex_spec(&std::env::temp_dir().join(format!(
            "freshell-e2e-grace-resume-marker-{}.txt",
            std::process::id()
        )))],
        vec![50, 100],
        vec![2_000, 2_000],
    )
    .await;
    let (mut ws, _inv) = common::connect_and_capture_inventory(&url).await;

    let create_request_id = "req-e2e-grace-resume";
    let old_tid = create_codex_terminal(&mut ws, create_request_id).await;
    // Harness has no codex locator: identity is genuinely absent at the
    // crash-decision instant (the mechanism-B precondition).

    // Identity lands inside the grace window (mimics locator-adoption lag).
    // NoIndexProbe::default() -> Unknown for codex -> the respawn gate fails
    // open, so this fabricated thread id is enough (same authority the
    // locator-adoption path writes with).
    let tid_for_upsert = old_tid.clone();
    let state_for_upsert = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(1_000)).await;
        state_for_upsert.identity.upsert(
            &tid_for_upsert,
            Some("codex"),
            Some("thread-grace-1"),
            None,
            now_ms(),
        );
    });

    // The crash shim exits on first spawn; the hub sees no identity at
    // decision time and must hold the crash in grace, then resume.
    wait_frame_matching(
        &mut ws, "terminal.replaced", tokio::time::Instant::now() + common::FRAME_BUDGET,
        |v| {
            v["type"] == "terminal.replaced"
                && v["oldTerminalId"] == old_tid
        },
    ).await;

    // Explicit negative assertion (NOT a silent sleep): fail if any
    // exited settle names old_tid while the recovered pane is healthy.
    assert_no_exited_settle_for(&mut ws, &old_tid, Duration::from_millis(1_500)).await;
}

/// Local millisecond clock helper (mirror of resume_validation_gate.rs:79);
/// `freshell_ws::terminal::now_ms` is `pub(crate)`, unreachable from tests.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("wall clock")
        .as_millis() as i64
}
```

(ii) Grace exhaustion — same shape but identity NEVER arrives; the terminal must settle exited/no_resumable_identity after the grace (replaces the historical "dead pane" as the correct behavior):

```rust
/// Grace exhaustion: identity never resolves — the settle is the SAME loud
/// frame as the pre-grace behavior, just bounded-late.
#[tokio::test(flavor = "multi_thread")]
#[cfg(unix)]
async fn crash_with_identity_never_arriving_settles_exited_after_grace() {
    let (url, _registry, _state) = common::spawn_server_with_specs_hub_and_state(
        vec![crash_once_codex_spec(&std::env::temp_dir().join(format!(
            "freshell-e2e-grace-exhaust-marker-{}.txt",
            std::process::id()
        )))],
        vec![50, 100],
        vec![2_000, 2_000],
    )
    .await;
    let (mut ws, _inv) = common::connect_and_capture_inventory(&url).await;

    let create_request_id = "req-e2e-grace-exhaust";
    let old_tid = create_codex_terminal(&mut ws, create_request_id).await;

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
    ).await;
}
```

Supporting spec helper in the same file (mirror `crash_once_claude_spec`, but spec `name: "codex"`, NO `create_session_args` — codex has no preallocation path — and resume args carried so the respawn can spawn the same shim):

```rust
/// Codex-mode crash-once shim (marker-file pattern identical to
/// `crash_once_claude_spec` — the caller passes a PER-TEST marker path,
/// because tests in one binary share `std::process::id()`): first
/// invocation exits 1, respawned generation (`exec sleep 30`) survives for
/// the assertion window. Codex carries no preallocated sessionRef (no
/// create_session_args), so the harness identity registry starts EMPTY for
/// the created terminal — the mechanism-B precondition constructed
/// deterministically. Shuffle-shape follows `codex_cli_spec` in
/// codex_session_ref_resume.rs (`resume_args: ["resume", "{{sessionId}}"]`).
fn crash_once_codex_spec(marker: &std::path::Path) -> freshell_platform::CliCommandSpec {
    let script_path = std::env::temp_dir().join(format!(
        "freshell-auto-resume-e2e-grace-shim-{}-{}.sh",
        std::process::id(),
        marker
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("m")
    ));
    let script = format!(
        "#!/bin/sh\nif [ -e \"{marker}\" ]; then exec sleep 30; fi\n: > \"{marker}\"\nexit 1\n",
        marker = marker.display()
    );
    write_executable(&script_path, &script);
    freshell_platform::CliCommandSpec {
        name: "codex".to_string(),
        label: "codex-grace-label".to_string(),
        env_var: None,
        default_cmd: script_path.to_string_lossy().to_string(),
        base_args: vec![],
        base_env: std::collections::BTreeMap::new(),
        resume_args: Some(vec!["resume".to_string(), "{{sessionId}}".to_string()]),
        create_session_args: None,
        model_args: None,
        sandbox_args: None,
        permission_mode_args: None,
    }
}

/// Fresh codex `terminal.create` — like `create_claude_terminal` but codex
/// carries NO preallocated sessionRef, so only the terminalId is returned.
async fn create_codex_terminal(ws: &mut common::TestWs, request_id: &str) -> String {
    let create = serde_json::json!({
        "type": "terminal.create",
        "requestId": request_id,
        "mode": "codex",
        "shell": "system",
        "cwd": std::env::temp_dir().to_string_lossy(),
    });
    ws.send(WsMessage::Text(create.to_string()))
        .await
        .expect("send terminal.create");
    let created = next_frame_of_type(ws, "terminal.created").await;
    created["terminalId"]
        .as_str()
        .expect("terminal.created carries terminalId")
        .to_string()
}

/// Explicit negative assertion: read frames for `dur`; FAIL the test (with
/// the offending frame quoted) if any terminal.status{exited} names `tid`.
/// This is NOT a silent sleep — it consumes and inspects every frame in the
/// window.
async fn assert_no_exited_settle_for(ws: &mut common::TestWs, tid: &str, dur: Duration) {
    let end = tokio::time::Instant::now() + dur;
    while let Ok(Some(Ok(WsMessage::Text(text)))) =
        tokio::time::timeout_at(end, ws.next()).await
    {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            assert!(
                !(v["type"] == "terminal.status"
                    && v["status"] == "exited"
                    && v["terminalId"] == tid),
                "unexpected exited settle for {tid}: {text}"
            );
        }
    }
}
```


Run: `cargo test -p freshell-ws --test auto_resume_e2e crash_with_identity`

- [ ] **Step 3: Run the tests and verify the intended failure… is not applicable post-Task-1 (behavior present); instead verify REASONS**

Expected: If Task 1 is in place, both new tests PASS. To prove they are not vacuous, the implementer MUST temporarily set the harness grace to empty (`vec![]`) in one local run and confirm BOTH tests fail (success test times out waiting for `terminal.replaced`; exhaustion test instead passes vacuously-fast — so the vacuity check belongs to the success test), then restore `vec![2_000, 2_000]`. Record the vacuity check output in the task commit message body.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-ws --test auto_resume_e2e`

Expected: PASS — including the two pre-existing `#[should_panic]` ring-pin tests and both claude-driven tests (their identities are preallocated, so grace never engages for them).

- [ ] **Step 5: Refactor while green**

Lift the duplicated "create → crash-shim → wait" scaffolding only if the two new tests share >10 identical lines with the existing reconcile test; otherwise keep tests self-contained (repo test style favors readability).

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-ws --test auto_resume_e2e --test restore_spawn_gate` and `cargo test -p freshell-ws auto_resume` (lib)

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
- Modify: `crates/freshell-ws/tests/auto_resume_e2e.rs` (comment-only scrub at ~:126-128 and ~:155-157 — classifer mentions; ring and assertions untouched)
- Modify: `docs/plans/2026-09-02-test-flake-hardening.md` (one-line supersede note at top of the additions section; mark the certification-loop snippet (Task 2 Step 6 :387-426) as superseded by "any FAIL blocks"; amend addition #5's "deferred to a follow-up task" to "fixed by auto-resume-hub-grace")
- Modify: `docs/plans/2026-07-27-agent-crash-resilience.md:73` (the D-5 "correct degraded behavior" note → superseded-by-grace one-liner)

**Interfaces:**
- Consumes: none beyond Task 1/2 having landed (the classifier is only safe to delete BECAUSE the defect no longer produces the waived shape).
- Produces: zero repo references to `classify-resume-waiver` / `classifyResumeWaiver` outside historical narrative.

- [ ] **Step 1: Deletion pre-check (read-only)**

Run: `grep -rn "classify-resume-waiver\|classifyResumeWaiver" --exclude-dir=node_modules --exclude-dir=target --exclude-dir=.git .`

Expected: hits ONLY in the four Modify/Delete files listed above (plus ignorable untracked logs under `.worktrees/.the-usual-logs/`).

- [ ] **Step 2: Delete + scrub + supersede notes**

```bash
git rm scripts/classify-resume-waiver.ts test/unit/scripts/classify-resume-waiver.test.ts
```

Comment scrub in `auto_resume_e2e.rs`: remove the sentences that name the classifier/waiver from the ring comment and the deflake doc comment; KEEP every field enumeration (`tid`/`oldTid`/`newTid`/...) and every assertion. Supersede notes (one line each, dated, referencing kata kmbs and this plan).

- [ ] **Step 3: Verify zero residue + unit lane green**

Run: `grep -rn "classify-resume-waiver\|classifyResumeWaiver" --exclude-dir=node_modules --exclude-dir=target --exclude-dir=.git --exclude-dir=.worktrees .` → expect NO output. Then `npm run test:vitest -- run test/unit/scripts --config config/vitest/vitest.config.ts` → expect "no test files found"-class pass with exit 0 (dir now empty), plus `npm run test:vitest -- run test/unit/config --config config/vitest/vitest.config.ts` PASS (config sanitization lane unaffected).

- [ ] **Step 4: Run impacted-test verification**

Run: `npm run test:unit` (scripts lane removal) and `cargo test -p freshell-ws --test auto_resume_e2e` (comment-only change must not shift behavior)

Expected: PASS

- [ ] **Step 5: Commit the task**

```bash
git add -A scripts/classify-resume-waiver.ts test/unit/scripts/classify-resume-waiver.test.ts crates/freshell-ws/tests/auto_resume_e2e.rs docs/plans/2026-09-02-test-flake-hardening.md docs/plans/2026-07-27-agent-crash-resilience.md
git commit -m "chore(tests): remove waiver classifier — mechanism-B is fixed, certification is strict again"
```

---

### Task 4: Strict certification campaign (waivers impossible by construction)

**Files:**
- No source changes. Artifacts under `<logs_dir>/reports/` only (untracked):

**Interfaces:**
- Consumes: Tasks 1-3. Produces: certification receipts cited in the recap.

- [ ] **Step 1: Campaign**

Run (from the worktree, sequential to bound load):

```bash
mkdir -p /home/dan/code/freshell/.worktrees/.the-usual-logs/auto-resume-hub-grace/reports/cert
for i in $(seq 1 10); do
  cargo test -p freshell-ws --locked --test auto_resume_e2e \
    > "/home/dan/code/freshell/.worktrees/.the-usual-logs/auto-resume-hub-grace/reports/cert/auto-resume-run-${i}.log" 2>&1 \
    || echo "FAIL run ${i}"
done
```

Expected: 10/10 pass, zero waiver-looking settle frames. Verification step greps every log: no occurrence of `no_resumable_identity` EXCEPT inside the exhaustion test's own successful execution (which asserts the frame matches expectation). The grep rule: any run whose log contains `no_resumable_identity` but whose exhaustion test did not pass is a certification failure.

- [ ] **Step 2: Campaign report**

Write `reports/cert/certification.md`: 10 rows (run, pass/fail, duration, grace frames observed). Append ledger entry to the run's progress ledger.

---

## Verification summary (gate inputs)

1. `cargo test -p freshell-ws auto_resume` + `--test auto_resume_e2e` (per-task).
2. Task 4 campaign 10/10.
3. Repo-wide full-suite gate at end of execution per executing-plans: `npm test` (coordinated) + `cargo test --workspace --locked`, green excluding ledger-recorded pre-existing flakes (katas 38cm/e08g/1xyw families, if they fire, need base_ref reproduction receipts).
4. Grep-verified classifier absence.
