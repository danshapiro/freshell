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
// `scrub_sidecar_record` is exercised indirectly (`failed_spawn_leaves_no_record`
// observes its effect through spawn_sidecar); `enrich_record_session_id` is wired
// by Tasks 3-4 — importing either here would be an unused-imports lint failure.
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
