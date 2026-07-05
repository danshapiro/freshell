//! Integration pinning test for the codex **status-guarded turn completion**
//! (`adapters/codex/adapter.ts:911-928`, cited in `port/machine/specs/coding-cli.md:272,283-289`).
//!
//! `turn/completed` fires for EVERY terminal status (`completed | interrupted | failed |
//! inProgress`, `protocol.ts:104`); the positive `sdk.turn.complete` edge — the T2
//! `provider.emits-completion-signal` this crate is graded on (`codex-gptmini.json`) — must
//! chime ONLY on `completed`. This test drives the FULL status matrix in BOTH wire shapes
//! (`params.turn.status` and flat `params.status`) through [`CodexSubscription`] and asserts
//! the guard, per status.

use serde_json::{json, Value};

use freshell_codex::{CodexAdapterEvent, CodexSubscription, CodexTurnEvent, TURN_STATUSES};

fn turn_event(thread_id: &str, params: Value) -> CodexTurnEvent {
    CodexTurnEvent {
        thread_id: thread_id.to_string(),
        turn_id: params.get("turnId").and_then(Value::as_str).map(str::to_string),
        params: params.as_object().cloned().unwrap_or_default(),
    }
}

fn chimed(events: &[CodexAdapterEvent]) -> bool {
    events.iter().any(|e| matches!(e, CodexAdapterEvent::TurnComplete { .. }))
}

fn snapshotted(events: &[CodexAdapterEvent]) -> bool {
    events.iter().any(|e| matches!(e, CodexAdapterEvent::StatusSnapshot { .. }))
}

#[test]
fn each_status_gates_the_completion_edge_in_both_wire_shapes() {
    // The authoritative per-status truth table. Only `completed` is a positive completion.
    for &status in TURN_STATUSES {
        let expect_chime = status == "completed";

        // Shape A: inline `params.turn.status` (real codex-cli 0.142.x, adapter.ts:1109).
        let mut sub_inline = CodexSubscription::new("thread-1");
        let inline = sub_inline.on_turn_completed(
            &turn_event(
                "thread-1",
                json!({ "threadId": "thread-1", "turn": { "id": "t", "status": status } }),
            ),
            1_000,
        );
        assert!(snapshotted(&inline), "{status}: an idle snapshot always fires (inline)");
        assert_eq!(chimed(&inline), expect_chime, "{status}: chime gate (inline shape)");

        // Shape B: flat `params.status` (the app-server client test shape, adapter.ts:1221).
        let mut sub_flat = CodexSubscription::new("thread-1");
        let flat = sub_flat.on_turn_completed(
            &turn_event("thread-1", json!({ "threadId": "thread-1", "turnId": "t", "status": status })),
            1_000,
        );
        assert!(snapshotted(&flat), "{status}: an idle snapshot always fires (flat)");
        assert_eq!(chimed(&flat), expect_chime, "{status}: chime gate (flat shape)");
    }
}

#[test]
fn absent_status_and_foreign_thread_never_chime() {
    let mut sub = CodexSubscription::new("thread-1");

    // No status at all → snapshot, no chime (codex-adapter.test.ts:1180).
    let empty = sub.on_turn_completed(&turn_event("thread-1", json!({ "threadId": "thread-1" })), 1);
    assert!(snapshotted(&empty) && !chimed(&empty));

    // A completed turn on ANOTHER thread → nothing at all (adapter.ts:912).
    let foreign = sub.on_turn_completed(
        &turn_event("other", json!({ "threadId": "other", "turn": { "status": "completed" } })),
        1,
    );
    assert!(foreign.is_empty());
}

#[test]
fn only_completed_advances_the_monotonic_clock() {
    // A non-completed turn must not touch the per-session monotonic `at`.
    let mut sub = CodexSubscription::new("thread-1");
    let completed = json!({ "threadId": "thread-1", "status": "completed" });

    sub.on_turn_completed(&turn_event("thread-1", json!({ "threadId": "thread-1", "status": "failed" })), 500);
    assert_eq!(sub.last_turn_complete_at(), None, "failed does not record a completion");

    sub.on_turn_completed(&turn_event("thread-1", completed.clone()), 1_000);
    assert_eq!(sub.last_turn_complete_at(), Some(1_000));

    // Second real completion in the same millisecond is bumped strictly forward.
    let again = sub.on_turn_completed(&turn_event("thread-1", completed), 1_000);
    match again.iter().find(|e| matches!(e, CodexAdapterEvent::TurnComplete { .. })) {
        Some(CodexAdapterEvent::TurnComplete { at, .. }) => assert_eq!(*at, 1_001),
        _ => panic!("expected a chime"),
    }
}
