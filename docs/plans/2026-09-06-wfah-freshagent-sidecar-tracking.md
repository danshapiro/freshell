# freshagent-lane Codex Sidecar Tracking (wfah) Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below. Code blocks are pre-implementation
> drafts: the source tree supersedes them once execution begins; only the
> prose (User Request, Goal, Architecture, Global Constraints, task intent)
> stays authoritative after execution.

## User Request

### Requested result

Eliminate freshagent-lane codex sidecar orphaning across unclean restarts:
after an unclean death of the Freshell server (crash, `kill -9`, or the 5s
`SHUTDOWN_HARD_TIMEOUT` force-exit at `crates/freshell-server/src/main.rs:1961`),
no codex app-server sidecar spawned by the freshagent lane
(`crates/freshell-freshagent/src/codex.rs::spawn_sidecar` — fresh-agent /
freshcodex panes) may be left running untracked. A later server generation must
identify every such survivor from durable records and reap it (or verifiably
retain it with a recorded reason) via the existing boot reconcile + sweep.

### Explicit constraints

- Extend the existing rust-codex-sidecars tracking
  (`crates/freshell-codex/src/sidecar_store.rs` + `sidecar_reconcile.rs` +
  `sidecar_sweep.rs`, store root `<home>/.freshell/rust-codex-sidecars/`) to the
  freshagent lane — the direction named by the work item. Persisting the
  in-memory `FreshAgentSessionLeases` alone is NOT a fix (it never identifies
  or reaps a process).
- Named root causes to close: freshagent sidecars write no durable record;
  `spawn_sidecar` relies on `kill_on_drop(true)` (`codex.rs:2523`) which is an
  in-process-only backstop; sidecar kills run only at graceful shutdown
  (`FreshCodexState::shutdown`, `codex.rs:446-463`, wired at `main.rs:1928`);
  the 5s force-exit calls `std::process::exit(1)` (`main.rs:2031-2037`), which
  skips every Drop; crash/`kill -9` runs nothing.
- The terminal-pane lane was fixed by
  `docs/plans/2026-08-10-codex-sidecar-lifecycle.md`; its behavior changes only
  where cross-lane safety requires: restore-time claims must never adopt a
  freshagent-lane record (and vice versa is vacuous — the freshagent lane gains
  no claim/reattach path in this change).
- Red/green/refactor TDD; comprehensive automated coverage (unit + server-level
  black-box); fix the system, not the symptom; structured tracing on every
  failure path (follow existing `freshagent.sidecar.*` / `sidecar_*` naming).
- Do not touch the three pre-existing baseline failures
  (`test/unit/vite-config.test.ts > getNetworkHost` x3) or any other
  pre-existing failure.
- `kill_on_drop(true)` on the freshagent spawn STAYS: the lane delivers no
  reattach, so no survivor may outlive the server by design of this lane;
  cross-restart handling is the store's job, not the child's lifetime flags.

### Accepted tradeoffs and residuals

- No reattach/claim of a previous generation's freshagent sidecar: a verified
  mid-turn survivor is retained with a recorded reason (existing sweep
  semantics) and reaped once idle on a later boot; within the grace window a
  resumed session spawns a replacement sidecar.
- The genuinely unclosable window (SIGKILL landing between the child's fork
  and the record write) is minimized by writing the record immediately after
  `spawn()` (before the WS handshake) and documented as a residual.
- If the store is disabled (flock contention, absent global, or non-Linux
  evidence stubs), today's behavior is unchanged (kill-on-drop only); the
  disabled-store boot error already logs loudly (`codex_sidecar_store_disabled`).
- The freshclaude lane shares the same in-memory-only posture and is out of
  scope for this work item.
- Graceful shutdown continues to kill freshagent sidecars (unchanged Node
  parity); this change adds record scrubbing on that path, never retention.

**Goal:** No freshagent-lane codex sidecar survives a server death untracked:
a later boot reaps verified-idle survivors (or retains verified mid-turn ones
with a recorded reason) through the existing rust-codex-sidecars machinery.

**Architecture:** Record-on-spawn, scrub-on-reap, filter-on-claim. The
freshagent lane writes a `CodexSidecarRecord` (with a new `lane` discriminator)
into the shared store immediately after `spawn()`, scrubs it on every reap path
(spawn-failure arms, the exit watcher's kill and crash arms, hence
`freshAgent.kill` and graceful shutdown), and enriches it with the served codex
thread id once known. The existing boot reconciler holds these rows but never
indexes them for terminal-pane claims (lane filter), and the existing
grace-delayed sweep reaps verified-idle ones. Nothing in `main.rs` boot wiring
changes; the machinery already runs.

**Tech Stack:** Rust (tokio), crates `freshell-codex` /
`freshell-freshagent` / `freshell-server`; cargo test (no nextest); the
existing Node fake app-server fixture
(`test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`).

## Global Constraints

- Rust toolchain per workspace (`rust-version = "1.96"`); no new crate
  dependencies (`tempfile = "3"` is already a dependency of freshell-freshagent
  and freshell-codex; `freshell-freshagent` already depends on `freshell-codex`
  with `features = ["real-transport"]`).
- The Darkforge QA gate and CI run `cargo fmt --check` + clippy legs but **no
  `cargo test`**. Every task therefore runs its focused and impacted cargo
  suites with real recorded pass counts; Task 6 runs the whole-workspace sweep.
  Per-task gates: `cargo fmt --all --check`,
  `cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings`,
  `cargo clippy -p freshell-codex --features real-transport --all-targets -- -D warnings`.
- Test hygiene (all existing convention): Linux-gate `/proc` assertions
  (`#![cfg(target_os = "linux")]` at the test-file top); signal only pids the
  test itself spawned and re-verified; ephemeral `127.0.0.1:0`-style ports
  only, never 3001/3001-3002; every spawned child carries `kill_on_drop(true)`
  or an equivalent cleanup guard.
- Tests mutating process-global env (`CODEX_CMD`, `FRESHELL_HOME`, fixture
  vars) serialize on the existing `ENV_LOCK`
  (`crates/freshell-freshagent/src/codex.rs:5802-5827`, reachable as
  `crate::codex::tests::ENV_LOCK` because `mod tests` is `pub(crate)`); the
  `IsolatedCodexEnvGuard` key list gains `"FRESHELL_HOME"` (one-line change).
- The process-global sidecar store handle is set exactly once per test via
  `set_codex_sidecar_store` under `ENV_LOCK` and restored to a disabled store
  on guard drop (there is no "unset" API; a disabled store is the documented
  identical-to-pre-store posture).
- Keep the existing `safe11_term22_shutdown_reaping.rs` graceful-shutdown test
  green and untouched in behavior (its codex leg IS a freshagent-lane sidecar
  and doubles as the tripwire that the graceful path still reaps within 5s);
  update only its stale header comment where it documents the freshagent lane
  as outside retention.
- The destructive server-kill black-box test follows
  `docs/development/test-sandbox.md`: sandbox-first via
  `scripts/sandbox-test.sh`; if the Docker sandbox is unavailable on this
  machine, use the documented host fallback (precedent:
  `docs/plans/2026-07-26-rust-wsl-crash-hardening.md`) and record the decision
  in the progress ledger.
- Known pre-existing failures to reproduce-then-ignore if encountered:
  `crates/freshell-ws/tests/auto_resume_e2e.rs` has 2 deterministic failures
  (recorded in the 2026-08-10 plan); two `freshell-server` network tests are
  order-flaky under WSL2 (parallel); the 3 vite-config baseline failures are
  npm-side only. None are touched by this work.
- No user-visible behavior change: `README.md` and `docs/index.html` need no
  updates.

## Stage-2 assumption list (load-bearing validation targets)

1. **Every `spawn_sidecar` success path reaches `spawn_exit_watcher`
   promptly**, and no post-spawn failure path can drop or kill the child
   without the watcher running (the record lives or dies with the watcher's
   scrub). Verify by walking all four spawn call sites
   (`codex.rs:577-635`, `:2038-2104`, `:2334-2336`, `:2824-2874` area) and
   their post-spawn error paths; if any path can orphan a record, the plan
   gains a scrub at that site instead of relying on the watcher.
2. **`crate::codex::tests::ENV_LOCK` is reachable from a sibling test module**
   (`pub(crate) mod tests`, `pub(crate) static ENV_LOCK`) — verified during
   planning; confirm by compiling the new test file.
3. **Fixture idleness**: the fake app-server reports no active thread for an
   unscripted thread (`thread/read` default status idle,
   `fake-app-server.mjs:372-399`, `threadStatuses` knob consulted only), so a
   killed-server's freshagent orphan sweeps to `Reaped` — not retained — in
   the Task-5 black-box. Verify by reading those fixture lines.
4. **Sandbox availability**: `docker version` — expected down on this machine;
   if so, Task 5 records the documented host-fallback run.
5. **Cargo-suite base state**: run, at the base commit, the suites the plan
   touches and record green receipts:
   `cargo test -p freshell-freshagent --lib codex` (long suite is fine),
   `cargo test -p freshell-codex --features real-transport sidecar`,
   `cargo test -p freshell-server --test safe11_term22_shutdown_reaping`.
   These become the regression reference for per-task runs.
6. **Store root path**: server boot constructs the store at
   `<FRESHELL_HOME>/.freshell/rust-codex-sidecars` (`main.rs:417-430`), which
   is what the Task-5 test asserts against; verify the exact join chain.
7. **Claim consumers**: enumerate every caller of `claim_for_session` so the
   lane filter's blast radius is exactly the terminal-pane restore path
   (verification: `grep -rn "claim_for_session" crates/`).

## Stage-2 corrections applied (load-bearing validation, 2026-09-06)

- **LB-1 FALSIFIED → Task 3 amended.** The watcher arms do not cover every
  reap: between a successful `spawn_sidecar` and watcher construction, every
  call site has explicit bail arms that `start_kill` +
  `reap_owned_codex_sidecars` the child directly (thread-RPC failure arms at
  codex.rs:664-665, :767-768, :787-788, :865-867, :2172-2173, :2193-2194,
  :2209-2210, :2353-2354, :2930-2931, :2955-2956, and `shut_down_fork_child`
  :4070-4079). Task 3 now scrubs at every `reap_owned_codex_sidecars` site in
  the lane and adds `create_bail_after_spawn_leaves_no_record` (behavioral
  RED). No alive-child-without-watcher hole exists; the scrub extension is
  litter/invariant discipline, not an orphan-leak fix. Evidence:
  `<logs_dir>/reports/load-bearing-validator-spawn-and-fixture.md`.
- LB-2..LB-7 verified as planned: ENV_LOCK reachable (pub(crate) mod tests +
  static); fixture reports idle/no-loaded-threads by default ⇒ the Task-5
  orphan sweeps to Reaped; store root `<FRESHELL_HOME>/.freshell/rust-codex-sidecars`
  (main.rs:417-430); one production claim consumer (runtime_select.rs:32);
  sandbox unavailable (docker daemon permission denied) ⇒ documented host
  fallback for Task 5; base cargo receipts recorded in
  `<logs_dir>/reports/load-bearing-base-cargo.md` (freshagent 115/0, safe11
  1/0, codex sidecar 33/1 with pre-existing parallel flake
  `sidecar_store::tests::verify_identity_confirms_own_spawned_child`,
  isolation-PASS repro receipt therein).

---

### Task 1: SidecarLane discriminator + never-claim-freshagent-records

**Files:**
- Modify: `crates/freshell-codex/src/sidecar_store.rs` (record field, lane enum, getter visibility)
- Modify: `crates/freshell-codex/src/sidecar_reconcile.rs` (claimable criterion)
- Test: `crates/freshell-codex/src/sidecar_store_tests.rs`
- Test: `crates/freshell-codex/src/sidecar_reconcile_tests.rs`

**Interfaces:**
- Consumes: existing `CodexSidecarRecord`, `SidecarReconciler::boot_reconcile`, `claim_for_session`, `sidecar_test_support::{store_in, spawn_own_sleep_child, ChildGuard}`.
- Produces: `pub enum SidecarLane { TerminalPane, FreshAgent }` (serde `rename_all = "camelCase"`); `CodexSidecarRecord.lane: Option<SidecarLane>`; `pub fn codex_sidecar_store() -> Option<Arc<CodexSidecarStore>>` (was `pub(crate)`); claim guarantee: records with `lane == Some(FreshAgent)` are never claimable.

- [ ] **Step 1: Write the failing behavioral test**

In `sidecar_reconcile_tests.rs` (verbatim intent; reuse this file's existing test-support imports exactly as its other tests do):

```rust
/// wfah: a `lane:"freshAgent"` row carrying valid live identity evidence and a
/// session id must be HELD (sweep fate) but NEVER indexed/claimable —
/// terminal-pane restores must not adopt fresh-agent-lane sidecars.
#[tokio::test]
async fn boot_reconcile_never_indexes_freshagent_lane_records_for_claim() {
    let child = spawn_own_sleep_child();
    let pid = child.0.id();
    let dir = tempfile::tempdir().expect("temp store root");
    let store = store_in(&dir);
    // Hand-written row, exactly as a previous freshagent generation will have
    // written it. serde ignores unknown fields — including today's missing
    // `lane` — so RED sees the row as claimable terminal-pane state.
    std::fs::write(
        dir.path().join("codex-sidecar-freshagent-lane.json"),
        serde_json::to_string_pretty(&serde_json::json!({
            "recordVersion": 1,
            "ownershipId": "codex-sidecar-freshagent-lane",
            "pid": pid,
            "starttime": proc_starttime(pid as i32).expect("live child starttime"),
            "cmdline": proc_cmdline(pid as i32).expect("live child cmdline"),
            "wsUrl": "ws://127.0.0.1:9",
            "sessionId": "thread-from-freshagent",
            "serverInstanceId": "srv-prev",
            "createdAt": 1,
            "updatedAt": 1,
            "state": { "kind": "active" },
            "lane": "freshAgent",
        }))
        .unwrap(),
    )
    .unwrap();

    let (reconciler, report) = SidecarReconciler::boot_reconcile(store);
    assert_eq!(report.pruned_dead + report.pruned_mismatch, 0, "live evidence is not pruned");
    assert_eq!(report.held, 1, "the freshagent row is held for the sweep");

    let claimed = reconciler.claim_for_session("thread-from-freshagent").await;
    assert!(claimed.is_none(), "freshagent-lane records are never claimable, got {claimed:?}");
    assert_eq!(reconciler.unclaimed_len(), 1, "still held after the refused claim");
}
```

And in `sidecar_store_tests.rs`:

```rust
#[test]
fn lane_field_roundtrips_and_legacy_rows_decode_with_lane_none() {
    let legacy = serde_json::json!({
        "recordVersion": 1,
        "ownershipId": "codex-sidecar-legacy",
        "pid": 424242,
        "starttime": 123456789,
        "cmdline": ["codex", "app-server", "--listen", "ws://127.0.0.1:9"],
        "wsUrl": "ws://127.0.0.1:9",
        "serverInstanceId": "srv-prev",
        "createdAt": 1,
        "updatedAt": 1,
        "state": { "kind": "active" },
    });
    let record: CodexSidecarRecord =
        serde_json::from_value(legacy).expect("legacy row decodes");
    assert_eq!(record.lane, None, "rows written before the lane field decode as terminal-pane");

    let with_lane = CodexSidecarRecord { lane: Some(SidecarLane::FreshAgent), ..record };
    let json = serde_json::to_string(&with_lane).expect("serialize");
    assert!(json.contains("\"lane\":\"freshAgent\""));
    let back: CodexSidecarRecord = serde_json::from_str(&json).expect("roundtrip");
    assert_eq!(back.lane, Some(SidecarLane::FreshAgent));
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-codex --features real-transport never_indexes_freshagent`

Expected: FAIL because today serde ignores the unknown `lane` key, the row is
indexed as claimable, and `claim_for_session("thread-from-freshagent")` returns
`Some(record)` — the exact cross-lane adoption the field prevents. (The store
roundtrip test does not compile until the API exists; that is an allowed
API-additive red — the reconcile test carries the behavioral red.)

- [ ] **Step 3: Add the minimal production implementation**

In `sidecar_store.rs`, after `SidecarRecordState`:

```rust
/// Which spawning lane owns a recorded sidecar. `None` decodes every row
/// written before this field existed — all of them terminal-pane writes —
/// and the claim path must treat `None`/`TerminalPane` identically forever.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SidecarLane {
    /// `SpawnedCodexAppServerRuntime` (terminal-pane codex sessions).
    TerminalPane,
    /// `FreshCodexState::spawn_sidecar` (freshcodex fresh-agent panes).
    FreshAgent,
}
```

Add to `CodexSidecarRecord` (after `state`):

```rust
    /// Spawning lane. Absent (`None`) on all pre-existing rows; `None` means
    /// terminal-pane for claim purposes and must keep meaning that.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lane: Option<SidecarLane>,
```

Widen the global getter (`sidecar_store.rs:367` area): `pub(crate) fn
codex_sidecar_store` becomes `pub fn codex_sidecar_store`, extending its doc
comment with: "Also read by the freshagent lane (freshell-freshagent), which
writes `Some(SidecarLane::FreshAgent)` records at spawn."

Re-export `SidecarLane` in `crates/freshell-codex/src/lib.rs` alongside the
existing `sidecar_store` re-exports.

In `sidecar_reconcile.rs`, `boot_reconcile`'s claimable computation:

```rust
let claimable = verdict == IdentityVerdict::Verified
    && record.session_id.is_some()
    && record.lane != Some(SidecarLane::FreshAgent);
```

with a comment: "freshagent-lane records are sweep-only: they are never
claimed by terminal-pane restores (wfah)."

Existing constructors (`launch_lifecycle.rs` record build, test support
`record_for_child`) keep `lane: None` — terminal-lane rows serialize
byte-identically to before.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-codex --features real-transport never_indexes_freshagent && cargo test -p freshell-codex --features real-transport lane_field_roundtrips`

Expected: PASS (2 tests).

- [ ] **Step 5: Refactor while green**

None expected — three localized changes. If `verify_and_fast_claim` +
`claim_first_still_held` duplicate-arm probes ever learn a lane parameter,
still refuse it for freshagent rows; today a lane can never enter
`by_session`, so no further changes.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: every consumer of the reconciler, the store schema, and the
black-box harness around boot wiring:

Run:
```
cargo test -p freshell-codex --features real-transport && \
cargo test -p freshell-ws --test codex_sidecar_reattach_e2e && \
cargo test -p freshell-server --test safe11_term22_shutdown_reaping && \
cargo fmt --all --check && \
cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings && \
cargo clippy -p freshell-codex --features real-transport --all-targets -- -D warnings
```

Expected: all PASS; record the real pass counts in the progress ledger.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-codex/src/sidecar_store.rs \
        crates/freshell-codex/src/sidecar_reconcile.rs \
        crates/freshell-codex/src/lib.rs \
        crates/freshell-codex/src/sidecar_store_tests.rs \
        crates/freshell-codex/src/sidecar_reconcile_tests.rs
git commit -m "feat(codex): lane discriminator on sidecar records; freshagent rows never claimable (wfah T1)"
```

---

### Task 2: freshagent tracking module + record-on-spawn + spawn-failure scrubs

**Files:**
- Create: `crates/freshell-freshagent/src/codex_sidecar_tracking.rs`
- Create: `crates/freshell-freshagent/src/codex_sidecar_tracking_tests.rs`
- Modify: `crates/freshell-freshagent/src/lib.rs` (one `pub(crate) mod` line)
- Modify: `crates/freshell-freshagent/src/codex.rs:2478-2579` (`spawn_sidecar`
  record write + three failure-arm scrubs) and its `IsolatedCodexEnvLock` key
  list (~`:7742`, add `"FRESHELL_HOME"`)

**Interfaces:**
- Consumes: `freshell_codex::sidecar_store::{codex_sidecar_store, set_codex_sidecar_store (tests only), proc_starttime, proc_cmdline, CodexSidecarRecord, CodexSidecarStore, SidecarLane, SidecarRecordState, SIDECAR_RECORD_VERSION, verify_sidecar_identity, IdentityVerdict}`, `freshell_codex::durability::default_server_instance_id`.
- Produces: `pub(crate) async fn record_spawned_sidecar(ownership_id: &str, pid: u32, ws_url: &str)`; `pub(crate) fn scrub_sidecar_record(ownership_id: &str)`; `pub(crate) fn enrich_record_session_id(ownership_id: &str, thread_id: &str)` (used by Tasks 3-4). No other lane behavior changes.

- [ ] **Step 1: Write the failing behavioral tests**

Create `codex_sidecar_tracking_tests.rs` (wired from the new module:
`#[cfg(test)] #[path = "codex_sidecar_tracking_tests.rs"] mod codex_sidecar_tracking_tests;`):

```rust
//! Cross-restart tracking tests for freshagent-lane codex sidecars (wfah).
//! Linux-only: identity evidence is /proc-based. Every test serializes on
//! `crate::codex::tests::ENV_LOCK` because the store handle is process-global
//! and the spawn tests mutate `CODEX_CMD` — this guarantees no codex.rs spawn
//! test runs concurrently (they all take ENV_LOCK for the same keys).
#![cfg(target_os = "linux")]

use std::sync::Arc;

use freshell_codex::sidecar_store::{
    proc_cmdline, proc_starttime, set_codex_sidecar_store, verify_sidecar_identity,
    CodexSidecarStore, IdentityVerdict, SidecarLane, SidecarRecordState,
};
use serde_json::{json, Value};

use crate::codex::tests::ENV_LOCK;
use crate::codex_sidecar_tracking::{
    enrich_record_session_id, record_spawned_sidecar, scrub_sidecar_record,
};
use freshell_protocol::FreshAgentCreate; // same path codex.rs uses (re-exported from client_messages)
use crate::FreshCodexState; // pub use codex::FreshCodexState (lib.rs:67)

/// Installs a tempdir store as the process-global handle for this test and
/// restores the "nothing installed" posture (a disabled store — the
/// documented identical-to-pre-store fallback) on drop.
struct TrackingStoreGuard {
    _dir: tempfile::TempDir,
    store: Arc<CodexSidecarStore>,
}

impl TrackingStoreGuard {
    fn install() -> Self {
        let dir = tempfile::tempdir().expect("temp sidecar store root");
        let store = Arc::new(CodexSidecarStore::new(dir.path().to_path_buf()));
        assert!(store.is_enabled(), "tempdir stores are always writable");
        set_codex_sidecar_store(store.clone());
        Self { _dir: dir, store }
    }
    fn records(&self) -> Vec<freshell_codex::sidecar_store::CodexSidecarRecord> {
        self.store.load_all()
    }
}

impl Drop for TrackingStoreGuard {
    fn drop(&mut self) {
        set_codex_sidecar_store(Arc::new(CodexSidecarStore::disabled()));
    }
}

fn fake_codex_cmd() -> String {
    format!(
        "node {}/../../test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs",
        env!("CARGO_MANIFEST_DIR")
    )
}

fn spawn_sleep_child() -> tokio::process::Child {
    let mut cmd = tokio::process::Command::new("sleep");
    cmd.arg("300");
    cmd.kill_on_drop(true);
    cmd.spawn().expect("spawn sleep fixture")
}

fn tracking_state() -> (FreshCodexState, tokio::sync::broadcast::Receiver<String>) {
    let (tx, rx) = tokio::sync::broadcast::channel::<String>(64);
    let st = FreshCodexState::new(
        Arc::new("tok".to_string()),
        Arc::new(tx),
        json!({ "freshAgent": { "enabled": false } }),
    );
    (st, rx)
}

async fn create_tracked_session(
    st: &FreshCodexState,
    rx: &mut tokio::sync::broadcast::Receiver<String>,
    request_id: &str,
) -> String {
    st.handle_create(FreshAgentCreate {
        request_id: request_id.to_string(),
        session_type: freshell_protocol::SessionType::Freshcodex,
        provider: Some(freshell_protocol::AgentProvider::Codex),
        cwd: None,
        legacy_restore_context: None,
        resume_session_id: None,
        session_ref: None,
        model: None,
        model_selection: None,
        permission_mode: None,
        sandbox: None,
        effort: None,
        plugins: None,
    })
    .await;
    let frame: Value = tokio::time::timeout(std::time::Duration::from_secs(20), async {
        loop {
            let frame: Value =
                serde_json::from_str(&rx.recv().await.expect("bus stays open")).expect("valid json");
            if frame["type"] == "freshAgent.created" || frame["type"] == "freshAgent.create.failed" {
                return frame;
            }
        }
    })
    .await
    .expect("fixture create responds within the budget");
    assert_eq!(frame["type"], "freshAgent.created", "fixture create failed: {frame}");
    frame["sessionId"].as_str().expect("sessionId").to_string()
}

#[tokio::test]
async fn spawn_record_carries_verifiable_proc_identity_and_freshagent_lane() {
    let _env = ENV_LOCK.lock().await;
    let guard = TrackingStoreGuard::install();
    let mut child = spawn_sleep_child();
    let pid = child.id().expect("spawned pid");

    record_spawned_sidecar("codex-sidecar-wfah-t2", pid, "ws://127.0.0.1:1").await;

    let records = guard.records();
    assert_eq!(records.len(), 1, "exactly one record written");
    let record = &records[0];
    assert_eq!(record.ownership_id, "codex-sidecar-wfah-t2");
    assert_eq!(record.pid, pid);
    assert_eq!(record.lane, Some(SidecarLane::FreshAgent));
    assert_eq!(record.state, SidecarRecordState::Active);
    assert_eq!(record.session_id, None, "thread id unknown at spawn time");
    assert_eq!(record.ws_url, "ws://127.0.0.1:1");
    assert_eq!(record.cmdline, proc_cmdline(pid as i32).unwrap());
    assert_eq!(record.starttime, proc_starttime(pid as i32).unwrap());
    assert_eq!(
        verify_sidecar_identity(record),
        IdentityVerdict::Verified,
        "a record must identify the very process it was written for"
    );
    let _ = child.start_kill();
}

#[tokio::test]
async fn record_is_skipped_cleanly_when_no_store_is_installed() {
    let _env = ENV_LOCK.lock().await;
    let guard = TrackingStoreGuard::install();
    // Stage the disabled posture the same way production falls back to it.
    drop(guard);
    let mut child = spawn_sleep_child();
    let pid = child.id().expect("spawned pid");
    record_spawned_sidecar("codex-sidecar-wfah-disabled", pid, "ws://127.0.0.1:1").await;
    // No panic, no record write possible; the disabled store swallows writes.
    let _ = child.start_kill();
}

#[tokio::test]
async fn create_writes_a_freshagent_laned_record_for_the_real_sidecar() {
    let _env = ENV_LOCK.lock().await;
    std::env::set_var("CODEX_CMD", fake_codex_cmd());
    let guard = TrackingStoreGuard::install();
    let (st, mut rx) = tracking_state();

    let session_id = create_tracked_session(&st, &mut rx, "req-wfah-t2-create").await;
    assert!(!session_id.is_empty());

    let records = guard.records();
    assert_eq!(records.len(), 1, "exactly the spawned sidecar is tracked: {records:?}");
    let record = &records[0];
    assert_eq!(record.lane, Some(SidecarLane::FreshAgent));
    assert!(std::path::Path::new(&format!("/proc/{}", record.pid)).exists(),
        "recorded pid must be live right after create");
    assert!(record.cmdline.iter().any(|a| a.contains("fake-app-server")),
        "recorded cmdline must identify the fixture sidecar, got {:?}", record.cmdline);
    assert_eq!(verify_sidecar_identity(record), IdentityVerdict::Verified);

    st.shutdown().await; // scrubs the record only once Task 3's wiring lands
}

#[tokio::test]
async fn failed_spawn_leaves_no_record() {
    let _env = ENV_LOCK.lock().await;
    // Exits ~0.2s in without ever listening: spawn_sidecar returns Err via the
    // "exited before listening" arm.
    std::env::set_var("CODEX_CMD", "sh -c 'sleep 0.2'");
    let guard = TrackingStoreGuard::install();
    let (st, mut rx) = tracking_state();

    st.handle_create(FreshAgentCreate {
        request_id: "req-wfah-t2-fail".to_string(),
        session_type: freshell_protocol::SessionType::Freshcodex,
        provider: Some(freshell_protocol::AgentProvider::Codex),
        cwd: None,
        legacy_restore_context: None,
        resume_session_id: None,
        session_ref: None,
        model: None,
        model_selection: None,
        permission_mode: None,
        sandbox: None,
        effort: None,
        plugins: None,
    })
    .await;
    let frame: Value = tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            let frame: Value =
                serde_json::from_str(&rx.recv().await.expect("bus")).expect("json");
            if frame["type"] == "freshAgent.created" || frame["type"] == "freshAgent.create.failed" {
                return frame;
            }
        }
    })
    .await
    .expect("failure frame within the budget");
    assert_eq!(frame["type"], "freshAgent.create.failed", "expected failure: {frame}");

    assert!(
        guard.records().is_empty(),
        "a failed spawn must scrub the record it optimistically wrote"
    );
}
```

- [ ] **Step 2: Run the tests and verify the intended failures**

Run: `cargo test -p freshell-freshagent --lib codex_sidecar_tracking`

Expected: FAIL — `create_writes_a_freshagent_laned_record_for_the_real_sidecar`
fails because no record is ever written today
(`freshell-codex` tracking is only visible to launch_lifecycle);
`spawn_record_carries_*`/`record_is_skipped_*` do not compile (new module APIs
— allowed API-additive red; the create-level test supplies the behavioral red).
`failed_spawn_leaves_no_record` compiles and passes only vacuously until the
record write lands — that is expected and is called out in Step 4.

- [ ] **Step 3: Add the minimal production implementation**

Create `crates/freshell-freshagent/src/codex_sidecar_tracking.rs`:

```rust
//! Durable cross-restart tracking for freshagent-lane codex sidecars (kata wfah).
//!
//! Every freshcodex sidecar (`FreshCodexState::spawn_sidecar`) is recorded in
//! the shared rust-codex-sidecars store the moment it is spawned, and scrubbed
//! whenever the lane reaps it, so the NEXT server generation's boot reconcile
//! + grace-delayed sweep (wired in `crates/freshell-server/src/main.rs`) always
//! sees this lane's survivors. Nothing in this module ever signals a process:
//! killing stays the sweep's job.

use std::sync::Arc;

use freshell_codex::durability::default_server_instance_id;
use freshell_codex::sidecar_store::{
    codex_sidecar_store, proc_cmdline, proc_starttime, CodexSidecarRecord, SidecarLane,
    SidecarRecordState, SIDECAR_RECORD_VERSION,
};

const PROVIDER: &str = "freshcodex";

/// Poll budget for `/proc/<pid>` evidence right after spawn: the fork/exec
/// window (empty cmdline) closes in milliseconds.
const EVIDENCE_POLL_BUDGET: std::time::Duration = std::time::Duration::from_millis(2000);
const EVIDENCE_POLL_STEP: std::time::Duration = std::time::Duration::from_millis(20);

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// Write a verified-identity `CodexSidecarRecord` for a just-spawned sidecar,
/// BEFORE its WS handshake completes (a server death mid-handshake must still
/// produce a tracked survivor). Never fails the spawn: no store, an unreadable
/// identity, or an io error are all logged loudly and leave today's
/// kill-on-drop-only posture in place for that child.
pub(crate) async fn record_spawned_sidecar(ownership_id: &str, pid: u32, ws_url: &str) {
    let Some(store) = codex_sidecar_store() else { return };
    if !store.is_enabled() {
        return;
    }
    if pid == 0 {
        tracing::warn!(provider = PROVIDER, ownership_id, "freshagent.sidecar.track_skipped: no pid");
        return;
    }

    let deadline = std::time::Instant::now() + EVIDENCE_POLL_BUDGET;
    let evidence = loop {
        match (proc_starttime(pid as i32), proc_cmdline(pid as i32)) {
            (Some(st), Some(cl)) if !cl.is_empty() => break Some((st, cl)),
            _ if std::time::Instant::now() >= deadline => break None,
            _ => tokio::time::sleep(EVIDENCE_POLL_STEP).await,
        }
    };
    let Some((starttime, cmdline)) = evidence else {
        tracing::warn!(
            provider = PROVIDER,
            ownership_id,
            pid,
            "freshagent.sidecar.track_skipped: /proc identity evidence unavailable within budget"
        );
        return;
    };

    let now = now_millis();
    let record = CodexSidecarRecord {
        record_version: SIDECAR_RECORD_VERSION,
        ownership_id: ownership_id.to_string(),
        pid,
        starttime,
        cmdline,
        ws_url: ws_url.to_string(),
        session_id: None,
        terminal_id: None,
        server_instance_id: default_server_instance_id(),
        created_at: now,
        updated_at: now,
        state: SidecarRecordState::Active,
        lane: Some(SidecarLane::FreshAgent),
    };
    match store.write(&record) {
        Ok(()) => {
            tracing::info!(provider = PROVIDER, ownership_id, pid, "freshagent.sidecar.tracked")
        }
        Err(err) => tracing::warn!(
            provider = PROVIDER,
            ownership_id,
            pid,
            error = %err,
            "freshagent.sidecar.track_write_failed"
        ),
    }
}

/// Remove a sidecar's record whenever the lane reaps it (requested kill, crash
/// arm, graceful shutdown, spawn-failure arm). Synchronous: the store's
/// lock-free + atomic single-writer remove matches the reconciler's internal
/// `remove_pruned` calls made under the same async discipline.
pub(crate) fn scrub_sidecar_record(ownership_id: &str) {
    let Some(store) = codex_sidecar_store() else { return };
    match store.remove(ownership_id) {
        Ok(()) => tracing::debug!(provider = PROVIDER, ownership_id, "freshagent.sidecar.untracked"),
        Err(err) => tracing::warn!(
            provider = PROVIDER,
            ownership_id,
            error = %err,
            "freshagent.sidecar.untrack_failed"
        ),
    }
}

/// Record which codex thread a tracked sidecar serves once the lane knows it
/// (watcher construction: the thread id is fixed at every successful spawn).
pub(crate) fn enrich_record_session_id(ownership_id: &str, thread_id: &str) {
    let Some(store) = codex_sidecar_store() else { return };
    let Some(mut record) =
        store.load_all().into_iter().find(|r| r.ownership_id == ownership_id)
    else {
        return; // never tracked (disabled store / skipped write) — fine
    };
    if record.session_id.as_deref() == Some(thread_id) {
        return;
    }
    record.session_id = Some(thread_id.to_string());
    record.updated_at = now_millis();
    if let Err(err) = store.write(&record) {
        tracing::warn!(
            provider = PROVIDER,
            ownership_id,
            session_id = %thread_id,
            error = %err,
            "freshagent.sidecar.enrich_failed"
        );
    }
}

#[cfg(test)]
#[path = "codex_sidecar_tracking_tests.rs"]
mod codex_sidecar_tracking_tests;
```

`lib.rs`: add `pub(crate) mod codex_sidecar_tracking;` beside `pub mod codex;`.

`codex.rs` — `spawn_sidecar`, immediately after `drain_child_io(&mut child);`
and before the WS connect loop:

```rust
        // wfah: durable tracking BEFORE the handshake — the record must exist
        // even while this sidecar's 45s startup budget is still running, or an
        // unclean server death would leave the child untracked.
        if let Some(pid) = child.id() {
            crate::codex_sidecar_tracking::record_spawned_sidecar(&ownership_id, pid, &ws_url)
                .await;
        }
```

`codex.rs` — all three `spawn_sidecar` failure arms gain a scrub ahead of the
return (the record exists from the optimistic write above):

```rust
if let Ok(Some(status)) = child.try_wait() {
    crate::codex_sidecar_tracking::scrub_sidecar_record(&ownership_id);
    return Err(format!("codex app-server exited before listening: {status}"));
}
...
if Instant::now() >= deadline {
    let _ = child.start_kill();
    reap_owned_codex_sidecars(&ownership_id);
    crate::codex_sidecar_tracking::scrub_sidecar_record(&ownership_id);
    return Err(format!("codex app-server WS never came up: {err}"));
}
...
if Instant::now() >= deadline {
    client.close().await;
    let _ = child.start_kill();
    reap_owned_codex_sidecars(&ownership_id);
    crate::codex_sidecar_tracking::scrub_sidecar_record(&ownership_id);
    return Err(format!("codex app-server initialize failed: {err}"));
}
```

`codex.rs` — `ISOLATED_CODEX_ENV_KEYS`: add `"FRESHELL_HOME"` so tests that
point the store at a temp HOME restore it on drop.

- [ ] **Step 4: Run the focused tests (in two halves — red between them proves the scrub)**

Run (a, record-write only — before the arm scrubs land if implemented in two
passes): `cargo test -p freshell-freshagent --lib codex_sidecar_tracking`

Intermediate expectation if the write is landed before the scrubs:
`failed_spawn_leaves_no_record` FAILS (record left behind) — proving the scrub
assertion is non-vacuous. Then land the arm scrubs.

Run (b): `cargo test -p freshell-freshagent --lib codex_sidecar_tracking`

Expected: PASS (4 tests).

- [ ] **Step 5: Refactor while green**

None expected. If the evidence-poll matches an existing helper exactly, share
it; otherwise keep the 6-line loop local (do not extract for one use).

- [ ] **Step 6: Run impacted-test verification**

Impacted set: the freshagent crate (spawn path changed for every session
creation), plus the codex tracking suites as smoke against the shared global
handle:

Run:
```
cargo test -p freshell-freshagent && \
cargo test -p freshell-codex --features real-transport sidecar && \
cargo fmt --all --check && \
cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings && \
cargo clippy -p freshell-codex --features real-transport --all-targets -- -D warnings
```

Expected: all PASS; record real pass counts in the progress ledger. (The crate
suite takes minutes; that is expected.)

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/codex_sidecar_tracking.rs \
        crates/freshell-freshagent/src/codex_sidecar_tracking_tests.rs \
        crates/freshell-freshagent/src/lib.rs \
        crates/freshell-freshagent/src/codex.rs
git commit -m "feat(freshagent): record codex sidecars in the durable store at spawn (wfah T2)"
```

---

### Task 3: scrub the record on every reap path (watcher kill + crash arms)

**Files:**
- Modify: `crates/freshell-freshagent/src/codex.rs:3859-3911` (`spawn_exit_watcher`: scrub in both arms; widen to `pub(crate)`)
- Test: `crates/freshell-freshagent/src/codex_sidecar_tracking_tests.rs` (append)

**Interfaces:**
- Consumes: Task 2's `scrub_sidecar_record`; Task 1's store.
- Produces: `pub(crate) fn spawn_exit_watcher(...)` (same signature as today); guarantee: after any of `freshAgent.kill`, unrequested exit, or `FreshCodexState::shutdown`, no record for the reaped ownership id remains.

Why the watcher instead of every call site: every sidecar kill flows through
the watcher — `handle_kill` sends `kill_tx`, `shutdown` sends `kill_tx` and
awaits the watcher, and an unrequested exit takes the `child.wait()` arm. Both
arms already call `reap_owned_codex_sidecars(&ownership_id)`; the record scrub
rides that exact line. This is also why `spawn_exit_watcher` becomes
`pub(crate)`: the direct-drive tests need it, and the widening carries zero
behavior change.

**Stage-2 correction (LB-1 falsified):** the watcher's two arms do NOT cover
every reap. Between a successful `spawn_sidecar` return (record already
written) and watcher construction, every call site has explicit bail arms that
`start_kill` + `reap_owned_codex_sidecars` the child directly — thread-RPC
failure arms (six sites at `codex.rs:664-665, :767-768, :787-788, :865-867,
:2172-2173, :2193-2194, :2209-2210, :2353-2354, :2930-2931, :2955-2956`) and
`shut_down_fork_child` (`codex.rs:4070-4079`). Those kills leave the freshly
written record behind (the dead pid is pruned at the next boot, so no orphan
leak — but litter rows violate this task's "scrub on every reap path"
invariant). The scrub therefore rides EVERY `reap_owned_codex_sidecars` call
in the freshagent lane, not just the watcher's. We do NOT put the scrub inside
`reap_owned_codex_sidecars` itself: that helper lives in `freshell-codex` and
is shared with the terminal-pane lane, which owns its record lifecycle
explicitly.

- [ ] **Step 1: Write the failing behavioral tests**

Append to `codex_sidecar_tracking_tests.rs`:

```rust
use std::sync::atomic::{AtomicBool, Ordering};

/// Build a tracked sleeper + exit watcher exactly as production does.
async fn build_recorded_watch(
    ownership_id: &str,
) -> (tokio::task::JoinHandle<()>, tokio::sync::oneshot::Sender<()>, u32) {
    let child = spawn_sleep_child();
    let pid = child.id().expect("spawned pid");
    record_spawned_sidecar(ownership_id, pid, "ws://127.0.0.1:1").await;
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(8);
    let (kill_tx, kill_rx) = tokio::sync::oneshot::channel();
    let watcher = crate::codex::spawn_exit_watcher(
        child,
        ownership_id.to_string(),
        "thread-wfah-t3".to_string(),
        Arc::new(tx),
        kill_rx,
        Arc::new(AtomicBool::new(false)),
        Arc::new(crate::session_lease::FreshAgentSessionLeases::new()),
    );
    (watcher, kill_tx, pid)
}

#[tokio::test]
async fn requested_kill_arm_removes_the_record() {
    let _env = ENV_LOCK.lock().await;
    let guard = TrackingStoreGuard::install();
    let (watcher, kill_tx, pid) = build_recorded_watch("codex-sidecar-wfah-t3-kill").await;
    assert_eq!(guard.records().len(), 1, "recorded before the kill");

    kill_tx.send(()).expect("kill channel open");
    watcher.await.expect("watcher completes");

    assert!(guard.records().is_empty(), "requested kill scrubs the record");
    assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists(),
        "the child itself is really gone");
}

#[tokio::test]
async fn unrequested_exit_arm_removes_the_record() {
    let _env = ENV_LOCK.lock().await;
    let guard = TrackingStoreGuard::install();
    let mut child = spawn_sleep_child();
    let pid = child.id().expect("spawned pid");
    record_spawned_sidecar("codex-sidecar-wfah-t3-crash", pid, "ws://127.0.0.1:1").await;
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(8);
    let (_kill_tx, kill_rx) = tokio::sync::oneshot::channel();
    let exited = Arc::new(AtomicBool::new(false));
    child.start_kill().expect("start_kill a live child"); // the "crash"

    let watcher = crate::codex::spawn_exit_watcher(
        child,
        "codex-sidecar-wfah-t3-crash".to_string(),
        "thread-wfah-t3".to_string(),
        Arc::new(tx),
        kill_rx,
        exited.clone(),
        Arc::new(crate::session_lease::FreshAgentSessionLeases::new()),
    );
    watcher.await.expect("watcher completes");

    assert!(guard.records().is_empty(), "the crash arm scrubs the record");
    assert!(exited.load(Ordering::SeqCst), "the crash arm flips the lazy-restart flag");
}

#[tokio::test]
async fn handle_kill_leaves_no_record() {
    let _env = ENV_LOCK.lock().await;
    std::env::set_var("CODEX_CMD", fake_codex_cmd());
    let guard = TrackingStoreGuard::install();
    let (st, mut rx) = tracking_state();
    let session_id = create_tracked_session(&st, &mut rx, "req-wfah-t3-kill").await;
    assert_eq!(guard.records().len(), 1);

    st.handle_kill(freshell_protocol::FreshAgentKill {
        provider: freshell_protocol::AgentProvider::Codex,
        session_id,
        session_type: freshell_protocol::SessionType::Freshcodex,
        cwd: None,
    })
    .await;

    assert!(
        guard.records().is_empty(),
        "freshAgent.kill reaps through the watcher, which scrubs"
    );
}

#[tokio::test]
async fn shutdown_leaves_no_records() {
    let _env = ENV_LOCK.lock().await;
    std::env::set_var("CODEX_CMD", fake_codex_cmd());
    let guard = TrackingStoreGuard::install();
    let (st, mut rx) = tracking_state();
    create_tracked_session(&st, &mut rx, "req-wfah-t3-shutdown-a").await;
    create_tracked_session(&st, &mut rx, "req-wfah-t3-shutdown-b").await;
    assert_eq!(guard.records().len(), 2);

    st.shutdown().await;

    assert!(
        guard.records().is_empty(),
        "graceful shutdown reaps the lane's sidecars AND their records"
    );
}

#[tokio::test]
async fn create_bail_after_spawn_leaves_no_record() {
    let _env = ENV_LOCK.lock().await;
    // thread/start errors AFTER spawn_sidecar returned OK: the lane takes the
    // pre-watcher bail arm, which kills the child directly. The freshly
    // written record must not linger.
    std::env::set_var(
        "FAKE_CODEX_APP_SERVER_BEHAVIOR",
        &json!({
            "overrides": {
                "thread/start": { "error": { "code": -32000, "message": "forced wfah bail" } }
            }
        })
        .to_string(),
    );
    std::env::set_var("CODEX_CMD", fake_codex_cmd());
    let guard = TrackingStoreGuard::install();
    let (st, mut rx) = tracking_state();

    st.handle_create(FreshAgentCreate {
        request_id: "req-wfah-t3-bail".to_string(),
        session_type: freshell_protocol::SessionType::Freshcodex,
        provider: Some(freshell_protocol::AgentProvider::Codex),
        cwd: None,
        legacy_restore_context: None,
        resume_session_id: None,
        session_ref: None,
        model: None,
        model_selection: None,
        permission_mode: None,
        sandbox: None,
        effort: None,
        plugins: None,
    })
    .await;
    let frame: Value = tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            let frame: Value =
                serde_json::from_str(&rx.recv().await.expect("bus")).expect("json");
            if frame["type"] == "freshAgent.created" || frame["type"] == "freshAgent.create.failed" {
                return frame;
            }
        }
    })
    .await
    .expect("failure frame within the budget");
    assert_eq!(frame["type"], "freshAgent.create.failed", "expected the bail: {frame}");

    assert!(
        guard.records().is_empty(),
        "a pre-watcher bail must scrub the record it wrote at spawn"
    );
}
```

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-freshagent --lib codex_sidecar_tracking`

Expected: FAIL — `requested_kill_arm_removes_the_record`,
`handle_kill_leaves_no_record`, `shutdown_leaves_no_records`, and
`create_bail_after_spawn_leaves_no_record` all fail because the record written
at spawn is removed on NONE of those reap paths today (the watcher's arms do
not exist yet and the bail arms never scrub). (`unrequested_exit_arm_*` does
not compile until `spawn_exit_watcher` is `pub(crate)` — API-additive red;
the kill/bail tests carry the behavioral red.)

- [ ] **Step 3: Add the minimal production implementation**

In `codex.rs::spawn_exit_watcher`, ride the existing reap lines in both arms:

```rust
            _ = kill_rx => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                reap_owned_codex_sidecars(&ownership_id);
                crate::codex_sidecar_tracking::scrub_sidecar_record(&ownership_id);
                leases.clear_binding(PROVIDER, &thread_id);
                ...existing log...
            }
            _ = child.wait() => {
                reap_owned_codex_sidecars(&ownership_id);
                crate::codex_sidecar_tracking::scrub_sidecar_record(&ownership_id);
                leases.clear_binding(PROVIDER, &thread_id);
                ...existing lines unchanged...
            }
```

Widen the signature: `fn spawn_exit_watcher(` → `pub(crate) fn
spawn_exit_watcher(` (visibility only; no behavior change).

Then, at EVERY pre-watcher bail arm that reaps a child this lane recorded
(stage-2 enumeration: the thread-RPC failure arms at `codex.rs:664-665`,
`:767-768`, `:787-788`, `:865-867`, `:2172-2173`, `:2193-2194`, `:2209-2210`,
`:2353-2354`, `:2930-2931`, `:2955-2956`, plus `shut_down_fork_child` at
`:4070-4079`), add the same one-liner immediately after the existing
`reap_owned_codex_sidecars(&ownership_id)` call:

```rust
crate::codex_sidecar_tracking::scrub_sidecar_record(&ownership_id);
```

(`shut_down_fork_child` carries whatever ownership id it already passes to
`reap_owned_codex_sidecars`.) Line numbers are guides; the anchor is "each
`reap_owned_codex_sidecars` call site in the freshagent lane".

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-freshagent --lib codex_sidecar_tracking`

Expected: PASS (9 tests total in the file).

- [ ] **Step 5: Refactor while green**

None expected — two one-line additions plus a visibility change. Confirm coverage: `grep -n "reap_owned_codex_sidecars" crates/freshell-freshagent/src/` — EVERY match must now sit adjacent to a `scrub_sidecar_record` call (failure arms from Task 2, watcher arms and bail arms from Task 3).

- [ ] **Step 6: Run impacted-test verification**

Impacted set: the whole freshagent lane (kill/shutdown flows), the lease e2e
(behavior around kills), and the server black-box that exercises graceful
shutdown of this exact code path:

Run:
```
cargo test -p freshell-freshagent && \
cargo test -p freshell-ws --test freshagent_session_lease && \
cargo test -p freshell-server --test safe11_term22_shutdown_reaping && \
cargo fmt --all --check && \
cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings && \
cargo clippy -p freshell-codex --features real-transport --all-targets -- -D warnings
```

Expected: all PASS; the safe11 graceful test proves records are scrubbed at
shutdown (its zero-orphan assertion already covers the process side). Record
real pass counts in the progress ledger.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/codex.rs \
        crates/freshell-freshagent/src/codex_sidecar_tracking_tests.rs
git commit -m "fix(freshagent): scrub sidecar records on every reap path (wfah T3)"
```

---

### Task 4: thread-id enrichment + cross-generation hold/never-claim proof

**Files:**
- Modify: `crates/freshell-freshagent/src/codex.rs:3859-3911` (`spawn_exit_watcher` entry enrichment)
- Test: `crates/freshell-freshagent/src/codex_sidecar_tracking_tests.rs` (append)

**Interfaces:**
- Consumes: Task 2's `enrich_record_session_id`; Task 1's lane filter; `freshell_codex::sidecar_reconcile::SidecarReconciler` (pub).
- Produces: guarantee that a freshagent record carries the served codex thread id within the create flow, and that a NEXT-generation boot reconcile holds it for the sweep and never claims it for a terminal-pane restore.

Why watcher entry: the watcher is constructed once per successful spawn with
the definitive thread id, at every one of the four call sites, before any
thread RPC — one insertion point covers fresh create, resume-create,
attach-resume, and crash respawn.

- [ ] **Step 1: Write the failing behavioral tests**

Append to `codex_sidecar_tracking_tests.rs`:

```rust
use freshell_codex::sidecar_reconcile::SidecarReconciler;
use freshell_codex::sidecar_sweep::SweepOutcome;

#[tokio::test]
async fn create_enriches_the_record_with_the_served_thread_id() {
    let _env = ENV_LOCK.lock().await;
    std::env::set_var("CODEX_CMD", fake_codex_cmd());
    let guard = TrackingStoreGuard::install();
    let (st, mut rx) = tracking_state();

    let session_id = create_tracked_session(&st, &mut rx, "req-wfah-t4-enrich").await;

    // watcher construction performs the enrichment before the lane finishes
    // create; poll defensively (<=3s) for the store write to land.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        let records = guard.records();
        if records.len() == 1 && records[0].session_id.as_deref() == Some(session_id.as_str()) {
            break;
        }
        assert!(std::time::Instant::now() < deadline,
            "record not enriched: {records:?}");
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }

    st.shutdown().await;
}

#[tokio::test]
async fn next_generation_holds_then_reaps_a_freshagent_survivor_never_claiming_it() {
    let _env = ENV_LOCK.lock().await;
    std::env::set_var("CODEX_CMD", fake_codex_cmd());
    let guard = TrackingStoreGuard::install();
    let (st, mut rx) = tracking_state();
    let session_id = create_tracked_session(&st, &mut rx, "req-wfah-t4-gen").await;
    let ownership_id = guard.records()[0].ownership_id.clone();
    let pid = guard.records()[0].pid;

    // SIMULATE THE GENERATION BOUNDARY against the shared disk state: the old
    // process is gone (crashed), its records survive; the new generation's boot
    // reconcile reloads them. (We reuse the same fixture process — its
    // /proc evidence is unchanged, exactly like a real orphan.)
    let (reconciler, report) = SidecarReconciler::boot_reconcile(guard.store.clone());
    assert_eq!(report.pruned_dead + report.pruned_mismatch, 0,
        "the live orphan is not pruned");
    assert!(report.held >= 1, "the orphan is held for the sweep");

    // A terminal-pane restore of the very same codex thread must never adopt the
    // freshagent-lane record.
    let claimed = reconciler.claim_for_session(&session_id).await;
    assert!(claimed.is_none(), "freshagent records are never claimable: {claimed:?}");

    // The grace-delayed sweep (driven directly here) reaps the verified-idle
    // orphan (the fake fixture reports no active thread), removing the record.
    let outcomes = reconciler.sweep_unclaimed().await;
    let outcome = outcomes
        .iter()
        .find(|(oid, _)| oid == &ownership_id)
        .map(|(_, o)| *o)
        .expect("the orphan record is swept");
    assert_eq!(outcome, SweepOutcome::Reaped, "verified-idle orphan is reaped, not retained");

    // The reaped process is really gone and the books are clean.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while std::path::Path::new(&format!("/proc/{pid}")).exists()
        && std::time::Instant::now() < deadline
    {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists(),
        "the swept orphan stays dead");
    assert!(guard.records().is_empty(), "no record remains after the sweep");

    // Old-generation cleanup: its watcher crash arm fires on the sweep's kill;
    // shutdown still completes safely with the mapping present.
    st.shutdown().await;
}
```

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-freshagent --lib codex_sidecar_tracking`

Expected: FAIL — `create_enriches_the_record_with_the_served_thread_id` times
out at the enrichment assertion because `session_id` is never written today.
(The generation-boundary test's `claim_for_session` refusal is already true
once Task 1 landed; its sweep outcome proves the whole path end to end.)

- [ ] **Step 3: Add the minimal production implementation**

In `codex.rs::spawn_exit_watcher`, first statement of the fn body (before
`tokio::spawn`):

```rust
    // wfah: the thread id is fixed by the time the watcher is constructed at
    // every successful spawn site; enrich the durable record once, here.
    crate::codex_sidecar_tracking::enrich_record_session_id(&ownership_id, &thread_id);
```

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-freshagent --lib codex_sidecar_tracking`

Expected: PASS (11 tests total).

- [ ] **Step 5: Refactor while green**

None expected. Do NOT dedupe the poll-until helpers into a shared test util —
two small loops beat a new abstraction.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: entire freshagent lane (watcher touched; every spawn path now
enriches), plus the codex tracking suites as smoke:

Run:
```
cargo test -p freshell-freshagent && \
cargo test -p freshell-codex --features real-transport sidecar && \
cargo fmt --all --check && \
cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings
```

Expected: all PASS; record real pass counts in the progress ledger.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/codex.rs \
        crates/freshell-freshagent/src/codex_sidecar_tracking_tests.rs
git commit -m "feat(freshagent): enrich sidecar records with the served codex thread id (wfah T4)"
```

---

### Task 5: server-level black-box proof across an unclean restart

**Files:**
- Modify: `crates/freshell-server/tests/safe11_term22_shutdown_reaping.rs` (one new test fn; one header-note update)

**Interfaces:**
- Consumes: all existing helpers in that file (`discover_server_binary`, `allocate_ephemeral_port`, `wait_for_health`, `drain_stderr`, `send_json`, `wait_for_message_type`, `wait_for_any_message_type`, `seed_fresh_agent_enabled`, `descendant_pids`, `pid_alive`, `pid_cmdline`, `fake_codex_app_server_cmd`, `AUTH_TOKEN`); `FRESHELL_CODEX_SIDECAR_REAP_GRACE_MS` env (`sidecar_sweep.rs:36`); the store root `<FRESHELL_HOME>/.freshell/rust-codex-sidecars/`.
- Produces: user-visible proof that a `kill -9`'d server's freshagent sidecar is reaped by the next generation — the workflow's end-to-end evidence.

- [ ] **Step 1: Write the failing behavioral test**

Append to `safe11_term22_shutdown_reaping.rs` (plus two tiny local helpers;
`libc` and `serde_json` are already used in this file):

```rust
/// Directory of durable sidecar records for a test server home.
fn sidecar_store_records(home: &std::path::Path) -> Vec<serde_json::Value> {
    let dir = home.join(".freshell/rust-codex-sidecars");
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".json") {
                if let Ok(text) = std::fs::read_to_string(entry.path()) {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                        out.push(v);
                    }
                }
            }
        }
    }
    out
}

/// The freshagent-lane fixture sidecar of a test server, if any: its cmdline
/// contains the fake app-server script name.
fn find_freshagent_sidecar_pid(server_pid: u32) -> Option<u32> {
    descendant_pids(server_pid)
        .into_iter()
        .find(|&pid| pid_cmdline(pid).contains("fake-app-server"))
}

#[tokio::test]
async fn sigkill_restart_reaps_tracked_freshagent_sidecar_via_store() {
    let server_binary = discover_server_binary();
    let home = tempfile::tempdir().expect("create temp home");
    let port1 = allocate_ephemeral_port();
    seed_fresh_agent_enabled(home.path());

    // Generation 1: boot, create a freshcodex fresh-agent session.
    let mut server1 = Command::new(&server_binary)
        .env("PORT", port1.to_string())
        .env("AUTH_TOKEN", AUTH_TOKEN)
        .env("FRESHELL_HOME", home.path())
        .env("HOME", home.path())
        .env("CODEX_CMD", format!("node {}", fake_codex_app_server_cmd()))
        .env_remove("FAKE_CODEX_APP_SERVER_BEHAVIOR")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn freshell-server #1");
    assert!(
        wait_for_health(port1, &mut server1, Duration::from_secs(15)).await,
        "server #1 never became healthy; stderr:
{}",
        drain_stderr(&mut server1)
    );
    let (mut ws, _resp) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port1}/ws"))
        .await
        .expect("ws connect");
    send_json(&mut ws, &serde_json::json!({
        "type": "hello", "protocolVersion": 7, "token": AUTH_TOKEN,
    }))
    .await;
    wait_for_message_type(&mut ws, "ready", Duration::from_secs(5))
        .await
        .expect("ready handshake");
    send_json(&mut ws, &serde_json::json!({
        "type": "freshAgent.create",
        "requestId": "rid-wfah-sigkill",
        "sessionType": "freshcodex",
        "provider": "codex",
    }))
    .await;
    match wait_for_any_message_type(
        &mut ws,
        &["freshAgent.created", "freshAgent.createFailed"],
        Duration::from_secs(50),
    )
    .await
    {
        Some((got, _)) if got == "freshAgent.created" => {}
        other => panic!("expected freshAgent.created, got {other:?}"),
    }

    // The sidecar exists, and a durable tracked record names it.
    let server1_pid = server1.id();
    let sidecar_pid = find_freshagent_sidecar_pid(server1_pid)
        .expect("a fixture sidecar among the server's descendants");
    let deadline = Instant::now() + Duration::from_secs(10);
    let record = loop {
        let found = sidecar_store_records(home.path())
            .into_iter()
            .find(|r| r["pid"].as_u64() == Some(sidecar_pid as u64));
        if let Some(record) = found {
            break record;
        }
        assert!(Instant::now() < deadline, "no tracked record for pid {sidecar_pid}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    assert_eq!(record["lane"].as_str(), Some("freshAgent"),
        "freshagent rows carry the lane marker: {record}");
    assert_eq!(record["state"]["kind"].as_str(), Some("active"));
    drop(ws);

    // THE UNCLEAN DEATH: no graceful shutdown, no Drop, no record scrub.
    let kill_rc = unsafe { libc::kill(server1_pid as libc::pid_t, libc::SIGKILL) };
    assert_eq!(kill_rc, 0, "SIGKILL to the server must land");
    let _ = server1.wait().await;
    // The orphan survives (that is precisely the bug class being fixed).
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(pid_alive(sidecar_pid),
        "the sidecar must still be alive after the unclean death — otherwise there is nothing to reap");

    // Generation 2 on the SAME home: boot reconcile + shortened grace sweep.
    let port2 = allocate_ephemeral_port();
    let mut server2 = Command::new(&server_binary)
        .env("PORT", port2.to_string())
        .env("AUTH_TOKEN", AUTH_TOKEN)
        .env("FRESHELL_HOME", home.path())
        .env("HOME", home.path())
        .env("CODEX_CMD", format!("node {}", fake_codex_app_server_cmd()))
        .env("FRESHELL_CODEX_SIDECAR_REAP_GRACE_MS", "1000")
        .env_remove("FAKE_CODEX_APP_SERVER_BEHAVIOR")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn freshell-server #2");
    assert!(
        wait_for_health(port2, &mut server2, Duration::from_secs(15)).await,
        "server #2 never became healthy; stderr:
{}",
        drain_stderr(&mut server2)
    );

    // Within the grace + probe budget, the orphan is reaped and its record removed.
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut reaped = false;
    while Instant::now() < deadline {
        let gone = !pid_alive(sidecar_pid);
        let scrubbed = !sidecar_store_records(home.path())
            .iter()
            .any(|r| r["pid"].as_u64() == Some(sidecar_pid as u64));
        if gone && scrubbed {
            reaped = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let server2_stderr = drain_stderr(&mut server2);
    let log_tail =
        std::fs::read_to_string(home.path().join(".freshell/logs/rust-server.jsonl"))
            .unwrap_or_default();

    // Leak guard + teardown: never leave the fixture running past the test.
    if !reaped {
        let _ = unsafe { libc::kill(sidecar_pid as libc::pid_t, libc::SIGKILL) };
    }
    let _ = unsafe { libc::kill(server2.id() as libc::pid_t, libc::SIGTERM) };
    let _ = server2.wait().await;

    assert!(
        reaped,
        "the next generation must reap the tracked orphan.          sidecar_pid={sidecar_pid} alive={} server2 stderr:\n{server2_stderr}\nlog tail:\n{log_tail}",
        pid_alive(sidecar_pid),
    );
}
```

Also update the file's header note (lines ~24-32) that documents the
freshagent lane as outside retention: the lane remains outside *retention*
(freshagent still kills its sidecars at graceful shutdown) but is now inside
*tracking* (durable records + next-generation reconcile/sweep). Keep the rest
of the header intact.

- [ ] **Step 2: Run the test and verify the intended failure**

Sandbox-first policy: try `scripts/sandbox-test.sh "cargo test -p freshell-server --test safe11_term22_shutdown_reaping sigkill_restart"`. If the Docker sandbox is unavailable on this machine (expected — verify with `docker version` during Stage 2), use the documented host fallback per `docs/development/test-sandbox.md` / the 2026-07-26 precedence and record the decision:

Run (fallback): `cargo test -p freshell-server --test safe11_term22_shutdown_reaping sigkill_restart`

Expected: FAIL at the "no tracked record for pid" assertion — today the
freshagent lane writes no record, so generation 2's sweep has nothing to reap
and the orphan survives. (If the run instead fails earlier at
`freshAgent.created`, treat as harness damage, fix, and re-run.)

- [ ] **Step 3: Add the minimal production implementation**

None — all production behavior landed in Tasks 1-4. This task adds the proof.

- [ ] **Step 4: Run the focused test**

Run (same sandbox-first / host-fallback rules): `cargo test -p freshell-server --test safe11_term22_shutdown_reaping sigkill_restart`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

None expected. Keep helpers local to this file.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: the whole black-box file (the pre-existing graceful test must
stay green), plus a freshagent-crate smoke:

Run (sandbox-first / host-fallback per above):
```
cargo test -p freshell-server --test safe11_term22_shutdown_reaping && \
cargo test -p freshell-freshagent --lib codex_sidecar_tracking && \
cargo fmt --all --check && \
cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings
```

Expected: both safe11 tests PASS; record real pass counts in the progress ledger.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-server/tests/safe11_term22_shutdown_reaping.rs
git commit -m "test(server): black-box proof that a rebooted server reaps a freshagent sidecar orphaned by kill -9 (wfah T5)"
```

---

### Task 6: whole-workspace sweep + final evidence

**Files:** none (verification only).

**Interfaces:** consumes everything above; produces the final cargo evidence the Darkforge QA gate does not run.

- [ ] **Step 1: Full workspace sweep**

Run: `cargo test --workspace` (add `-- --nocapture` only for debugging a failure).

Expected: pass, EXCEPT any pre-existing failures reproduced at the base
commit in Stage 2 (assumption 5) — notably the two known
`freshell-ws/tests/auto_resume_e2e.rs` deterministic failures. Record exact
failure identities + full counts in the progress ledger; an empty exception
list is expected on native Ubuntu.

- [ ] **Step 2: Final statics**

Run: `cargo fmt --all --check && cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings && cargo clippy -p freshell-codex --features real-transport --all-targets -- -D warnings && cargo clippy -p freshell-opencode --features real-transport --all-targets -- -D warnings`

Expected: all PASS.

- [ ] **Step 3: Record the evidence**

Write `<logs_dir>/reports/execution-sweep.md` with the commands, timestamps,
and real counts. No code change — normally no commit; commit only if a fix was
required, with a focused message.

---

## Execution notes for the implementer

- This plan's code blocks are drafts verified by reading the current tree.
  Exact line numbers will drift; the named anchors (`drain_child_io`,
  `reap_owned_codex_sidecars`, the three spawn-failure `return Err` arms, the
  `claimable` computation) are the authority.
- Every freshagent unit/integration run may be long (the crate suite is large);
  that is expected. Run them via plain `cargo test`; there is no nextest.
- Progress ledger: record each task's commands + real pass counts + commit SHA
  in `<logs_dir>/reports/execution-progress.md` as tasks land.
