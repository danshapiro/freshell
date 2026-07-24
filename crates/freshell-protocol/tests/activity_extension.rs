//! TERM-15/TERM-16 extension surface: the amplifier activity family + the new
//! `terminal.idle` truly-idle edge.
//!
//! The frozen T0 inventory (`port/contract/ws-message-inventory.json`, 27+52)
//! predates the legacy amplifier provider's activity family
//! (`shared/ws-protocol.ts` `AmplifierActivity*Schema`) and does not contain
//! the NEW `terminal.idle` capability at all. These are deliberately declared
//! as an EXTENSION surface (`EXTENSION_CLIENT_MESSAGE_TYPES` /
//! `EXTENSION_SERVER_MESSAGE_TYPES`) so `tests/inventory.rs` keeps pinning the
//! frozen contract untouched, while this file pins the extension wire shapes:
//!
//! * `amplifier.activity.list` / `.list.response` / `.updated` are
//!   byte-shape-compatible with the legacy zod schemas (the frozen client
//!   already sends/consumes them, `src/App.tsx:696/1130/1149`).
//! * `terminal.idle` is the pinned NEW contract:
//!   `{ terminalId, at (server epoch ms), reason: 'grace' | 'queue-empty' }`.

use std::collections::BTreeSet;

use freshell_protocol::{
    AmplifierActivityListResponse, AmplifierActivityRecord, AmplifierActivityUpdated,
    AmplifierPhase, ClientMessage, ServerMessage, TerminalIdle, TerminalIdleReason,
    TurnCompletionSnapshot, CLIENT_MESSAGE_TYPES, EXTENSION_CLIENT_MESSAGE_TYPES,
    EXTENSION_SERVER_MESSAGE_TYPES, SERVER_MESSAGE_TYPES,
};
use serde_json::json;

#[test]
fn amplifier_activity_list_parses_like_the_other_activity_lists() {
    let msg: ClientMessage =
        serde_json::from_str(r#"{"type":"amplifier.activity.list","requestId":"req-1"}"#)
            .expect("amplifier.activity.list must parse");
    match msg {
        ClientMessage::AmplifierActivityList(list) => assert_eq!(list.request_id, "req-1"),
        other => panic!("expected AmplifierActivityList, got {other:?}"),
    }
}

#[test]
fn amplifier_activity_list_response_serializes_the_legacy_shape() {
    let msg = ServerMessage::AmplifierActivityListResponse(AmplifierActivityListResponse {
        request_id: "req-1".into(),
        terminals: vec![AmplifierActivityRecord {
            terminal_id: "term-1".into(),
            phase: AmplifierPhase::Busy,
            updated_at: 1000,
            session_id: Some("sess-1".into()),
        }],
        latest_turn_completions: Some(vec![TurnCompletionSnapshot {
            terminal_id: "term-1".into(),
            at: 900,
            completion_seq: 3,
        }]),
    });
    let wire = serde_json::to_value(&msg).unwrap();
    assert_eq!(
        wire,
        json!({
            "type": "amplifier.activity.list.response",
            "requestId": "req-1",
            "terminals": [{
                "terminalId": "term-1",
                "phase": "busy",
                "updatedAt": 1000,
                "sessionId": "sess-1"
            }],
            "latestTurnCompletions": [{
                "terminalId": "term-1",
                "at": 900,
                "completionSeq": 3
            }]
        })
    );
}

#[test]
fn amplifier_activity_updated_serializes_upsert_and_remove() {
    let msg = ServerMessage::AmplifierActivityUpdated(AmplifierActivityUpdated {
        upsert: vec![AmplifierActivityRecord {
            terminal_id: "term-1".into(),
            phase: AmplifierPhase::Idle,
            updated_at: 42,
            session_id: None,
        }],
        remove: vec!["term-2".into()],
    });
    let wire = serde_json::to_value(&msg).unwrap();
    assert_eq!(
        wire,
        json!({
            "type": "amplifier.activity.updated",
            "upsert": [{ "terminalId": "term-1", "phase": "idle", "updatedAt": 42 }],
            "remove": ["term-2"]
        })
    );
}

#[test]
fn terminal_idle_serializes_the_pinned_contract() {
    let grace = ServerMessage::TerminalIdle(TerminalIdle {
        terminal_id: "term-1".into(),
        at: 1234,
        reason: TerminalIdleReason::Grace,
    });
    assert_eq!(
        serde_json::to_value(&grace).unwrap(),
        json!({ "type": "terminal.idle", "terminalId": "term-1", "at": 1234, "reason": "grace" })
    );

    let queue_empty = ServerMessage::TerminalIdle(TerminalIdle {
        terminal_id: "term-1".into(),
        at: 1234,
        reason: TerminalIdleReason::QueueEmpty,
    });
    assert_eq!(
        serde_json::to_value(&queue_empty).unwrap()["reason"],
        "queue-empty"
    );
}

#[test]
fn extension_surface_is_disjoint_from_the_frozen_inventory() {
    let frozen: BTreeSet<&str> = CLIENT_MESSAGE_TYPES
        .iter()
        .chain(SERVER_MESSAGE_TYPES.iter())
        .copied()
        .collect();
    for extension in EXTENSION_CLIENT_MESSAGE_TYPES
        .iter()
        .chain(EXTENSION_SERVER_MESSAGE_TYPES.iter())
    {
        assert!(
            !frozen.contains(extension),
            "{extension} must not collide with the frozen inventory"
        );
    }
    assert_eq!(EXTENSION_CLIENT_MESSAGE_TYPES, ["amplifier.activity.list"]);
    assert_eq!(
        EXTENSION_SERVER_MESSAGE_TYPES,
        [
            "amplifier.activity.list.response",
            "amplifier.activity.updated",
            "terminal.idle",
        ]
    );
}
