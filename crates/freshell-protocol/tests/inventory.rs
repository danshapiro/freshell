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
        Some(34),
        "inventory declares 34 client→server types"
    );
    let expected = json_type_set(&inv["clientToServer"]["types"]);
    let actual: BTreeSet<String> = CLIENT_MESSAGE_TYPES.iter().map(|s| s.to_string()).collect();
    assert_eq!(actual.len(), 34, "crate declares 34 client types (no dups)");
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
        Some(60),
        "inventory declares 60 server→client types"
    );
    let expected = json_type_set(&inv["serverToClient"]["types"]);
    let actual: BTreeSet<String> = SERVER_MESSAGE_TYPES.iter().map(|s| s.to_string()).collect();
    assert_eq!(actual.len(), 60, "crate declares 60 server types (no dups)");
    assert_eq!(
        actual, expected,
        "SERVER_MESSAGE_TYPES must equal the frozen inventory (no missing/extra)"
    );
}

#[test]
fn combined_surface_is_94() {
    let all = all_message_types();
    assert_eq!(all.len(), 94, "34 client + 60 server = 94 discriminants");
    // sorted + unique
    let unique: BTreeSet<&str> = all.iter().copied().collect();
    assert_eq!(
        unique.len(),
        94,
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
