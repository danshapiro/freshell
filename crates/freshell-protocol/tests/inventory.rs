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
        Some(27),
        "inventory declares 27 client→server types"
    );
    let expected = json_type_set(&inv["clientToServer"]["types"]);
    let actual: BTreeSet<String> = CLIENT_MESSAGE_TYPES.iter().map(|s| s.to_string()).collect();
    assert_eq!(actual.len(), 27, "crate declares 27 client types (no dups)");
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
        Some(52),
        "inventory declares 52 server→client types"
    );
    let expected = json_type_set(&inv["serverToClient"]["types"]);
    let actual: BTreeSet<String> = SERVER_MESSAGE_TYPES.iter().map(|s| s.to_string()).collect();
    assert_eq!(actual.len(), 52, "crate declares 52 server types (no dups)");
    assert_eq!(
        actual, expected,
        "SERVER_MESSAGE_TYPES must equal the frozen inventory (no missing/extra)"
    );
}

#[test]
fn combined_surface_is_79() {
    let all = all_message_types();
    assert_eq!(all.len(), 79, "27 client + 52 server = 79 discriminants");
    // sorted + unique
    let unique: BTreeSet<&str> = all.iter().copied().collect();
    assert_eq!(unique.len(), 79, "no discriminant collides across directions");
}
