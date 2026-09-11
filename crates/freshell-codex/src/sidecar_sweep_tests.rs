//! Unit tests for the conservative reap sweep + the tree-aware kill helper
//! ([`super`]) — Task 9's never-silently-orphaned invariant (ynfn).
//!
//! Tempfile tempdirs ONLY — no global state, nothing outside each test's own
//! temp dir. These tests must NEVER touch `~/.freshell/codex-sidecars/`
//! (Node's store), the production `~/.freshell/rust-codex-sidecars/` root
//! (wired in Task 10), or any live process the test did not itself spawn.
//!
//! PROCESS SAFETY: each test spawns and signals ONLY its own children
//! (`sleep 300` trees / fake app-server fixtures), cleaned up by drop guards
//! (`ChildGuard` / `kill_on_drop(true)` / snapshot-verified orphan guards) —
//! nothing else on the machine is ever signalled. The machine's live orphaned
//! codex app-servers stay structurally unreachable: every record here names a
//! test-spawned pid, and the sweep only ever signals recorded AND re-verified
//! pids. Loopback ephemeral ports only; never 3001/3002.
//!
//! /proc semantics are Linux-only, so these tests are
//! `#[cfg(target_os = "linux")]` (the sidecar_reconcile_tests precedent).

#![cfg(target_os = "linux")]

use std::sync::Arc;

use super::*;
use crate::launch_lifecycle::CodexLaunchRuntime;
use crate::sidecar_reconcile::{ReattachedCodexAppServerRuntime, SidecarReconciler};
use crate::sidecar_store::SidecarRecordState;
use crate::sidecar_test_support::{
    record_for_child, spawn_own_fake_app_server_with_behavior, spawn_own_shell_child,
    spawn_own_sleep_child, store_in, NEVER_SIGNALLED_GRACE, SESSION,
};

/// Poll this test's OWN spawned-tree root until `want` direct children exist
/// whose cmdline reads `sleep 300` (post-exec — a pre-exec fork window would
/// snapshot the parent's argv and flake the kill as a Mismatch skip).
fn wait_for_sleep_children(root: i32, want: usize) -> Vec<(i32, u64)> {
    let want_cmdline = vec!["sleep".to_string(), "300".to_string()];
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let settled: Vec<(i32, u64)> = proc_children(root)
            .into_iter()
            .filter(|&pid| proc_cmdline(pid).as_ref() == Some(&want_cmdline))
            .filter_map(|pid| proc_starttime(pid).map(|starttime| (pid, starttime)))
            .collect();
        if settled.len() >= want {
            return settled;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the test tree's sleep children never appeared"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

/// Cleanup-on-failure guard for indirectly spawned pids (a bash tree's
/// sleeps): on drop, SIGKILL any pid whose `(pid, starttime)` incarnation
/// still matches the snapshot — a recycled pid is never signalled. The happy
/// path leaves every snapshot dead, making drop a no-op.
struct OrphanSnapshotGuard(Vec<(i32, u64)>);

impl Drop for OrphanSnapshotGuard {
    fn drop(&mut self) {
        for &(pid, starttime) in &self.0 {
            if proc_starttime(pid) == Some(starttime) {
                signal_pid(pid, libc::SIGKILL);
            }
        }
    }
}

/// Poll a std child until it is observed exited+reaped (SIGTERM'd by the
/// sweep) or the deadline passes.
fn wait_child_gone(child: &mut std::process::Child, why: &str) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        if child.try_wait().expect("try_wait own child").is_some() {
            return;
        }
        assert!(std::time::Instant::now() < deadline, "{why}");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

// ---------------------------------------------------------------------------
// The seven Task 9 tests (names verbatim from the plan).
// ---------------------------------------------------------------------------

#[tokio::test]
async fn sweep_reaps_verified_idle_unclaimed_sidecar() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_in(&dir);
    let ownership_id = "codex-sidecar-a9000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    // Deliberately loaded-but-idle: pins the `loaded ≠ mid-turn`
    // discriminator (idle threads stay loaded forever, reports/V1.md).
    let (mut child, ws_url) = spawn_own_fake_app_server_with_behavior(
        ownership_id,
        Some(r#"{"loadedThreadIds": ["t-1"], "threadStatuses": {"t-1": "idle"}}"#),
    )
    .await;
    let record = CodexSidecarRecord {
        ws_url: ws_url.clone(),
        ..record_for_child(
            ownership_id,
            child.id().expect("live fixture pid"),
            Some(SESSION),
        )
    };
    store.write(&record).expect("write record");

    let (reconciler, report) = SidecarReconciler::boot_reconcile(Arc::clone(&store));
    assert_eq!(report.held, 1, "the survivor is held, unclaimed");

    let outcomes = reconciler.sweep_unclaimed().await;
    assert_eq!(
        outcomes,
        vec![(ownership_id.to_string(), SweepOutcome::Reaped)],
        "a verified, reachable, idle, unclaimed sidecar is reaped"
    );

    // The whole tree is gone within the drain budget...
    tokio::time::timeout(Duration::from_secs(10), child.wait())
        .await
        .expect("the reaped sidecar must exit within the drain budget")
        .expect("wait fixture");
    // ...and the record left both the store and `held`.
    assert!(store.load_all().is_empty(), "the reaped record is removed");
    assert_eq!(reconciler.unclaimed_len(), 0, "nothing left to sweep");
}

#[tokio::test]
async fn sweep_retains_mid_turn_sidecar_with_recorded_reason() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_in(&dir);
    let ownership_id = "codex-sidecar-a9000002-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let (mut child, ws_url) = spawn_own_fake_app_server_with_behavior(
        ownership_id,
        Some(r#"{"loadedThreadIds": ["t-1"], "threadStatuses": {"t-1": "active"}}"#),
    )
    .await;
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
    let outcomes = reconciler.sweep_unclaimed().await;
    assert_eq!(
        outcomes,
        vec![(ownership_id.to_string(), SweepOutcome::RetainedMidTurn)],
        "a mid-turn survivor must end up retained, not killed and not leaked"
    );

    // NEVER signalled: still alive after the grace window.
    tokio::time::sleep(NEVER_SIGNALLED_GRACE).await;
    assert_eq!(
        child.try_wait().expect("try_wait fixture"),
        None,
        "a mid-turn sidecar must never be signalled by the sweep"
    );
    // The reason is durably recorded...
    let rows = store.load_all();
    assert_eq!(rows.len(), 1, "the retained record stays in the store");
    assert_eq!(rows[0].ownership_id, ownership_id);
    assert_eq!(
        rows[0].state,
        SidecarRecordState::Retained {
            reason: "mid-turn-active-thread".to_string()
        }
    );
    // ...and the record STAYS held (claimable; re-evaluated at next boot).
    assert_eq!(reconciler.unclaimed_len(), 1, "retained rows stay held");

    child
        .kill()
        .await
        .expect("cleanup: kill this test's own fixture");
}

#[tokio::test]
async fn late_restore_after_sweep_reattaches_mid_turn_survivor() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_in(&dir);
    let ownership_id = "codex-sidecar-a9000003-cccc-4ccc-8ccc-cccccccccccc";
    let (mut child, ws_url) = spawn_own_fake_app_server_with_behavior(
        ownership_id,
        Some(r#"{"loadedThreadIds": ["t-1"], "threadStatuses": {"t-1": "active"}}"#),
    )
    .await;
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
    let outcomes = reconciler.sweep_unclaimed().await;
    assert_eq!(
        outcomes,
        vec![(ownership_id.to_string(), SweepOutcome::RetainedMidTurn)]
    );

    // A LATE restore still claims the retained survivor (re-verified) — it
    // reattaches instead of fresh-spawning into the -32600 (A5 fix,
    // reports/V3.md).
    let claimed = reconciler
        .claim_for_session(SESSION)
        .await
        .expect("the retained mid-turn survivor is still claimable");
    assert_eq!(claimed.ownership_id, ownership_id);
    assert_eq!(
        claimed.state,
        SidecarRecordState::Retained {
            reason: "mid-turn-active-thread".to_string()
        },
        "the claim returns the retained record as recorded"
    );
    assert_eq!(reconciler.unclaimed_len(), 0, "the claim left held");
    assert_eq!(
        child.try_wait().expect("try_wait fixture"),
        None,
        "the survivor is alive for the reattach"
    );

    // Final-review H3a: the adopt-time enrich flips the claimed record back
    // to Active — a reattached pane's row must not keep reading
    // Retained{mid-turn} (that would lie to auditors).
    let runtime = ReattachedCodexAppServerRuntime::new(claimed, Arc::clone(&store));
    runtime
        .update_ownership_metadata("term-late-restore".to_string(), 1)
        .await
        .expect("adopt-time enrich");
    let rows = store.load_all();
    assert_eq!(rows.len(), 1, "one durable row for the reattached survivor");
    assert_eq!(
        rows[0].state,
        SidecarRecordState::Active,
        "adopt flips a Retained record back to Active"
    );
    assert_eq!(rows[0].terminal_id.as_deref(), Some("term-late-restore"));

    child
        .kill()
        .await
        .expect("cleanup: kill this test's own fixture");
}

#[tokio::test]
async fn sweep_never_touches_unverified_pids() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_in(&dir);
    let child = spawn_own_sleep_child();
    let ownership_id = "codex-sidecar-a9000004-dddd-4ddd-8ddd-dddddddddddd";
    let record = record_for_child(ownership_id, child.0.id(), Some(SESSION));
    store.write(&record).expect("write record");

    let (reconciler, report) = SidecarReconciler::boot_reconcile(Arc::clone(&store));
    assert_eq!(report.held, 1);
    // The pid-reuse shape appearing AFTER boot: the held record's cmdline no
    // longer matches the live process — this pid is NOT ours. (A record
    // mismatched at boot time is pruned by boot_reconcile before the sweep
    // ever sees it; the sweep's own Mismatch arm exists for post-boot decay.)
    reconciler
        .held
        .lock()
        .unwrap()
        .get_mut(ownership_id)
        .expect("held record")
        .cmdline = vec!["codex".to_string(), "app-server".to_string()];

    let outcomes = reconciler.sweep_unclaimed().await;
    assert_eq!(
        outcomes,
        vec![(ownership_id.to_string(), SweepOutcome::RecordRemovedStale)],
        "a mismatched record is removed, NEVER signalled"
    );

    tokio::time::sleep(NEVER_SIGNALLED_GRACE).await;
    let mut child = child;
    assert_eq!(
        child.0.try_wait().expect("try_wait own sleep child"),
        None,
        "the mismatching pid must never be signalled"
    );
    assert!(store.load_all().is_empty(), "the stale record is removed");
    assert_eq!(reconciler.unclaimed_len(), 0);
}

#[tokio::test]
async fn sweep_never_kills_a_record_claimed_during_the_probe_window() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_in(&dir);
    let ownership_id = "codex-sidecar-a9000005-eeee-4eee-8eee-eeeeeeeeeeee";
    // Default fixture behavior: reachable, no loaded threads — exactly the
    // shape the decide phase turns into a Kill decision.
    let (mut child, ws_url) = spawn_own_fake_app_server_with_behavior(ownership_id, None).await;
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

    // The TOCTOU shape, deterministic (no timing dependence): the sweep's
    // probe phase snapshotted the record...
    let pre_claim_snapshot = record.clone();
    // ...then a restore claimed it while the probe awaited. Per-pid identity
    // re-verification CANNOT detect this (same live process) — membership in
    // `held` is the single source of truth.
    let claimed = reconciler
        .claim_for_session(SESSION)
        .await
        .expect("the restore's claim wins the record");
    assert_eq!(claimed.ownership_id, ownership_id);

    // Drive the sweep's commit arm with the PRE-claim snapshot.
    let outcome = reconciler
        .commit_sweep_decision(&pre_claim_snapshot, SweepDecision::Kill)
        .await;
    assert_eq!(
        outcome,
        SweepOutcome::SkippedClaimedDuringSweep,
        "a record claimed mid-sweep is skipped — killing it is the exact da92 harm"
    );

    // NO signal was sent: the claimant's sidecar is still alive...
    tokio::time::sleep(NEVER_SIGNALLED_GRACE).await;
    assert_eq!(
        child.try_wait().expect("try_wait fixture"),
        None,
        "the claimed sidecar must never be signalled by the sweep"
    );
    // ...and the claimant's record is untouched.
    assert_eq!(
        store.load_all(),
        vec![record],
        "the claimant's record must stay untouched"
    );

    child
        .kill()
        .await
        .expect("cleanup: kill this test's own fixture");
}

#[tokio::test]
async fn kill_verified_sidecar_tree_reaps_descendants() {
    // A tree THIS TEST owns: bash root + two background sleeps. bash dies on
    // SIGTERM without propagating it, orphaning the sleeps — the exact shape
    // that makes single-pid signalling insufficient (A3 falsified).
    let script = "sleep 300 & sleep 300 & wait";
    let root = spawn_own_shell_child("bash", &["-c", script], &["bash", "-c", script]);
    let root_pid = root.0.id() as i32;
    let children = wait_for_sleep_children(root_pid, 2);
    let _orphan_guard = OrphanSnapshotGuard(children.clone());
    let record = record_for_child(
        "codex-sidecar-a9000006-ffff-4fff-8fff-ffffffffffff",
        root.0.id(),
        Some(SESSION),
    );

    let outcome = kill_verified_sidecar_tree(&record).await;
    assert_eq!(
        outcome.outcomes.len(),
        3,
        "root + both captured descendants are accounted for"
    );
    assert_eq!(
        outcome.outcomes[0],
        (record.pid, KillOutcome::ExitedAfterSigterm),
        "the root drains on SIGTERM"
    );
    for &(pid, starttime) in &children {
        assert!(
            outcome
                .outcomes
                .iter()
                .any(|&(p, o)| p == pid as u32 && o == KillOutcome::ExitedAfterSigterm),
            "each captured descendant is individually reaped"
        );
        assert_ne!(
            proc_starttime(pid),
            Some(starttime),
            "the descendant incarnation is gone"
        );
    }

    // The negative: a snapshot-mismatched descendant is NEVER signalled.
    let bystander = spawn_own_sleep_child();
    let bystander_pid = bystander.0.id() as i32;
    let mismatched = PidSnapshot {
        pid: bystander_pid,
        starttime: proc_starttime(bystander_pid).expect("live bystander") + 1,
        cmdline: proc_cmdline(bystander_pid).expect("live bystander"),
    };
    assert_eq!(
        kill_captured_descendant(&mismatched).await,
        KillOutcome::SkippedIdentityMismatch,
        "a stale snapshot refuses the kill"
    );
    tokio::time::sleep(NEVER_SIGNALLED_GRACE).await;
    let mut bystander = bystander;
    assert_eq!(
        bystander.0.try_wait().expect("try_wait bystander"),
        None,
        "the snapshot-mismatched pid must never be signalled"
    );
}

#[tokio::test]
async fn restart_reconciliation_leaves_no_sidecar_silently_orphaned() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_in(&dir);

    // (a) The claimable verified survivor (newest updated_at of the
    //     session-id duplicates — the claim's fallback winner).
    let child_a = spawn_own_sleep_child();
    let id_a = "codex-sidecar-a9000011-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let record_a = CodexSidecarRecord {
        updated_at: 1_700_000_000_002,
        ..record_for_child(id_a, child_a.0.id(), Some(SESSION))
    };

    // (b) A dead pid: real evidence captured live, then OUR OWN child is
    //     killed+reaped — pruned at boot.
    let mut child_b = spawn_own_sleep_child();
    let id_b = "codex-sidecar-a9000012-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let record_b = record_for_child(id_b, child_b.0.id(), Some(SESSION));
    child_b.0.kill().expect("kill own child");
    child_b.0.wait().expect("reap own child");

    // (c) A verified idle sidecar (loaded-but-idle fixture) — reaped.
    let id_c = "codex-sidecar-a9000013-cccc-4ccc-8ccc-cccccccccccc";
    let (mut child_c, ws_c) = spawn_own_fake_app_server_with_behavior(
        id_c,
        Some(r#"{"loadedThreadIds": ["t-c"], "threadStatuses": {"t-c": "idle"}}"#),
    )
    .await;
    let record_c = CodexSidecarRecord {
        ws_url: ws_c,
        ..record_for_child(id_c, child_c.id().expect("live fixture pid"), None)
    };

    // (d) A verified mid-turn sidecar — retained with a recorded reason.
    let id_d = "codex-sidecar-a9000014-dddd-4ddd-8ddd-dddddddddddd";
    let (mut child_d, ws_d) = spawn_own_fake_app_server_with_behavior(
        id_d,
        Some(r#"{"loadedThreadIds": ["t-d"], "threadStatuses": {"t-d": "active"}}"#),
    )
    .await;
    let record_d = CodexSidecarRecord {
        ws_url: ws_d,
        ..record_for_child(
            id_d,
            child_d.id().expect("live fixture pid"),
            Some("0198f00d-0d0d-7db3-9c47-1c2a3b4c5d6e"),
        )
    };

    // (e) A DUPLICATE verified record sharing (a)'s session id (the A4
    //     shape, reports/V3.md) — the claim LOSER, swept to its own fate
    //     (reaped here — idle).
    let child_e = spawn_own_sleep_child();
    let id_e = "codex-sidecar-a9000015-eeee-4eee-8eee-eeeeeeeeeeee";
    let record_e = CodexSidecarRecord {
        updated_at: 1_700_000_000_001,
        ..record_for_child(id_e, child_e.0.id(), Some(SESSION))
    };

    for record in [&record_a, &record_b, &record_c, &record_d, &record_e] {
        store.write(record).expect("write record");
    }

    // Boot → claim (a restore for (a)'s session) → sweep.
    let (reconciler, report) = SidecarReconciler::boot_reconcile(Arc::clone(&store));
    assert_eq!(report.loaded, 5);
    assert_eq!(report.pruned_dead, 1, "(b) is removed at boot");
    assert_eq!(report.held, 4);

    let claimed = reconciler
        .claim_for_session(SESSION)
        .await
        .expect("the restore claims one of the session duplicates");
    assert_eq!(
        claimed, record_a,
        "the newest-updated_at duplicate wins the claim (reattached-by-construction)"
    );
    assert_eq!(
        reconciler.unclaimed_len(),
        3,
        "(c), (d), (e) remain unclaimed"
    );

    let mut outcomes = reconciler.sweep_unclaimed().await;
    outcomes.sort_by(|x, y| x.0.cmp(&y.0));
    assert_eq!(
        outcomes,
        vec![
            (id_c.to_string(), SweepOutcome::Reaped),
            (id_d.to_string(), SweepOutcome::RetainedMidTurn),
            (id_e.to_string(), SweepOutcome::Reaped),
        ],
        "every unclaimed record is swept to an explicit fate"
    );

    // The exhaustive end-state: every sidecar is accounted for — reattached,
    // reaped, or intentionally retained with a recorded reason. Never
    // silently dropped from the books.
    tokio::time::timeout(Duration::from_secs(10), child_c.wait())
        .await
        .expect("(c) must be reaped within the drain budget")
        .expect("wait fixture c");
    let mut child_e = child_e;
    wait_child_gone(&mut child_e.0, "(e) — the claim loser — must be reaped");
    let mut child_a = child_a;
    assert_eq!(
        child_a.0.try_wait().expect("try_wait child a"),
        None,
        "(a) — the claimed survivor — must stay alive"
    );
    assert_eq!(
        child_d.try_wait().expect("try_wait fixture d"),
        None,
        "(d) — mid-turn — must stay alive"
    );

    let mut rows = store.load_all();
    rows.sort_by(|x, y| x.ownership_id.cmp(&y.ownership_id));
    assert_eq!(
        rows.len(),
        2,
        "the store holds ONLY the claimed Active record and the retained record"
    );
    assert_eq!(rows[0], record_a, "(a)'s claimed record stays Active");
    assert_eq!(rows[1].ownership_id, id_d);
    assert_eq!(
        rows[1].state,
        SidecarRecordState::Retained {
            reason: "mid-turn-active-thread".to_string()
        },
        "(d)'s retention reason is durably recorded"
    );
    assert_eq!(
        reconciler.unclaimed_len(),
        1,
        "(d) stays held — claimable by a late restore, re-evaluated at next boot"
    );

    child_d
        .kill()
        .await
        .expect("cleanup: kill this test's own fixture");
}

// ---------------------------------------------------------------------------
// Supplementary coverage: the remaining SweepOutcome paths + the Task 6
// carry-forward (truthful KillOutcome fidelity).
// ---------------------------------------------------------------------------

#[tokio::test]
async fn sweep_retains_ws_unreachable_writer_holding_survivor() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_in(&dir);
    // A verified survivor whose ws is UNREACHABLE but which holds an open
    // rollout .jsonl WRITE handle — the writer-evidence shape (reports/V2.md).
    let rollout = dir.path().join("rollout-t-writer.jsonl");
    let script = format!("exec sleep 300 >> '{}'", rollout.display());
    let child = spawn_own_shell_child("bash", &["-c", &script], &["sleep", "300"]);
    let ownership_id = "codex-sidecar-a9000021-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    // record_for_child's default ws_url points at a closed loopback port.
    let record = record_for_child(ownership_id, child.0.id(), Some(SESSION));
    store.write(&record).expect("write record");

    let (reconciler, _report) = SidecarReconciler::boot_reconcile(Arc::clone(&store));
    let outcomes = reconciler.sweep_unclaimed().await;
    assert_eq!(
        outcomes,
        vec![(ownership_id.to_string(), SweepOutcome::RetainedWriterHeld)],
        "an unreachable-but-writer-holding survivor is retained, not killed"
    );

    tokio::time::sleep(NEVER_SIGNALLED_GRACE).await;
    let mut child = child;
    assert_eq!(
        child.0.try_wait().expect("try_wait own writer child"),
        None,
        "the writer-holding survivor must never be signalled"
    );
    let rows = store.load_all();
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].state,
        SidecarRecordState::Retained {
            reason: "ws-unreachable-writer-held".to_string()
        }
    );
    assert_eq!(reconciler.unclaimed_len(), 1, "retained rows stay held");
}

#[tokio::test]
async fn unverifiable_verdict_decides_retain_and_commit_records_reason() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_in(&dir);
    let child = spawn_own_sleep_child();
    let ownership_id = "codex-sidecar-a9000022-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let record = record_for_child(ownership_id, child.0.id(), Some(SESSION));
    store.write(&record).expect("write record");
    let (reconciler, _report) = SidecarReconciler::boot_reconcile(Arc::clone(&store));

    // An Unverifiable verdict cannot be synthesized end-to-end for a
    // test-owned child on Linux (its cmdline is always readable), so the
    // decide-phase mapping and the commit arm are pinned directly.
    let decision = decide_sweep_action(&record, &IdentityVerdict::Unverifiable).await;
    assert!(
        matches!(decision, SweepDecision::RetainUnverifiable),
        "not provably ours + not provably stale ⇒ retained, never signalled"
    );
    let outcome = reconciler.commit_sweep_decision(&record, decision).await;
    assert_eq!(outcome, SweepOutcome::RetainedUnverifiable);

    tokio::time::sleep(NEVER_SIGNALLED_GRACE).await;
    let mut child = child;
    assert_eq!(
        child.0.try_wait().expect("try_wait own sleep child"),
        None,
        "an unverifiable pid must never be signalled"
    );
    let rows = store.load_all();
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].state,
        SidecarRecordState::Retained {
            reason: "identity-unverifiable".to_string()
        }
    );
    // Still held AND still claimable (evidence re-verifies fine at claim).
    assert_eq!(reconciler.unclaimed_len(), 1);
    let claimed = reconciler
        .claim_for_session(SESSION)
        .await
        .expect("the retained record is still claimable");
    assert_eq!(claimed.ownership_id, ownership_id);
}

#[tokio::test]
async fn sweep_preserves_record_and_reports_unconfirmed_when_kill_cannot_prove_empty() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_in(&dir);
    let ownership_id = "codex-sidecar-a9000022-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    // On TERM the root re-execs with a different argv. The sweep has already
    // sent a signal, but the identity no longer authorizes escalation. This is
    // the exact shape that used to be mislabeled Reaped and have its record
    // deleted even though the root still existed.
    let script = r#"trap 'exec sleep 301' TERM; sleep 300 & wait"#;
    let root = spawn_own_shell_child("bash", &["-c", script], &["bash", "-c", script]);
    let root_pid = root.0.id() as i32;
    let children = wait_for_sleep_children(root_pid, 1);
    let _orphan_guard = OrphanSnapshotGuard(children);
    let record = record_for_child(ownership_id, root.0.id(), Some(SESSION));
    store.write(&record).expect("write record");
    let (reconciler, report) = SidecarReconciler::boot_reconcile(Arc::clone(&store));
    assert_eq!(report.held, 1);

    let outcome = reconciler
        .commit_sweep_decision(&record, SweepDecision::Kill)
        .await;
    assert_eq!(outcome, SweepOutcome::TerminationUnconfirmed);
    assert_eq!(
        proc_starttime(root_pid),
        Some(record.starttime),
        "the exact root incarnation still exists, so Reaped would be false"
    );
    let rows = store.load_all();
    assert_eq!(
        rows.len(),
        1,
        "ownership evidence must survive an unconfirmed kill"
    );
    assert_eq!(rows[0].ownership_id, ownership_id);
    assert_eq!(
        rows[0].state,
        SidecarRecordState::Retained {
            reason: "termination-unconfirmed".to_string()
        }
    );
    assert_eq!(
        reconciler.unclaimed_len(),
        1,
        "the unconfirmed row remains held for later reconciliation"
    );
    // ChildGuard owns and reaps only this test's re-exec'd root on drop.
}

#[tokio::test]
async fn kill_tree_reports_sigterm_sent_when_escalation_is_refused() {
    // The Task 6 carry-forward: after SIGTERM is sent and the drain budget
    // expires, a pre-SIGKILL re-verify that no longer matches must report
    // that a SIGTERM WAS sent and the escalation was refused — not a
    // "Skipped*" outcome that under-reports the signal. The tree here execs
    // a NEW argv on TERM (same pid, same starttime, new cmdline): the
    // pid-identity decays mid-drain.
    let script = r#"trap 'exec sleep 301' TERM; sleep 300 & wait"#;
    let root = spawn_own_shell_child("bash", &["-c", script], &["bash", "-c", script]);
    let root_pid = root.0.id() as i32;
    let children = wait_for_sleep_children(root_pid, 1);
    let _orphan_guard = OrphanSnapshotGuard(children.clone());
    let record = record_for_child(
        "codex-sidecar-a9000023-cccc-4ccc-8ccc-cccccccccccc",
        root.0.id(),
        Some(SESSION),
    );

    let outcome = kill_verified_sidecar_tree(&record).await;
    assert_eq!(
        outcome.outcomes[0],
        (record.pid, KillOutcome::SigtermSentEscalationRefused),
        "the outcome must report the sent SIGTERM and the refused SIGKILL truthfully"
    );
    // No SIGKILL was sent: the same incarnation is still alive (as its new
    // argv).
    assert_eq!(
        proc_starttime(root_pid),
        Some(record.starttime),
        "the re-exec'd root incarnation survives — escalation was refused"
    );
    assert_eq!(
        proc_cmdline(root_pid).as_deref(),
        Some(&["sleep".to_string(), "301".to_string()][..]),
        "the root re-exec'd mid-drain (the identity-decay shape)"
    );
    // Its captured descendant was still individually reaped.
    let (child_pid, child_starttime) = children[0];
    assert!(
        outcome
            .outcomes
            .iter()
            .any(|&(p, o)| p == child_pid as u32 && o == KillOutcome::ExitedAfterSigterm),
        "the captured descendant is reaped independently of the root refusal"
    );
    assert_ne!(proc_starttime(child_pid), Some(child_starttime));
    // ChildGuard drop reaps the re-exec'd root (still this test's child).
}

/// Task 10: the boot wiring's grace parse — env value in millis, default on
/// unset/non-numeric, `0` honored (immediate sweep). Pure half only: env
/// mutation races parallel test binaries.
#[test]
fn reap_grace_parse_honors_value_zero_and_default() {
    let default = std::time::Duration::from_millis(CODEX_SIDECAR_REAP_GRACE_MS_DEFAULT);
    assert_eq!(
        reap_grace_from_value(Some("1500")),
        std::time::Duration::from_millis(1500)
    );
    assert_eq!(
        reap_grace_from_value(Some("0")),
        std::time::Duration::ZERO,
        "0 is a legitimate immediate-sweep knob"
    );
    assert_eq!(reap_grace_from_value(None), default);
    assert_eq!(reap_grace_from_value(Some("not-a-number")), default);
}

#[tokio::test]
async fn sweep_treats_malformed_loaded_list_as_unreachable_not_idle() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_in(&dir);
    // A reachable fixture whose thread/loaded/list result is MALFORMED (no
    // `data` array) via the per-method overrides knob (final review F2):
    // Ok(vec![]) parsing would read this as "reachable, no loaded threads"
    // and REAP — the client must surface an error instead, sending the sweep
    // down the conservative Unreachable → writer-evidence path.
    let fixture_ownership = "codex-sidecar-f2000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let (mut fixture, ws_url) = spawn_own_fake_app_server_with_behavior(
        fixture_ownership,
        Some(r#"{"overrides": {"thread/loaded/list": {"result": {"unexpected": true}}}}"#),
    )
    .await;
    // The RECORD's verified pid is a SEPARATE test-owned child holding real
    // writer evidence (an open rollout .jsonl write fd), while its ws_url
    // points at the malformed fixture. The outcome discriminates the two
    // paths deterministically: ReachableIdle would Kill/Reap this record;
    // the Unreachable arm consults /proc/<pid>/fd and RETAINS it.
    let rollout = dir.path().join("rollout-t-malformed.jsonl");
    let script = format!("exec sleep 300 >> '{}'", rollout.display());
    let writer_child = spawn_own_shell_child("bash", &["-c", &script], &["sleep", "300"]);
    let ownership_id = "codex-sidecar-f2000002-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let record = CodexSidecarRecord {
        ws_url,
        ..record_for_child(ownership_id, writer_child.0.id(), Some(SESSION))
    };
    store.write(&record).expect("write record");

    let (reconciler, _report) = SidecarReconciler::boot_reconcile(Arc::clone(&store));
    let outcomes = reconciler.sweep_unclaimed().await;
    assert_eq!(
        outcomes,
        vec![(ownership_id.to_string(), SweepOutcome::RetainedWriterHeld)],
        "a malformed loaded-list must take the writer-evidence path, not ReachableIdle"
    );

    tokio::time::sleep(NEVER_SIGNALLED_GRACE).await;
    let mut writer_child = writer_child;
    assert_eq!(
        writer_child.0.try_wait().expect("try_wait writer child"),
        None,
        "the writer-holding survivor must never be signalled on malformed data"
    );

    fixture
        .kill()
        .await
        .expect("cleanup: kill this test's own fixture");
}

#[tokio::test]
async fn kill_tree_root_refusal_skips_captured_descendants() {
    // Final-review H3b: when the root's PRE-signal re-verify refuses
    // (Mismatch/Unverifiable), the captured descendants' provenance is in
    // doubt (they were snapshotted as children of an unproven root) — the
    // descendant loop must be skipped entirely, nothing signalled. Driven
    // through the private linux arm directly: the public entry refuses a
    // Mismatch before ever capturing, so the inner re-verify refusal is the
    // only reachable shape for this guard.
    let script = "sleep 300 & sleep 300 & wait";
    let root = spawn_own_shell_child("bash", &["-c", script], &["bash", "-c", script]);
    let root_pid = root.0.id() as i32;
    let children = wait_for_sleep_children(root_pid, 2);
    let _orphan_guard = OrphanSnapshotGuard(children.clone());
    // The pid-reuse shape: live pid + starttime, WRONG cmdline.
    let record = CodexSidecarRecord {
        cmdline: vec!["codex".to_string(), "app-server".to_string()],
        ..record_for_child(
            "codex-sidecar-b3000001-cccc-4ccc-8ccc-cccccccccccc",
            root.0.id(),
            Some(SESSION),
        )
    };

    let outcome = kill_verified_tree_linux(&record).await;
    assert_eq!(
        outcome.outcomes,
        vec![(record.pid, KillOutcome::SkippedIdentityMismatch)],
        "a pre-signal root refusal reports ONLY the root; no descendant is processed"
    );

    // NOTHING was signalled: the root and both captured descendants live on.
    tokio::time::sleep(NEVER_SIGNALLED_GRACE).await;
    let mut root = root;
    assert_eq!(
        root.0.try_wait().expect("try_wait root"),
        None,
        "the mismatched root must never be signalled"
    );
    for &(pid, starttime) in &children {
        assert_eq!(
            proc_starttime(pid),
            Some(starttime),
            "descendants of an unproven root must never be signalled"
        );
    }
}
