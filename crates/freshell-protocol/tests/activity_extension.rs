//! TERM-15/TERM-16 extension surface: the amplifier activity family + the new
//! `terminal.idle` truly-idle edge.
//!
//! The generated T0 inventory (`port/contract/ws-message-inventory.json`,
//! 29+56) is generated-current as of the 2026-07-26 contract reconciliation:
//! the legacy amplifier provider's activity family (`shared/ws-protocol.ts`
//! `AmplifierActivity*Schema`) and the `terminal.idle` capability are now
//! part of the frozen surface (`CLIENT_MESSAGE_TYPES` /
//! `SERVER_MESSAGE_TYPES`). This file still pins the wire shapes:
//!
//! * `amplifier.activity.list` / `.list.response` / `.updated` are
//!   byte-shape-compatible with the legacy zod schemas (the frozen client
//!   already sends/consumes them, `src/App.tsx:696/1130/1149`).
//! * `terminal.idle` is the pinned NEW contract:
//!   `{ terminalId, at (server epoch ms), reason: 'grace' | 'queue-empty' }`.

use std::collections::BTreeSet;

use freshell_protocol::{
    AmplifierActivityListResponse, AmplifierActivityRecord, AmplifierActivityUpdated,
    AmplifierPhase, ClientMessage, FreshAgentRecoveryStopped, ServerMessage, TerminalIdle,
    TerminalIdleReason, TurnCompletionSnapshot, CLIENT_MESSAGE_TYPES,
    EXTENSION_CLIENT_MESSAGE_TYPES, EXTENSION_SERVER_MESSAGE_TYPES, SERVER_MESSAGE_TYPES,
};
use serde_json::json;

#[test]
fn recovery_stop_parses_and_replies_with_the_same_request_id() {
    let request: ClientMessage = serde_json::from_value(json!({
        "type": "freshAgent.recovery.stop", "requestId": "stop-7",
        "provider": "codex", "sessionId": "thread-7", "sessionType": "freshcodex"
    }))
    .unwrap();
    let ClientMessage::FreshAgentRecoveryStop(stop) = request else {
        panic!("expected recovery stop")
    };
    assert_eq!(stop.request_id, "stop-7");
    assert_eq!(stop.session_id, "thread-7");

    let answer = ServerMessage::FreshAgentRecoveryStopped(FreshAgentRecoveryStopped {
        request_id: stop.request_id,
        provider: "codex".into(),
        session_id: stop.session_id,
        session_type: "freshcodex".into(),
        success: true,
        code: None,
        message: None,
    });
    let wire = serde_json::to_value(answer).unwrap();
    assert_eq!(wire["type"], "freshAgent.recovery.stopped");
    assert_eq!(wire["requestId"], "stop-7");
    assert_eq!(wire["success"], true);
}

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
}

// ── antigravity plan Task 8: the antigravity activity family (the amplifier
// record's additive twin — same wire shapes, new discriminants). ───────────

use freshell_protocol::{
    AgentProvider, AntigravityActivityListResponse, AntigravityActivityRecord,
    AntigravityActivityUpdated, AntigravityPhase,
};

#[test]
fn antigravity_activity_list_parses_like_the_other_activity_lists() {
    let msg: ClientMessage =
        serde_json::from_str(r#"{"type":"antigravity.activity.list","requestId":"req-1"}"#)
            .expect("antigravity.activity.list must parse");
    match msg {
        ClientMessage::AntigravityActivityList(list) => assert_eq!(list.request_id, "req-1"),
        other => panic!("expected AntigravityActivityList, got {other:?}"),
    }
}

#[test]
fn antigravity_activity_list_response_serializes_the_amplifier_shape() {
    let msg = ServerMessage::AntigravityActivityListResponse(AntigravityActivityListResponse {
        request_id: "req-1".into(),
        terminals: vec![AntigravityActivityRecord {
            terminal_id: "term-1".into(),
            phase: AntigravityPhase::Busy,
            updated_at: 1000,
            session_id: Some("conv-1".into()),
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
            "type": "antigravity.activity.list.response",
            "requestId": "req-1",
            "terminals": [{
                "terminalId": "term-1",
                "phase": "busy",
                "updatedAt": 1000,
                "sessionId": "conv-1"
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
fn antigravity_activity_updated_serializes_upsert_and_remove() {
    let msg = ServerMessage::AntigravityActivityUpdated(AntigravityActivityUpdated {
        upsert: vec![AntigravityActivityRecord {
            terminal_id: "term-1".into(),
            phase: AntigravityPhase::Idle,
            updated_at: 42,
            session_id: None,
        }],
        remove: vec!["term-2".into()],
    });
    let wire = serde_json::to_value(&msg).unwrap();
    assert_eq!(
        wire,
        json!({
            "type": "antigravity.activity.updated",
            "upsert": [{ "terminalId": "term-1", "phase": "idle", "updatedAt": 42 }],
            "remove": ["term-2"]
        })
    );
}

#[test]
fn terminal_turn_complete_accepts_the_antigravity_provider() {
    // BOTH twins must admit the provider or the frame cannot be minted: the
    // Rust enum here, `TerminalTurnCompleteSchema.provider` in
    // shared/ws-protocol.ts (the zod pin lives in the client vitest).
    let wire: serde_json::Value = serde_json::to_value(freshell_protocol::TerminalTurnComplete {
        at: 1_000,
        completion_seq: 1,
        provider: AgentProvider::Antigravity,
        terminal_id: "term-1".into(),
        session_id: Some("conv-1".into()),
        outcome: None,
    })
    .unwrap();
    assert_eq!(wire["provider"], "antigravity");
    let parsed: freshell_protocol::TerminalTurnComplete =
        serde_json::from_value(wire).expect("provider round-trips");
    assert_eq!(parsed.provider, AgentProvider::Antigravity);
}
