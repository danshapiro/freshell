//! Reconciliation-handshake wire frames (Phase 1 of
//! `docs/plans/2026-07-22-reconciliation-handshake-design.md` §4).
//!
//! Additive protocol surface only: `pane.reconcile.request` (client→server),
//! `pane.reconcile.result` (server→client), the `paneReconcileV1` capability on
//! `hello` + its advertisement on `ready`, and the two reconcile error codes.
//! `protocolVersion` stays 7 (§4.5 / fence "No protocolVersion bump").

use freshell_protocol::{
    ClientMessage, ErrorCode, PaneReconcileResult, PaneVerdict, ReadyCapabilities,
    ReconcileVerdict, ServerMessage, SessionLocator,
};
use serde_json::json;

// --- capability (hello) ------------------------------------------------------

#[test]
fn hello_capabilities_parse_pane_reconcile_v1() {
    let wire = json!({
        "type": "hello",
        "protocolVersion": 7,
        "token": "t",
        "capabilities": { "paneReconcileV1": true }
    });
    let msg: ClientMessage = serde_json::from_value(wire).expect("hello parses");
    let ClientMessage::Hello(hello) = msg else {
        panic!("expected hello");
    };
    assert_eq!(
        hello.capabilities.and_then(|c| c.pane_reconcile_v1),
        Some(true)
    );
}

#[test]
fn hello_capabilities_omit_pane_reconcile_v1_when_absent() {
    // Frozen-client shape: no paneReconcileV1 anywhere. Round-trip must not
    // invent the field (skip_serializing_if).
    let wire = json!({
        "type": "hello",
        "protocolVersion": 7,
        "token": "t",
        "capabilities": { "terminalOutputBatchV1": true }
    });
    let msg: ClientMessage = serde_json::from_value(wire.clone()).expect("hello parses");
    let back = serde_json::to_value(&msg).expect("serializes");
    assert_eq!(back, wire);
}

// --- advertisement (ready) ---------------------------------------------------

#[test]
fn ready_capabilities_field_is_omitted_when_none() {
    // The pinned clean-boot handshake bytes must be unchanged for a frozen
    // client (§3): `capabilities: None` must not appear on the wire at all.
    let ready = freshell_protocol::Ready {
        timestamp: "2026-07-22T00:00:00.000Z".to_string(),
        boot_id: Some("boot-1".to_string()),
        server_instance_id: Some("srv-1".to_string()),
        capabilities: None,
    };
    let wire = serde_json::to_value(ServerMessage::Ready(ready)).expect("serializes");
    assert!(
        wire.get("capabilities").is_none(),
        "ready must omit capabilities when not negotiated: {wire}"
    );
}

#[test]
fn ready_capabilities_advertise_pane_reconcile_v1_when_negotiated() {
    let ready = freshell_protocol::Ready {
        timestamp: "2026-07-22T00:00:00.000Z".to_string(),
        boot_id: Some("boot-1".to_string()),
        server_instance_id: Some("srv-1".to_string()),
        capabilities: Some(ReadyCapabilities {
            pane_reconcile_v1: Some(true),
        }),
    };
    let wire = serde_json::to_value(ServerMessage::Ready(ready)).expect("serializes");
    assert_eq!(wire["capabilities"], json!({ "paneReconcileV1": true }));
}

// --- pane.reconcile.request --------------------------------------------------

#[test]
fn reconcile_request_parses_full_pane_claims() {
    let wire = json!({
        "type": "pane.reconcile.request",
        "reconcileId": "rec-8f2k",
        "panes": [
            {
                "paneKey": "tab3:paneA",
                "kind": "terminal",
                "mode": "amplifier",
                "createRequestId": "cr-1",
                "terminalId": "term-1",
                "serverInstanceId": "srv-old",
                "sessionRef": { "provider": "amplifier", "sessionId": "s-1" },
                "resumeSessionId": "s-1",
                "status": "running"
            }
        ]
    });
    let msg: ClientMessage = serde_json::from_value(wire).expect("request parses");
    let ClientMessage::PaneReconcileRequest(req) = msg else {
        panic!("expected pane.reconcile.request");
    };
    assert_eq!(req.reconcile_id, "rec-8f2k");
    assert_eq!(req.panes.len(), 1);
    let pane = &req.panes[0];
    assert_eq!(pane.pane_key, "tab3:paneA");
    assert_eq!(pane.kind.as_deref(), Some("terminal"));
    assert_eq!(pane.mode.as_deref(), Some("amplifier"));
    assert_eq!(pane.create_request_id.as_deref(), Some("cr-1"));
    assert_eq!(pane.terminal_id.as_deref(), Some("term-1"));
    assert_eq!(pane.server_instance_id.as_deref(), Some("srv-old"));
    assert_eq!(
        pane.session_ref,
        Some(SessionLocator {
            provider: "amplifier".to_string(),
            session_id: "s-1".to_string(),
        })
    );
    assert_eq!(pane.resume_session_id.as_deref(), Some("s-1"));
    assert_eq!(pane.status.as_deref(), Some("running"));
}

#[test]
fn reconcile_request_tolerates_malformed_pane_entries() {
    // A malformed entry (no createRequestId, unknown kind, even a missing
    // paneKey) must still PARSE — the server answers it with an `invalid`
    // verdict (§8 total cardinality), never a frame-level parse failure.
    let wire = json!({
        "type": "pane.reconcile.request",
        "reconcileId": "rec-1",
        "panes": [ {}, { "paneKey": "p2", "kind": "fresh-agent" } ]
    });
    let msg: ClientMessage = serde_json::from_value(wire).expect("malformed panes still parse");
    let ClientMessage::PaneReconcileRequest(req) = msg else {
        panic!("expected pane.reconcile.request");
    };
    assert_eq!(req.panes.len(), 2);
    assert_eq!(req.panes[0].pane_key, "");
    assert!(req.panes[0].create_request_id.is_none());
    assert_eq!(req.panes[1].kind.as_deref(), Some("fresh-agent"));
}

// --- pane.reconcile.result ---------------------------------------------------

#[test]
fn reconcile_result_serializes_verdicts_with_optional_fields_omitted() {
    let result = ServerMessage::PaneReconcileResult(PaneReconcileResult {
        reconcile_id: "rec-8f2k".to_string(),
        boot_id: "boot-1".to_string(),
        server_instance_id: "srv-1".to_string(),
        verdicts: vec![
            PaneVerdict {
                pane_key: "tab3:paneA".to_string(),
                verdict: ReconcileVerdict::Attach,
                terminal_id: Some("term-1".to_string()),
                session_ref: Some(SessionLocator {
                    provider: "amplifier".to_string(),
                    session_id: "s-1".to_string(),
                }),
                corrected: Some(true),
                reason: None,
                retry_after_ms: None,
                duplicate: None,
            },
            PaneVerdict {
                pane_key: "tab3:paneB".to_string(),
                verdict: ReconcileVerdict::Fresh,
                terminal_id: None,
                session_ref: None,
                corrected: None,
                reason: Some("no_recoverable_identity".to_string()),
                retry_after_ms: None,
                duplicate: None,
            },
        ],
    });
    let wire = serde_json::to_value(&result).expect("serializes");
    assert_eq!(wire["type"], "pane.reconcile.result");
    assert_eq!(wire["reconcileId"], "rec-8f2k");
    assert_eq!(wire["bootId"], "boot-1");
    assert_eq!(wire["serverInstanceId"], "srv-1");
    assert_eq!(wire["verdicts"][0]["verdict"], "attach");
    assert_eq!(wire["verdicts"][0]["terminalId"], "term-1");
    assert_eq!(wire["verdicts"][0]["corrected"], true);
    // Optional fields absent from the JSON entirely, not null.
    assert!(wire["verdicts"][0].get("reason").is_none());
    assert!(wire["verdicts"][1].get("terminalId").is_none());
    assert_eq!(wire["verdicts"][1]["verdict"], "fresh");
    assert_eq!(wire["verdicts"][1]["reason"], "no_recoverable_identity");
}

#[test]
fn reconcile_verdict_wire_names_are_snake_case() {
    for (verdict, name) in [
        (ReconcileVerdict::Attach, "attach"),
        (ReconcileVerdict::Respawn, "respawn"),
        (ReconcileVerdict::Fresh, "fresh"),
        (ReconcileVerdict::DeadSession, "dead_session"),
        (ReconcileVerdict::Retry, "retry"),
        (ReconcileVerdict::Invalid, "invalid"),
    ] {
        assert_eq!(serde_json::to_value(verdict).unwrap(), json!(name));
    }
}

#[test]
fn retry_verdict_carries_retry_after_ms() {
    let verdict = PaneVerdict {
        pane_key: "p".to_string(),
        verdict: ReconcileVerdict::Retry,
        terminal_id: None,
        session_ref: None,
        corrected: None,
        reason: Some("index_warming".to_string()),
        retry_after_ms: Some(2000),
        duplicate: None,
    };
    let wire = serde_json::to_value(&verdict).expect("serializes");
    assert_eq!(wire["retryAfterMs"], 2000);
    assert_eq!(wire["reason"], "index_warming");
}

// --- error codes --------------------------------------------------------------

#[test]
fn reconcile_error_codes_are_screaming_snake_case() {
    assert_eq!(
        serde_json::to_value(ErrorCode::ReconcileTooLarge).unwrap(),
        json!("RECONCILE_TOO_LARGE")
    );
    assert_eq!(
        serde_json::to_value(ErrorCode::ReconcileUnavailable).unwrap(),
        json!("RECONCILE_UNAVAILABLE")
    );
}
