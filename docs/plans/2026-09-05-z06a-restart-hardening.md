# Resumable-pane restart hardening (review-11) Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Finish and land the resumable-pane restart feature (from `feat/restart-resumable-pane` @ `1d591b723`, merged onto this owner branch at `b5ad0d469`) by fixing the eight review-11 findings plus the terminal restart-retirement tombstone leak, with fresh no-context whole-delta review returning PASS. Kata freshell#z06a.

Fix list (required fixes from review 11):
1. Graceful shutdown must own, stop, and join every live explicit restart transaction before provider/terminal cleanup. Replacement creation must reject shutdown. Claude/Codex quarantine maps must be drained through confirmed process-tree termination.
2. The server-owned recovery driver must wake for retryable pending rows created during normal runtime, not only rows loaded at boot, and must recover independently of browser survival.
3. Treat rename-success followed by parent-directory-fsync failure as an indeterminate durable commit. Disk and memory state must remain fail-closed and recoveryPending must stay true.
4. Do not advertise/allow restart where persisted replacement-fence recovery cannot succeed. Implement platform-specific ownership recovery or gate capability and preflight on supported platforms.
5. Linux ownership scanning must not silently skip unreadable `/proc/*/environ`. An incomplete scan is indeterminate and must fail closed so recovery cannot create a second writer.
6. Bound restart ingress before spawning tasks or allocating locks: message/string sizes, per-session/global queued restart work, pending durable rows, and persisted fingerprint/result bytes. Overload must return a typed failure without growing the journal unboundedly.
7. Separate active restart plans from bounded retired/replay caches. Never evict an active terminal/Claude/Codex plan. Remove OpenCode preflight plans on every recovery terminal outcome so capacity cannot leak.
8. Keep live runtime ownership descriptors pinned separately from the 1,024-entry retired/history cache so active terminal output can always be enriched and delivered.

Also: clean up the terminal restart-retirement tombstone leak identified by the backend subreview: consume/remove tombstones after the queued crash event is suppressed and bound abandoned entries.

Acceptance evidence required: red/green/refactor regression tests for every item (hard shutdown races, unreadable process ownership, post-rename fsync ambiguity, browserless live recovery, overload/backpressure, active-plan capacity, OpenCode recovery cleanup, and more than 1,024 live/runtime-history transitions without dropped active output); Rust-only production backend changes (Node backend untouched); coordinated `npm run check`, strict all-target/all-feature Rust Clippy, cargo fmt, diff check, focused Rust lifecycle/restart suites, and a canonical-launcher Chromium smoke on a non-3002 scratch port all pass; the pre-existing successful Codex-kill fixture hang is addressed; fresh no-context direct whole-delta review returns PASS after the fixes.

### Explicit constraints
- Rust backend and existing TypeScript client only. Do not add Node backend behavior.
- Preserve delivered UX: supported resumable panes show Restart; only the selected runtime is replaced; shared viewers follow it; unrelated panes remain untouched; unsupported/custom panes retain Refresh; duplicate sessions focus the existing pane; Open all opens only missing sessions.
- Commit changes on the feature branch (here: the owner branch `darkforge/z06a-20260826-072716`, which carries the feature merge). Push is allowed; do not create a PR without explicit approval.
- Never restart the live production server (ports 3001/3002) without explicit APPROVED.
- Red/Green/Refactor TDD for every change; no test skips, no coverage reduction.

### Accepted tradeoffs and residuals
- Baseline exception: `freshell-qa.sh` exits 1 at base with 4 pre-existing vitest failures (FreshAgentView 429-backoff snapshot test; three `vite-config getNetworkHost` tests). Gate passes when a run's parsed failure identities are a subset of that baseline.
- The `freshagent_session_lease` destructive suite (5 host failures pre-existing, also failing on pure `1d591b723`) requires the disposable sandbox and is out of scope for host runs.
- Non-Linux platforms keep fail-closed behavior; restart capability becomes Linux-gated (production is Linux-only). Per-kind exceptions (freshopencode's platform-independent remote-abort lane) are deferred behind the gate rather than carved out on the wire in this iteration.

**Goal:** Land the resumable-pane restart feature with all review-11 hardening fixes so restart transactions are fail-closed under shutdown, crash, durability, and overload hazards.

**Architecture:** Server-side Rust restart machinery (`RestartCoordinator` in `crates/freshell-ws/src/restart.rs` plus the fresh-agent providers in `crates/freshell-freshagent/`) gains: a shutdown-interlocked in-flight transaction registry and quarantine drains (fix 1); an always-on recovery driver with a `Notify` wake channel (fix 2); an explicit three-outcome durable-commit contract on the journal write path (fix 3); Linux-gated restart capability with a fail-closed `/proc` ownership scanner (fixes 4+5); door-level ingress bounds with typed overload failures (fix 6); an always-retained active-plan set with terminal-outcome cleanup (fix 7); and live-descriptor pinning split from the bounded retired/history cache (fix 8), plus consume-on-suppress tombstones.

**Tech Stack:** Rust (tokio, workspace crates `freshell-ws`, `freshell-server`, `freshell-freshagent`, `freshell-codex`, `freshell-terminal`, `freshell-protocol`), cargo test; TypeScript React client (vitest); repo gates: `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check`, `npm run check`.

## Global Constraints

- Worktree-fixed: all work in `/home/dan/.local/state/darkforge/freshell-fb808e79f4/worktrees/z06a` on branch `darkforge/z06a-20260826-072716`. Never create/switch/remove worktrees or branches.
- Production servers on ports 3001 and 3002 must not be restarted; scratch ports only for smoke (allowed range excludes 3001/3002; use e.g. 3499+ free ports).
- Node backend (`server/`) untouched. Client changes limited to `src/` (menu gating) and TS tests.
- Process-kill fixtures run under the repo sandbox (`scripts/sandbox-test.sh`) per `docs/development/test-sandbox.md` and AGENTS.md; focused suites that only kill their own spawned children run in-process as the existing tests do (the existing `freshell-codex transport` barrier tests are the precedent).
- Commit each task with a focused conventional message; `git add` exact files only.
- Server uses NodeNext/ESM conventions for TS where applicable; Rust is the authority for behavior.
- Do not edit `docs/plans/2026-09-05-z06a-restart-hardening.md` during execution except as explicitly noted (plan prose stays historical; code is not backported).

---

### Task 1: Codex restart-kill lease-binding policy fix + panic-safe condvar fixture

**Why first:** the pre-existing in-suite hang (`incomplete_codex_restart_retirement_is_quarantined_for_same_runtime_retry`, `crates/freshell-freshagent/src/codex.rs:5812`) must be fixed before any other freshagent evidence is meaningful: the acceptance explicitly says to address this hang, and it wedges the whole `freshell-freshagent` test binary on failure. Root cause (verified by exploration): the merge brought mainline's `spawn_exit_watcher` kill arm, which calls `leases.clear_binding(PROVIDER, &thread_id)` at `codex.rs:4384` after confirmed tree death; the restart feature's policy is that only `continue_codex_restart_retirement`'s `Stopped` path (`codex.rs:2102`) releases a quarantined binding. In-suite, the watcher reliably clears the binding before the test's claim assertion at 5868, the assertion panics, the panic skips releasing a `spawn_blocking` task parked on a `Condvar` (5878-5882), and `#[tokio::test(flavor = "multi_thread")]` runtime Drop then waits forever on the un-abortable blocking task.

**Files:**
- Modify: `crates/freshell-freshagent/src/codex.rs` (struct `CodexKillRequest` at ~246; watcher kill arm ~4343-4400; `shutdown_for_restart_detailed` kill-request send ~1984-1991; `stop_codex_session` ~4316-4338; tests ~5566-5891)

**Interfaces:**
- Consumes: existing `CodexKillRequest`, `spawn_exit_watcher` kill arm, `leases.clear_binding`, `RESTART_CONSUMER_JOIN_BUDGET` (codex.rs:103).
- Produces: quarantine-membership-gated lease release in BOTH `spawn_exit_watcher` arms (kill arm + unrequested-exit arm; see LB-04 correction in Step 3); panic-safe fixture guard; green `codex::tests` module in-suite.

- [ ] **Step 1: Write the failing behavioral test**

Add a deterministic, deadlock-proof regression test in `crates/freshell-freshagent/src/codex.rs` tests module. The determinism comes from awaiting the watcher handle already stored in the quarantine entry before asserting the binding (no sleeps/races):

```rust
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn restart_quarantine_holds_lease_binding_until_retirement_completes() {
    let state = state();
    let (session_id, child_pid) = insert_fake_session(&state, "thread-restart-bind").await;
    // Claim a durable lease binding for the session, mirroring restart preflight.
    // (Load-bearing note: the real claim type is `FreshSessionClaim`, not
    // `ClaimOutcome`; mirror the exact call shape of codex.rs:5827-5837.)
    assert!(matches!(
        state.leases.claim(PROVIDER, &session_id, /* per claim API used at codex.rs:5827-5837 */),
        crate::session_lease::FreshSessionClaim::Acquired
    ));
    // Begin retirement; the quarantine path sends CodexKillRequest to the watcher.
    let outcome = state.shutdown_for_restart_detailed(/* as existing test 5859 does */).await;
    assert!(matches!(outcome, RetirementOutcome::Incomplete));
    // Join the watcher's kill arm deterministically: it already confirmed the
    // tree dead; without the fix it also cleared the binding.
    {
        let retirements = state.restart_retirements.lock().await;
        let entry = retirements.get(&session_id).expect("quarantined entry");
        if let Some(watcher) = entry.watcher_handle() {
            let _ = tokio::time::timeout(Duration::from_secs(5), watcher).await;
        }
    }
    // The fix: binding is still held until the retirement's Stopped path.
    assert!(matches!(
        state.leases.claim(PROVIDER, &session_id, ..),
        crate::session_lease::ClaimOutcome::BoundLive
    ));
}
```

Note for the implementer: reuse the exact claim-call shape from the existing test at `codex.rs:5827-5837` and the retirement-drive call shape from :5859; the only new move is joining the watcher handle via the quarantine entry before asserting. If the retirement entry does not expose a joinable watcher handle, add a test-visible accessor on `CodexRestartRetirement` (the watcher is already a `JoinHandle<bool>` captured in quarantine).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cd crates && cargo test -p freshell-freshagent --lib codex::tests::restart_quarantine_holds_lease_binding_until_retirement_completes`

Expected: FAIL because the kill arm cleared the lease binding (`claim` returns `Acquired`, not `BoundLive`); the test must not hang (bounded 5s join).

- [ ] **Step 3: Add the minimal production implementation**

**Load-bearing correction (LB-04): the kill-arm-only guard is insufficient.** The watcher has a SECOND release arm: the unrequested-exit (`child.wait()`) arm at codex.rs:4399-4423 runs a best-effort non-confirming `reap_owned_codex_sidecars` then unconditionally `leases.clear_binding` (:4404) and returns `true`. Policy fix must cover both arms, keyed on quarantine membership rather than a per-request flag:

- In `spawn_exit_watcher`, before any `leases.clear_binding(PROVIDER, &thread_id)` (both the kill arm :4384 AND the wait arm :4404), check whether the session is currently quarantined (present in `restart_retirements`, keyed by runtime id — pin the exact key by reading the insert sites :1967→1992). If quarantined: do not clear; the `Stopped` path of `continue_codex_restart_retirement` (:2102) owns the release.
- Ordering requirement (verify at implementation time; swap if needed): `shutdown_for_restart_detailed` must INSERT the quarantine entry before the `CodexKillRequest` is sent, so neither watcher arm can observe an unquarantined session mid-retirement.
- `stop_codex_session` (~4320, non-restart kill path) keeps immediate clearing (not quarantined ⇒ arms clear).

Regression coverage: the deterministic join-watcher test above PLUS a second fixture where the fake child dies naturally BEFORE the kill request lands (drives the wait arm), asserting the binding is still held (BoundLive) while quarantined.

(Extract the flag before `request.captured.send(())` consumes the request; `request` is `Ok(...)` in this arm.) Also make the existing test's `Condvar` blocker panic-safe: replace the bare `blocker` release at 5878-5882 with a drop guard:

```rust
struct ReleaseOnDrop(Arc<(Mutex<bool>, Condvar)>);
impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        let (lock, cv) = &*self.0;
        *lock.lock().unwrap() = true;
        cv.notify_all();
    }
}
```

Instantiate `let _release = ReleaseOnDrop(blocker.clone());` immediately after creating the blocker in the test, and remove the manual release (the guard subsumes it on every exit path).

- [ ] **Step 4: Run the focused test**

Run: `cd crates && cargo test -p freshell-freshagent --lib codex::tests::restart_quarantine_holds_lease_binding_until_retirement_completes`

Expected: PASS.

Then prove the hang is gone (this is the kata's mandatory evidence item — run the whole module, not just the one test, under an external timeout):

Run: `cd crates && timeout 600 cargo test -p freshell-freshagent --lib codex::tests::`

Expected: all tests PASS and the command returns inside the timeout (no wedged binary).

- [ ] **Step 5: Refactor while green**

If the drop-guard pattern is duplicated in the tests module, hoist it next to the fixture helpers (`state()` at :5071 / `insert_fake_session` at :5250). No production refactor expected.

- [ ] **Step 6: Run impacted-test verification**

Impacted: every freshagent codex test (module), plus the claude retirement tests (shared lease machinery is per-provider but the fixture pattern is shared).

Run: `cd crates && timeout 900 cargo test -p freshell-freshagent --lib`

Expected: PASS, completes within timeout.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/codex.rs
git commit -m "fix(restart): hold quarantined codex lease binding until retirement completes"
```

---

### Task 2: Fail-closed Linux ownership scanning (fix 5)

Convert the `/proc/*/environ` ownership scan into a tri-state (`Complete` / `Indeterminate`) so an incomplete scan can never be read as "quiescent", and poison the restart barrier machinery on `Indeterminate`. Empirical predicate (validated live on garageserver, Ubuntu 24.04 + yama=1): an entry whose `/proc/<pid>` directory is owned by our **euid AND egid** whose environ read fails with anything other than gone (`ENOENT`) is a real gap; other-uid/gid entries (e.g. gid-986 sandbox browsers) and pid-gone races are skipped with zero false positives on this host.

**Files:**
- Modify: `crates/freshell-codex/src/transport.rs:332-356` (`scan_owned_pids`), `:313-330` (`scan_process_group`), `:125-289` (`capture`/`capture_by_ownership`/`refresh_members`/`terminate_and_confirm`), struct fields at `:99-116`
- Modify: `crates/freshell-freshagent/src/claude.rs:2543-2567` (`reap_owned_claude_sidecars` — route through the shared scanner)
- Modify: `crates/freshell-opencode/src/transport.rs:320-345` (`reap_owned_processes` — same)
- Modify: `crates/freshell-codex/src/transport.rs:362-370` (`reap_owned_codex_sidecars` — same)
- Test: `crates/freshell-codex/src/transport.rs` unit tests (extend the `#[cfg(all(test, target_os = "linux"))]` module at :378-434)
- Test: `crates/freshell-ws/tests/restart_protocol.rs` (one integration test that a poisoned barrier blocks ambiguous-replacement quiesce)

**Interfaces:**
- Produces: `pub(crate) enum OwnershipScan { Complete(Vec<i32>), Indeterminate(ScanGap) }` with `pub(crate) struct ScanGap { pub read_dir_failed: bool, pub unusable_owned_entries: usize }` in `freshell-codex/src/transport.rs`; `OwnedProcessTreeBarrier` gains `scan_incomplete: bool` (serde `#[serde(default)]`); a test-only proc-root override `FRESHELL_OWNERSHIP_TEST_PROC_ROOT` consulted only by tests (house pattern: env-override seams, cf. `FRESHELL_FRESH_AGENT_LEASE_TTL_MS`).
- Consumes: existing barrier state machine unchanged otherwise.

**Load-bearing correction (LB-01 = falsified-as-designed, plan fixed):** every `cargo test -p freshell-codex` command in this plan carries `--features real-transport` — without it, `transport` (lib.rs:66-67) and the whole `launch_lifecycle` target (tests/launch_lifecycle.rs:13) are cfg-erased and the commands pass vacuously with zero tests (verified by `-- --list` probes: 0 unflagged / 2 flagged). The Red step must prove tests actually RUN.

- [ ] **Step 1: Write the failing behavioral tests**

Unit tests in `crates/freshell-codex/src/transport.rs` tests module:

```rust
// 1. A fake /proc root with an owned-but-unreadable environ entry must be Indeterminate.
#[cfg(target_os = "linux")]
#[test]
fn unreadable_owned_environ_makes_scan_indeterminate_not_empty() {
    let root = tempfile::tempdir().unwrap();
    let pid_dir = root.path().join("4242");
    std::fs::create_dir(&pid_dir).unwrap();
    std::fs::write(pid_dir.join("environ"), b"FRESHELL_RESTART_REPLACEMENT_ID=fence-x\0").unwrap();
    // Make the environ file unreadable even to its owner.
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(pid_dir.join("environ"), std::fs::Permissions::from_mode(0o000)).unwrap();
    let scan = scan_owned_pids_in(root.path(), "FRESHELL_RESTART_REPLACEMENT_ID", "fence-x");
    assert!(matches!(scan, OwnershipScan::Indeterminate(_)), "got {scan:?}");
}

// 2. A poisoned (Indeterminate) barrier never reports confirmed termination.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn indeterminate_scan_blocks_confirmed_termination() {
    // root with one owned-unreadable entry; capture via the injected proc root
    let barrier = /* OwnedProcessTreeBarrier with scan_incomplete = true via test ctor */;
    assert!(!barrier.terminate_and_confirm().await);
}

// 3. A complete clean scan of the fake root reports Complete with the tagged pid.
```

Implementation seam: split `scan_owned_pids` into `scan_owned_pids(env, id)` (production, real `/proc`) and `scan_owned_pids_in(root, env, id)` (test-visible). The test-local proc-root override only needs to exist behind the private `_in` function plus `cfg(test)` callers — do not add a production env knob unless integration tests in `crates/freshell-ws/tests/` need it (they do NOT for the unit-level poison tests; see Step 6 for the integration coverage choice).

**Poison lifecycle contract (load-bearing decision LB-11 = verified-decision):** a poisoned (Indeterminate-tainted) barrier forces `terminate_and_confirm()` `false` *while incomplete*; the first fully-`Complete` scan round CLEARS the poison (a Complete round rediscovers any live tagged writer, so clearing is safe); `refresh_members` never shrinks membership on an Indeterminate round; poison persists across boots via `#[serde(default)]` and can only be cleared by a Complete round, so a wedged fence recovers as soon as the host's /proc is readable again. Four unit tests pin this lifecycle (added to the Step-1 batch): (a) poisoned barrier never confirms; (b) poison → Complete-clean round → confirms; (c) poison round-trips a persisted barrier reopen; (d) refresh never shrinks on Indeterminate.

**Residual miss class (load-bearing LB-05 = acceptable, recorded):** the euid+egid `/proc/<pid>`-dir ownership screen cannot see a tagged writer that changed its own dumpable attribute (`PR_SET_DUMPABLE=0` ⇒ the dir is presented root:root, proc_pid(5)) or its gid. Verified by grep (2026-09-06): no freshell production spawn path invokes prctl/set_dumpable/setuid/setgid/pre_exec uid/gid changes, so we can never produce this class ourselves; a user CLI child self-hiding requires deliberate non-good-faith behavior, out of the declared threat model. Follow-up (not this work item): fix-4C's persisted `(pid,starttime)` primary path shrinks this residual. Sandbox gid leg (no Indeterminate storms inside the Docker sandbox) is deferred to Task 11's recorded sandbox run; WSL2 is documented as unchecked (it IS Linux /proc; acceptable).

- [ ] **Step 2: Run the tests and verify the intended failures**

Run: `cargo test -p freshell-codex --features real-transport --lib transport`

Expected: FAIL — test 1 fails because the current `continue` on unreadable environ makes the scan silently `Complete(vec![])`; tests 2-3 fail to compile (types don't exist yet), which is the intended missing-behavior failure.

- [ ] **Step 3: Add the minimal production implementation**

In `transport.rs`:

```rust
pub(crate) struct ScanGap {
    pub read_dir_failed: bool,
    pub unusable_owned_entries: usize,
}

pub(crate) enum OwnershipScan {
    Complete(Vec<i32>),
    Indeterminate(ScanGap),
}

#[cfg(target_os = "linux")]
fn scan_owned_pids_in(root: &Path, ownership_env: &str, ownership_id: &str) -> OwnershipScan {
    let mut pids = Vec::new();
    let mut gap = ScanGap { read_dir_failed: false, unusable_owned_entries: 0 };
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return OwnershipScan::Indeterminate(ScanGap { read_dir_failed: true, ..gap }),
    };
    let (euid, egid) = (unsafe { libc::geteuid() }, unsafe { libc::getegid() });
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(text) = name.to_str() else { continue };
        let Ok(pid) = text.parse::<i32>() else { continue };
        // Ownership screen: only entries owned by our euid+egid can carry our
        // tag. Use the /proc/<pid> directory's uid/gid as the owner identity.
        use std::os::unix::fs::MetadataExt;
        let Ok(meta) = entry.metadata() else { continue }; // pid-gone race: skip
        if meta.uid() != euid || meta.gid() != egid { continue; }
        match std::fs::read(entry.path().join("environ")) {
            Ok(contents) => {
                if contents
                    .split(|b| *b == 0)
                    .any(|kv| kv == format!("{ownership_env}={ownership_id}").as_bytes())
                {
                    pids.push(pid);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue, // pid gone
            Err(_) => gap.unusable_owned_entries += 1, // owned but unreadable: indeterminate
        }
    }
    if gap.read_dir_failed || gap.unusable_owned_entries > 0 {
        OwnershipScan::Indeterminate(gap)
    } else {
        OwnershipScan::Complete(pids)
    }
}
```

Barrier changes (`transport.rs:99-289`): add `scan_incomplete: bool` (`#[serde(default)]`) to the Linux variant of `OwnedProcessTreeBarrier`; `capture*` record a poisoned flag when their initial scan is `Indeterminate`; `refresh_members` keeps existing members and re-sets the flag on `Indeterminate` (never shrinks membership on an incomplete round); `terminate_and_confirm` returns `members.is_empty()` only on the last `Complete` round and forces `false` while poisoned. Log loudly on poison: `tracing::warn!(...,"agent.restart.ownership_scan_incomplete")`.

`scan_process_group` (`:313-330`): `read_dir` failure becomes `Indeterminate`; stat-read races skip.

Unify the three reaper copies onto this scanner (claude.rs:2543-2567, opencode transport :320-345, codex `reap_owned_codex_sidecars` :362-370): each calls the shared scanner and, on `Indeterminate`, logs `agent.ownership_scan.incomplete_reapers_skip` and skips signaling those candidates (fail closed). Keep the codex `reap_owned_codex_sidecars` call shape stable for its existing callers.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-codex --features real-transport --lib transport`

Expected: PASS (new tri-state tests plus the existing Linux barrier tests).

- [ ] **Step 5: Refactor while green**

Dedupe env-tag matching into one helper; ensure the pub(crate) surface stays minimal; run `cargo fmt` on touched files.

- [ ] **Step 6: Run impacted-test verification**

Impacted: freshell-codex transport + launch_lifecycle barrier consumers, freshagent claude/codex reapers, opencode transport reaper, and the restart fence path.

Run: `cargo test -p freshell-codex --features real-transport && cargo test -p freshell-ws --test restart_protocol -- persisted_spawn_fence`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-codex/src/transport.rs crates/freshell-freshagent/src/claude.rs crates/freshell-opencode/src/transport.rs
git commit -m "fix(restart): treat incomplete /proc ownership scans as indeterminate and fail closed"
```

---

### Task 3: Platform gating of restart capability + preflight (fix 4)

The replacement-fence ownership barrier (`OwnedProcessTreeBarrier`, `crates/freshell-codex/src/transport.rs:86-290`) can only prove quiescence on Linux: the non-Linux stub returns `confirmed_empty: false` forever, so a persisted replacement fence can never be quiesced there — restart must not be advertised or allowed on those platforms, and the client must fall back to Refresh. Decision (recorded; scope): one global gate — on non-Linux the whole `agentRestartV1` capability is withheld and every preflight is rejected; freshopencode's platform-independent remote-abort lane is NOT carved out in this iteration (keeps the wire shape unchanged; non-Linux is not a deployment target).

**Files:**
- Modify: `crates/freshell-ws/src/restart.rs` (new `restart_fence_recovery_supported()`, preflight gate)
- Modify: `crates/freshell-ws/src/lib.rs:766-784` (AND the gate into the `agent_restart_v1` advertisement)
- Modify: `crates/freshell-protocol/src/server_messages.rs:279-292` (new `UnsupportedPlatform` variant)
- Modify: `crates/freshell-server/src/main.rs:289-310` (loud boot log if pending rows exist on an unsupported platform)
- Modify: `src/components/context-menu/menu-defs.ts:93-109,244-266,451,511` (capability-aware lifecycle item)
- Modify: `src/components/context-menu/ContextMenuProvider.tsx` (populate the new context flag from `getServerCapabilities()`)
- Test: `crates/freshell-ws/tests/restart_platform_gate.rs` (NEW binary — env-race isolation per LB-13), `test/unit/components/context-menu/menu-defs.test.ts` (NEW), `test/e2e/pane-context-menu-stability.test.tsx` (keep green)

**Interfaces:**
- Produces: `pub fn restart_fence_recovery_supported() -> bool` (restart.rs); `AgentRestartFailureCode::UnsupportedPlatform` (wire `UNSUPPORTED_PLATFORM`); client `MenuBuildContext.agentRestartSupported: boolean`.
- Consumes: existing `getServerCapabilities()` (src/lib/ws-client.ts:649-655).

- [ ] **Step 1: Write the failing behavioral tests**

Rust (new tests in `crates/freshell-ws/tests/restart_protocol.rs`):

**Load-bearing correction (LB-13 = falsified-as-designed):** the gate env knob is process-global while 8 sibling handshake-reader sites in `restart_protocol.rs` read it implicitly under parallel scheduling. The fix is test-binary isolation: these gate tests live in a NEW integration binary `crates/freshell-ws/tests/restart_platform_gate.rs` (its own process, so no other suite ever observes the forced-off window), with a binary-local serialized env guard (LEASE_ENV_LOCK/IsolatedCodexEnv precedent, freshagent_session_lease.rs:30-69). The production gate fn reads the env var on every call; production never sets it.

```rust
// crates/freshell-ws/tests/restart_platform_gate.rs
#[tokio::test]
async fn handshake_omits_restart_advertisement_when_platform_gate_closed() {
    let _env = EnvGate::set("0"); // serialized test env lock; forces gate closed
    // Existing handshake harness pattern (see restart_protocol.rs:3355-3384):
    // connect + hello with capabilities.agentRestartV1: true, read ready frame.
    let mut ws = /* connect + hello */;
    let ready = /* read ready frame */;
    assert!(ready.capabilities.and_then(|c| c.agent_restart_v1).is_none());
}

#[tokio::test]
async fn preflight_rejects_restart_when_platform_gate_closed() {
    let _env = EnvGate::set("0");
    // Drive ProductionRestartRuntime.preflight for a supported pane (existing
    // harness pattern) and expect the typed nonretryable rejection.
    let outcome = /* preflight via coordinator execute */;
    assert!(matches!(outcome.code, AgentRestartFailureCode::UnsupportedPlatform));
    assert!(!outcome.retryable);
}
```

```rust
/// Linux is the only platform whose ownership scanning can prove a persisted
/// replacement fence safe to re-spawn (Task: fix 4). Everywhere else the
/// barrier stubs fail closed. Runtime tests force the gate closed with
/// FRESHELL_RESTART_PLATFORM_GATE=0 (serialized env lock); `=1` is ignored so
/// tests can never fabricate support on a genuinely unsupported host.
pub fn restart_fence_recovery_supported() -> bool {
    if std::env::var("FRESHELL_RESTART_PLATFORM_GATE").map(|v| v == "0").unwrap_or(false) {
        return false;
    }
    cfg!(target_os = "linux")
}
```

Client (new file `test/unit/components/context-menu/menu-defs.test.ts`):

```tsx
// buildMenuItems with a restartable pane content + agentRestartSupported: false
// must yield "Refresh pane", and with true must yield "Restart pane".
it('degrades Restart to Refresh when the server does not advertise agentRestartV1', () => {
  const items = buildMenuItems(/* pane target whose content passes resolveAgentRestartTarget */, {
    ...baseCtx, agentRestartSupported: false,
  })
  const lifecycle = items.find(i => i.id === 'refresh-pane' || i.id === 'restart-pane')
  expect(lifecycle?.id).toBe('refresh-pane')
})
it('shows Restart when content is eligible and the server advertises the capability', () => {
  const items = buildMenuItems(/* same pane target */, { ...baseCtx, agentRestartSupported: true })
  expect(items.some(i => i.id === 'restart-pane')).toBe(true)
})
```

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-ws --test restart_platform_gate` and `npm run test:vitest -- run test/unit/components/context-menu/menu-defs.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL (Rust: no gate/arm exists yet — compile-level missing; client: `agentRestartSupported` unknown to the menu builder, Restart shows regardless).

- [ ] **Step 3: Add the minimal production implementation**

1. `crates/freshell-protocol/src/server_messages.rs:279-292`: add `UnsupportedPlatform` to `AgentRestartFailureCode` (SCREAMING_SNAKE_CASE wire encoding is automatic).
2. `crates/freshell-ws/src/restart.rs`: add `restart_fence_recovery_supported()` (above); in `ProductionRestartRuntime::preflight` (restart.rs:3847) add as the FIRST statement:

```rust
if !crate::restart::restart_fence_recovery_supported() {
    return Err(RestartFailure::new(
        AgentRestartFailureCode::UnsupportedPlatform,
        "pane restart is not supported on this server's platform (restart recovery requires Linux /proc ownership scanning)",
        false,
    ));
}
```

3. `crates/freshell-ws/src/lib.rs`: where the parsed `agent_restart_v1` is passed into `build_handshake_with_capabilities` (~:778-784), pass `agent_restart_v1 && crate::restart::restart_fence_recovery_supported()` instead.
4. `crates/freshell-server/src/main.rs` (right after the coordinator is constructed at :289-307): if `!freshell_ws::restart::restart_fence_recovery_supported()` and the coordinator has pending rows, `tracing::error!(count, "agent.restart.pending_rows_platform_unsupported")` — rows remain fail-closed pending.
5. Client: add `agentRestartSupported: boolean` to `MenuBuildContext` (menu-defs.ts:93); gate the restart branch in `buildPaneLifecycleItem` (:250): `if (content && ctx.agentRestartSupported && resolveAgentRestartTarget(content))`; thread `ctx` (or just the flag) into the two call sites (:451, :511); populate in `ContextMenuProvider.tsx` from `getServerCapabilities().agentRestartV1 === true` (import from `@/lib/ws-client`).

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-ws --test restart_platform_gate` and the new menu-defs vitest file.

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Confirm no test ONLY asserts presence (add the EnvGate drop-restore so sibling tests see the real gate); run `cargo fmt`.

- [ ] **Step 6: Run impacted-test verification**

Impacted: the whole WS handshake surface, restart ingress, client menu surface.

Run: `cargo test -p freshell-ws --test restart_protocol && cargo test -p freshell-ws --test max_payload && npm run test:vitest -- run test/e2e/pane-context-menu-stability.test.tsx test/unit/client/restart-runtime-ws.test.ts test/unit/lib/pane-utils.test.ts --config config/vitest/vitest.config.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-protocol/src/server_messages.rs crates/freshell-ws/src/restart.rs crates/freshell-ws/src/lib.rs crates/freshell-server/src/main.rs src/components/context-menu/menu-defs.ts src/components/context-menu/ContextMenuProvider.tsx test/unit/components/context-menu/menu-defs.test.ts crates/freshell-ws/tests/restart_platform_gate.rs
git commit -m "feat(restart): gate restart capability and preflight to platforms with fence recovery"
```

---

### Task 4: Always-on, runtime-woken recovery driver (fix 2)

Today only three recovery triggers exist: boot pass, a backoff retry task spawned only when boot left rows pending (and which exits when drained), and browser resends (`crates/freshell-freshagent`-independent; see run report plan-recovery-journal.md). After this task the driver runs for the process lifetime, parks on a `Notify`, and is woken the moment any runtime-created retryable pending row lands — recovery no longer needs any browser. Land this before Task 5 so that Task 5's new indeterminate-retained rows are driven immediately.

**Files:**
- Modify: `crates/freshell-ws/src/restart.rs` (`RestartCoordinator` gains `recovery_notify: Arc<Notify>`; wake in `try_update_ownership`; new public driver loop relocated from main.rs)
- Modify: `crates/freshell-server/src/main.rs:1129-1143,2664-2733` (spawn unconditionally; delete moved loop)
- Modify: `crates/freshell-server/src/main.rs` tests at :3207-3654 (driver tests move/adjust)
- Test: `crates/freshell-ws/tests/restart_protocol.rs` (new wake tests with the existing fake runtimes)

**Interfaces:**
- Produces: `pub fn recovery_notify_handle(&self) -> Arc<Notify>`; `pub async fn run_restart_recovery_driver(restart: RestartCoordinator, shutdown: Arc<Notify>)` in restart.rs; coordinator-side row-count probe reuse `pending_recoveries()`.
- Consumes: existing `recover_pending_registered` (:1016-1046), `RESTART_BOOT_RECOVERY_RETRY_INITIAL/MAX` backoff constants (move to restart.rs as `RECOVERY_RETRY_INITIAL/MAX`).

**Load-bearing corrections applied to this task:**
- (LB-07 = falsified-as-sketched) The relocated driver keeps today's `shutdown_started: Arc<AtomicBool>` input and re-checks it after every select arm — `Notify::notify_waiters` stores no permit (house rule documented at net_bind.rs:12-13; the current driver re-checks at main.rs:2694-2696 for exactly this reason). The wake `Notify` is additive, not a replacement.
- (LB-08 = falsified-as-sketched) The suite has NO `wait_until` poller — write one in this task's test section (a simple real-time poll loop with deadline). The moved paused-time tests need RE-SEQUENCING, not just moving: under the always-on driver, spawn triggers an immediate first pass when a row exists, so `boot_recovery_retry_driver_stops_on_server_shutdown`'s `retirement_attempts == 0` assertion only holds if the shutdown latch precedes the spawn. Recreate the main.rs-test-module locals the tests use (`RetirementAlwaysPending`, `TransientBootRecovery`, `unique_temp_dir`) in restart_protocol.rs. The driver loop must thread the recovery `emit` broadcast wiring that `recover_pending_registered` requires (the old main.rs driver had it).

- [ ] **Step 1: Write the failing behavioral tests**

In restart_protocol.rs (fake runtime machinery at :132-206 / :1115-1290 is already available here, not in main.rs):

```rust
async fn wait_until(deadline: Duration, mut probe: impl FnMut() -> bool) -> bool {
    let until = tokio::time::Instant::now() + deadline;
    while tokio::time::Instant::now() < until {
        if probe() { return true; }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    probe()
}

#[tokio::test] // real time, bounded
async fn runtime_created_pending_row_wakes_the_parked_recovery_driver() {
    let restart = RestartCoordinator::new(); // in-memory; no persistence needed
    let runtime = FlakyThenSucceedRuntime::new(); // first execute fails retryable, recovery attempt succeeds
    restart.set_runtime(Arc::new(runtime.clone()));
    let shutdown_started = Arc::new(AtomicBool::new(false));
    let shutdown_notify = Arc::new(Notify::new());
    let driver = tokio::spawn(run_restart_recovery_driver(restart.clone(), shutdown_started.clone(), shutdown_notify.clone()));
    // Driver starts with ZERO pending rows — the pre-fix driver would exit immediately.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!driver.is_finished(), "driver must park, not exit on empty");
    // Normal-runtime failure creates a retryable row (no boot, no browser resend).
    restart.execute_registered(request_for(&runtime), sink()).await;
    // The driver wakes on the Notify and finishes the row by itself.
    assert!(wait_until(Duration::from_secs(5), || restart.pending_recoveries().is_empty()).await);
    assert!(runtime.succeeded_count() >= 1);
    // Mid-pass shutdown edge (LB-07 evidence): notify_waiters mid-pass must exit promptly.
    shutdown_started.store(true, Ordering::SeqCst);
    shutdown_notify.notify_waiters();
    tokio::time::timeout(Duration::from_secs(2), driver).await.expect("driver exits on shutdown");
}
```

Second test: paused-time sibling (`#[tokio::test(start_paused = true)]`) asserting no busy-poll: after wake+drain, runtime call-count stays stable across `time::advance(60s)` until the next notify.

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-ws --test restart_protocol -- recovery_driver`

Expected: FAIL — `run_restart_recovery_driver` does not exist / driver exits immediately on empty pending set / no Notify wake exists (the runtime-created row only gets driven here because nothing else re-sends).

- [ ] **Step 3: Add the minimal production implementation**

restart.rs:

```rust
// RestartCoordinator fields (add):
recovery_notify: Arc<tokio::sync::Notify>,

// In try_update_ownership, immediately after `*ownership = candidate;`:
if self.has_pending_rows() { self.recovery_notify.notify_one(); }
// (has_pending_rows reads the swapped-in ownership or captures
// candidate.pending_recoveries.is_empty() before the swap.)

pub fn recovery_notify_handle(&self) -> Arc<tokio::sync::Notify> {
    Arc::clone(&self.recovery_notify)
}

/// Always-on recovery driver. Parks on the coordinator's Notify (created as a
/// runtime wake by every successful transaction write that leaves pending
/// rows), falls back to a slow poll, and runs the existing recovery passes
/// with the existing backoff while rows are pending. Never exits on empty;
/// exits on shutdown.
pub async fn run_restart_recovery_driver(
    restart: RestartCoordinator,
    shutdown_started: Arc<std::sync::atomic::AtomicBool>,
    shutdown_notify: Arc<tokio::sync::Notify>,
) {
    let notify = restart.recovery_notify_handle();
    let mut backoff = RECOVERY_RETRY_INITIAL;
    loop {
        if shutdown_started.load(Ordering::SeqCst) { break; } // LB-07: notify_waiters stores no permit
        let notified = notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable(); // register interest BEFORE re-checking (missed-wake race)
        let pending = restart.pending_recoveries().len();
        if pending == 0 {
            backoff = RECOVERY_RETRY_INITIAL;
            tokio::select! {
                _ = &mut notified => {}
                _ = shutdown_notify.notified() => { if shutdown_started.load(Ordering::SeqCst) { break; } }
                _ = tokio::time::sleep(RECOVERY_PARK_POLL) => {} // 30s watchdog fallback
            }
            continue;
        }
        let progressed = run_recovery_pass(&restart).await; // extracted existing attempt body (emit threading preserved);
        // wrap each pass: spawn + await JoinHandle; JoinError => tracing::error!("agent.restart.recovery_driver.pass_panicked") + progressed = false
        backoff = if progressed { RECOVERY_RETRY_INITIAL } else { (backoff * 2).min(RECOVERY_RETRY_MAX) };
        tokio::select! {
            _ = &mut notified => {}
            _ = shutdown_notify.notified() => { if shutdown_started.load(Ordering::SeqCst) { break; } }
            _ = tokio::time::sleep(backoff) => {}
        }
    }
}
```

main.rs: at :1129 drop the `if boot_recovery.pending_after > 0` condition and spawn `run_restart_recovery_driver(restart.clone(), shutdown_started.clone(), shutdown_notify.clone())` unconditionally (keep the join handle for shutdown — the existing join at :1943-1952 already covers it). Delete the old `run_restart_boot_recovery_retry_driver`/`spawn_restart_boot_recovery_retry_driver` bodies; `complete_restart_boot_recovery` (readiness gate) is unchanged. Move the two driver tests (`retryable_boot_recovery_continues_in_background_with_backoff` main.rs:3516-3591, `boot_recovery_retry_driver_stops_on_server_shutdown` :3594-3654) out of main.rs into restart_protocol.rs **with re-sequencing (LB-08)**: latch `shutdown_started`/notify BEFORE spawning the driver where a zero-first-pass assertion is needed, and port their helper locals (`RetirementAlwaysPending`, `TransientBootRecovery`, `unique_temp_dir`) into the suite. They use `start_paused`; the notify arm keeps them deterministic under paused time.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-ws --test restart_protocol -- recovery_driver`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Extract the pass body once; keep backoff constants adjacent to the driver; `cargo fmt`.

- [ ] **Step 6: Run impacted-test verification**

Impacted: boot recovery readiness/order, shutdown stop behavior, all restart recovery passes.

Run: `cargo test -p freshell-server boot_recovery && cargo test -p freshell-server sessions_sweep_tests:: && cargo test -p freshell-ws --test restart_protocol`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ws/src/restart.rs crates/freshell-server/src/main.rs crates/freshell-ws/tests/restart_protocol.rs
git commit -m "feat(restart): always-on recovery driver woken by runtime-created pending rows"
```

---

### Task 5: Indeterminate durable-commit semantics on the journal (fix 3)

`atomic_write_restart_journal` (restart.rs:4425-4484) currently returns bare `Err` when the post-rename parent-dir fsync fails — but the rename already landed, so "definitely not committed" and "indeterminate" are conflated, and `try_update_ownership` (885-903) discards the candidate: memory holds pre-write state while disk may hold post-write state (fail-open; worst case at `record_shutdown_pending` :1998-2022 where a session may be durably reserved on disk while memory admits a second writer). After this task the write has three outcomes and the coordinator stays fail-closed on `Indeterminate`.

**Files:**
- Modify: `crates/freshell-ws/src/restart.rs` (writer re-type :4425-4484; `persist_locked` :826-873; `try_update_ownership` :885-903; dirty flag on coordinator; call-site outcome handling at :1998-2022 record_shutdown_pending, :2865 commit_replacement, :2063/:2172/:2403/:2683 terminal stores, all `record_retryable_*`; constructor seam at :552-560)
- Modify: `crates/freshell-protocol/src/server_messages.rs:357-364` (doc comment on `recovery_pending`)
- Test: `crates/freshell-ws/src/restart.rs` persistence_tests (:4486-4648 — re-type :4492 test; add dirty-flag tests)
- Test: `crates/freshell-ws/tests/restart_protocol.rs` (integration: add-side and commit-side indeterminate faults)

**Interfaces:**
- Produces: `enum JournalWriteOutcome { Committed, NotCommitted(io::Error), Indeterminate(io::Error) }`; `pub(crate) enum UpdateDurability { Committed, Indeterminate }`; `try_update_ownership` returns `io::Result<(T, UpdateDurability)>`; `#[doc(hidden)] pub fn new_persistent_with_test_parent_sync(...)` constructor seam taking `Arc<dyn Fn(&Path) -> io::Result<()> + Send + Sync>`.
- Consumes: existing adoption machinery (`adoptable_registered_replacement` :1426-1474; test `pending_retry_adopts_registered_replacement_after_ambiguous_durable_commit` :2628).

- [ ] **Step 1: Write the failing behavioral tests**

Re-type the existing unit test (:4492-4514) to expect the third outcome:

```rust
#[test]
fn parent_directory_sync_failure_after_rename_is_indeterminate() {
    // ...same temp fixtures as before...
    let outcome = atomic_write_restart_journal_with_parent_sync(&destination, &temporary, BYTES, |_p| {
        Err(std::io::Error::other("injected directory sync failure"))
    });
    assert!(matches!(outcome, JournalWriteOutcome::Indeterminate(_)));
    assert!(destination.exists(), "the injected failure occurs after the atomic rename");
    assert!(!temporary.exists());
}
```

New unit tests on the coordinator's dirty flag:

```rust
#[test]
fn dirty_dir_sync_blocks_committed_status_until_a_clean_write() {
    // coordinator with injected parent-sync that fails once (AtomicUsize gate),
    // writes twice; first => Indeterminate, second => Indeterminate still if the
    // pre-retry fails, Committed after the injected faults are exhausted; assert
    // the flag's public probe transitions.
}
```

Integration (restart_protocol.rs), add-side:

```rust
#[tokio::test]
async fn indeterminate_journal_write_during_record_shutdown_pending_keeps_row_and_reports_recovery_pending() {
    // Coordinator: new_persistent_with_test_parent_sync(path, limits, sync that fails post-rename ONCE).
    // Fake runtime whose preflight succeeds and whose shutdown_for_restart we must NOT reach.
    let (mut events, _rx) = collect_events();
    restart.execute_registered(request, emit).await;
    // Frames: agent.restart.failed with retryable == true && recovery_pending == true;
    // NO agent.restart.started-success sequence and NO replaced frame.
    // Invariant: pending_recoveries() contains the request (memory reserved);
    // runtime recorder asserts abort_preflight was NOT called.
    // Then clear the fault and wait: the Task-4 driver re-drives the row to a
    // clean commit (shutdown_for_restart runs exactly once).
}
```

Integration, commit-side:

```rust
#[tokio::test]
async fn indeterminate_journal_write_during_commit_keeps_pending_row_and_defers_replaced_frame() {
    // Drive a full restart to the commit persist with the fault latched;
    // assert: failed frame (recovery_pending == true, retryable == false), no `replaced`,
    // pending row still in memory, replacement runtime registered.
    // Clear the fault; drive recovery; assert convergence to committed result that a
    // duplicate request replays (adoption flow of test :2628).
}
```

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-ws --lib restart::persistence_tests && cargo test -p freshell-ws --test restart_protocol -- indeterminate`

Expected: FAIL — the three-outcome type and constructor seam do not exist (compile-red), and behaviorally the current code discards candidates (row absent, `recovery_pending: false` on the emit).

- [ ] **Step 3: Add the minimal production implementation**

1. Writer:

```rust
pub enum JournalWriteOutcome {
    Committed,
    NotCommitted(std::io::Error),
    Indeterminate(std::io::Error),
}

fn atomic_write_restart_journal_with_parent_sync(
    destination: &Path, temporary: &Path, bytes: &[u8],
    sync_parent: impl FnOnce(&Path) -> std::io::Result<()>,
) -> JournalWriteOutcome {
    // ...existing validation + tmp write + fsync...
    // every error BEFORE `std::fs::rename(temporary, destination)` returns => NotCommitted(err)
    // rename itself Err => NotCommitted(err)
    // rename Ok, then sync_parent(parent) Err => remove nothing else, Indeterminate(err)
}
```

(Keep the existing temp-cleanup; on `Indeterminate` the destination HAS the new bytes — do not attempt rollback.)

2. `persist_locked` returns `JournalWriteOutcome`; the coordinator gains `journal_dir_sync_dirty: Arc<AtomicBool>` and a stored `sync_parent: Arc<dyn Fn(&Path) -> io::Result<()> + Send + Sync>` (default = the cfg(unix) real fsync / no-op otherwise). Semantics in `persist_locked`:

```rust
if self.journal_dir_sync_dirty.load(Ordering::SeqCst) {
    match (self.sync_parent)(parent) {
        Ok(()) => self.journal_dir_sync_dirty.store(false, Ordering::SeqCst),
        Err(e) => return JournalWriteOutcome::Indeterminate(e), // do not even write; directory unproven
    }
}
// ...write...
match outcome { Committed => {}, Indeterminate(_) => self.journal_dir_sync_dirty.store(true, ...), NotCommitted(_) => {} }
```

(Non-unix default sync is `Ok(())`, so `Indeterminate` cannot arise there — behavior unchanged.)

3. `try_update_ownership` returns `io::Result<(T, UpdateDurability)>`: `Err` only for `NotCommitted` (candidate discarded, as today); on `Indeterminate` apply a fail-closed merge — the candidate wholesale EXCEPT pending-row membership takes the union old∪candidate (row content = candidate's when both have it), set dirty, return `Ok((t, UpdateDurability::Indeterminate))`.

4. Call sites (each keeps its current `Err` branch; add the `Indeterminate` arm):
   - `record_shutdown_pending` (:1998-2022): `Indeterminate` → do NOT `abort_preflight` (:2018), do NOT emit `persistence_failure(...false)`; emit a retryable `AgentRestartFailed` with `recovery_pending: true` and message naming the indeterminate durability; skip the shutdown phase for this pass (the retained row + Task-4 driver re-drive it).
   - `commit_replacement` (:2865+: the pending-removal persist): `Indeterminate` → adopt bindings/results from the merge, emit failure `recovery_pending: true` (NOT `replaced`), return; recovery/adoption converges.
   - terminal stores (:2063, :2172-2178, :2403-2422, :2683-2702): `Indeterminate` → the row survives (union), so reframe the emit as `recovery_pending: true`, `retryable: false`, "durability indeterminate — reconciled by recovery".
   - `record_retryable_*` sites (:2052, :2137, :2212, :2395, :2599, :2674, :2738): row already persists; on `Indeterminate` log `agent.restart.persistence.indeterminate` and keep the existing emit.
   - The protocol doc comment on `recovery_pending` (server_messages.rs:357-364) gains "or durability of the transaction record is indeterminate".

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-ws --lib restart:: && cargo test -p freshell-ws --test restart_protocol -- indeterminate`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Extract the dirty-flag retry into one helper on the coordinator; keep per-site match arms minimal and named; `cargo fmt`. Also confirm the sibling writers were NOT changed: `tabs_persist::atomic_write_durable` (tabs_persist.rs:682-708) and settings_store atomic write keep their existing contracts (no behavior change outside the restart journal).

- [ ] **Step 6: Run impacted-test verification**

Impacted: every persist path in the coordinator (all recovery/replay/fault tests), plus boot recovery (journal load).

Run: `cargo test -p freshell-ws --test restart_protocol && cargo test -p freshell-server boot_recovery`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ws/src/restart.rs crates/freshell-protocol/src/server_messages.rs crates/freshell-ws/tests/restart_protocol.rs
git commit -m "fix(restart): treat post-rename dir fsync failure as indeterminate and stay fail-closed"
```

---

### Task 6: Shutdown owns/stops/joins restart transactions + quarantine drains (fix 1)

Today: WS ingress spawns each restart as a detached `tokio::spawn` with a discarded `JoinHandle` (terminal.rs:1143-1151); shutdown (main.rs:1928-2036) joins only the boot-retry driver; `registry.kill_all()` can kill the selected old runtime of a mid-flight transaction; the fresh-agent `shutdown()`s drain only their `sessions` maps, never the `restart_retirements` quarantine maps (claude.rs:130, codex.rs:188) — a quarantined sidecar leaks alive past shutdown. After this task: ingress registers every transaction, shutdown latches new work, joins the in-flight set before cleanup, replacement creation is refused once latched (retryable, row retained), and quarantines are drained through confirmed process-tree termination.

**Files:**
- Modify: `crates/freshell-ws/src/restart.rs` (coordinator: `shutdown_latch`, `transactions`, `begin_restart_shutdown`, `join_in_flight_transactions`, `spawn_registered`; latch checks in `execute_with_events` entry and before `create_replacement_fenced` :2118 and before `recover_replacement_fenced` :2645)
- Modify: `crates/freshell-ws/src/terminal.rs:1114-1153` (use `spawn_registered`; door emits typed rejection during shutdown), `:5849-5918` `create_terminal_replacement` (defense-in-depth latch checks)
- Modify: `crates/freshell-freshagent/src/codex.rs` (`pub async fn drain_restart_retirements(&self)` reusing the `continue_codex_restart_retirement` bounded steps)
- Modify: `crates/freshell-freshagent/src/claude.rs` (same, against `ClaudeRestartRetirement`'s `tree`/`child`/`consumer` fields :255-266)
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs` (bookkeeping drain: log + clear the map; remote abort stays boot recovery's job)
- Modify: `crates/freshell-server/src/main.rs:1928-2036` (latch → join → drains before `registry.kill_all()`/provider shutdowns)
- Test: `crates/freshell-ws/tests/restart_protocol.rs` (latch/join tests), `crates/freshell-freshagent/src/codex.rs` + `claude.rs` tests (drain tests)

**Interfaces:**
- Produces: `pub async fn spawn_registered(self: &RestartCoordinator, request: AgentRestart, emit: impl FnMut(&ServerMessage) + Send + 'static) -> bool` (false = rejected due to shutdown, after emitting the failure frame); `pub fn begin_restart_shutdown(&self)`; `pub async fn join_in_flight_transactions(&self)`; `FreshCodexState::drain_restart_retirements(&self, deadline: tokio::time::Instant)`, `FreshClaudeState::drain_restart_retirements(&self, deadline: tokio::time::Instant)` (per-entry budgets clamped by the shared deadline; truncation logs loudly); `OpencodeWsState::drain_restart_retirements(&self)` (bookkeeping only).
- Consumes: existing `SHUTDOWN_HARD_TIMEOUT` (main.rs:2042), existing codex/claude retirement machinery and budgets (`RESTART_CONSUMER_JOIN_BUDGET`, `RESTART_WATCHER_JOIN_BUDGET`).

- [ ] **Step 1: Write the failing behavioral tests**

restart_protocol.rs:

```rust
#[tokio::test]
async fn restart_spawn_rejected_once_shutdown_latched() {
    // coordinator + fake runtime; begin_restart_shutdown(); then spawn_registered
    // must return false and have emitted agent.restart.failed{code: ShutdownFailed,
    // retryable: true, recovery_pending: false}; no AgentRestartStarted, no pending row.
}

#[tokio::test]
async fn in_flight_transaction_is_joined_by_shutdown_and_replacement_creation_after_latch_is_refused() {
    // Fake runtime with a gate inside shutdown_for_restart: start the transaction,
    // latch shutdown, then un-gate retirement. create_replacement_fenced must NOT run;
    // the failure frame is retryable + recovery_pending == true and the row is retained.
    // join_in_flight_transactions() resolves once the task returns.
}

#[tokio::test]
async fn recovery_pass_skips_replacement_creation_after_shutdown_latch() {
    // Seed a pending row whose phase needs recover_replacement_fenced; latch;
    // run the recovery pass; assert no spawn happened and the row remains.
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn spawn_registered_cannot_insert_after_the_drain_observed_empty() {
    // LB-06 mandatory race test: coordinate a spawn_registered that has passed the
    // fast-path latch check and parks on the transactions mutex, run
    // begin_restart_shutdown + join_in_flight_transactions to completion, then
    // release the parked task; it must observe the latch INSIDE the lock, emit the
    // typed rejection, and NOT register. Assert the finished drain saw zero tasks
    // and no late AgentRestartStarted arrives.
}

#[tokio::test]
async fn shutdown_sequence_completes_within_the_shared_deadline_with_a_live_gated_transaction_and_quarantine_entry() {
    // LB-02 acceptance evidence: fake runtime gating a mid-flight transaction +
    // one quarantined codex retirement; run the Task-6 phased order with the
    // 3s/2s split (scaled constants under test); assert: join awaited, drain ran,
    // total wall time under the shared envelope, and no orphan: the quarantined
    // child pid is gone from /proc.
}
```

freshagent codex.rs tests:

```rust
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn shutdown_drains_codex_restart_quarantine_with_confirmed_termination() {
    // insert_fake_session; claim lease; shutdown_for_restart_detailed => Incomplete (quarantined).
    // fresh_codex_state equivalent: state.drain_restart_retirements().await
    // assert: restart_retirements empty; the fake child pid is gone from /proc (kill confirmed,
    // mirroring the assertions style at :5714-5811).
}
```

and the claude.rs analogue using its existing `restart_shutdown_*` fixtures.

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-ws --test restart_protocol -- shutdown_ spawn_registered` and `cargo test -p freshell-freshagent --lib "codex::tests::shutdown_drains" "claude::tests::shutdown_drains"` (adjust filter to actual names)

Expected: FAIL — no latch/registry/drain exists (compile-red on new methods; behavioral red where stubs are wired).

- [ ] **Step 3: Add the minimal production implementation**

Coordinator (restart.rs):

```rust
// fields:
shutdown_latch: Arc<AtomicBool>,
transactions: Arc<tokio::sync::Mutex<tokio::task::JoinSet<()>>>,

pub fn set_shutdown_latch(&self, latch: Arc<AtomicBool>) { self.shutdown_latch = latch; }
pub fn shutdown_latch_handle(&self) -> Arc<AtomicBool> { Arc::clone(&self.shutdown_latch) }
pub fn begin_restart_shutdown(&self) { self.shutdown_latch.store(true, Ordering::SeqCst); }

pub async fn spawn_registered(&self, request: AgentRestart, mut emit: impl FnMut(&ServerMessage) + Send + 'static) -> bool {
    if self.shutdown_latch.load(Ordering::SeqCst) {
        let failure = /* AgentRestartFailed { code: ShutdownFailed, retryable: true, recovery_pending: false, message: "server is shutting down; restart not started" } built from request */;
        emit(&failure);
        return false;
    }
    // Register under the mutex with the latch re-checked INSIDE the lock
    // (load-bearing LB-06): the latch load above is only a fast path; a task
    // parked on the mutex could otherwise resume after begin_restart_shutdown +
    // a completed empty drain and insert a racing transaction.
    let coordinator = self.clone();
    let mut transactions = self.transactions.lock().await;
    if self.shutdown_latch.load(Ordering::SeqCst) {
        drop(transactions);
        emit(&failure_frame_for(&request)); // same typed shape as above
        return false;
    }
    transactions.spawn(async move {
        coordinator.execute_registered(request, |m| emit(m)).await;
    });
    drop(transactions);
    true
}

pub async fn join_in_flight_transactions(&self) {
    let mut set = self.transactions.lock().await;
    while set.join_next().await.is_some() {}
}
```

Latch checks: (a) top of `execute_with_events` — same typed failure as the door rejection; (b) immediately before `runtime.create_replacement_fenced` (:2118) and before `recover_replacement_fenced` (:2645): if latched, `record_retryable_replacement_failure(request, "server is shutting down; replacement deferred", ...)` (`recovery_pending: true`, row retained) and return early. (c) defense-in-depth in `create_terminal_replacement` (terminal.rs:5849): mirror restore-door checks (`create_gate.rs:181-192/250-259`): check `state.shutdown_started` before acquiring `spawn_gate` and again before insert; also in `WsStateFreshRuntime::handle_create_fenced` (restart.rs:3583-3604).

terminal.rs door (:1135-1151): replace the bare `tokio::spawn` with `state.restart.spawn_registered(request, emit)`; the closure body stays the broadcast wiring.

freshagent codex.rs:

```rust
/// Server-shutdown drain: quarantined runtimes are outside `sessions`, so the
/// ordinary shutdown sweep never sees them. Drive every retirement to the same
/// bounded steps as `continue_codex_restart_retirement` and log loudly on any
/// budget violation; per-entry budgets are CLAMPED by the shared drain deadline
/// (LB-02); truncated entries log and release to cross-boot recovery — the
/// durable pending row owns recovery next boot.
pub async fn drain_restart_retirements(&self, deadline: tokio::time::Instant) {
    let entries: Vec<CodexRestartRetirement> = self.restart_retirements.lock().await.drain().map(|(_, v)| v).collect();
    for entry in entries { /* capture-ack ≤ min(1s, remaining); consumer abort+join; client.close(); watcher join ≤ min(3s, remaining); on timeout/truncation tracing::error!("agent.restart.codex_quarantine_drain_not_quiescent", ...) */ if tokio::time::Instant::now() >= deadline { tracing::error!("agent.restart.codex_quarantine_drain_deadline_exhausted"); break; } }
}
```

claude.rs: same shape against `ClaudeRestartRetirement` — start_kill, `tree.terminate_and_confirm().await`, consumer abort + join bounded, loud log on failure. opencode_ws.rs: drain the map, log entry count (remote abort remains the next boot's job).

main.rs shutdown ordering (after the existing boot-driver join at :1943-1952, before `registry.kill_all()` at :1995):

**Load-bearing correction (LB-02 = falsified-as-designed):** the SAFE-11 shutdown watchdog (main.rs:2042 `SHUTDOWN_HARD_TIMEOUT = 5s`, armed at signal arrival :2112-2118) bounds the ENTIRE graceful sequence — `timeout(5s, …)` on the transaction join plus ~N×5s of sequential drains cannot fit inside it beside the existing boots. Budget as ONE shared deadline: transaction join ≤ 3,000 ms, then quarantine drains ≤ 2,000 ms total (across both providers, in parallel per provider), then the pre-existing kill_all/provider sequence keeps its remaining time. Spend-tracking is a simple `Instant` deadline handed to each phase; truncation logs loudly and lets cross-boot fence recovery finish the stragglers (durable rows + Task-2 confirmed barriers remain the fail-closed backstop):

```rust
restart.begin_restart_shutdown();
let deadline = tokio::time::Instant::now() + Duration::from_millis(3_000);
if let Err(_) = tokio::time::timeout_at(deadline, restart.join_in_flight_transactions()).await {
    tracing::error!("agent.restart.shutdown.transactions_join_timeout"); // do NOT abort; durable rows + cleanup reaps
}
let drain_deadline = tokio::time::Instant::now() + Duration::from_millis(2_000);
tokio::join!(
    fresh_codex_state.drain_restart_retirements(drain_deadline),  // per-entry budgets CLAMPED by the shared deadline
    fresh_claude_state.drain_restart_retirements(drain_deadline),
);
```

and the opencode bookkeeping drain adjacent to its provider shutdown. Keep the existing sequences otherwise untouched. Wire the latch at construction: `ws_state.restart.set_shutdown_latch(shutdown_started.clone())`.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-ws --test restart_protocol -- shutdown_ spawn_registered` && cargo test -p freshell-freshagent --lib "codex::tests::shutdown_drains" "claude::tests::shutdown_drains"`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Factor the per-provider drain bodies behind each retirement's own method (e.g. `CodexRestartRetirement::drain(...)`); confirm budgets/constants reused, not duplicated; `cargo fmt`.

- [ ] **Step 6: Run impacted-test verification**

Impacted: WS ingress, recovery passes, main shutdown sequence, fresh-agent kill/retire paths.

Run: `cargo test -p freshell-ws --test restart_protocol && cargo test -p freshell-freshagent --lib && cargo test -p freshell-server boot_recovery`

Expected: PASS and the freshagent binary terminates (watch for the Task-1 regression classes).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ws/src/restart.rs crates/freshell-ws/src/terminal.rs crates/freshell-freshagent/src/codex.rs crates/freshell-freshagent/src/claude.rs crates/freshell-freshagent/src/opencode_ws.rs crates/freshell-server/src/main.rs crates/freshell-ws/tests/restart_protocol.rs
git commit -m "fix(restart): shutdown owns, stops and joins restart transactions; drain quarantines with confirmed termination"
```

---

### Task 7: Bounded restart ingress with typed overload failures (fix 6)

Today restart ingress is a WS-only door (terminal.rs:1114-1153) whose only bound is the 16 MiB tungstenite frame cap: every valid frame spawns an unbounded task, coordinator lock maps grow with queued waiters, `pending_recoveries` is uncapped, and `AgentRestart`'s string fields are unbounded. After this task every bound is enforced BEFORE any task/lock allocation, overload returns a typed failure frame, and the journal cannot grow past a byte cap.

**Files:**
- Modify: `crates/freshell-protocol/src/server_messages.rs:279-292` (new `Overloaded` variant)
- Modify: `crates/freshell-ws/src/restart.rs` (constants; `try_admit_restart` + `AdmissionGuard`; `execute_with_events` pending-row backstop at :1998; `persist_locked` byte cap at :826-873)
- Modify: `crates/freshell-ws/src/terminal.rs:1114-1153` (door admission before spawn)
- Test: `crates/freshell-ws/tests/restart_protocol.rs` (coordinator + WS door tests)

**Interfaces:**
- Produces: `AgentRestartFailureCode::Overloaded` (wire `OVERLOADED`); `pub fn is_known_request(&self, request: &AgentRestart) -> bool` (LB-03 dedupe: in-flight registry ∪ pending rows ∪ stored results); `pub fn try_admit_restart(&self, request: &AgentRestart) -> Result<AdmissionGuard, RestartFailure>`; `pub struct AdmissionGuard` (holds a global semaphore permit, releases the per-session slot on drop); constants `MAX_AGENT_RESTART_FIELD_BYTES = 256`, `MAX_PENDING_RESTART_RECOVERIES = 1_024`, `MAX_IN_FLIGHT_RESTARTS = 256`, `MAX_QUEUED_RESTARTS_PER_SESSION = 4` (counts DISTINCT new requests per session after dedupe), `MAX_RESTART_JOURNAL_BYTES = 8 * 1024 * 1024`.
- Consumes: existing `RestartFailure` (:235) and door failure-frame shape (capability rejection at terminal.rs:1122-1139 — the Overloaded frame must mirror its runtime-descriptor fill from the request).

- [ ] **Step 1: Write the failing behavioral tests**

```rust
#[tokio::test]
async fn oversized_restart_field_is_rejected_at_the_door_without_spawning() {
    // Real WS harness. Send AgentRestart with a 300-byte session_id.
    // Expect agent.restart.failed { code: OVERLOADED, retryable: false } echoing the
    // request's runtime descriptor; assert NO agent.restart.started arrives in a 500ms
    // window and the coordinator's in-flight probe stays 0.
}

#[tokio::test]
async fn pending_row_cap_rejects_new_restart_without_touching_the_journal() {
    // Coordinator via new_persistent_with_limits with the pending cap clamped low
    // (extend the limits ctor with a pending limit param; default = 1_024).
    // Seed rows to the cap; a new distinct request => Overloaded (retryable: true),
    // journal's pendingRecoveries length on disk unchanged.
}

#[tokio::test]
async fn per_session_queue_cap_rejects_excess_queued_restarts() {
    // Fake runtime whose preflight parks on a gate; send 5 distinct requests for one
    // session; the 5th receives Overloaded before any spawn; un-gate -> the other 4
    // drain to completion (retry/replay semantics preserved by existing machinery).
}

#[tokio::test]
async fn global_in_flight_cap_rejects_overload() { /* small-ctor-override analogue */ }

#[test]
fn journal_write_refusing_megabyte_overrun_is_a_notcommitted_persistence_failure() {
    // persist_locked with a state exceeding MAX_RESTART_JOURNAL_BYTES returns
    // NotCommitted and leaves the previous journal + memory untouched.
}
```

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-ws --test restart_protocol -- overload` (plus the specific test names)

Expected: FAIL — no `Overloaded` variant/admission API/byte cap exists (compile-red), and the door accepts everything (behavioral red).

- [ ] **Step 3: Add the minimal production implementation**

1. Protocol: add `Overloaded` to `AgentRestartFailureCode` (:279-292) — wire-additive `OVERLOADED`; client renders `message` for unknown/new codes already (ContextMenuProvider.tsx:209-243), verify no exhaustive TS union needs a new arm (grep for the SCREAMING codes in src/ — found only in tests).
2. restart.rs constants + admission:

```rust
const MAX_AGENT_RESTART_FIELD_BYTES: usize = 256;
const MAX_PENDING_RESTART_RECOVERIES: usize = 1_024; // extended as a limits-ctor param
const MAX_IN_FLIGHT_RESTARTS: usize = 256;           // "
const MAX_QUEUED_RESTARTS_PER_SESSION: usize = 4;    // "
const MAX_RESTART_JOURNAL_BYTES: usize = 8 * 1024 * 1024;

// coordinator fields:
in_flight: Arc<tokio::sync::Semaphore>,            // MAX_IN_FLIGHT_RESTARTS permits
queued_by_session: std::sync::Mutex<HashMap<String, usize>>, // bounded: <=1_024 DISTINCT session keys; prune on drop

pub struct AdmissionGuard {
    _permit: tokio::sync::OwnedSemaphorePermit,
    session_key: String,
    queued: Arc<std::sync::Mutex<HashMap<String, usize>>>,
}
impl Drop for AdmissionGuard { /* decrement; remove on zero */ }

pub fn try_admit_restart(&self, request: &AgentRestart) -> Result<AdmissionGuard, RestartFailure> {
    for (name, value) in [("requestId", &request.request_id), ("provider", &request.provider),
                          ("sessionId", &request.session_id), ("liveId", &request.live_id)] {
        if value.len() > MAX_AGENT_RESTART_FIELD_BYTES {
            return Err(RestartFailure::new(AgentRestartFailureCode::Overloaded,
                format!("agent restart field {name} exceeds {MAX_AGENT_RESTART_FIELD_BYTES} bytes"), false));
        }
    }
    let pending = { self.ownership.lock().expect("restart ownership lock").pending_recoveries.len() };
    if pending >= self.pending_limit {
        return Err(RestartFailure::new(AgentRestartFailureCode::Overloaded,
            format!("restart journal holds {pending} pending recoveries; cap {}", self.pending_limit), true));
    }
    let permit = Arc::clone(&self.in_flight).try_acquire_owned().map_err(|_| RestartFailure::new(
        AgentRestartFailureCode::Overloaded, "restart system is at the global in-flight cap", true))?;
    {
        let mut queued = self.queued_by_session.lock().expect(...);
        let key = format!("{}:{}", request.kind wire-discriminant, request.session_id); // match reservation keying at :1910-1939
        let count = queued.entry(key.clone()).or_insert(0);
        if *count >= MAX_QUEUED_RESTARTS_PER_SESSION { return Err(...Overloaded...true...); }
        if !queued.contains_key(&key) && queued.len() >= 1_024 { return Err(...Overloaded...true...); }
        *count += 1;
    }
    Ok(AdmissionGuard { _permit: permit, session_key: key, queued: Arc::clone(&self.queued_by_session) })
}
```

(Careful ordering bug guard in the draft above: check the entry-before-insert race — implement as contains/get first, then insert; the implementer writes the final exact form.)

3. terminal.rs door (after the capability check, before spawning):

**Load-bearing correction (LB-03 = falsified-as-designed):** arrivals must be deduped BEFORE any counting — the shipped client resends the SAME `request_id` on a 500ms→4s backoff loop (ws-client.ts:290-314, up to 4 arrivals per request, more with reconnects/followers), while resend handling (`replay_or_conflict` :3053-3071, follower correlation :1837-1904, pending-row retry :1805-1826) lives INSIDE `execute_with_events`, downstream of the door. Arrival-counting as sketched could Overload a healthy single restart (a 5th correlated arrival). Rule: an arrival whose `request_id` is already (a) an in-flight registered transaction, (b) a pending durable row, or (c) a stored terminal result bypasses admission entirely and goes straight to the coordinator (existing replay/follower machinery handles it); only DISTINCT new request ids consume per-session/global budget. Overloaded for the global/journal caps stays `retryable: true`; since dedupe happens first, the per-session cap is never hit by resends, so no separate non-retryable variant is required.

```rust
// Door order: capability -> dedupe probe (restart.is_known_request(&request):
// in-flight registry membership OR pending row OR stored result) -> admission.
let known = restart.is_known_request(&request);
let admission = if known {
    None
} else {
    match restart.try_admit_restart(&request) {
        Ok(guard) => Some(guard),
        Err(failure) => return send(ws_tx, &failure_frame_for(&request, failure)).await,
    }
};
```
Hold the guard (when present) across the whole spawned task (move it into `spawn_registered`'s task from Task 6; also skip admission for the shutdown-latch rejection path). The per-session-key queue test that sent "5 distinct requests for one session" stays distinct-request-shaped; add one new test: the same request_id resent 6 times through a gated retirement receives NO Overloaded and replays normally.

4. execute_with_events backstop at :1998 (immediately before `try_update_ownership("record_shutdown_pending", ...)`): if this request does not already own a pending row and `pending_recoveries.len() >= self.pending_limit`, run `abort_preflight` (:2018 path) and emit Overloaded retryable — never insert.

5. persist_locked byte cap: after `to_vec_pretty`, `if bytes.len() > MAX_RESTART_JOURNAL_BYTES { return Err(io::Error::other("restart journal exceeds byte cap")); }` — a `NotCommitted` persistence failure (existing recovery_pending handling applies). `load_persisted` keeps loading all pending rows (bounded forward by the insert cap; recorded decision — do NOT truncate on load).

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-ws --test restart_protocol -- overload` + the byte-cap unit test.

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Hoist the failure-frame builder shared by door/capability/overload rejections (three near-copies at terminal.rs:1122-1139+); `cargo fmt`.

- [ ] **Step 6: Run impacted-test verification**

Impacted: door dispatch, coordinator execute path, journal persist, existing bound tests (:2446/:2499/:2810 use the extended limits ctor — mechanical signature updates), restore_plan_queue_cap + max_payload neighbors.

Run: `cargo test -p freshell-ws --test restart_protocol && cargo test -p freshell-ws --test restore_plan_queue_cap && cargo test -p freshell-ws --test max_payload && cargo test -p freshell-ws --lib restart::`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-protocol/src/server_messages.rs crates/freshell-ws/src/restart.rs crates/freshell-ws/src/terminal.rs crates/freshell-ws/tests/restart_protocol.rs
git commit -m "feat(restart): bound restart ingress with typed overload failures before any spawn or lock"
```

---

### Task 8: Active restart plans never evicted; OpenCode plans removed on terminal outcomes (fix 7)

`ProductionRestartRuntime.plans` (restart.rs:3611) is a single 1,024-entry map whose eviction can drop an ACTIVE terminal/Claude/Codex plan mid-transaction (:3982-4023 evicts an arbitrary non-reservation plan), wedging its durable row; and nothing removes plans on terminal outcomes (`commit_replacement`, the `store_terminal_*`/`store_failed_shutdown` set), so OpenCode's `restart_reservation` (opencode_ws.rs:954) can leak forever ("reserved by another restart", kill/interrupt refused). After this task, active plans are retained for the life of the transaction (implicitly bounded by Task 7's in-flight/pending caps) and every recovery terminal outcome removes the plan and releases the OpenCode reservation.

**Files:**
- Modify: `crates/freshell-ws/src/restart.rs` (rename `plans` to `active_plans` :3609-3613; delete the eviction block :3982-4023; new `RestartRuntime::on_terminal_outcome` hook + call sites)
- Test: `crates/freshell-ws/tests/restart_protocol.rs` (retention + cleanup tests)
- Test: `crates/freshell-freshagent` opencode reservation-release assertion where the existing reservation tests live (opencode_ws.rs tests)

**Interfaces:**
- Produces: `async fn on_terminal_outcome(&self, _request: &AgentRestart) {}` (default no-op) on `RestartRuntime`; production impl removes the plan and calls `fresh_runtime.release_restart_preflight(...)` when the plan held a reservation.
- Consumes: existing `release_restart_preflight` seam (opencode_ws.rs:974-992, trait-exposed via `ProductionFreshRuntime`), existing insertion (:3994-4003 region after refactor).

- [ ] **Step 1: Write the failing behavioral tests**

**Load-bearing correction (LB-12 = falsified-as-sketched):** after Task 7's door caps (256 global / 4 per-session), >1,024 preflights cannot arrive via `execute_registered`/the WS door. The flood drives `ProductionRestartRuntime::preflight` DIRECTLY (adapter test ctor `with_fresh_runtime`, restart.rs:3627; adapter-test template :4060-4616) while the held transaction runs through the coordinator door.

```rust
#[tokio::test]
async fn active_plan_survives_preflight_flood_from_other_requests() {
    // Production adapter (with_fresh_runtime test ctor). Hold one transaction's plan
    // un-created (preflight done, create gated), run >1_024 DIRECT preflight calls for
    // distinct request ids + sessions, then un-gate and assert the original transaction
    // commits (its plan was never evicted).
}

#[tokio::test]
async fn commit_removes_plan_and_releases_opencode_preflight_reservation() {
    // Recording ProductionFreshRuntime seam: complete a full opencode-kind restart;
    // assert release_restart_preflight was called with the exact token and
    // active_plans no longer contains the request id.
}

#[tokio::test]
async fn terminal_shutdown_failure_removes_plan_and_releases_reservation() {
    // Fake runtime returns a terminal shutdown failure; after the failure frame, plan gone
    // and reservation released; counterpart: RETRYABLE shutdown failure keeps the plan
    // (opencode token must survive for the retry).
}
```

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-ws --test restart_protocol -- plan_`

Expected: FAIL — the flood test wedges the held transaction today (plan evicted); the cleanup tests fail because no hook exists and the reservation persists.

- [ ] **Step 3: Add the minimal production implementation**

1. Replace the plans insert/evict block (:3982-4023) with an unconditional `active_plans.insert(...)`. Delete the capacity-exhaustion failure arm (Task 7's ingress caps are the boundary now; record the removal rationale in the commit message).
2. Trait hook (restart.rs trait block near :246-372):

```rust
/// The coordinator reached a terminal outcome for this request (commit or a
/// terminal failure): release any preflight plan/reservation state. Called
/// once per terminal outcome; retryable failures keep the plan so a same-request
/// retry reuses its reservation token (opencode lane).
async fn on_terminal_outcome(&self, _request: &AgentRestart) {}
```

3. Production impl (on `ProductionRestartRuntime`): remove from `active_plans`; if the removed plan had `Some(token)`, `self.fresh_runtime.release_restart_preflight(provider, &request.session_id, &request.live_id, token).await`.
4. Coordinator call sites — invoke after the terminal state is persisted (upgrade `registered_runtime` Weak; dropped runtime = skip):
   `commit_replacement` success (:2865-2935), `store_failed_shutdown` (:2063-2066), `store_terminal_replacement_failure` (:2172-2178), `store_terminal_retirement_failure` (:2403-2422), `store_terminal_recovery_failure` (:2683-2702), and the recovery-side commit/adopt paths (:2538/:2757/:2808) where a pending row is finally removed.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-ws --test restart_protocol -- plan_`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Ensure plan removal lives at exactly the row-removal choke points (one helper `finish_request(request)` on the coordinator that both persists and notifies the runtime); `cargo fmt`.

- [ ] **Step 6: Run impacted-test verification**

Impacted: all adapter preflight/create/abort paths, opencode reservation lane, recovery suite.

Run: `cargo test -p freshell-ws --test restart_protocol && cargo test -p freshell-freshagent --lib -- opencode`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ws/src/restart.rs crates/freshell-ws/tests/restart_protocol.rs crates/freshell-freshagent/src/opencode_ws.rs
git commit -m "fix(restart): never evict active plans; release OpenCode reservations on terminal outcomes"
```

---

### Task 9: Live runtime descriptors pinned apart from the 1,024-entry retired cache (fix 8)

`descriptor_by_live` + `descriptor_order` are one FIFO pruned at `ownership_limit` (1,024 in production via `new_persistent`), and reads never refresh recency (`runtime_for_live` :1405-1415). Once 1,024 descriptors churn, an ACTIVE pane's descriptor is evicted; the contract gate (`restart_runtime_contract_satisfied` :1655-1681) then drops every output/exit frame for that pane — output silently black-holes (drop points terminal.rs:359-376, :577-579). After this task live descriptors are pinned and only retired descriptors ride the bounded FIFO.

**Files:**
- Modify: `crates/freshell-ws/src/restart.rs` (`RuntimeOwnership` split; `prune_ownership_locked` :1187-1231; move sites :1364, :2111-2114, :2638-2642; `runtime_for_live` fallback; new `unpin_descriptor` / retire method; constructor-limit bookkeeping)
- Modify: `crates/freshell-ws/src/terminal.rs:2255-2367` (PTY exit hook unpins at identity retire :2278)
- Modify: `crates/freshell-freshagent` session-finalization sites via the `FreshRuntimeRegistry` seam (restart.rs:4411-4423) — mirror unpin on fresh session end
- Test: `crates/freshell-ws/tests/restart_protocol.rs` (>1,024 transitions test), keep `retired_descriptor_fences_late_frames_only_for_the_bounded_window` (:2850-2871) semantics for retired entries

**Interfaces:**
- Produces: `RuntimeOwnership.live_descriptors` (unpruned while live) + `retired_descriptors`/`retired_descriptor_order` (FIFO, 1,024); `pub fn unpin_descriptor(&self, kind: AgentRuntimeKind, runtime_id: &str)` (live → retired move); `FreshRuntimeRegistry::unregister_runtime(...)` default no-op (implemented by `RestartCoordinator`).
- Consumes: existing registration callers (`register_initial` :1316/:1335, `register_live` :1399, `register_supplied` :1743, `commit_replacement` :2933) and late-frame fencing (`retired_live` set; its membership becomes "key present in retired_descriptors").

- [ ] **Step 1: Write the failing behavioral tests**

```rust
#[tokio::test]
async fn live_descriptor_survives_more_than_1024_retired_transitions_and_output_is_delivered() {
    // Coordinator + fake runtime. Register one long-lived terminal runtime (live target),
    // then drive 1_100 register->retire cycles for OTHER ids through the coordinator's
    // real registration/unpin seams. Assert:
    //   runtime_for_live(live_id) is Some,
    //   observe_server_message(TerminalOutput{ live_id, ..., runtime: None }) fills runtime
    //   and the contract gate passes (frame delivered by the enrichment path),
    //   retired cache length is clamped to the 1,024 window.
}

#[tokio::test]
async fn pty_exit_unpins_descriptor_into_the_bounded_retired_store() {
    // Via the WS harness: terminal kind restart, kill the replacement PTY, and assert the
    // descriptor lands in the retired store (late frames still fenced) instead of pinning forever.
}
```

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-ws --test restart_protocol -- descriptor`

Expected: FAIL — after >1,024 churn the live descriptor is evicted by the single FIFO (today's `descriptor_by_live` eviction path removes it), so enrichment yields `runtime: None` and the framed assert fails.

- [ ] **Step 3: Add the minimal production implementation**

1. `RuntimeOwnership` (:204-224): add `live_descriptors: HashMap<(AgentRuntimeKind, String), RuntimeDescriptor>`; rename the retired half's storage usage — concrete mapping: keep `descriptor_by_live` as the LIVE store (unpruned) and add `retired_descriptors` + `retired_descriptor_order: VecDeque<(AgentRuntimeKind, String)>`. The `retired_live` set is replaced by membership checks against `retired_descriptors` (delete the separate set once all reads route through it).
2. `prune_ownership_locked` (:1187-1231): prune ONLY `retired_descriptors` (pop oldest; also drop the retired membership) plus locators/aliases/generations as today; never touch `descriptor_by_live`.
3. Retirements (:1364 in `bind_locator_locked`, and the two replacement sites :2111-2114 / :2638-2642): move the entry from live to the retired store (FIFO-clamped) at exactly the places `retired_live.insert` happened.
4. `runtime_for_live` (:1405-1415): live first, then `retired_descriptors` (late frames).
5. `pub fn unpin_descriptor(&self, kind, runtime_id)`: move live → retired (no-op if absent; idempotent — double-calls are harmless); call it from the PTY exit hook where the identity retires (terminal.rs:2278 region) and extend `FreshRuntimeRegistry` (restart.rs:4411-4423) with `fn unregister_runtime(&self, provider: &str, durable_session_id: &str, live_runtime_id: &str) {}` — implemented by the coordinator to unpin.

**Load-bearing finding (LB-10 = verified):** the fresh-agent removal sites are now enumerated; the unpin call set is exactly:
- create lease-revoke teardown: codex.rs:1011, claude.rs:636
- `freshAgent.kill`: codex.rs:1878, claude.rs:784, opencode_ws.rs:1080-1082
- attach-resume lease-revoke teardown: codex.rs:3433, claude.rs:1785
- claude sidecar consumer-exit eviction (death-without-rebind — the easy-to-miss one): claude.rs:1991-2000
- retirement `Stopped` map removal: codex.rs:2102-2106, claude.rs:~1000-1010, opencode_ws.rs:1280-1283
- Do NOT unpin at: watcher arms (codex.rs:4384/4404 — sessions entry retained for lazy respawn), codex crash self-heal (sessions stays mapped with `exited=true`; unpin lands on its later kill/rebind), quarantine-install moves (alias moves only), or shutdown sweeps (process dying anyway).
6. Preserve persisted surface: the retired store stays in-memory like today's descriptors (no journal format change).

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-ws --test restart_protocol -- descriptor`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Document the invariant on the structs: "live descriptors are pinned while their runtime is registered; capacity pruning only applies to retired descriptors." Assert debugging aid: `retained_ownership_counts` probe (:1254) reports both stores; `cargo fmt`.

- [ ] **Step 6: Run impacted-test verification**

Impacted: enrichment/contract gate, register/rebind/retire flows, ownership retention tests (:2810, :2850), attach/inventory surfaces that consult descriptors.

Run: `cargo test -p freshell-ws --test restart_protocol && cargo test -p freshell-ws --test max_payload && cargo test -p freshell-ws --lib restart::`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ws/src/restart.rs crates/freshell-ws/src/terminal.rs crates/freshell-freshagent/src/claude.rs crates/freshell-freshagent/src/codex.rs crates/freshell-freshagent/src/opencode_ws.rs crates/freshell-ws/tests/restart_protocol.rs
git commit -m "fix(restart): pin live runtime descriptors apart from the bounded retired history cache"
```

---

### Task 10: Terminal restart-retirement tombstone lifecycle (backend subreview item)

`TerminalRegistry::restart_retiring_terminals` (crates/freshell-terminal/src/registry.rs:648) has `mark` (`:1732-1747`) and `is` (`:1751-1756`) but no removal: every restarted pane's tombstone lives for the server process's lifetime, and kill-path restarts never even emit a consumable `CrashEvent` (terminal.rs:2343-2365). After this task tombstones are consumed at their suppression points and abandoned entries are FIFO-bounded.

**Files:**
- Modify: `crates/freshell-terminal/src/registry.rs` (set→struct with insertion order; `consume_restart_retiring`; FIFO cap 4,096 with warn on eviction)
- Modify: `crates/freshell-ws/src/auto_resume.rs:623-626,651-657` (consume on suppress)
- Modify: `crates/freshell-ws/src/terminal.rs:2344-2364` (consume in the expected-exit suppression branch)
- Test: `crates/freshell-terminal/src/registry.rs` (:3560-3582 survives-removal pin + new consume/cap tests), `crates/freshell-ws/src/auto_resume.rs:1672-1700` (existing suppression test now asserts consumption)

**Interfaces:**
- Produces: `pub fn consume_restart_retiring(&self, terminal_id: &str) -> bool`; bounded `RestartRetiringSet { set: HashSet<String>, order: VecDeque<String> }`.
- Consumes: existing mark/is callers (unchanged signatures).

- [ ] **Step 1: Write the failing behavioral tests**

```rust
// crates/freshell-terminal/src/registry.rs
#[test]
fn consume_restart_retiring_removes_the_tombstone_once() {
    let reg = TerminalRegistry::new(..test shape as :3560..);
    reg.mark_restart_retiring("T-1");
    assert!(reg.consume_restart_retiring("T-1"));
    assert!(!reg.is_restart_retiring("T-1"));
    assert!(!reg.consume_restart_retiring("T-1")); // idempotent second consume
}

#[test]
fn abandoned_restart_retiring_tombstones_are_fifo_bounded() {
    // mark 4_097 ids without consuming; assert oldest evicted, warn logged,
    // len clamped to 4_096, and order tracked.
}
```

Auto-resume consumption proof — **load-bearing correction (LB-09 = falsified-as-designed):** the paused hub-test harness (auto_resume.rs:1672-1700) drives `FakeDriver` (:1251/:1351-1370) whose `pre_respawn_guard`/`resumable_session_ref` return canned values with no `TerminalRegistry` at all — extending it could never fail when the production wiring is missing. Leave that harness untouched and instead write tests against the real targets: (a) `WsAutoResumeDriver::pre_respawn_guard`/`resumable_session_ref` unit-ish tests backed by a fresh REAL `TerminalRegistry` with a marked tombstone — assert the tombstone is consumed after the settle; (b) the exit-hook suppression path (terminal.rs:2344-2364) consuming the tombstone (WS-harness or registry-level drive of the hook branch); plus the two registry unit tests above.

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-terminal restart_retiring && cargo test -p freshell-ws auto_resume::tests::restart_retiring`

Expected: FAIL — no consume API / no unpin (behavioral red), and no FIFO bound (red on cap assertions).

- [ ] **Step 3: Add the minimal production implementation**

registry.rs:

```rust
const MAX_RESTART_RETIRING_TOMBSTONES: usize = 4_096;

struct RestartRetiringSet { set: HashSet<String>, order: VecDeque<String> }

pub fn consume_restart_retiring(&self, terminal_id: &str) -> bool {
    let mut tombstones = self.restart_retiring_terminals.lock().expect(...);
    // remove from `set`; if present, also remove from `order` (swap_remove by position is
    // fine at this size; or order-rebuild on consume — implementer's choice, documented)
}

// mark_restart_retiring gains: on insert past the cap, pop the oldest with
// tracing::warn!("terminal.restart_retiring_tombstone_evicted").
```

Consume at the three suppression points: exit-hook expected-exit branch (terminal.rs:2359-2364), `resumable_session_ref` returning `None` for a tombstoned id (auto_resume.rs:623-626), and `pre_respawn_guard`'s `Some("restart_retiring")` settle (:655). Safety note (record in code comment): terminal ids are never reused within a boot (registry.rs:642-648) and post-commit stale events are fenced by `pre_respawn_guard`'s `session_owned_live` check (auto_resume.rs:659-666).

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-terminal restart_retiring && cargo test -p freshell-ws auto_resume::tests::restart_retiring`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Keep `is_restart_retiring` as the read-only probe (used by tests/diagnostics); `cargo fmt`.

- [ ] **Step 6: Run impacted-test verification**

Impacted: terminal exit hooks, auto-resume hub, codex managed-launch sibling set (must stay consume-on-success/retain-on-failure: `freshell-codex` launch_lifecycle tests :620-690).

Run: `cargo test -p freshell-terminal && cargo test -p freshell-ws auto_resume && cargo test -p freshell-codex --features real-transport --test launch_lifecycle restart`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-terminal/src/registry.rs crates/freshell-ws/src/auto_resume.rs crates/freshell-ws/src/terminal.rs
git commit -m "fix(terminal): consume restart-retirement tombstones at suppression points and bound abandoned entries"
```

---

### Task 11: Acceptance gates

Whole-feature acceptance lane; red/green is N/A per se — this task's "failing first" state is any regression the earlier tasks missed.

**Files:**
- None (verification only; allowed touch: `docs/plans/` history note if a gate output must be archived — keep in `<logs_dir>` instead)

**Interfaces:**
- Consumes: all previous tasks.

- [ ] **Step 1: Focused Rust suites**

Run:
```bash
cargo test -p freshell-ws --test restart_protocol
cargo test -p freshell-ws --lib restart::
cargo test -p freshell-freshagent --lib   # must TERMINATE and pass (Task 1 hang fixed; external `timeout 1200`)
cargo test -p freshell-server boot_recovery
cargo test -p freshell-codex --features real-transport --test launch_lifecycle restart
cargo test -p freshell-terminal
cargo test -p freshell-ws --test restore_plan_queue_cap && cargo test -p freshell-ws --test max_payload
```

Expected: all PASS. Additionally run the destructive lease suite in the sandbox and record its result in the progress ledger (it has 5 pre-existing host failures): `scripts/sandbox-test.sh "cargo test -p freshell-ws --test freshagent_session_lease"`.

- [ ] **Step 2: Rust hygiene**

Run: `cargo clippy --workspace --all-targets -- -D warnings && cargo clippy -p freshell-codex --features real-transport --all-targets -- -D warnings && cargo clippy -p freshell-opencode --features real-transport --all-targets -- -D warnings && cargo fmt --check && git diff --check`

Expected: PASS (zero warnings).

- [ ] **Step 3: Coordinated suite**

Run: `npm run check` (coordinated full suite: typecheck + client/server/electron vitest lanes)

Expected: PASS or exit 1 whose parsed failure identities are a subset of the baseline ledger's four pre-existing failures (FreshAgentView 429 snapshot; three vite-config getNetworkHost).

- [ ] **Step 4a: Scope assertions**

Run: `git diff --name-only 398a866f527909e37e68c46424a5d3a77951cf60...HEAD -- server/ node_modules/ | wc -l` → Expected: 0 (Node backend untouched), and `git diff --name-only 398a866f...HEAD` shows only `crates/`, `src/`, `test/`, `docs/` paths.

- [ ] **Step 4b: Chromium smoke on a scratch port (never 3001/3002)**

Run:
```bash
scripts/launch-rust.sh --port 3499        # builds + starts from THIS worktree
curl -sf http://127.0.0.1:3499/api/health
/usr/bin/google-chrome --headless=new --disable-gpu --dump-dom 'http://127.0.0.1:3499/?token='"$(grep '^AUTH_TOKEN=' .env | cut -d= -f2-)" | grep -q '<div id="root"'
scripts/launch-rust.sh --stop --port 3499
```

Expected: health OK; DOM contains the app root; clean stop.

- [ ] **Step 5: Commit the task**

Only commit if step artifacts landed in-repo (they should not; evidence lives in `<logs_dir>`). If any gate required a code fix, that fix belongs to the task that introduced it — never here — except mechanical clippy/fmt fallout, which may be fixed here and committed:

```bash
git commit -am "chore(restart): gate-driven clippy/fmt fixes for restart hardening"
```

---

## Capability-shape and sequencing notes (non-task)

- New wire-additive `AgentRestartFailureCode` variants land in Tasks 3 (`UNSUPPORTED_PLATFORM`) and 7 (`OVERLOADED`). The client never switches exhaustively on the union (grep-verified: codes only appear in tests), and `AgentRestartFailed.message` is rendered generically, so no client code change is required for the new codes beyond Task 3's menu gate.
- Task ordering rationale: Task 1 unblocks the freshagent binary (all later evidence depends on it); 2→3 because gating depends on scan semantics; 4 before 5 so indeterminate-retained rows are driven immediately upon introduction; 6 before 7 because ingress admission reuses the transaction registry/latch; 7 before 8 because plan retention is bounded by the ingress caps; 9 and 10 are independent leaves after the core lands.
- Merge-carryover ambiguity flags (from the owner-branch merge of `1d591b723`, recorded in run-state.md) — reviewers/implementers should NOT "fix" these mid-task; flag to me if a task's code legitimately conflicts: claude ladder stays post-adopt (main pin); fenced plan lane bypasses the class/cancel budget queue; try_rebind ack speaks real tracked status + runtime; opencode compact settle frames now carry runtime; ejh6 raw guard now fence-first (legacy-only refusal / inert echo passthrough / pending-retirement SESSION_RESERVED); freshagent_session_lease destructive suite requires sandbox (5 host failures pre-existing, also failing on pure 1d591b723).
- Pre-existing vitest failures (baseline ledger) are identity-tracked; do not repair them to force green.

## Load-bearing validation record (Stage 2)

13 claims validated (2026-09-06): 2 verified (LB-10 unpin-site enumeration; LB-11 poison-lifecycle decision = clear-on-Complete), 10 falsified-as-designed with plan corrections applied in place (LB-01 codex test commands now carry `--features real-transport`; LB-02 shared 3s/2s join+drain deadline; LB-03 admission dedupes request_id before counting; LB-04 both watcher arms gated on quarantine membership; LB-06 latch re-checked under the transactions mutex; LB-07 driver keeps shutdown_started re-check; LB-08 moved driver tests re-sequenced with recreated helpers; LB-09 tombstone-consumption tests target real WsAutoResumeDriver+registry; LB-12 flood test drives the adapter directly; LB-13 gate tests isolated in their own test binary), 1 acceptable (LB-05 euid+egid predicate — residual self-hiding miss class is outside the threat model and unreachable via our own spawn paths; fix-4C stays optional follow-up). Halt: false. Ledger: `<logs_dir>/load-bearing-ledger.md`; evidence reports: `<logs_dir>/reports/load-bearing-finder.md`, `load-bearing-strategist.md`.





