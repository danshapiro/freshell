#![cfg(feature = "real-transport")]

use freshell_activity::opencode::{OpencodeActivityTracker, OpencodeEffect, OpencodeLaneEvent};
use freshell_activity::TrackerEffect;
use freshell_opencode::{activity_lane::translate_serve_event, parse_serve_event};
use serde_json::{json, Value};

fn observe(tracker: &mut OpencodeActivityTracker, raw: Value, at: i64) -> Vec<OpencodeEffect> {
    let parsed = parse_serve_event(&raw).unwrap();
    match translate_serve_event(&parsed) {
        Some(OpencodeLaneEvent::Status { session_id, status }) => {
            tracker.note_status("terminal", &session_id, status, 1, 1, at)
        }
        Some(OpencodeLaneEvent::SessionError {
            session_id,
            error_name,
        }) => tracker.note_error("terminal", &session_id, &error_name, 1, 1, at),
        Some(OpencodeLaneEvent::SessionIdle { session_id }) => {
            tracker.note_session_idle("terminal", &session_id, 1, 1, at)
        }
        None => vec![],
        other => panic!("unexpected lane event: {other:?}"),
    }
}

fn busy(tracker: &mut OpencodeActivityTracker, at: i64) {
    observe(
        tracker,
        json!({"type":"session.status", "properties":{
            "sessionID":"ses-root", "status":{"type":"busy"}
        }}),
        at,
    );
}

fn idle(tracker: &mut OpencodeActivityTracker, at: i64) -> Vec<OpencodeEffect> {
    observe(
        tracker,
        json!({"type":"session.idle", "properties":{"sessionID":"ses-root"}}),
        at,
    )
}

fn outcomes(effects: &[OpencodeEffect]) -> Vec<Value> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            TrackerEffect::TurnComplete { outcome, .. } => {
                Some(serde_json::to_value(outcome).unwrap())
            }
            _ => None,
        })
        .collect()
}

fn started_turn() -> OpencodeActivityTracker {
    let mut tracker = OpencodeActivityTracker::new();
    tracker.track_terminal("terminal", Some("ses-root"), 0);
    busy(&mut tracker, 100);
    tracker
}

fn message(error: Option<&str>) -> Value {
    let mut info = json!({"id":"msg-assistant", "sessionID":"ses-root", "role":"assistant"});
    if let Some(name) = error {
        info["error"] = json!({"name":name});
    }
    json!({"type":"message.updated", "properties":{"info":info}})
}

#[test]
fn native_nested_message_abort_then_idle_is_silent_and_next_turn_completes() {
    let mut tracker = started_turn();
    assert!(observe(&mut tracker, message(Some("MessageAbortedError")), 150).is_empty());

    let effects = idle(&mut tracker, 200);
    assert_eq!(outcomes(&effects), Vec::<Value>::new());
    assert!(tracker.list().is_empty(), "abort must clear busy");
    assert!(tracker.list_latest_completions().is_empty());

    busy(&mut tracker, 300);
    assert_eq!(outcomes(&idle(&mut tracker, 400)), vec![json!("completed")]);
}

#[test]
fn native_nested_message_error_then_idle_reports_failure() {
    let mut tracker = started_turn();
    observe(&mut tracker, message(Some("APIError")), 150);
    assert_eq!(outcomes(&idle(&mut tracker, 200)), vec![json!("failed")]);
    assert!(tracker.list().is_empty());
}

#[test]
fn native_nested_message_without_error_keeps_successful_completion() {
    let mut tracker = started_turn();
    assert!(observe(&mut tracker, message(None), 150).is_empty());
    assert_eq!(outcomes(&idle(&mut tracker, 200)), vec![json!("completed")]);
    assert!(tracker.list().is_empty());
}
