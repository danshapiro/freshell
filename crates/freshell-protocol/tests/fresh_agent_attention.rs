use freshell_protocol::{ClientMessage, ServerMessage};
use serde_json::json;

#[test]
fn attention_replay_capability_and_marks_survive_wire_round_trip() {
    let hello_wire = json!({
        "type": "hello", "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
        "capabilities": { "freshAgentAttentionReplayV1": true },
    });
    let hello: ClientMessage = serde_json::from_value(hello_wire.clone()).unwrap();
    assert_eq!(serde_json::to_value(hello).unwrap(), hello_wire);
    let ready_wire = json!({
        "type": "ready", "timestamp": "now",
        "capabilities": { "freshAgentAttentionReplayV1": true },
        "freshAgentAttention": [{
            "provider": "claude", "sessionId": "session", "sessionType": "kilroy",
            "lastTurnCompleteAt": 100, "lastWaitingAt": 101,
        }],
    });
    let ready: ServerMessage = serde_json::from_value(ready_wire.clone()).unwrap();
    assert_eq!(serde_json::to_value(ready).unwrap(), ready_wire);
}

#[test]
fn legacy_wire_does_not_acquire_attention_replay_fields() {
    let wire = json!({ "type": "ready", "timestamp": "now" });
    let ready: ServerMessage = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(serde_json::to_value(ready).unwrap(), wire);
}
