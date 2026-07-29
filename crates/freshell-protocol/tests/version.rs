//! Deliverable #3 — `WS_PROTOCOL_VERSION` parity.
//!
//! The Rust constant must equal the version pinned in every committed contract
//! artifact and in `shared/ws-version.ts`. This is the compile-time half of the
//! T0 gate ("`WS_PROTOCOL_VERSION == 8`").

use std::path::PathBuf;

use freshell_protocol::WS_PROTOCOL_VERSION;

/// Repo-root-relative path to a committed contract artifact.
fn repo_path(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(rel)
}

fn read_json(rel: &str) -> serde_json::Value {
    let text =
        std::fs::read_to_string(repo_path(rel)).unwrap_or_else(|e| panic!("read {rel}: {e}"));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {rel}: {e}"))
}

#[test]
fn rust_const_is_eight() {
    assert_eq!(WS_PROTOCOL_VERSION, 8);
}

#[test]
fn matches_message_inventory() {
    let inv = read_json("port/contract/ws-message-inventory.json");
    assert_eq!(
        inv["wsProtocolVersion"].as_u64(),
        Some(WS_PROTOCOL_VERSION as u64),
        "ws-message-inventory.json wsProtocolVersion must equal the Rust const"
    );
}

#[test]
fn matches_inbound_schema_bundle() {
    let schema = read_json("port/contract/ws-protocol.schema.json");
    assert_eq!(
        schema["wsProtocolVersion"].as_u64(),
        Some(WS_PROTOCOL_VERSION as u64)
    );
    // v8 is current and v7 is the one explicit compatibility handshake.
    let version_schema = &schema["schemas"]["HelloSchema"]["properties"]["protocolVersion"];
    let mut accepted = std::collections::BTreeSet::new();
    fn collect_consts(node: &serde_json::Value, accepted: &mut std::collections::BTreeSet<u64>) {
        if let Some(value) = node.get("const").and_then(|value| value.as_u64()) {
            accepted.insert(value);
        }
        if let Some(values) = node.get("enum").and_then(|value| value.as_array()) {
            accepted.extend(values.iter().filter_map(|value| value.as_u64()));
        }
        for keyword in ["anyOf", "oneOf"] {
            if let Some(branches) = node.get(keyword).and_then(|value| value.as_array()) {
                for branch in branches {
                    collect_consts(branch, accepted);
                }
            }
        }
    }
    collect_consts(version_schema, &mut accepted);
    assert_eq!(
        accepted,
        std::collections::BTreeSet::from([7, 8]),
        "HelloSchema accepts exactly current v8 and compatibility v7"
    );
}

#[test]
fn matches_outbound_schema_bundle() {
    let schema = read_json("port/contract/ws-server-messages.schema.json");
    assert_eq!(
        schema["wsProtocolVersion"].as_u64(),
        Some(WS_PROTOCOL_VERSION as u64)
    );
}

#[test]
fn matches_shared_ws_version_ts() {
    // `shared/ws-version.ts` is the TypeScript authoring source:
    //   export const WS_PROTOCOL_VERSION = 8 as const
    let text = std::fs::read_to_string(repo_path("shared/ws-version.ts"))
        .expect("read shared/ws-version.ts");
    let after_eq = text
        .split('=')
        .nth(1)
        .expect("ws-version.ts has an assignment");
    let digits: String = after_eq
        .trim()
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    let parsed: u32 = digits.parse().expect("numeric version literal");
    assert_eq!(
        parsed, WS_PROTOCOL_VERSION,
        "shared/ws-version.ts must equal the Rust const"
    );
}
