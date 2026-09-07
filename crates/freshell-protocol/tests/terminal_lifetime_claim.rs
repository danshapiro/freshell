//! Hidden-pane lifetime-claim wire frames (responsive-terminal-restore
//! Workstream 1): the `terminalLifetimeClaimV1` capability on `hello`, its
//! advertisement on `ready`, and the additive optional
//! `terminal.interest.claimedTerminalIds` field. Additive surface only;
//! `protocolVersion` stays put (no bump — older peers accept-and-strip).

use freshell_protocol::{ClientMessage, Ready, ReadyCapabilities, ServerMessage};
use serde_json::json;

// --- capability (hello) ------------------------------------------------------

#[test]
fn hello_capabilities_parse_terminal_lifetime_claim_v1() {
    let wire = json!({
        "type": "hello",
        "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
        "token": "t",
        "capabilities": { "terminalLifetimeClaimV1": true }
    });
    let msg: ClientMessage = serde_json::from_value(wire).expect("hello parses");
    let ClientMessage::Hello(hello) = msg else {
        panic!("expected hello");
    };
    assert_eq!(
        hello
            .capabilities
            .and_then(|c| c.terminal_lifetime_claim_v1),
        Some(true)
    );
}

#[test]
fn hello_capabilities_omit_terminal_lifetime_claim_v1_when_absent() {
    // Frozen-client shape: no terminalLifetimeClaimV1 anywhere. Round-trip
    // must not invent the field (skip_serializing_if).
    let wire = json!({
        "type": "hello",
        "protocolVersion": freshell_protocol::WS_PROTOCOL_VERSION,
        "token": "t",
        "capabilities": { "terminalOutputBatchV1": true }
    });
    let msg: ClientMessage = serde_json::from_value(wire.clone()).expect("hello parses");
    let back = serde_json::to_value(&msg).expect("serializes");
    assert_eq!(back, wire);
}

// --- advertisement (ready) ---------------------------------------------------

#[test]
fn ready_capabilities_advertise_terminal_lifetime_claim_v1_when_negotiated() {
    let ready = Ready {
        timestamp: "2026-09-20T00:00:00.000Z".to_string(),
        boot_id: Some("boot-1".to_string()),
        server_instance_id: Some("srv-1".to_string()),
        build_id: None,
        capabilities: Some(ReadyCapabilities {
            pane_reconcile_v1: None,
            pane_reconcile_fresh_agent_v1: None,
            terminal_interest_v1: Some(true),
            paced_terminal_replay_v1: None,
            terminal_lifetime_claim_v1: Some(true),
            managed_runtime_v1: None,
        }),
        runtime_owners: None,
    };
    let wire = serde_json::to_value(ServerMessage::Ready(ready)).expect("serializes");
    assert_eq!(
        wire["capabilities"],
        json!({ "terminalInterestV1": true, "terminalLifetimeClaimV1": true })
    );
}

#[test]
fn ready_capabilities_omit_terminal_lifetime_claim_v1_when_none() {
    let ready = Ready {
        timestamp: "2026-09-20T00:00:00.000Z".to_string(),
        boot_id: Some("boot-1".to_string()),
        server_instance_id: Some("srv-1".to_string()),
        build_id: None,
        capabilities: Some(ReadyCapabilities {
            pane_reconcile_v1: Some(true),
            pane_reconcile_fresh_agent_v1: None,
            terminal_interest_v1: None,
            paced_terminal_replay_v1: None,
            terminal_lifetime_claim_v1: None,
            managed_runtime_v1: None,
        }),
        runtime_owners: None,
    };
    let wire = serde_json::to_value(ServerMessage::Ready(ready)).expect("serializes");
    assert_eq!(wire["capabilities"], json!({ "paneReconcileV1": true }));
}

// --- terminal.interest.claimedTerminalIds -------------------------------------

#[test]
fn terminal_interest_parses_claimed_terminal_ids() {
    let wire = json!({
        "type": "terminal.interest",
        "revision": 1,
        "focusedTerminalId": null,
        "visibleTerminalIds": [],
        "claimedTerminalIds": ["T-hidden-1", "T-hidden-2"]
    });
    let msg: ClientMessage = serde_json::from_value(wire).expect("interest parses");
    let ClientMessage::TerminalInterest(interest) = msg else {
        panic!("expected terminal.interest");
    };
    assert_eq!(
        interest.claimed_terminal_ids.as_deref(),
        Some(["T-hidden-1".to_string(), "T-hidden-2".to_string()].as_slice())
    );
}

#[test]
fn terminal_interest_round_trip_keeps_frozen_shape_without_claims() {
    // The frozen client's snapshot must serialize byte-identically: the new
    // field is skipped when None (older servers accept-and-strip anyway, but
    // the wire stays the committed shape).
    let wire = json!({
        "type": "terminal.interest",
        "revision": 1,
        "focusedTerminalId": "A",
        "visibleTerminalIds": ["A"]
    });
    let msg: ClientMessage = serde_json::from_value(wire.clone()).expect("interest parses");
    let back = serde_json::to_value(&msg).expect("serializes");
    assert_eq!(back, wire);
}
