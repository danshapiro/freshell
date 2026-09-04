//! T0 conformance-surface coverage / drift guard.
//!
//! Every `type` discriminant in the frozen inventory must be declared by the
//! crate, and the crate must declare no extras. This is the type-level half of
//! the "any contract message the Rust types can't represent is a FIDELITY GAP"
//! rule: a missing or misnamed variant fails here loudly.

use std::collections::BTreeSet;
use std::path::PathBuf;

use freshell_protocol::{all_message_types, CLIENT_MESSAGE_TYPES, SERVER_MESSAGE_TYPES};

fn inventory() -> serde_json::Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("port/contract/ws-message-inventory.json");
    let text = std::fs::read_to_string(path).expect("read ws-message-inventory.json");
    serde_json::from_str(&text).expect("parse ws-message-inventory.json")
}

fn json_type_set(node: &serde_json::Value) -> BTreeSet<String> {
    node.as_array()
        .expect("types array")
        .iter()
        .map(|v| v.as_str().expect("type is string").to_string())
        .collect()
}

#[test]
fn client_types_match_inventory_exactly() {
    let inv = inventory();
    assert_eq!(
        inv["clientToServer"]["count"].as_u64(),
        Some(36),
        "inventory declares 36 client→server types"
    );
    let expected = json_type_set(&inv["clientToServer"]["types"]);
    let actual: BTreeSet<String> = CLIENT_MESSAGE_TYPES.iter().map(|s| s.to_string()).collect();
    assert_eq!(actual.len(), 36, "crate declares 36 client types (no dups)");
    assert_eq!(
        actual, expected,
        "CLIENT_MESSAGE_TYPES must equal the frozen inventory (no missing/extra)"
    );
}

#[test]
fn server_types_match_inventory_exactly() {
    let inv = inventory();
    assert_eq!(
        inv["serverToClient"]["count"].as_u64(),
        Some(61),
        "inventory declares 61 server→client types"
    );
    let expected = json_type_set(&inv["serverToClient"]["types"]);
    let actual: BTreeSet<String> = SERVER_MESSAGE_TYPES.iter().map(|s| s.to_string()).collect();
    assert_eq!(actual.len(), 61, "crate declares 61 server types (no dups)");
    assert_eq!(
        actual, expected,
        "SERVER_MESSAGE_TYPES must equal the frozen inventory (no missing/extra)"
    );
}

#[test]
fn combined_surface_is_97() {
    let all = all_message_types();
    assert_eq!(all.len(), 97, "36 client + 61 server = 97 discriminants");
    // sorted + unique
    let unique: BTreeSet<&str> = all.iter().copied().collect();
    assert_eq!(
        unique.len(),
        97,
        "no discriminant collides across directions"
    );
}

#[test]
fn terminal_replaced_roundtrips_camel_case() {
    let json = r#"{"type":"terminal.replaced","oldTerminalId":"t-old","newTerminalId":"t-new","exitCode":1,"attempt":1,"maxAttempts":2}"#;
    let msg: freshell_protocol::ServerMessage = serde_json::from_str(json).expect("parse");
    let back = serde_json::to_string(&msg).expect("serialize");
    let v: serde_json::Value = serde_json::from_str(&back).unwrap();
    assert_eq!(v["type"], "terminal.replaced");
    assert_eq!(v["oldTerminalId"], "t-old");
    assert_eq!(v["newTerminalId"], "t-new");
    assert_eq!(v["exitCode"], 1);
    assert_eq!(v["maxAttempts"], 2);
}

/// Delta-r6-r3 (focused-episode-6 round 2): the correlated kill answer
/// roundtrips camelCase with the optional error elided when absent, and the
/// kill's new optional fields stay absent-shape-stable (older kill payloads
/// parse; the new fields ride through).
#[test]
fn terminal_killed_roundtrips_camel_case() {
    let json = r#"{"type":"terminal.killed","requestId":"req-kill-1","terminalId":"t-1","success":true}"#;
    let msg: freshell_protocol::ServerMessage = serde_json::from_str(json).expect("parse");
    let back = serde_json::to_string(&msg).expect("serialize");
    let v: serde_json::Value = serde_json::from_str(&back).unwrap();
    assert_eq!(v["type"], "terminal.killed");
    assert_eq!(v["requestId"], "req-kill-1");
    assert_eq!(v["terminalId"], "t-1");
    assert_eq!(v["success"], true);
    assert!(v.get("error").is_none(), "no error key without a failure");
    let fail: freshell_protocol::ServerMessage = serde_json::from_str(
        r#"{"type":"terminal.killed","requestId":"r2","terminalId":"t-2","success":false,"error":"the close could not be recorded"}"#,
    )
    .expect("parse failure shape");
    let v: serde_json::Value = serde_json::to_value(&fail).unwrap();
    assert_eq!(v["success"], false);
    assert_eq!(v["error"], "the close could not be recorded");
}

#[test]
fn terminal_kill_accepts_and_carries_the_optional_correlation_fields() {
    // Legacy shape (no new fields) parses unchanged.
    let legacy: freshell_protocol::ClientMessage = serde_json::from_str(
        r#"{"type":"terminal.kill","terminalId":"t-1"}"#,
    )
    .expect("legacy parse");
    let freshell_protocol::ClientMessage::TerminalKill(k) = legacy else {
        panic!("expected terminal.kill")
    };
    assert_eq!(k.request_id, None);
    assert_eq!(k.create_request_id, None);
    // The correlated close carries both; accept-and-strip keeps unknown extras out.
    let full: freshell_protocol::ClientMessage = serde_json::from_str(
        r#"{"type":"terminal.kill","terminalId":"t-1","requestId":"r1","createRequestId":"cr1","futureExtra":1}"#,
    )
    .expect("full parse");
    let freshell_protocol::ClientMessage::TerminalKill(k) = full else {
        panic!("expected terminal.kill")
    };
    assert_eq!(k.request_id.as_deref(), Some("r1"));
    assert_eq!(k.create_request_id.as_deref(), Some("cr1"));
}
