//! Unit tests for the boot-time sidecar reconciler ([`super`]).
//!
//! Tempfile tempdirs ONLY — no global state, nothing outside each test's own
//! temp dir. In particular these tests must NEVER touch
//! `~/.freshell/codex-sidecars/` (Node's store), the production
//! `~/.freshell/rust-codex-sidecars/` root (wired in Task 10), or any live
//! process the test did not itself spawn.
//!
//! PROCESS SAFETY: each test spawns and reaps ONLY its own children
//! (`sleep 300`), killed in a [`ChildGuard`] drop guard — nothing else on the
//! machine is ever signalled. Reconciliation itself NEVER signals any pid
//! (prune is `store.remove` only), and the tests assert exactly that by
//! checking their children are still alive afterwards.
//!
//! Writer-probe note: `sleep` children speak no ws, and every record's
//! `ws_url` points at a loopback port nothing listens on, so the duplicate
//! arm's probe fails fast (connection refused, bounded by the ~1s budget) and
//! the newest-`updated_at` fallback decides — deterministic. The probe's
//! POSITIVE arm is pinned here by
//! `duplicate_claim_prefers_the_live_writer_over_newer_updated_at` (an
//! initialize-gated fixture — the real-codex shape). Tests bind loopback
//! ephemeral ports only; never port 3001.
//!
//! /proc semantics are Linux-only, so these tests are
//! `#[cfg(target_os = "linux")]` (the sidecar_store_tests precedent).

#![cfg(target_os = "linux")]

use std::sync::Arc;

use super::*;
use crate::sidecar_store::{proc_cmdline, proc_starttime, CodexSidecarRecord};
use crate::sidecar_test_support::{
    record_for_child, spawn_own_fake_app_server, spawn_own_fake_app_server_with_behavior,
    spawn_own_sleep_child, store_in, NEVER_SIGNALLED_GRACE, SESSION,
};

#[test]
fn boot_reconcile_prunes_dead_and_mismatched_records() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_in(&dir);

    // Dead: real evidence captured live, then OUR OWN child is killed+reaped.
    let mut dead_child = spawn_own_sleep_child();
    let dead = record_for_child(
        "codex-sidecar-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        dead_child.0.id(),
        Some(SESSION),
    );
    dead_child.0.kill().expect("kill own child");
    dead_child.0.wait().expect("reap own child");

    // Mismatch: a live child's pid+starttime but a DIFFERENT cmdline —
    // the pid-reuse shape. This pid is NOT ours; it must never be signalled.
    let mut mismatch_child = spawn_own_sleep_child();
    let mismatch = CodexSidecarRecord {
        cmdline: vec!["codex".to_string(), "app-server".to_string()],
        ..record_for_child(
            "codex-sidecar-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            mismatch_child.0.id(),
            Some(SESSION),
        )
    };

    // Verified: a live child's real evidence.
    let mut verified_child = spawn_own_sleep_child();
    let verified = record_for_child(
        "codex-sidecar-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        verified_child.0.id(),
        Some(SESSION),
    );

    store.write(&dead).expect("write dead");
    store.write(&mismatch).expect("write mismatch");
    store.write(&verified).expect("write verified");

    let (reconciler, report) = SidecarReconciler::boot_reconcile(Arc::clone(&store));

    assert_eq!(
        report,
        BootReconcileReport {
            loaded: 3,
            pruned_dead: 1,
            pruned_mismatch: 1,
            held: 1,
        }
    );
    assert_eq!(reconciler.unclaimed_len(), 1, "only the verified row held");
    assert_eq!(
        store.load_all(),
        vec![verified],
        "the store holds ONLY the verified row after pruning"
    );

    // Prune NEVER signals: both live children are still alive afterwards.
    assert_eq!(
        mismatch_child
            .0
            .try_wait()
            .expect("try_wait mismatch child"),
        None,
        "the mismatching pid must never be signalled"
    );
    assert_eq!(
        verified_child
            .0
            .try_wait()
            .expect("try_wait verified child"),
        None,
        "the verified child must not be signalled by boot"
    );
}

#[tokio::test]
async fn boot_reconcile_holds_sessionless_records_for_the_sweep() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_in(&dir);

    let child = spawn_own_sleep_child();
    let sessionless = record_for_child(
        "codex-sidecar-dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        child.0.id(),
        None,
    );
    store.write(&sessionless).expect("write sessionless");

    let (reconciler, report) = SidecarReconciler::boot_reconcile(Arc::clone(&store));
    assert_eq!(report.held, 1);
    assert_eq!(
        reconciler.unclaimed_len(),
        1,
        "a verified record WITHOUT a session is held for the sweep"
    );

    // Not claimable by any session — and NOT dropped by the attempt.
    assert_eq!(reconciler.claim_for_session(SESSION).await, None);
    assert_eq!(
        reconciler.unclaimed_len(),
        1,
        "the sessionless record stays held after a foreign claim attempt"
    );
    assert_eq!(
        store.load_all(),
        vec![sessionless],
        "the sessionless row survives in the store"
    );
}

#[tokio::test]
async fn claim_for_session_returns_each_record_once() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_in(&dir);

    let child = spawn_own_sleep_child();
    let record = record_for_child(
        "codex-sidecar-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        child.0.id(),
        Some(SESSION),
    );
    store.write(&record).expect("write record");

    let (reconciler, _report) = SidecarReconciler::boot_reconcile(Arc::clone(&store));
    assert_eq!(reconciler.unclaimed_len(), 1);

    let first = reconciler.claim_for_session(SESSION).await;
    assert_eq!(first, Some(record), "first claim returns the record");
    assert_eq!(reconciler.unclaimed_len(), 0, "the claim left held");

    let second = reconciler.claim_for_session(SESSION).await;
    assert_eq!(second, None, "each record is claimable ONCE");
}

#[tokio::test]
async fn claim_reverifies_identity_at_claim_time() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_in(&dir);

    let mut child = spawn_own_sleep_child();
    let record = record_for_child(
        "codex-sidecar-ffffffff-ffff-4fff-8fff-ffffffffffff",
        child.0.id(),
        Some(SESSION),
    );
    store.write(&record).expect("write record");

    let (reconciler, _report) = SidecarReconciler::boot_reconcile(Arc::clone(&store));
    assert_eq!(reconciler.unclaimed_len(), 1, "held while the child lives");

    // The sidecar dies BETWEEN boot and claim (kill+reap OUR OWN child).
    child.0.kill().expect("kill own child");
    child.0.wait().expect("reap own child");

    assert_eq!(
        reconciler.claim_for_session(SESSION).await,
        None,
        "claim re-verifies identity and refuses a dead sidecar"
    );
    assert_eq!(reconciler.unclaimed_len(), 0, "the dead record left held");
    assert!(
        store.load_all().is_empty(),
        "the dead record was removed from the store"
    );
}

#[tokio::test]
async fn duplicate_session_records_claim_one_keep_the_loser_held() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_in(&dir);

    // Two VERIFIED records sharing one session id (two live test children) —
    // the mid-turn-survivor + fresh-spawn shape (reports/V3.md).
    let mut older_child = spawn_own_sleep_child();
    let older = CodexSidecarRecord {
        updated_at: 1_700_000_000_001,
        ..record_for_child(
            "codex-sidecar-11111111-2222-4333-8444-555555555555",
            older_child.0.id(),
            Some(SESSION),
        )
    };
    let mut newer_child = spawn_own_sleep_child();
    let newer = CodexSidecarRecord {
        updated_at: 1_700_000_000_002,
        ..record_for_child(
            "codex-sidecar-66666666-7777-4888-8999-aaaaaaaaaaaa",
            newer_child.0.id(),
            Some(SESSION),
        )
    };
    store.write(&older).expect("write older");
    store.write(&newer).expect("write newer");

    let (reconciler, _report) = SidecarReconciler::boot_reconcile(Arc::clone(&store));
    assert_eq!(reconciler.unclaimed_len(), 2, "both duplicates held");

    // `sleep` children speak no ws (and the ws_urls point at closed ports),
    // so the writer probe fails fast on both and the newest-`updated_at`
    // fallback decides.
    let claimed = reconciler.claim_for_session(SESSION).await;
    assert_eq!(
        claimed,
        Some(newer),
        "the newest-updated_at candidate wins the fallback"
    );
    assert_eq!(
        reconciler.unclaimed_len(),
        1,
        "the loser STAYS held for the sweep — never silently dropped"
    );

    // Claiming NEVER signals: both children are still alive.
    assert_eq!(
        older_child.0.try_wait().expect("try_wait older child"),
        None,
        "the losing candidate's sidecar must not be signalled"
    );
    assert_eq!(
        newer_child.0.try_wait().expect("try_wait newer child"),
        None,
        "the winning candidate's sidecar must not be signalled"
    );
}

#[tokio::test]
async fn duplicate_claim_prefers_the_live_writer_over_newer_updated_at() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_in(&dir);

    // The WRITER candidate: a live fixture reporting this session in
    // thread/loaded/list, with the OLDER updated_at — writer preference must
    // beat the newest-updated_at fallback (final review F1: the fallback
    // tends to pick the NON-writer in exactly this scenario). The fixture
    // GATES pre-initialize RPCs (requireInitializeBeforeOtherMethods +
    // requireInitializedNotification, the real-codex shape): a probe that
    // skipped the initialize/initialized handshake would get -32000, read as
    // not-writer, and this test would fail on the fallback picking the
    // newer non-writer.
    let ownership_writer = "codex-sidecar-f1000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let behavior = format!(
        r#"{{"loadedThreadIds": ["{SESSION}"], "requireInitializeBeforeOtherMethods": true, "requireInitializedNotification": true}}"#
    );
    let (mut fixture, ws_url) =
        spawn_own_fake_app_server_with_behavior(ownership_writer, Some(&behavior)).await;
    let writer = CodexSidecarRecord {
        ws_url: ws_url.clone(),
        updated_at: 1_700_000_000_001,
        ..record_for_child(
            ownership_writer,
            fixture.id().expect("live fixture pid"),
            Some(SESSION),
        )
    };

    // The NON-writer duplicate: NEWER updated_at, no ws listener (sleep
    // child + closed loopback port) — the fallback's pick.
    let mut non_writer_child = spawn_own_sleep_child();
    let non_writer = CodexSidecarRecord {
        updated_at: 1_700_000_000_002,
        ..record_for_child(
            "codex-sidecar-f1000002-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            non_writer_child.0.id(),
            Some(SESSION),
        )
    };
    store.write(&writer).expect("write writer");
    store.write(&non_writer).expect("write non-writer");

    let (reconciler, _report) = SidecarReconciler::boot_reconcile(Arc::clone(&store));
    assert_eq!(reconciler.unclaimed_len(), 2, "both duplicates held");

    let claimed = reconciler.claim_for_session(SESSION).await;
    assert_eq!(
        claimed,
        Some(writer),
        "the live WRITER wins the duplicate claim despite the older updated_at"
    );
    assert_eq!(
        reconciler.unclaimed_len(),
        1,
        "the non-writer loser STAYS held for the sweep"
    );

    // Claiming NEVER signals: both candidates are still alive.
    assert_eq!(
        non_writer_child
            .0
            .try_wait()
            .expect("try_wait non-writer child"),
        None,
        "the losing candidate's sidecar must not be signalled"
    );
    assert_eq!(
        fixture.try_wait().expect("try_wait fixture"),
        None,
        "the winning writer's sidecar must not be signalled"
    );

    fixture
        .kill()
        .await
        .expect("cleanup: kill this test's own fixture");
}

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
    assert_eq!(
        report.pruned_dead + report.pruned_mismatch,
        0,
        "live evidence is not pruned"
    );
    assert_eq!(report.held, 1, "the freshagent row is held for the sweep");

    let claimed = reconciler.claim_for_session("thread-from-freshagent").await;
    assert!(
        claimed.is_none(),
        "freshagent-lane records are never claimable, got {claimed:?}"
    );
    assert_eq!(
        reconciler.unclaimed_len(),
        1,
        "still held after the refused claim"
    );
}

// ---------------------------------------------------------------------------
// Task 6: ReattachedCodexAppServerRuntime + kill_verified_sidecar_tree.
//
// Each reattach test spawns ITS OWN fake app-server fixture
// (`node test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs
// --listen ws://127.0.0.1:<port>`) as a direct tokio::process child tagged
// `FRESHELL_CODEX_SIDECAR_ID=<test-ownership-id>`, records that pid, and
// kills ONLY that pid in cleanup (`kill_on_drop(true)` plus explicit kills)
// — nothing else on the machine is ever signalled. Loopback ephemeral ports
// only; never 3001/3002.
// ---------------------------------------------------------------------------

use crate::launch_lifecycle::CodexLaunchRuntime;

/// Count live processes whose `/proc/<pid>/environ` carries OUR unique
/// ownership tag — a read-only `/proc` scan keyed on this test's own id,
/// used to prove a reattach spawned NO new sidecar process.
fn count_own_tagged_processes(ownership_id: &str) -> usize {
    let needle = crate::durability::ownership_needle(ownership_id);
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return 0;
    };
    entries
        .flatten()
        .filter(|entry| {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                return false;
            };
            let Ok(pid) = name.parse::<i32>() else {
                return false;
            };
            let Ok(environ) = std::fs::read(format!("/proc/{pid}/environ")) else {
                return false;
            };
            environ
                .split(|&b| b == 0)
                .any(|var| var == needle.as_bytes())
        })
        .count()
}

#[tokio::test]
async fn reattach_ensure_ready_returns_the_existing_listener() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_in(&dir);
    let ownership_id = "codex-sidecar-a6000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let (mut child, ws_url) = spawn_own_fake_app_server(ownership_id).await;
    // Record built from the live fixture's REAL /proc evidence + real ws_url.
    let record = CodexSidecarRecord {
        ws_url: ws_url.clone(),
        ..record_for_child(
            ownership_id,
            child.id().expect("live fixture pid"),
            Some(SESSION),
        )
    };
    store.write(&record).expect("write record");

    let runtime = ReattachedCodexAppServerRuntime::new(record.clone(), Arc::clone(&store));
    let ready = runtime
        .ensure_ready(Some("/tmp/ignored-reattach-cwd".to_string()))
        .await
        .expect("reattach ensure_ready adopts the surviving listener");
    assert_eq!(
        ready.ws_url, ws_url,
        "reattach returns the SURVIVOR's ws url"
    );

    // The survivor is still alive and NO new process was spawned: exactly
    // one live process carries this test's unique ownership tag.
    assert_eq!(
        child.try_wait().expect("try_wait fixture"),
        None,
        "the adopted survivor must still be alive"
    );
    assert_eq!(
        count_own_tagged_processes(ownership_id),
        1,
        "reattach must spawn NO new sidecar process"
    );
    assert_eq!(
        store.load_all(),
        vec![record],
        "a usable survivor's record stays in the store"
    );

    child
        .kill()
        .await
        .expect("cleanup: kill this test's own fixture");
}

#[tokio::test]
async fn reattach_refuses_on_identity_mismatch_without_signalling() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_in(&dir);
    let ownership_id = "codex-sidecar-a6000002-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let (mut child, ws_url) = spawn_own_fake_app_server(ownership_id).await;
    // The fixture's pid + starttime but a WRONG cmdline — the pid-reuse
    // shape. This pid is NOT ours; it must never be signalled.
    let record = CodexSidecarRecord {
        ws_url: ws_url.clone(),
        cmdline: vec!["codex".to_string(), "app-server".to_string()],
        ..record_for_child(
            ownership_id,
            child.id().expect("live fixture pid"),
            Some(SESSION),
        )
    };
    store.write(&record).expect("write record");

    let runtime = ReattachedCodexAppServerRuntime::new(record, Arc::clone(&store));
    runtime
        .ensure_ready(None)
        .await
        .expect_err("a mismatched identity must refuse the reattach");

    assert!(
        store.load_all().is_empty(),
        "the mismatched record is removed"
    );
    tokio::time::sleep(NEVER_SIGNALLED_GRACE).await;
    assert_eq!(
        child.try_wait().expect("try_wait fixture"),
        None,
        "the mismatching pid must NEVER be signalled"
    );

    child
        .kill()
        .await
        .expect("cleanup: kill this test's own fixture");
}

#[tokio::test]
async fn reattach_reaps_verified_but_unusable_survivor() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_in(&dir);
    let ownership_id = "codex-sidecar-a6000003-cccc-4ccc-8ccc-cccccccccccc";
    // Fixture listens on port A; the record's ws_url points at port B where
    // NOTHING listens (record_for_child's default) — pid evidence stays
    // valid, so identity is Verified but the probe fails fast.
    let (mut child, _fixture_ws_url) = spawn_own_fake_app_server(ownership_id).await;
    let record = record_for_child(
        ownership_id,
        child.id().expect("live fixture pid"),
        Some(SESSION),
    );
    store.write(&record).expect("write record");

    let runtime = ReattachedCodexAppServerRuntime::new(record, Arc::clone(&store));
    runtime
        .ensure_ready(None)
        .await
        .expect_err("a verified-but-unusable survivor must fail into fallback");

    // The unusable survivor was REAPED — an unusable tracked sidecar must
    // not leak (killing it releases codex's writer-lock files on exit).
    tokio::time::timeout(Duration::from_secs(10), child.wait())
        .await
        .expect("the unusable survivor must be reaped within the drain budget")
        .expect("wait fixture");
    assert!(
        store.load_all().is_empty(),
        "the unusable survivor's record is removed"
    );
}

#[tokio::test]
async fn reattach_shutdown_kills_only_after_reverification() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_in(&dir);

    // Positive arm: successful ensure_ready, then shutdown() → fixture gone,
    // record removed.
    let ownership_a = "codex-sidecar-a6000004-dddd-4ddd-8ddd-dddddddddddd";
    let (mut child_a, ws_a) = spawn_own_fake_app_server(ownership_a).await;
    let record_a = CodexSidecarRecord {
        ws_url: ws_a.clone(),
        ..record_for_child(
            ownership_a,
            child_a.id().expect("live fixture pid"),
            Some(SESSION),
        )
    };
    store.write(&record_a).expect("write record a");
    let runtime_a = ReattachedCodexAppServerRuntime::new(record_a, Arc::clone(&store));
    runtime_a
        .ensure_ready(None)
        .await
        .expect("ensure_ready adopts survivor A");
    runtime_a.shutdown().await.expect("shutdown A");
    tokio::time::timeout(Duration::from_secs(10), child_a.wait())
        .await
        .expect("shutdown must reap the adopted survivor within the drain budget")
        .expect("wait fixture a");
    assert!(
        store.load_all().is_empty(),
        "shutdown removes the adopted survivor's record"
    );

    // Negative arm: successful ensure_ready, THEN the record's starttime is
    // replaced — the kill-time re-verification sees Mismatch and NEVER
    // signals; the record is still removed.
    let ownership_b = "codex-sidecar-a6000005-eeee-4eee-8eee-eeeeeeeeeeee";
    let (mut child_b, ws_b) = spawn_own_fake_app_server(ownership_b).await;
    let record_b = CodexSidecarRecord {
        ws_url: ws_b.clone(),
        ..record_for_child(
            ownership_b,
            child_b.id().expect("live fixture pid"),
            Some(SESSION),
        )
    };
    store.write(&record_b).expect("write record b");
    let runtime_b = ReattachedCodexAppServerRuntime::new(record_b, Arc::clone(&store));
    runtime_b
        .ensure_ready(None)
        .await
        .expect("ensure_ready adopts survivor B");
    // Tamper the held record's starttime (tests are a child module of the
    // runtime, so private field access is available): the pid-reuse shape
    // appearing AFTER a successful adopt.
    runtime_b.record.lock().unwrap().starttime += 1;
    runtime_b
        .shutdown()
        .await
        .expect("shutdown returns Ok even when re-verification refuses the kill");
    tokio::time::sleep(NEVER_SIGNALLED_GRACE).await;
    assert_eq!(
        child_b.try_wait().expect("try_wait fixture b"),
        None,
        "a kill-time identity mismatch must NEVER be signalled"
    );
    assert!(
        store.load_all().is_empty(),
        "shutdown removes the record even when the kill is refused"
    );

    child_b
        .kill()
        .await
        .expect("cleanup: kill this test's own fixture");
}

// ---------------------------------------------------------------------------
// Task 7: the plan-aware selection seam ([`crate::runtime_select`]).
//
// The spawn arm is asserted BEHAVIORALLY without ever spawning: the returned
// runtime must not have consumed the claim, and its `shutdown` (a no-op for
// an un-started spawn runtime) must leave the survivor's record untouched —
// a reattach runtime's shutdown would scrub it.
// ---------------------------------------------------------------------------

use crate::launch_plan::{plan_codex_launch, CodexLaunchPlanInput};
use crate::runtime_select::select_codex_runtime;

#[tokio::test]
async fn select_codex_runtime_prefers_a_claimable_survivor() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_in(&dir);
    let ownership_id = "codex-sidecar-a7000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let (mut child, ws_url) = spawn_own_fake_app_server(ownership_id).await;
    let record = CodexSidecarRecord {
        ws_url: ws_url.clone(),
        ..record_for_child(
            ownership_id,
            child.id().expect("live fixture pid"),
            Some(SESSION),
        )
    };
    store.write(&record).expect("write record");
    let (reconciler, _report) = SidecarReconciler::boot_reconcile(Arc::clone(&store));
    let reconciler = Arc::new(reconciler);

    let resume_plan = plan_codex_launch(&CodexLaunchPlanInput {
        resume_session_id: Some(SESSION),
        ..Default::default()
    })
    .expect("resume plan");
    let fresh_plan = plan_codex_launch(&CodexLaunchPlanInput::default()).expect("fresh plan");
    let unknown_plan = plan_codex_launch(&CodexLaunchPlanInput {
        resume_session_id: Some("s-unknown"),
        ..Default::default()
    })
    .expect("unknown-session resume plan");

    // A fresh plan NEVER claims (the A4 fresh-restore exclusion).
    let runtime = select_codex_runtime(Some(&reconciler), Some(&store), &fresh_plan).await;
    assert_eq!(
        reconciler.unclaimed_len(),
        1,
        "a fresh plan must not claim the survivor"
    );
    runtime.shutdown().await.expect("spawn-type shutdown");
    assert_eq!(
        store.load_all(),
        vec![record.clone()],
        "fresh plan: the survivor's record must stay untouched"
    );

    // An unknown resume session has nothing to claim: spawn, survivor held.
    let runtime = select_codex_runtime(Some(&reconciler), Some(&store), &unknown_plan).await;
    assert_eq!(
        reconciler.unclaimed_len(),
        1,
        "an unknown session must not claim the survivor"
    );
    runtime.shutdown().await.expect("spawn-type shutdown");
    assert_eq!(
        store.load_all(),
        vec![record.clone()],
        "unknown session: the survivor's record must stay untouched"
    );

    // No reconciler installed: spawn, even for the claimable resume session.
    let runtime = select_codex_runtime(None, Some(&store), &resume_plan).await;
    assert_eq!(
        reconciler.unclaimed_len(),
        1,
        "a None reconciler must claim nothing"
    );
    runtime.shutdown().await.expect("spawn-type shutdown");
    assert_eq!(
        store.load_all(),
        vec![record.clone()],
        "no reconciler: the survivor's record must stay untouched"
    );

    // No store installed: spawn — a reattach runtime cannot be minted
    // without the store Arc, so the claim must stay unconsumed even with a
    // live reconciler and a claimable resume session.
    let runtime = select_codex_runtime(Some(&reconciler), None, &resume_plan).await;
    assert_eq!(
        reconciler.unclaimed_len(),
        1,
        "a None store must claim nothing"
    );
    runtime.shutdown().await.expect("spawn-type shutdown");
    assert_eq!(
        store.load_all(),
        vec![record.clone()],
        "no store: the survivor's record must stay untouched"
    );

    // The resume plan for the held session claims the survivor and mints the
    // reattach runtime: the claim leaves `held`, and `ensure_ready` adopts
    // the record's live listener (no spawn).
    let runtime = select_codex_runtime(Some(&reconciler), Some(&store), &resume_plan).await;
    assert_eq!(
        reconciler.unclaimed_len(),
        0,
        "the resume plan must consume the claim"
    );
    let ready = runtime
        .ensure_ready(None)
        .await
        .expect("reattach adopts the surviving listener");
    assert_eq!(ready.ws_url, ws_url, "reattach returns the RECORD's ws url");
    assert_eq!(
        child.try_wait().expect("try_wait fixture"),
        None,
        "the adopted survivor must still be alive"
    );

    child
        .kill()
        .await
        .expect("cleanup: kill this test's own fixture");
}
