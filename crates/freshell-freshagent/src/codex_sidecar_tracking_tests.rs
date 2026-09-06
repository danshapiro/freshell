//! Cross-restart tracking tests for freshagent-lane codex sidecars (wfah).
//! Linux-only: identity evidence is /proc-based. Every test serializes on
//! `crate::codex::tests::ENV_LOCK` because the store handle is process-global
//! and the spawn tests mutate `CODEX_CMD` — this guarantees no codex.rs spawn
//! test runs concurrently (they all take ENV_LOCK for the same keys).
#![cfg(target_os = "linux")]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use freshell_codex::sidecar_store::{
    proc_cmdline, proc_starttime, set_codex_sidecar_store, verify_sidecar_identity,
    CodexSidecarStore, IdentityVerdict, SidecarLane, SidecarRecordState,
};
use serde_json::{json, Value};

use crate::codex::tests::ENV_LOCK;
// `scrub_sidecar_record` and `enrich_record_session_id` are exercised indirectly
// (through spawn_sidecar / spawn_exit_watcher) — importing either here would be
// an unused-imports lint failure.
use crate::codex_sidecar_tracking::record_spawned_sidecar;
// Same path codex.rs uses (re-exported from client_messages).
use crate::FreshCodexState; // re-exported: `pub use codex::FreshCodexState` in lib.rs
use freshell_protocol::FreshAgentCreate;

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
    create_tracked_session_with_resume(st, rx, request_id, None).await
}

async fn create_tracked_session_with_resume(
    st: &FreshCodexState,
    rx: &mut tokio::sync::broadcast::Receiver<String>,
    request_id: &str,
    resume_session_id: Option<&str>,
) -> String {
    st.handle_create(
        FreshAgentCreate {
            request_id: request_id.to_string(),
            session_type: freshell_protocol::SessionType::Freshcodex,
            provider: Some(freshell_protocol::AgentProvider::Codex),
            cwd: None,
            legacy_restore_context: None,
            resume_session_id: resume_session_id.map(str::to_string),
            session_ref: None,
            model: None,
            model_selection: None,
            permission_mode: None,
            sandbox: None,
            effort: None,
            plugins: None,
            tab_id: None,
        },
        None,
    )
    .await;
    let frame: Value = tokio::time::timeout(std::time::Duration::from_secs(20), async {
        loop {
            let frame: Value = serde_json::from_str(&rx.recv().await.expect("bus stays open"))
                .expect("valid json");
            if frame["type"] == "freshAgent.created" || frame["type"] == "freshAgent.create.failed"
            {
                return frame;
            }
        }
    })
    .await
    .expect("fixture create responds within the budget");
    assert_eq!(
        frame["type"], "freshAgent.created",
        "fixture create failed: {frame}"
    );
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
    assert_eq!(
        records.len(),
        1,
        "exactly the spawned sidecar is tracked: {records:?}"
    );
    let record = &records[0];
    assert_eq!(record.lane, Some(SidecarLane::FreshAgent));
    assert!(
        std::path::Path::new(&format!("/proc/{}", record.pid)).exists(),
        "recorded pid must be live right after create"
    );
    assert!(
        record.cmdline.iter().any(|a| a.contains("fake-app-server")),
        "recorded cmdline must identify the fixture sidecar, got {:?}",
        record.cmdline
    );
    assert_eq!(verify_sidecar_identity(record), IdentityVerdict::Verified);

    st.shutdown().await; // scrubs the record only once Task 3's wiring lands
}

#[tokio::test]
async fn failed_spawn_leaves_no_record() {
    let _env = ENV_LOCK.lock().await;
    // The node child survives ~1.5s — far beyond any realistic evidence-poll
    // latency, so the optimistic record write deterministically lands before
    // the child exits — it never listens, then exits, so spawn_sidecar returns
    // Err via the "exited before listening" arm with the record already
    // written. (No inner spaces in the script: spawn_sidecar whitespace-splits
    // CODEX_CMD, so the script must stay a single argv. The trailing `--`
    // stops node's option parsing, so the `-c ...` app-server args
    // spawn_sidecar appends cannot be misparsed as node flags — without it
    // node dies in milliseconds on `either --check or --eval`.)
    std::env::set_var("CODEX_CMD", "node -e setTimeout(()=>{},1500) --");
    let guard = TrackingStoreGuard::install();
    let (st, mut rx) = tracking_state();

    st.handle_create(
        FreshAgentCreate {
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
            tab_id: None,
        },
        None,
    )
    .await;
    let frame: Value = tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            let frame: Value = serde_json::from_str(&rx.recv().await.expect("bus")).expect("json");
            if frame["type"] == "freshAgent.created" || frame["type"] == "freshAgent.create.failed"
            {
                return frame;
            }
        }
    })
    .await
    .expect("failure frame within the budget");
    assert_eq!(
        frame["type"], "freshAgent.create.failed",
        "expected failure: {frame}"
    );

    assert!(
        guard.records().is_empty(),
        "a failed spawn must scrub the record it optimistically wrote"
    );
}

// ── Task 3: scrub the record on EVERY reap path ─────────────────────────────
// (The Task 4 tests live at the bottom of this file.)

/// Build a tracked sleeper + exit watcher exactly as production does.
async fn build_recorded_watch(
    ownership_id: &str,
) -> (
    tokio::task::JoinHandle<()>,
    tokio::sync::oneshot::Sender<()>,
    u32,
) {
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

    assert!(
        guard.records().is_empty(),
        "requested kill scrubs the record"
    );
    assert!(
        !std::path::Path::new(&format!("/proc/{pid}")).exists(),
        "the child itself is really gone"
    );
}

#[tokio::test]
async fn unrequested_exit_arm_removes_the_record() {
    let _env = ENV_LOCK.lock().await;
    let guard = TrackingStoreGuard::install();
    let mut child = spawn_sleep_child();
    let pid = child.id().expect("spawned pid");
    record_spawned_sidecar("codex-sidecar-wfah-t3-crash", pid, "ws://127.0.0.1:1").await;
    assert_eq!(
        guard.records().len(),
        1,
        "set-up must have written the record"
    );
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

    assert!(
        guard.records().is_empty(),
        "the crash arm scrubs the record"
    );
    assert!(
        exited.load(Ordering::SeqCst),
        "the crash arm flips the lazy-restart flag"
    );
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
    // The fixture answers EVERY default `thread/start` with `thread-new-1`, so a
    // second PLAIN create would hit finish_create's live-incumbent adopt path and
    // tear its own sidecar down (correctly scrubbing it) — leaving ONE record and
    // one sidecar, not the two this test needs. Resume-create pins a distinct
    // thread id (the fixture echoes `params.threadId`), so session b genuinely
    // owns a second live sidecar.
    create_tracked_session_with_resume(
        &st,
        &mut rx,
        "req-wfah-t3-shutdown-b",
        Some("thread-wfah-t3-shutdown-b"),
    )
    .await;
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
        json!({
            "overrides": {
                "thread/start": { "error": { "code": -32000, "message": "forced wfah bail" } }
            }
        })
        .to_string(),
    );
    std::env::set_var("CODEX_CMD", fake_codex_cmd());
    let guard = TrackingStoreGuard::install();
    let (st, mut rx) = tracking_state();

    st.handle_create(
        FreshAgentCreate {
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
            tab_id: None,
        },
        None,
    )
    .await;
    let frame: Value = tokio::time::timeout(std::time::Duration::from_secs(15), async {
        loop {
            let frame: Value = serde_json::from_str(&rx.recv().await.expect("bus")).expect("json");
            if frame["type"] == "freshAgent.created" || frame["type"] == "freshAgent.create.failed"
            {
                return frame;
            }
        }
    })
    .await
    .expect("failure frame within the budget");
    assert_eq!(
        frame["type"], "freshAgent.create.failed",
        "expected the bail: {frame}"
    );

    assert!(
        guard.records().is_empty(),
        "a pre-watcher bail must scrub the record it wrote at spawn"
    );
}

// ── Task 4: thread-id enrichment + cross-generation hold/never-claim ────────

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
        assert!(
            std::time::Instant::now() < deadline,
            "record not enriched: {records:?}"
        );
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
    assert_eq!(
        guard.records()[0].session_id.as_deref(),
        Some(session_id.as_str()),
        "the claim-refusal assertion is only meaningful on an enriched (indexed) record"
    );

    // SIMULATE THE GENERATION BOUNDARY against the shared disk state: the old
    // process is gone (crashed), its records survive; the new generation's boot
    // reconcile reloads them. (We reuse the same fixture process — its
    // /proc evidence is unchanged, exactly like a real orphan.)
    let (reconciler, report) = SidecarReconciler::boot_reconcile(guard.store.clone());
    assert_eq!(
        report.pruned_dead + report.pruned_mismatch,
        0,
        "the live orphan is not pruned"
    );
    assert!(report.held >= 1, "the orphan is held for the sweep");

    // A terminal-pane restore of the very same codex thread must never adopt the
    // freshagent-lane record.
    let claimed = reconciler.claim_for_session(&session_id).await;
    assert!(
        claimed.is_none(),
        "freshagent records are never claimable: {claimed:?}"
    );

    // The grace-delayed sweep (driven directly here) reaps the verified-idle
    // orphan (the fake fixture reports no active thread), removing the record.
    let outcomes = reconciler.sweep_unclaimed().await;
    let outcome = outcomes
        .iter()
        .find(|(oid, _)| oid == &ownership_id)
        .map(|(_, o)| o)
        .expect("the orphan record is swept");
    assert_eq!(
        outcome,
        &SweepOutcome::Reaped,
        "verified-idle orphan is reaped, not retained"
    );

    // The reaped process is really gone and the books are clean.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while std::path::Path::new(&format!("/proc/{pid}")).exists()
        && std::time::Instant::now() < deadline
    {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(
        !std::path::Path::new(&format!("/proc/{pid}")).exists(),
        "the swept orphan stays dead"
    );
    assert!(
        guard.records().is_empty(),
        "no record remains after the sweep"
    );

    // Old-generation cleanup: its watcher crash arm fires on the sweep's kill;
    // shutdown still completes safely with the mapping present.
    st.shutdown().await;
}
