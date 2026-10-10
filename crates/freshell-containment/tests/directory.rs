//! `UnitDirectory`: which unit is which pane (unit id <-> terminal id /
//! create-request id), start cancellation, start settlement, the
//! killed-start memory and the lifecycle hook other lanes stop through.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use freshell_containment::*;

fn unit() -> AgentUnit {
    Containment::tag_backend(SelectOptions::default())
        .create_unit(UnitId::mint(), UnitLabel::default())
        .unwrap()
}

fn starting_entry(u: &AgentUnit, create_request_id: &str) -> UnitEntry {
    UnitEntry {
        unit: u.clone(),
        provider: "codex".into(),
        mode: "codex".into(),
        create_request_id: Some(create_request_id.into()),
        terminal_id: None,
    }
}

#[tokio::test]
async fn starting_units_are_found_by_create_request_and_cancel_only_before_settling() {
    let dir = UnitDirectory::new();
    let u = unit();
    dir.register(starting_entry(&u, "crq"));
    assert_eq!(dir.by_create_request("crq").unwrap().unit.id(), u.id());
    let waiter = tokio::spawn({
        let dir = dir.clone();
        let id = u.id().clone();
        async move { dir.wait_start_cancelled(&id).await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!waiter.is_finished());
    assert!(dir.cancel_start(u.id()));
    tokio::time::timeout(Duration::from_millis(200), waiter)
        .await
        .expect("woken")
        .unwrap();
    assert!(dir.start_cancelled(u.id()));
    let settled = dir.start_settled(u.id());
    dir.mark_start_settled(u.id());
    tokio::time::timeout(Duration::from_millis(200), settled)
        .await
        .expect("settled");
}

#[tokio::test]
async fn a_bound_start_settles_only_when_marked() {
    let dir = UnitDirectory::new();
    let bound: Arc<Mutex<Vec<UnitEntry>>> = Arc::default();
    dir.set_on_bind(Arc::new({
        let bound = bound.clone();
        move |entry| bound.lock().unwrap().push(entry)
    }));
    let u = unit();
    dir.register(starting_entry(&u, "crq-bound"));

    dir.note_terminal(u.id(), "T1");
    assert_eq!(dir.by_terminal("T1").unwrap().unit.id(), u.id());
    assert!(
        bound.lock().unwrap().is_empty(),
        "noting the terminal fires no bind hook"
    );

    dir.bind_terminal(u.id(), "T1");
    assert_eq!(
        bound.lock().unwrap().len(),
        1,
        "binding fires the hook once"
    );
    assert_eq!(bound.lock().unwrap()[0].terminal_id.as_deref(), Some("T1"));
    assert!(!dir.start_is_settled(u.id()), "binding does not settle");
    let settled = dir.start_settled(u.id());
    tokio::pin!(settled);
    assert!(
        tokio::time::timeout(Duration::from_millis(50), &mut settled)
            .await
            .is_err(),
        "the start is still unsettled after binding"
    );
    assert!(
        dir.cancel_start(u.id()),
        "an unsettled bound start can still be cancelled"
    );

    dir.mark_start_settled(u.id());
    tokio::time::timeout(Duration::from_millis(200), &mut settled)
        .await
        .expect("settled once marked");
    assert!(dir.start_is_settled(u.id()));
    assert!(
        !dir.cancel_start(u.id()),
        "a settled start is not cancelled"
    );

    let replacement = unit();
    let previous = dir
        .replace_unit(u.id(), replacement.clone())
        .expect("re-keyed");
    assert_eq!(previous.id(), u.id());
    assert_eq!(
        dir.by_terminal("T1").unwrap().unit.id(),
        replacement.id(),
        "the slot now names the replacement unit"
    );
    assert!(dir.get(u.id()).is_none(), "the old id no longer has a slot");

    dir.remove(replacement.id()).expect("removed");
    assert!(dir.by_terminal("T1").is_none());
    tokio::time::timeout(Duration::from_millis(50), dir.start_settled(u.id()))
        .await
        .expect("an unknown unit's start is settled at once");
}

#[tokio::test]
async fn cancellation_waits_follow_their_start_across_a_re_key() {
    let dir = UnitDirectory::new();
    let first = unit();
    dir.register(starting_entry(&first, "crq-rekey"));
    let waiter = tokio::spawn({
        let dir = dir.clone();
        let id = first.id().clone();
        async move { dir.wait_start_cancelled(&id).await }
    });
    let settled = dir.start_settled(first.id());
    tokio::time::sleep(Duration::from_millis(20)).await;

    let second = unit();
    dir.replace_unit(first.id(), second.clone())
        .expect("re-keyed");
    assert!(dir.cancel_start(second.id()));
    tokio::time::timeout(Duration::from_millis(200), waiter)
        .await
        .expect("a wait begun under the old id is woken by the re-keyed start's cancellation")
        .unwrap();

    dir.mark_start_settled(second.id());
    tokio::time::timeout(Duration::from_millis(200), settled)
        .await
        .expect("a settle wait begun under the old id resolves with the re-keyed start");
}

#[tokio::test]
async fn gone_removes_a_settled_start_at_once_and_an_unsettled_one_when_it_settles() {
    let dir = UnitDirectory::new();
    let settled_unit = unit();
    dir.register(starting_entry(&settled_unit, "crq-settled"));
    dir.mark_start_settled(settled_unit.id());
    assert!(
        dir.note_gone(settled_unit.id()),
        "a settled start's entry goes at Gone"
    );
    assert!(dir.get(settled_unit.id()).is_none());

    let starting = unit();
    dir.register(starting_entry(&starting, "crq-starting"));
    assert!(
        !dir.note_gone(starting.id()),
        "an unsettled start keeps its entry for its owner"
    );
    assert!(dir.get(starting.id()).is_some());
    dir.mark_start_settled(starting.id());
    assert!(
        dir.get(starting.id()).is_none(),
        "settling a start whose unit is gone removes its entry"
    );
}

#[tokio::test]
async fn killed_starts_are_remembered_after_the_unit_is_gone() {
    let dir = UnitDirectory::new();
    dir.remember_killed_start("crq-k");
    assert!(dir.killed_start("crq-k"));
    assert!(!dir.killed_start("crq-other"));

    let u = unit();
    dir.register(starting_entry(&u, "crq-k"));
    dir.remove(u.id());
    assert!(
        dir.killed_start("crq-k"),
        "removing the unit never forgets a killed start"
    );
    assert!(!dir.killed_start("crq-other"));
}

/// Records every call it receives; its `stop` stops the entry's unit for
/// real (the tag backend), so the returned handle is a genuine one.
#[derive(Default)]
struct RecordingLifecycle {
    stops: Mutex<Vec<(String, StopMode, String)>>,
    settles: Mutex<Vec<(String, u32)>>,
}

impl UnitLifecycle for RecordingLifecycle {
    fn stop(
        &self,
        entry: &UnitEntry,
        mode: StopMode,
        reason: StopReason,
        initiator: &str,
    ) -> StopHandle {
        self.stops.lock().unwrap().push((
            entry.unit.id().to_string(),
            mode,
            reason.as_str().to_string(),
        ));
        entry.unit.stop(StopRequest::new(mode, reason, initiator))
    }

    fn settle_start(&self, entry: &UnitEntry, screen_pid: u32) {
        self.settles
            .lock()
            .unwrap()
            .push((entry.unit.id().to_string(), screen_pid));
    }
}

#[tokio::test]
async fn stop_unit_routes_through_the_installed_lifecycle() {
    let dir = UnitDirectory::new();
    let recorder = Arc::new(RecordingLifecycle::default());
    dir.set_lifecycle(recorder.clone());
    let u = unit();
    dir.register(starting_entry(&u, "crq-stop"));

    let handle = dir
        .stop_unit(
            u.id(),
            StopMode::Force,
            StopReason::StartCancelled,
            "rest-start-cancelled",
        )
        .expect("a registered unit is stopped through the lifecycle");
    assert_eq!(
        *recorder.stops.lock().unwrap(),
        vec![(
            u.id().to_string(),
            StopMode::Force,
            "start-cancelled".to_string()
        )]
    );
    handle
        .wait_for(Duration::from_secs(10))
        .await
        .expect("the memberless unit reaches Gone");

    assert!(
        dir.stop_unit(
            &UnitId::mint(),
            StopMode::Force,
            StopReason::StartCancelled,
            "rest-start-cancelled"
        )
        .is_none(),
        "an unknown unit is not stopped"
    );

    dir.settle_start(u.id(), 42);
    assert_eq!(
        *recorder.settles.lock().unwrap(),
        vec![(u.id().to_string(), 42)]
    );
}
