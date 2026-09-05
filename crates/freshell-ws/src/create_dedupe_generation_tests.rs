use super::*;

fn sink() -> FrameSink {
    Arc::new(|_| {})
}
fn created() -> ServerMessage {
    ServerMessage::Pong(freshell_protocol::Pong {
        timestamp: "test".into(),
    })
}

#[test]
fn old_cleanup_cannot_erase_a_post_settle_retry() {
    let dedupe = CreateDedupe::default();
    let origin = sink();
    assert!(matches!(
        dedupe.begin("r", &origin, None, |_| true, 1),
        DedupeDecision::Proceed
    ));
    let old = dedupe.in_flight_generation("r").unwrap();
    dedupe.settle("r", "t", &created(), None, |_| true);
    // The existing contract deliberately treats a restore-flag change as a
    // distinct attempt, even while t is live. Its sentinel must survive.
    assert!(matches!(
        dedupe.begin("r", &origin, Some(true), |_| true, 1),
        DedupeDecision::Proceed
    ));
    let new = dedupe.in_flight_generation("r").unwrap();
    assert!(!Arc::ptr_eq(&old, &new));
    dedupe.clear_matching_generation("r", &old);
    assert!(matches!(
        dedupe.begin("r", &origin, Some(true), |_| true, 1),
        DedupeDecision::DuplicateInFlight
    ));
    dedupe.clear_matching_generation("r", &new);
    assert!(matches!(
        dedupe.begin("r", &origin, Some(true), |_| true, 1),
        DedupeDecision::Proceed
    ));
}

#[test]
fn matching_cleanup_notifies_waiters_and_retains_settled_entries() {
    let dedupe = CreateDedupe::default();
    let origin = sink();
    let captured = Arc::new(Mutex::new(Vec::new()));
    let copy = Arc::clone(&captured);
    let waiter: FrameSink = Arc::new(move |msg| copy.lock().unwrap().push(msg));
    let _ = dedupe.begin("r", &origin, None, |_| true, 1);
    let generation = dedupe.in_flight_generation("r").unwrap();
    let _ = dedupe.begin("r", &waiter, None, |_| true, 2);
    dedupe.clear_matching_generation("r", &generation);
    assert_eq!(captured.lock().unwrap().len(), 1);
    let _ = dedupe.begin("r", &origin, None, |_| true, 1);
    let generation = dedupe.in_flight_generation("r").unwrap();
    dedupe.settle("r", "t", &created(), None, |_| true);
    dedupe.clear_matching_generation("r", &generation);
    assert!(matches!(
        dedupe.begin("r", &origin, None, |_| true, 1),
        DedupeDecision::DuplicateSettled(_)
    ));
}

#[test]
fn equal_clock_values_still_have_distinct_cleanup_generations() {
    let dedupe = CreateDedupe::default();
    let origin = sink();
    let _ = dedupe.begin("r", &origin, None, |_| true, 1);
    let old = dedupe.in_flight_generation("r").unwrap();
    // Force equal timestamps to rule out timestamp-as-identity assumptions.
    if let Some(Entry::InFlight { started, .. }) = dedupe.entries.lock().unwrap().get_mut("r") {
        *started = Arc::new(*old);
    }
    let new = dedupe.in_flight_generation("r").unwrap();
    assert_eq!(*old, *new);
    assert!(!Arc::ptr_eq(&old, &new));
    dedupe.clear_matching_generation("r", &old);
    assert!(dedupe.in_flight_generation("r").is_some());
}
