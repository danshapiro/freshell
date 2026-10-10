//! The REST lane's start of a Codex pane in its unit ([`RestUnitStart`]):
//! a start the lane gives up is handed, with the row it spawned and the
//! create's claims, to the installed lifecycle (the WebSocket layer's,
//! which ends that row even when the unit's stop reached Gone before the
//! row was known), and a start dropped without an answer is given up too.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use freshell_containment::{
    AbandonedStart, Containment, SelectOptions, StopHandle, StopMode, StopReason, StopRequest,
    UnitDirectory, UnitEntry, UnitLifecycle,
};

use super::*;

/// An abandoned start as recorded: (unit id, base unit id, terminal id,
/// initiator).
type Abandoned = (String, Option<String>, Option<String>, String);

/// Records what the lane hands to the lifecycle.
#[derive(Default)]
struct Recorder {
    abandons: Mutex<Vec<Abandoned>>,
    claims: Mutex<Vec<Box<dyn std::any::Any + Send>>>,
}

impl UnitLifecycle for Recorder {
    fn stop(
        &self,
        entry: &UnitEntry,
        mode: StopMode,
        reason: StopReason,
        initiator: &str,
    ) -> StopHandle {
        entry.unit.stop(StopRequest::new(mode, reason, initiator))
    }

    fn settle_start(&self, _entry: &UnitEntry, _screen_pid: u32) {}

    fn abandon_start(&self, start: AbandonedStart) {
        self.abandons.lock().unwrap().push((
            start.entry.unit.id().to_string(),
            start.base.as_ref().map(|base| base.id().to_string()),
            start.entry.terminal_id.clone(),
            start.initiator.clone(),
        ));
        if let Some(claim) = start.claim {
            self.claims.lock().unwrap().push(claim);
        }
    }
}

fn state_with(recorder: &Arc<Recorder>) -> (FreshAgentState, Arc<UnitDirectory>) {
    let units = UnitDirectory::new();
    units.set_lifecycle(recorder.clone());
    let state = FreshAgentState::new(
        Arc::new("token".to_string()),
        Arc::new(tokio::sync::broadcast::channel(8).0),
    )
    .with_units(
        units.clone(),
        Containment::tag_backend(SelectOptions::default()),
    );
    (state, units)
}

struct DropFlag(Arc<std::sync::atomic::AtomicBool>);

impl Drop for DropFlag {
    fn drop(&mut self) {
        self.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// The unit's stop reached Gone before the start noted its row: `spawned`
/// says to give the start up, and the give-up hands that row (and the
/// create's claims, undropped) to the lifecycle, which ends the row (Task 12
/// review M4).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rest_start_whose_unit_is_gone_is_given_up_with_its_row_and_claims() {
    let recorder = Arc::new(Recorder::default());
    let (state, units) = state_with(&recorder);
    let mut start = RestUnitStart::begin(&state, "codex", "crq-gone", "T-gone", Some("t-gone"))
        .expect("the unit is recorded")
        .expect("a lifecycle is installed");
    let unit = start.unit();
    unit.stop(StopRequest::new(
        StopMode::Force,
        StopReason::ShiftX,
        "test-kill",
    ))
    .wait_for(Duration::from_secs(10))
    .await
    .expect("Gone");

    let registry = freshell_terminal::TerminalRegistry::new();
    assert!(
        !start.spawned(&registry, "T-gone", u32::MAX),
        "a start whose unit is Gone is given up"
    );
    assert_eq!(
        units.get(unit.id()).and_then(|entry| entry.terminal_id),
        Some("T-gone".to_string()),
        "the row is noted"
    );
    let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
    start.give_up(
        "rest-start-cancelled",
        Some(Box::new(DropFlag(dropped.clone()))),
    );
    assert_eq!(
        *recorder.abandons.lock().unwrap(),
        vec![(
            unit.id().to_string(),
            None,
            Some("T-gone".to_string()),
            "rest-start-cancelled".to_string()
        )]
    );
    assert!(
        !dropped.load(std::sync::atomic::Ordering::SeqCst),
        "the claims go to the lifecycle, dropped at Gone"
    );
}

/// A start dropped without being committed or given up (an early return)
/// is given up, with no claim.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_dropped_rest_start_is_given_up() {
    let recorder = Arc::new(Recorder::default());
    let (state, _units) = state_with(&recorder);
    let start = RestUnitStart::begin(&state, "codex", "crq-drop", "T-drop", None)
        .unwrap()
        .unwrap();
    let unit = start.unit();
    drop(start);
    assert_eq!(
        *recorder.abandons.lock().unwrap(),
        vec![(
            unit.id().to_string(),
            None,
            None,
            "rest-start-dropped".to_string()
        )]
    );

    // A committed start is never given up.
    let start = RestUnitStart::begin(&state, "codex", "crq-ok", "T-ok", None)
        .unwrap()
        .unwrap();
    start.commit();
    assert_eq!(recorder.abandons.lock().unwrap().len(), 1);
}

/// Task 12 re-review 3, m2: a given-up create's lease release (it runs at
/// its unit's Gone) frees the conversation's sessionRef lease only while
/// that create still holds it. A reopen that took the lease once the
/// conversation went Vacant keeps it (before, the release removed the lease
/// whoever held it, and the reopen's bind then failed with 409 "still
/// running").
#[test]
fn a_given_up_creates_lease_release_leaves_a_lease_another_create_took() {
    let registry = freshell_terminal::TerminalRegistry::new();
    let locator = SessionLocator {
        provider: "codex".into(),
        session_id: "t-m2".into(),
    };
    let release = |holder: &str| ReleaseLeaseAfterGone {
        registry: registry.clone(),
        locator: locator.clone(),
        holder_create_request_id: holder.to_string(),
    };
    assert!(matches!(
        registry.claim_session_ref(&locator, "crq-reopen", 2, 1_000),
        freshell_terminal::registry::SessionRefClaim::Acquired
    ));
    drop(release("crq-given-up"));
    assert!(
        matches!(
            registry.claim_session_ref(&locator, "crq-third", 3, 1_500),
            freshell_terminal::registry::SessionRefClaim::Held { .. }
        ),
        "the reopen keeps its lease"
    );
    drop(release("crq-reopen"));
    assert!(matches!(
        registry.claim_session_ref(&locator, "crq-third", 3, 2_000),
        freshell_terminal::registry::SessionRefClaim::Acquired
    ));
}
