//! Durable cross-restart tracking for freshagent-lane codex sidecars (kata wfah).
//!
//! Every freshcodex sidecar (`FreshCodexState::spawn_sidecar`) is recorded in
//! the shared rust-codex-sidecars store the moment it is spawned, and scrubbed
//! whenever the lane reaps it, so the NEXT server generation's boot reconcile +
//! grace-delayed sweep (wired in `crates/freshell-server/src/main.rs`) always
//! sees this lane's survivors. Nothing in this module ever signals a process:
//! killing stays the sweep's job.

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
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (ownership_id, pid, ws_url);
        return; // /proc identity evidence is Linux-only
    }

    let Some(store) = codex_sidecar_store() else {
        return;
    };
    if !store.is_enabled() {
        return;
    }
    if pid == 0 {
        tracing::warn!(
            provider = PROVIDER,
            ownership_id,
            "freshagent.sidecar.track_skipped: no pid"
        );
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
            tracing::info!(
                provider = PROVIDER,
                ownership_id,
                pid,
                "freshagent.sidecar.tracked"
            )
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
    let Some(store) = codex_sidecar_store() else {
        return;
    };
    match store.remove(ownership_id) {
        Ok(()) => tracing::debug!(
            provider = PROVIDER,
            ownership_id,
            "freshagent.sidecar.untracked"
        ),
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
    let Some(store) = codex_sidecar_store() else {
        return;
    };
    let Some(mut record) = store
        .load_all()
        .into_iter()
        .find(|r| r.ownership_id == ownership_id)
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
