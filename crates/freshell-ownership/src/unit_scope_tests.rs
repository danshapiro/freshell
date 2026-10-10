//! Unit-scoped lifecycle on the ONE registry (no second state machine):
//! Running = Live, Stopping = Stopping, Gone = Vacant, with event-driven
//! waiting (wakers; no polling).
use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};
use std::time::Duration;

use super::*;

const NOW: u64 = 1_000;

fn owner(terminal: &str, unit: &str) -> OwnerIdentity {
    OwnerIdentity {
        kind: RuntimeOwnerKind::Terminal,
        terminal_id: Some(terminal.into()),
        unit_id: Some(unit.into()),
        ..OwnerIdentity::default()
    }
}

/// Drive a key to Live{owner} through the ordinary start path.
fn make_live(reg: &RuntimeOwnershipRegistry, sid: &str, who: OwnerIdentity) {
    let BeginOutcome::Granted { generation } = reg.begin_start(
        "codex",
        sid,
        RuntimeOwnerKind::Terminal,
        "op-start",
        None,
        "test",
        NOW,
    ) else {
        panic!("start granted")
    };
    assert_eq!(
        reg.commit_live("codex", sid, "op-start", generation, who),
        CommitOutcome::Committed
    );
}

fn session_ids(keys: &[UnitStopKey]) -> Vec<&str> {
    keys.iter().map(|k| k.key.session_id.as_str()).collect()
}

fn stopping_operation(reg: &RuntimeOwnershipRegistry, sid: &str) -> Option<String> {
    match reg.observe("codex", sid).state {
        OwnershipState::Stopping { operation_id, .. } => Some(operation_id),
        _ => None,
    }
}

/// A waker that only counts how often it was woken.
#[derive(Default)]
struct CountingWaker(AtomicUsize);

impl Wake for CountingWaker {
    fn wake(self: Arc<Self>) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn wait_settled_is_ready_at_once_for_settled_states() {
    let reg = Arc::new(RuntimeOwnershipRegistry::with_epoch(7));
    let snap = tokio::time::timeout(Duration::from_millis(50), reg.wait_settled("codex", "a"))
        .await
        .unwrap();
    assert_eq!(snap.state, OwnershipState::Vacant);
    make_live(&reg, "a", owner("T1", "u1"));
    let snap = tokio::time::timeout(Duration::from_millis(50), reg.wait_settled("codex", "a"))
        .await
        .unwrap();
    assert!(matches!(snap.state, OwnershipState::Live { .. }));
}

/// No tokio runtime and no timer exists here: only the commit's lock
/// scope ending can wake the parked waiter, so a polling or timer-driven
/// implementation cannot pass.
#[test]
fn wait_settled_is_woken_synchronously_by_the_gone_commit() {
    let reg = Arc::new(RuntimeOwnershipRegistry::with_epoch(7));
    make_live(&reg, "a", owner("T1", "u1"));
    reg.begin_unit_stop("u1", "op-kill", "test", NOW);

    let counter = Arc::new(CountingWaker::default());
    let waker = Waker::from(Arc::clone(&counter));
    let mut cx = Context::from_waker(&waker);
    let mut wait = std::pin::pin!(reg.wait_settled("codex", "a"));

    assert!(
        wait.as_mut().poll(&mut cx).is_pending(),
        "a Stopping key is not settled"
    );
    assert_eq!(counter.0.load(Ordering::SeqCst), 0);

    reg.commit_unit_stop("u1", "op-kill");
    assert!(
        counter.0.load(Ordering::SeqCst) >= 1,
        "the Gone commit wakes the parked waiter before it returns"
    );
    match wait.as_mut().poll(&mut cx) {
        Poll::Ready(snap) => assert_eq!(snap.state, OwnershipState::Vacant),
        Poll::Pending => panic!("the woken wait resolves to the committed Vacant state"),
    }
}

/// A wait polled again before anything changed (a `select!` loop whose
/// other branch keeps firing) keeps ONE parked waker, not one per poll,
/// and each parked wait is woken once.
#[test]
fn a_pending_wait_polled_again_parks_one_waker() {
    let reg = Arc::new(RuntimeOwnershipRegistry::with_epoch(7));
    make_live(&reg, "a", owner("T1", "u1"));
    reg.begin_unit_stop("u1", "op-kill", "test", NOW);

    let counter = Arc::new(CountingWaker::default());
    let waker = Waker::from(Arc::clone(&counter));
    let mut cx = Context::from_waker(&waker);
    let mut first = std::pin::pin!(reg.wait_settled("codex", "a"));
    let mut second = std::pin::pin!(reg.wait_settled("codex", "a"));
    for _ in 0..5 {
        assert!(first.as_mut().poll(&mut cx).is_pending());
    }
    assert!(second.as_mut().poll(&mut cx).is_pending());
    assert_eq!(
        reg.waiters.lock().unwrap().len(),
        2,
        "one parked waker per wait, however often it is polled"
    );

    reg.commit_unit_stop("u1", "op-kill");
    assert_eq!(
        counter.0.load(Ordering::SeqCst),
        2,
        "the Gone commit wakes each parked wait once"
    );
    assert!(reg.waiters.lock().unwrap().is_empty());
    assert!(first.as_mut().poll(&mut cx).is_ready());
    assert!(second.as_mut().poll(&mut cx).is_ready());
}

#[test]
fn a_second_stop_on_a_stopping_key_is_told_to_join() {
    let reg = RuntimeOwnershipRegistry::with_epoch(7);
    make_live(&reg, "a", owner("T1", "u1"));
    reg.begin_unit_stop("u1", "op-kill-1", "test", NOW);
    let claim = StopClaim {
        expected_kind: RuntimeOwnerKind::Terminal,
        expected_runtime: None,
        observed: ObservedFence {
            epoch: 7,
            generation: 1,
        },
    };
    match reg.begin_stop("codex", "a", "op-kill-2", &claim, "test", NOW) {
        StopOutcome::AlreadyStopping {
            operation_id,
            owner,
            ..
        } => {
            assert_eq!(operation_id, "op-kill-1");
            assert_eq!(owner.and_then(|o| o.unit_id).as_deref(), Some("u1"));
        }
        other => panic!("expected AlreadyStopping, got {other:?}"),
    }
}

#[test]
fn extra_holds_respect_other_units_and_reopen_adopts_the_holder() {
    let reg = RuntimeOwnershipRegistry::with_epoch(7);
    make_live(&reg, "root", owner("T1", "u1"));
    reg.hold_extra("codex", "helper", owner("T1", "u1"), "test", NOW);
    assert_eq!(
        reg.hold_extra("codex", "helper", owner("T1", "u1"), "test", NOW),
        HoldOutcome::AlreadyHeld
    );
    assert!(matches!(
        reg.hold_extra("codex", "helper", owner("T9", "u9"), "test", NOW),
        HoldOutcome::HeldByOther { .. }
    ));
    match reg.begin_start(
        "codex",
        "helper",
        RuntimeOwnerKind::Terminal,
        "op-reopen",
        None,
        "test",
        NOW,
    ) {
        BeginOutcome::AdoptLive { owner, .. } => {
            assert_eq!(owner.terminal_id.as_deref(), Some("T1"))
        }
        other => panic!("reopen of an extra thread adopts its holder, got {other:?}"),
    }
    assert!(
        !reg.release_extra("codex", "helper", "u9"),
        "only the holding unit releases"
    );
    assert!(reg.release_extra("codex", "helper", "u1"));
    assert_eq!(reg.observe("codex", "helper").state, OwnershipState::Vacant);
}

#[test]
fn states_for_terminal_and_keys_for_unit_report_holdings() {
    let reg = RuntimeOwnershipRegistry::with_epoch(7);
    make_live(&reg, "root", owner("T1", "u1"));
    reg.hold_extra("codex", "helper", owner("T1", "u1"), "test", NOW);
    assert_eq!(reg.states_for_terminal("T1").len(), 2);
    assert_eq!(reg.keys_for_unit("u1").len(), 2);
    assert!(reg.states_for_terminal("T2").is_empty());
}

#[test]
fn unit_stop_moves_every_key_the_unit_holds_and_commit_vacates_them() {
    let reg = RuntimeOwnershipRegistry::with_epoch(7);
    make_live(&reg, "root", owner("T1", "u1"));
    assert!(matches!(
        reg.hold_extra("codex", "helper", owner("T1", "u1"), "test", NOW),
        HoldOutcome::Held { .. }
    ));
    assert!(matches!(
        reg.hold_extra("codex", "earlier", owner("T1", "u1"), "test", NOW),
        HoldOutcome::Held { .. }
    ));
    make_live(&reg, "other", owner("T2", "u2"));

    let moved = reg.begin_unit_stop("u1", "op-kill", "test", NOW);
    assert_eq!(session_ids(&moved), vec!["earlier", "helper", "root"]);
    assert!(
        moved.iter().all(|k| !k.joined),
        "a fresh stop joins nothing: {moved:?}"
    );
    assert!(matches!(
        reg.observe("codex", "other").state,
        OwnershipState::Live { .. }
    ));

    let joined = reg.begin_unit_stop("u1", "op-kill-2", "test", NOW);
    assert_eq!(session_ids(&joined), vec!["earlier", "helper", "root"]);
    assert!(
        joined.iter().all(|k| k.joined),
        "a second stop joins every key: {joined:?}"
    );
    for sid in ["earlier", "helper", "root"] {
        assert_eq!(
            stopping_operation(&reg, sid).as_deref(),
            Some("op-kill"),
            "{sid} stays Stopping under the first stop's operation"
        );
    }

    assert!(
        reg.commit_unit_stop("u1", "op-kill-2").is_empty(),
        "a commit under an operation that owns no key vacates nothing"
    );
    for sid in ["earlier", "helper", "root"] {
        assert_eq!(stopping_operation(&reg, sid).as_deref(), Some("op-kill"));
    }

    let committed = reg.commit_unit_stop("u1", "op-kill");
    assert_eq!(session_ids(&committed), vec!["earlier", "helper", "root"]);
    for sid in ["earlier", "helper", "root"] {
        assert_eq!(reg.observe("codex", sid).state, OwnershipState::Vacant);
    }
    assert!(matches!(
        reg.observe("codex", "other").state,
        OwnershipState::Live { .. }
    ));
}

/// A unit has one stop operation at a time: a key the unit gained after
/// its stop began (here a start that registered its partial runtime) is
/// moved under the IN-FLIGHT operation by a joining stop, so the one
/// commit at Gone covers it.
#[test]
fn a_joining_unit_stop_moves_new_keys_under_the_in_flight_operation() {
    let reg = RuntimeOwnershipRegistry::with_epoch(7);
    make_live(&reg, "root", owner("T1", "u1"));
    reg.begin_unit_stop("u1", "op-kill", "test", NOW);

    let BeginOutcome::Granted { generation } = reg.begin_start(
        "codex",
        "late",
        RuntimeOwnerKind::Terminal,
        "op-late",
        None,
        "test",
        NOW,
    ) else {
        panic!("start granted")
    };
    reg.register_partial_runtime("codex", "late", "op-late", generation, owner("T1", "u1"));

    let keys = reg.begin_unit_stop("u1", "op-kill-2", "test", NOW);
    assert_eq!(session_ids(&keys), vec!["late", "root"]);
    assert_eq!(
        keys.iter().map(|k| k.joined).collect::<Vec<_>>(),
        vec![false, true]
    );
    assert_eq!(stopping_operation(&reg, "late").as_deref(), Some("op-kill"));

    let committed = reg.commit_unit_stop("u1", "op-kill");
    assert_eq!(session_ids(&committed), vec!["late", "root"]);
}

#[test]
fn boot_seeds_stopping_and_the_finish_vacates() {
    let reg = RuntimeOwnershipRegistry::with_epoch(7);
    let no_unit = OwnerIdentity {
        terminal_id: Some("T1".into()),
        ..OwnerIdentity::default()
    };
    assert!(
        !reg.restore_stopping("codex", "a", no_unit, "op-boot", "boot", NOW),
        "a seed must name its unit: no unit commit could ever vacate it"
    );
    assert_eq!(reg.observe("codex", "a").state, OwnershipState::Vacant);
    assert!(reg.restore_stopping("codex", "a", owner("T1", "u1"), "op-boot", "boot", NOW));
    assert!(matches!(
        reg.observe("codex", "a").state,
        OwnershipState::Stopping { .. }
    ));
    assert!(
        !reg.restore_stopping("codex", "a", owner("T1", "u1"), "op-boot-2", "boot", NOW),
        "only a never-seen (Vacant) key is seeded"
    );
    assert!(
        matches!(
            reg.begin_start(
                "codex",
                "a",
                RuntimeOwnerKind::Terminal,
                "op-new",
                None,
                "test",
                NOW
            ),
            BeginOutcome::Blocked { .. }
        ),
        "a Stopping unit is never offered for reuse"
    );
    let committed = reg.commit_unit_stop("u1", "op-boot");
    assert_eq!(committed.len(), 1);
    assert_eq!(committed[0].key, SessionKey::new("codex", "a"));
    assert_eq!(reg.observe("codex", "a").state, OwnershipState::Vacant);
}

#[test]
fn unit_stop_covers_starting_and_foreign_handoff_keys_but_never_aliases() {
    // Registry 1: a Starting key with the unit's partial runtime, a
    // Handoff key under the stopping operation itself, and an alias.
    let reg = RuntimeOwnershipRegistry::with_epoch(7);
    let BeginOutcome::Granted { generation: g_s } = reg.begin_start(
        "codex",
        "s",
        RuntimeOwnerKind::Terminal,
        "op-start",
        None,
        "test",
        NOW,
    ) else {
        panic!("start granted")
    };
    reg.register_partial_runtime("codex", "s", "op-start", g_s, owner("T1", "u1"));
    make_live(&reg, "h", owner("T1", "u1"));
    assert!(matches!(
        reg.begin_handoff(
            "codex",
            "h",
            RuntimeOwnerKind::FreshAgent,
            "op-switch",
            None,
            "test",
            NOW
        ),
        BeginOutcome::Granted { .. }
    ));
    assert_eq!(
        reg.alias_vacant_key("codex", "old", "s", "op-alias", "test"),
        CommitOutcome::Committed
    );

    let moved = reg.begin_unit_stop("u1", "op-switch", "test", NOW);
    assert_eq!(session_ids(&moved), vec!["s"]);
    match reg.observe("codex", "s").state {
        OwnershipState::Stopping {
            owner: Some(o),
            prior_generation: None,
            operation_id,
            ..
        } => {
            assert_eq!(o.unit_id.as_deref(), Some("u1"));
            assert_eq!(operation_id, "op-switch");
        }
        other => panic!("the Starting key stops with its partial runtime as owner, got {other:?}"),
    }
    assert!(
        matches!(
            reg.observe("codex", "h").state,
            OwnershipState::Handoff { .. }
        ),
        "the handoff that requested the stop keeps its own key"
    );
    assert!(matches!(
        reg.observe("codex", "old").state,
        OwnershipState::Aliased { .. }
    ));

    // Registry 2: the same handoff, stopped by a foreign operation (a kill).
    let reg2 = RuntimeOwnershipRegistry::with_epoch(7);
    make_live(&reg2, "h", owner("T1", "u1"));
    let live_generation = reg2.observe("codex", "h").generation;
    assert!(matches!(
        reg2.begin_handoff(
            "codex",
            "h",
            RuntimeOwnerKind::FreshAgent,
            "op-switch",
            None,
            "test",
            NOW
        ),
        BeginOutcome::Granted { .. }
    ));
    let moved2 = reg2.begin_unit_stop("u1", "op-kill", "test", NOW);
    assert_eq!(session_ids(&moved2), vec!["h"]);
    match reg2.observe("codex", "h").state {
        OwnershipState::Stopping {
            owner: Some(o),
            prior_generation,
            operation_id,
            ..
        } => {
            assert_eq!(o.terminal_id.as_deref(), Some("T1"));
            assert_eq!(o.unit_id.as_deref(), Some("u1"));
            assert_eq!(prior_generation, Some(live_generation));
            assert_eq!(operation_id, "op-kill");
        }
        other => panic!("a foreign stop moves the handoff's prior to Stopping, got {other:?}"),
    }

    // Registry 1: the commit vacates the stopped start; the alias stays.
    let committed = reg.commit_unit_stop("u1", "op-switch");
    assert_eq!(session_ids(&committed), vec!["s"]);
    assert_eq!(reg.observe("codex", "s").state, OwnershipState::Vacant);
    match reg.observe("codex", "old").state {
        OwnershipState::Aliased { to, .. } => assert_eq!(to, "s"),
        other => panic!("the alias is never vacated, got {other:?}"),
    }
}

#[test]
fn commit_vacates_only_its_own_operation_and_clears_attach_guards() {
    let reg = Arc::new(RuntimeOwnershipRegistry::with_epoch(7));
    make_live(&reg, "a", owner("T1", "u1"));
    let guard = match reg.begin_attach_guard("codex", "a", "attach-1", None, "test") {
        AttachGuardOutcome::Armed(guard) => guard,
        other => panic!("the attach guard arms on a Live key, got {other:?}"),
    };

    let moved = reg.begin_unit_stop("u1", "op-kill", "test", NOW);
    assert_eq!(
        session_ids(&moved),
        vec!["a"],
        "a kill wins over an attach guard"
    );
    assert!(reg.restore_stopping("codex", "c", owner("T1", "u1"), "op-other", "boot", NOW));

    let committed = reg.commit_unit_stop("u1", "op-kill");
    assert_eq!(session_ids(&committed), vec!["a"]);
    assert_eq!(stopping_operation(&reg, "c").as_deref(), Some("op-other"));

    assert!(
        matches!(
            reg.begin_start(
                "codex",
                "a",
                RuntimeOwnerKind::Terminal,
                "op-new",
                None,
                "test",
                NOW
            ),
            BeginOutcome::Granted { .. }
        ),
        "the Gone commit leaves no armed attach window behind"
    );
    drop(guard);
    match reg.observe("codex", "a").state {
        OwnershipState::Starting { operation_id, .. } => assert_eq!(operation_id, "op-new"),
        other => panic!("the late guard drop changes nothing, got {other:?}"),
    }
}

/// The Gone commit clears the attach windows it won over; the cleared
/// guard's later drop must not close a window armed afterwards by a new
/// owner's attach (it would let a stop or switch interleave with that
/// attach).
#[test]
fn a_guard_cleared_by_the_gone_commit_never_releases_a_later_window() {
    let reg = Arc::new(RuntimeOwnershipRegistry::with_epoch(7));
    make_live(&reg, "a", owner("T1", "u1"));
    let stale_guard = match reg.begin_attach_guard("codex", "a", "attach-1", None, "test") {
        AttachGuardOutcome::Armed(guard) => guard,
        other => panic!("the attach guard arms on a Live key, got {other:?}"),
    };
    reg.begin_unit_stop("u1", "op-kill", "test", NOW);
    reg.commit_unit_stop("u1", "op-kill");

    let BeginOutcome::Granted { generation } = reg.begin_start(
        "codex",
        "a",
        RuntimeOwnerKind::Terminal,
        "op-again",
        None,
        "test",
        NOW,
    ) else {
        panic!("the vacated key starts again")
    };
    assert_eq!(
        reg.commit_live("codex", "a", "op-again", generation, owner("T2", "u2")),
        CommitOutcome::Committed
    );
    let live_guard = match reg.begin_attach_guard("codex", "a", "attach-2", None, "test") {
        AttachGuardOutcome::Armed(guard) => guard,
        other => panic!("the new owner's attach arms, got {other:?}"),
    };

    drop(stale_guard);
    assert!(
        matches!(
            reg.begin_handoff(
                "codex",
                "a",
                RuntimeOwnerKind::FreshAgent,
                "op-switch",
                None,
                "test",
                NOW
            ),
            BeginOutcome::Blocked { .. }
        ),
        "the new attach window stays armed after the cleared guard drops"
    );
    drop(live_guard);
    assert!(matches!(
        reg.begin_handoff(
            "codex",
            "a",
            RuntimeOwnerKind::FreshAgent,
            "op-switch",
            None,
            "test",
            NOW
        ),
        BeginOutcome::Granted { .. }
    ));
}

#[test]
fn the_post_commit_generation_is_accepted_by_a_fenced_start() {
    let reg = RuntimeOwnershipRegistry::with_epoch(7);
    make_live(&reg, "a", owner("T1", "u1"));
    let live_generation = reg.observe("codex", "a").generation;
    reg.begin_unit_stop("u1", "op-kill", "test", NOW);
    let committed = reg.commit_unit_stop("u1", "op-kill");
    assert_eq!(committed.len(), 1);
    let gone_generation = committed[0].generation;
    assert_eq!(gone_generation, reg.observe("codex", "a").generation);

    assert!(matches!(
        reg.begin_start(
            "codex",
            "a",
            RuntimeOwnerKind::Terminal,
            "op-stale",
            Some(ObservedFence {
                epoch: 7,
                generation: live_generation,
            }),
            "test",
            NOW,
        ),
        BeginOutcome::StaleGeneration { .. }
    ));
    assert!(matches!(
        reg.begin_start(
            "codex",
            "a",
            RuntimeOwnerKind::Terminal,
            "op-fresh",
            Some(ObservedFence {
                epoch: 7,
                generation: gone_generation,
            }),
            "test",
            NOW,
        ),
        BeginOutcome::Granted { .. }
    ));
}

#[test]
fn extra_holds_are_typed_and_never_switched_away() {
    let reg = RuntimeOwnershipRegistry::with_epoch(7);
    make_live(&reg, "root", owner("T1", "u1"));
    assert!(matches!(
        reg.hold_extra("codex", "helper", owner("T1", "u1"), "test", NOW),
        HoldOutcome::Held { .. }
    ));
    match reg.observe("codex", "helper").state {
        OwnershipState::Live { owner, .. } => assert_eq!(owner.hold, HoldKind::Extra),
        other => panic!("the helper is held Live, got {other:?}"),
    }
    match reg.observe("codex", "root").state {
        OwnershipState::Live { owner, .. } => assert_eq!(owner.hold, HoldKind::Main),
        other => panic!("the root is Live, got {other:?}"),
    }
    assert!(
        !reg.release_extra("codex", "root", "u1"),
        "release_extra never releases the unit's main conversation"
    );

    match reg.begin_handoff(
        "codex",
        "helper",
        RuntimeOwnerKind::FreshAgent,
        "op-switch",
        None,
        "test",
        NOW,
    ) {
        BeginOutcome::AdoptLive { owner, .. } => assert_eq!(owner.unit_id.as_deref(), Some("u1")),
        other => panic!("a switch on an extra-held thread adopts its holder, got {other:?}"),
    }
    assert!(matches!(
        reg.observe("codex", "helper").state,
        OwnershipState::Live { .. }
    ));
    assert!(
        matches!(
            reg.begin_handoff(
                "codex",
                "root",
                RuntimeOwnerKind::FreshAgent,
                "op-switch-root",
                None,
                "test",
                NOW
            ),
            BeginOutcome::Granted { .. }
        ),
        "a main conversation still switches"
    );

    let no_unit = OwnerIdentity {
        terminal_id: Some("T1".into()),
        ..OwnerIdentity::default()
    };
    assert!(
        matches!(
            reg.hold_extra("codex", "unowned", no_unit, "test", NOW),
            HoldOutcome::Skipped {
                state: OwnershipState::Vacant
            }
        ),
        "an extra hold must name its unit"
    );
    assert_eq!(
        reg.observe("codex", "unowned").state,
        OwnershipState::Vacant
    );

    let fresh = RuntimeOwnershipRegistry::with_epoch(7);
    make_live(&fresh, "root", owner("T1", "u1"));
    fresh.begin_unit_stop("u1", "op-kill", "test", NOW);
    assert!(
        matches!(
            fresh.hold_extra("codex", "late", owner("T1", "u1"), "test", NOW),
            HoldOutcome::Skipped {
                state: OwnershipState::Stopping { .. }
            }
        ),
        "a stopping unit never gains holds"
    );
    assert_eq!(fresh.observe("codex", "late").state, OwnershipState::Vacant);
}

/// A hold that arrives after the unit reached Gone (a notification its
/// app-server sent before it died, handled after the commit) is refused,
/// so no dead unit owns a thread and a reopen never adopts a dead pane. A
/// unit whose stop began while it held no key is refused the same way.
#[test]
fn a_unit_whose_stop_began_or_finished_never_gains_holds() {
    let reg = RuntimeOwnershipRegistry::with_epoch(7);
    make_live(&reg, "root", owner("T1", "u1"));
    reg.begin_unit_stop("u1", "op-kill", "test", NOW);
    reg.commit_unit_stop("u1", "op-kill");
    assert!(
        matches!(
            reg.hold_extra("codex", "late", owner("T1", "u1"), "test", NOW),
            HoldOutcome::Skipped {
                state: OwnershipState::Vacant
            }
        ),
        "a unit that reached Gone never gains holds"
    );
    assert_eq!(reg.observe("codex", "late").state, OwnershipState::Vacant);
    assert!(
        matches!(
            reg.begin_start(
                "codex",
                "late",
                RuntimeOwnerKind::Terminal,
                "op-reopen",
                None,
                "test",
                NOW
            ),
            BeginOutcome::Granted { .. }
        ),
        "a reopen of the thread starts it; it never adopts the dead unit"
    );

    // A unit stopped while it held no key at all.
    assert!(reg
        .begin_unit_stop("u2", "op-kill-2", "test", NOW)
        .is_empty());
    assert!(
        matches!(
            reg.hold_extra("codex", "racing", owner("T2", "u2"), "test", NOW),
            HoldOutcome::Skipped {
                state: OwnershipState::Vacant
            }
        ),
        "a unit whose stop began never gains holds, even with no Stopping key"
    );
    assert!(reg.commit_unit_stop("u2", "op-kill-2").is_empty());
    assert!(matches!(
        reg.hold_extra("codex", "racing", owner("T2", "u2"), "test", NOW),
        HoldOutcome::Skipped { .. }
    ));
    assert_eq!(reg.observe("codex", "racing").state, OwnershipState::Vacant);

    // A boot-seeded unit whose stop is committed without a begin.
    assert!(reg.restore_stopping("codex", "seeded", owner("T4", "u4"), "op-boot", "boot", NOW));
    assert_eq!(
        session_ids(&reg.commit_unit_stop("u4", "op-boot")),
        vec!["seeded"]
    );
    assert!(matches!(
        reg.hold_extra("codex", "seeded-late", owner("T4", "u4"), "test", NOW),
        HoldOutcome::Skipped { .. }
    ));

    // Other units are unaffected.
    assert!(matches!(
        reg.hold_extra("codex", "helper", owner("T3", "u3"), "test", NOW),
        HoldOutcome::Held { .. }
    ));
}

/// The registry remembers only the most recent ended units, so a
/// long-running server's memory stays flat; the newest are still refused.
#[test]
fn the_memory_of_ended_units_is_bounded() {
    let reg = RuntimeOwnershipRegistry::with_epoch(7);
    for i in 0..ENDED_UNIT_MEMORY + 10 {
        let unit = format!("u-ended-{i}");
        reg.begin_unit_stop(&unit, "op-kill", "test", NOW);
        reg.commit_unit_stop(&unit, "op-kill");
    }
    assert_eq!(reg.ended_units.lock().unwrap().len(), ENDED_UNIT_MEMORY);
    let newest = format!("u-ended-{}", ENDED_UNIT_MEMORY + 9);
    assert!(matches!(
        reg.hold_extra("codex", "late", owner("T1", &newest), "test", NOW),
        HoldOutcome::Skipped { .. }
    ));
    assert!(matches!(
        reg.hold_extra("codex", "first", owner("T1", "u-ended-0"), "test", NOW),
        HoldOutcome::Held { .. }
    ));
}

#[test]
fn the_stale_stopping_watchdog_skips_unit_stamped_keys() {
    let reg = RuntimeOwnershipRegistry::with_epoch(7);
    make_live(&reg, "u", owner("T1", "u1"));
    reg.begin_unit_stop("u1", "op-kill", "test", NOW);

    let legacy = OwnerIdentity {
        terminal_id: Some("T2".into()),
        ..OwnerIdentity::default()
    };
    make_live(&reg, "n", legacy.clone());
    let claim = StopClaim {
        expected_kind: RuntimeOwnerKind::Terminal,
        expected_runtime: Some(legacy),
        observed: ObservedFence {
            epoch: 7,
            generation: reg.observe("codex", "n").generation,
        },
    };
    assert!(matches!(
        reg.begin_stop("codex", "n", "op-legacy", &claim, "test", NOW),
        StopOutcome::Granted { .. }
    ));

    let fenced = reg.recover_stale_stoppings(NOW + 3_600_000, 30_000);
    assert_eq!(
        fenced
            .iter()
            .map(|s| s.session_id.as_str())
            .collect::<Vec<_>>(),
        vec!["n"]
    );
    assert_eq!(stopping_operation(&reg, "u").as_deref(), Some("op-kill"));
}
