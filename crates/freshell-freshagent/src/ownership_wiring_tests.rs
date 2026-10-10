//! Fresh-agent-lane coordinator wiring (kata b8ke Task 3).
//!
//! Drives the SHARED claim helpers with a bare registry — no sidecar, no
//! server — proving the lane's claim/commit/fail/stop semantics map 1:1 onto
//! the coordinator states. The live-path integration (a real create/kill
//! driving the same helpers) is pinned in
//! freshell-ws/tests/cross_kind_liveness.rs.
use std::sync::Arc;

use freshell_ownership::{
    BeginOutcome, CommitOutcome, OwnershipState, RuntimeOwnerKind, StopOutcome,
};

use crate::ownership_lane::{
    begin_fresh_agent_stop, claim_fresh_agent_ownership, commit_fresh_agent_ownership,
    commit_fresh_agent_stop, fail_fresh_agent_ownership,
};

fn owner_fresh(key: &str) -> freshell_ownership::OwnerIdentity {
    freshell_ownership::OwnerIdentity {
        kind: RuntimeOwnerKind::FreshAgent,
        terminal_id: None,
        live_session_key: Some(key.to_string()),
        pid: Some(991),
        ownership_id: Some("own-1".into()),
        unit_id: None,
        hold: freshell_ownership::HoldKind::Main,
    }
}

#[test]
fn fresh_agent_claim_then_commit_is_live_then_kill_releases() {
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    let BeginOutcome::Granted { generation } =
        claim_fresh_agent_ownership(&registry, "codex", "sid-1", "op-1", None, "test", 1)
    else {
        panic!("expected Granted")
    };
    assert_eq!(
        commit_fresh_agent_ownership(
            &registry,
            "codex",
            "sid-1",
            "op-1",
            generation,
            owner_fresh("freshcodex:sid-1")
        ),
        CommitOutcome::Committed
    );
    assert!(matches!(
        registry.observe("codex", "sid-1").state,
        OwnershipState::Live { .. }
    ));
    // Kill path (round-1 review): Live{fresh-agent} -> Stopping FIRST (the kill
    // happens while Stopping — competing starts are Blocked), then
    // commit_stop -> Vacant ONLY after the confirmed reap. Round-2 review:
    // the stop carries the FENCED claim — the lane's believed runtime
    // identity plus the (epoch, generation) its commit stamped.
    let stop_claim = freshell_ownership::StopClaim {
        expected_kind: RuntimeOwnerKind::FreshAgent,
        expected_runtime: Some(owner_fresh("freshcodex:sid-1")),
        observed: freshell_ownership::ObservedFence {
            epoch: registry.boot_epoch(),
            generation,
        },
    };
    match begin_fresh_agent_stop(
        &registry,
        "codex",
        "sid-1",
        "kill-1",
        &stop_claim,
        "test",
        2,
    ) {
        StopOutcome::Granted { generation } => {
            assert!(
                matches!(
                    claim_fresh_agent_ownership(
                        &registry, "codex", "sid-1", "op-x", None, "test", 3
                    ),
                    BeginOutcome::Blocked { .. }
                ),
                "no competing start may be granted while Stopping"
            );
            // ...the caller kills the sidecar and awaits its confirmed exit...
            assert_eq!(
                commit_fresh_agent_stop(&registry, "codex", "sid-1", "kill-1", generation),
                CommitOutcome::Committed
            );
        }
        other => panic!("expected Granted, got {other:?}"),
    }
    assert_eq!(
        registry.observe("codex", "sid-1").state,
        OwnershipState::Vacant
    );
}

#[test]
fn fresh_agent_stop_during_a_handoff_is_typed_blocked_and_does_not_kill() {
    // Round-1 review: a stop attempted during another operation's Handoff
    // returns the typed BlockedHandoff — the caller must NOT kill.
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    let BeginOutcome::Granted { generation } =
        claim_fresh_agent_ownership(&registry, "codex", "sid-4", "op-4", None, "test", 1)
    else {
        panic!()
    };
    assert_eq!(
        commit_fresh_agent_ownership(
            &registry,
            "codex",
            "sid-4",
            "op-4",
            generation,
            owner_fresh("freshcodex:sid-4")
        ),
        CommitOutcome::Committed
    );
    let BeginOutcome::Granted { .. } = registry.begin_handoff(
        "codex",
        "sid-4",
        RuntimeOwnerKind::Terminal,
        "ho-4",
        None,
        "test",
        2,
    ) else {
        panic!()
    };
    let stop_claim = freshell_ownership::StopClaim {
        expected_kind: RuntimeOwnerKind::FreshAgent,
        expected_runtime: Some(owner_fresh("freshcodex:sid-4")),
        observed: freshell_ownership::ObservedFence {
            epoch: registry.boot_epoch(),
            generation,
        },
    };
    assert!(matches!(
        begin_fresh_agent_stop(
            &registry,
            "codex",
            "sid-4",
            "kill-4",
            &stop_claim,
            "test",
            3
        ),
        StopOutcome::BlockedHandoff { .. }
    ));
    assert!(
        matches!(
            registry.observe("codex", "sid-4").state,
            OwnershipState::Handoff { .. }
        ),
        "the blocked stop must not have killed or transitioned the handoff"
    );
}

#[test]
fn fresh_agent_stop_with_a_stale_claim_is_typed_refused_and_does_not_kill() {
    // Round-2 review: a delayed fresh-agent kill whose claim no longer
    // matches the current owner (ownership moved to a terminal under a new
    // generation) is the typed StaleClaim — NO kill, no transition.
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    let BeginOutcome::Granted { generation } =
        claim_fresh_agent_ownership(&registry, "codex", "sid-5", "op-5", None, "test", 1)
    else {
        panic!()
    };
    assert_eq!(
        commit_fresh_agent_ownership(
            &registry,
            "codex",
            "sid-5",
            "op-5",
            generation,
            owner_fresh("freshcodex:sid-5")
        ),
        CommitOutcome::Committed
    );
    // Ownership moves to a terminal via a handoff.
    let BeginOutcome::Granted { generation: g2 } = registry.begin_handoff(
        "codex",
        "sid-5",
        RuntimeOwnerKind::Terminal,
        "ho-5",
        None,
        "test",
        2,
    ) else {
        panic!()
    };
    let term = freshell_ownership::OwnerIdentity {
        kind: RuntimeOwnerKind::Terminal,
        terminal_id: Some("t-5".into()),
        live_session_key: None,
        pid: None,
        ownership_id: None,
        unit_id: None,
        hold: freshell_ownership::HoldKind::Main,
    };
    assert_eq!(
        registry.commit_live("codex", "sid-5", "ho-5", g2, term),
        CommitOutcome::Committed
    );
    // The delayed kill's fence still carries the fresh-agent generation.
    let stale = freshell_ownership::StopClaim {
        expected_kind: RuntimeOwnerKind::FreshAgent,
        expected_runtime: Some(owner_fresh("freshcodex:sid-5")),
        observed: freshell_ownership::ObservedFence {
            epoch: registry.boot_epoch(),
            generation,
        },
    };
    assert!(matches!(
        begin_fresh_agent_stop(&registry, "codex", "sid-5", "kill-5", &stale, "test", 3),
        StopOutcome::StaleClaim { .. }
    ));
    assert!(
        matches!(
            registry.observe("codex", "sid-5").state,
            OwnershipState::Live { ref owner, .. } if owner.kind == RuntimeOwnerKind::Terminal
        ),
        "the stale kill must not have transitioned or killed the terminal owner"
    );
}

#[test]
fn fresh_agent_claim_fails_typed_when_terminal_owns() {
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    let BeginOutcome::Granted { generation } = registry.begin_start(
        "codex",
        "sid-2",
        RuntimeOwnerKind::Terminal,
        "term-op",
        None,
        "test",
        1,
    ) else {
        panic!()
    };
    let t = freshell_ownership::OwnerIdentity {
        kind: RuntimeOwnerKind::Terminal,
        terminal_id: Some("t-1".into()),
        live_session_key: None,
        pid: None,
        ownership_id: None,
        unit_id: None,
        hold: freshell_ownership::HoldKind::Main,
    };
    registry.commit_live("codex", "sid-2", "term-op", generation, t);
    // The fresh-agent lane's claim must see the typed cross-kind conflict.
    let claim = claim_fresh_agent_ownership(&registry, "codex", "sid-2", "op-2", None, "test", 2);
    assert!(matches!(claim, BeginOutcome::OwnedByOtherKind { .. }));
}

#[test]
fn fresh_agent_fail_reopens_the_key() {
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    let BeginOutcome::Granted { generation } =
        claim_fresh_agent_ownership(&registry, "opencode", "ses-3", "op-3", None, "test", 1)
    else {
        panic!()
    };
    assert_eq!(
        fail_fresh_agent_ownership(&registry, "opencode", "ses-3", "op-3", generation),
        freshell_ownership::FailOutcome::Released
    );
    let retry =
        claim_fresh_agent_ownership(&registry, "opencode", "ses-3", "op-4", None, "test", 2);
    assert!(matches!(retry, BeginOutcome::Granted { .. }));
}

/// b8ke focused episode-2 round-1 F6: the start-cancellation slot signals
/// ONLY through the recorded-incarnation path. The slot records (pid, start
/// time) at spawn; a forged MISMATCHED start time models the recycled-pid
/// shape (the original exited; an unrelated process took the id within the
/// watchdog's sweep window) — the cancellation must NEVER signal it.
/// Pre-fix the closure SIGTERMed the bare numeric pid and the unrelated
/// process died.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn the_start_cancellation_slot_never_signals_a_recycled_pid() {
    // A live "unrelated replacement" process.
    let mut unrelated = tokio::process::Command::new("sleep")
        .arg("300")
        .kill_on_drop(true)
        .spawn()
        .expect("spawn the unrelated replacement");
    let pid = unrelated.id().expect("unrelated pid");

    // The slot armed with the ORIGINAL (dead) incarnation's identity — the
    // start time forged to differ, the pid-reuse shape.
    let slot = crate::ownership_lane::sidecar_pid_cancel_slot();
    crate::ownership_lane::arm_sidecar_pid_slot(&slot, Some(pid));
    {
        let mut armed = slot.lock().expect("slot lock");
        let (recorded_pid, _) = armed.expect("the slot armed");
        assert_eq!(recorded_pid, pid);
        // Forge the mismatch: the pid now belongs to a different
        // incarnation than the one the slot recorded.
        *armed = Some((
            pid,
            crate::session_lease::recorded_start_time(Some(pid)).map(|st| st + 1),
        ));
    }
    (crate::ownership_lane::pid_slot_cancellation(&slot))();
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(
        crate::session_lease::proc_starttime(pid as i32).is_some(),
        "the recycled pid's unrelated process must NEVER be signaled by the \
         start cancellation"
    );

    // The matching-incarnation control: the recorded identity still holds
    // — the cancellation signals and the process dies.
    crate::ownership_lane::arm_sidecar_pid_slot(&slot, Some(pid));
    (crate::ownership_lane::pid_slot_cancellation(&slot))();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while crate::session_lease::proc_starttime(pid as i32).is_some() {
        assert!(
            std::time::Instant::now() < deadline,
            "the recorded incarnation was never signaled"
        );
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    let _ = unrelated.wait().await;
}

/// F6 (the post-spawn direct variant): a mismatched recorded incarnation
/// never signals; the matching one does.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn the_start_cancellation_direct_variant_verifies_the_incarnation() {
    let mut child = tokio::process::Command::new("sleep")
        .arg("300")
        .kill_on_drop(true)
        .spawn()
        .expect("spawn the child");
    let pid = child.id().expect("child pid");
    let start = crate::session_lease::recorded_start_time(Some(pid));

    // The recycled shape: the recorded start time does not match the pid's
    // current occupant — never signaled.
    let wrong = crate::ownership_lane::sidecar_pid_cancellation(Some(pid), start.map(|st| st + 1));
    wrong();
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(
        crate::session_lease::proc_starttime(pid as i32).is_some(),
        "the mismatched incarnation must never be signaled"
    );

    // The matching control.
    let right = crate::ownership_lane::sidecar_pid_cancellation(Some(pid), start);
    right();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while crate::session_lease::proc_starttime(pid as i32).is_some() {
        assert!(
            std::time::Instant::now() < deadline,
            "the matching incarnation was never signaled"
        );
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    let _ = child.wait().await;
}

/// b8ke focused episode-2 post-cap F6: the start-cancellation registration
/// targets the TICKET'S canonical key — the claim path resolves aliases
/// before acquiring, so a legitimate resume through a superseded (re-keyed)
/// wire id arms its cancellation on the record the watchdog actually
/// sweeps. Pre-fix the helper registered against the caller's wire id: the
/// registry looked for `Starting` under the old `Aliased` key, silently
/// declined, and the operation ran unkillable (a slow resume fenced with
/// nothing armed). The decline is LOUD now (the invariant log) — this test
/// pins the POSITIVE contract: registered on the canonical record, the
/// settle-fired evidence observable.
#[tokio::test]
async fn start_cancellation_registers_on_the_tickets_canonical_key() {
    let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());

    // The re-key residue: wire-old was Live, then re-keyed to wire-canonical
    // (the claude rollback's move). A stale pane still addresses wire-old.
    let BeginOutcome::Granted { generation: g0 } = registry.begin_start(
        "claude",
        "wire-old",
        RuntimeOwnerKind::FreshAgent,
        "op-original",
        None,
        "test",
        0,
    ) else {
        panic!("expected Granted")
    };
    assert!(matches!(
        registry.commit_live(
            "claude",
            "wire-old",
            "op-original",
            g0,
            freshell_ownership::OwnerIdentity {
                kind: RuntimeOwnerKind::FreshAgent,
                terminal_id: None,
                live_session_key: Some("map-key".into()),
                pid: Some(4321),
                ownership_id: None,
                unit_id: None,
                hold: freshell_ownership::HoldKind::Main,
            }
        ),
        CommitOutcome::Committed
    ));
    assert!(matches!(
        registry.rekey_live(
            "claude",
            "wire-old",
            "wire-canonical",
            "map-key",
            freshell_ownership::OwnerIdentity {
                kind: RuntimeOwnerKind::FreshAgent,
                terminal_id: None,
                live_session_key: Some("map-key".into()),
                pid: Some(4322),
                ownership_id: Some("rekey-op".into()),
                unit_id: None,
                hold: freshell_ownership::HoldKind::Main,
            },
            "test-rekey",
            "rekey-op",
        ),
        CommitOutcome::Committed
    ));

    // The canonical runtime exits (the rekeyed owner releases) — the
    // stale pane's RESUME shape: the pane still holds wire-old, the
    // canonical key is Vacant.
    assert!(matches!(
        registry.force_release_for_confirmed_kill(
            "claude",
            "wire-canonical",
            &freshell_ownership::ReleaseClaim {
                operation_id: "rekey-op".into(),
                generation: g0 + 1,
                runtime: Some(freshell_ownership::OwnerIdentity {
                    kind: RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some("map-key".into()),
                    pid: Some(4322),
                    ownership_id: Some("rekey-op".into()),
                    unit_id: None,
                    hold: freshell_ownership::HoldKind::Main,
                }),
            },
            "claude-exit",
        ),
        ()
    ));
    assert!(matches!(
        registry.observe("claude", "wire-canonical").state,
        OwnershipState::Vacant
    ));
    // The lane claim — the claude lane's production shape: resolve the
    // alias FIRST (resolve_ownership_key → the registry's fixpoint walk),
    // then claim the canonical key (the ticket carries it).
    let canonical = registry.resolve_canonical("claude", "wire-old");
    assert_eq!(canonical, "wire-canonical");
    let claim = crate::ownership_lane::begin_lane_claim(
        &Some(Arc::clone(&registry)),
        "claude",
        &canonical,
        "op-resume",
        None,
        "test",
        0,
    );
    let ticket = match claim {
        crate::ownership_lane::LaneClaim::Granted(ticket) => ticket,
        crate::ownership_lane::LaneClaim::Unwired => panic!("expected Granted through the alias"),
        crate::ownership_lane::LaneClaim::Adopt => panic!("expected Granted, got Adopt"),
        crate::ownership_lane::LaneClaim::Refused(_) => panic!("expected Granted, got Refused"),
    };
    assert_eq!(
        ticket.session_id(),
        "wire-canonical",
        "the ticket carries the CANONICAL key (the claim resolved the alias)"
    );

    // THE REGISTRATION through the stale wire id (the production call
    // shape): it must land on the CANONICAL record — the pre-fix helper
    // passed the wire id straight through and the registry silently
    // declined (no cancellation, unkillable).
    let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let cancel = {
        let cancelled = Arc::clone(&cancelled);
        Arc::new(move || cancelled.store(true, std::sync::atomic::Ordering::SeqCst))
            as Arc<dyn Fn() + Send + Sync>
    };
    // The ticket binding must OUTLIVE the registration (the production
    // shape: `&own_ticket` where the Option is a long-lived local — a
    // temporary `&Some(ticket)` would drop the ticket at the call's end
    // and FAIL the claim).
    let own_ticket = Some(ticket);
    let guard = crate::ownership_lane::register_start_cancellation_for_ticket(
        &Some(Arc::clone(&registry)),
        "claude",
        "wire-old",
        &own_ticket,
        cancel,
    );
    // b8ke ext r20 F1: the sweep now SKIPS a witnessed LIVE start (the
    // registered-and-not-fired flag means the handler still runs) — drop
    // the guard first (the handler-unwound arm) so the sweep takes the
    // record and the canonical-key machinery assertions observe through
    // the arm the watchdog exists for.
    drop(guard);
    let recovered = registry.recover_stale_starts(0, 0);
    assert_eq!(
        recovered.len(),
        1,
        "the canonical Starting record is sweep-visible"
    );
    let rec = &recovered[0];
    assert_eq!(rec.session_id, "wire-canonical");
    assert!(
        rec.cancellation.is_some(),
        "the cancellation ARMED on the canonical record — the pre-fix \
         registration targeted the aliased wire id and silently declined"
    );
    // The settle evidence: fence, drop the guard (the operation concluded),
    // and the probe's enumerate carries the reason-appropriate
    // settle_concluded = Some(true) (a START fence reads the start's
    // settle_fired flag).
    assert!(matches!(
        registry.fence_unconfirmed_stop(
            "claude",
            "wire-canonical",
            &rec.operation_id,
            rec.generation,
            freshell_ownership::FenceReason::StaleStart,
        ),
        freshell_ownership::FenceOutcome::Fenced
    ));
    // (the guard already dropped above — its Drop fired the sender-side
    // settle evidence the assertion below reads)
    let fences = registry.stale_start_fences();
    assert_eq!(fences.len(), 1);
    assert_eq!(
        fences[0].settle_concluded,
        Some(true),
        "the guard's Drop sets the SENDER-side settle evidence — the probe \
         can answer 'the operation concluded' without polling the boxed future"
    );
    let _ = cancelled;
}
