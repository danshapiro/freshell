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
        Some(40),
        "inventory declares 40 client→server types"
    );
    let expected = json_type_set(&inv["clientToServer"]["types"]);
    let actual: BTreeSet<String> = CLIENT_MESSAGE_TYPES.iter().map(|s| s.to_string()).collect();
    assert_eq!(actual.len(), 40, "crate declares 40 client types (no dups)");
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
        Some(64),
        "inventory declares 64 server→client types"
    );
    let expected = json_type_set(&inv["serverToClient"]["types"]);
    let actual: BTreeSet<String> = SERVER_MESSAGE_TYPES.iter().map(|s| s.to_string()).collect();
    assert_eq!(actual.len(), 64, "crate declares 64 server types (no dups)");
    assert_eq!(
        actual, expected,
        "SERVER_MESSAGE_TYPES must equal the frozen inventory (no missing/extra)"
    );
}

#[test]
fn combined_surface_is_104() {
    let all = all_message_types();
    assert_eq!(all.len(), 104, "40 client + 64 server = 104 discriminants");
    // sorted + unique
    let unique: BTreeSet<&str> = all.iter().copied().collect();
    assert_eq!(
        unique.len(),
        104,
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
    let json =
        r#"{"type":"terminal.killed","requestId":"req-kill-1","terminalId":"t-1","success":true}"#;
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

/// Delta-r7-round-3 (focused-episode-7 round 2, Finding F2/F4): the
/// correlated `pane.closed` answer roundtrips camelCase, elides the absent
/// terminalId/error, and parses the failure shape.
#[test]
fn pane_closed_result_roundtrips_camel_case() {
    let json = r#"{"type":"pane.closed.result","createRequestId":"req-1","terminalId":"t-1","success":true}"#;
    let msg: freshell_protocol::ServerMessage = serde_json::from_str(json).expect("parse");
    let back = serde_json::to_string(&msg).expect("serialize");
    let v: serde_json::Value = serde_json::from_str(&back).unwrap();
    assert_eq!(v["type"], "pane.closed.result");
    assert_eq!(v["createRequestId"], "req-1");
    assert_eq!(v["terminalId"], "t-1");
    assert_eq!(v["success"], true);
    assert!(v.get("error").is_none(), "no error key without a failure");
    // The terminalId-less (in-flight-create close) shape elides the key.
    let no_tid: freshell_protocol::ServerMessage = serde_json::from_str(
        r#"{"type":"pane.closed.result","createRequestId":"req-2","success":true}"#,
    )
    .expect("parse terminalId-less shape");
    let v: serde_json::Value = serde_json::to_value(&no_tid).unwrap();
    assert!(v.get("terminalId").is_none(), "{v}");
    // The failure shape carries the reason.
    let fail: freshell_protocol::ServerMessage = serde_json::from_str(
        r#"{"type":"pane.closed.result","createRequestId":"req-3","success":false,"error":"the record could not be written durably"}"#,
    )
    .expect("parse failure shape");
    let v: serde_json::Value = serde_json::to_value(&fail).unwrap();
    assert_eq!(v["success"], false);
    assert_eq!(v["error"], "the record could not be written durably");
}

/// Focused-episode-7 round 5, Finding F3: the correlated `pane.opened`
/// answer roundtrips camelCase and elides the absent error — `success:false`
/// means the consume did NOT land durably (the client retries it on the next
/// sweep tick; pre-latest servers simply never send the frame and the client
/// never blocks on it).
#[test]
fn pane_opened_result_roundtrips_camel_case() {
    let json = r#"{"type":"pane.opened.result","createRequestId":"req-1","success":true}"#;
    let msg: freshell_protocol::ServerMessage = serde_json::from_str(json).expect("parse");
    let back = serde_json::to_string(&msg).expect("serialize");
    let v: serde_json::Value = serde_json::from_str(&back).unwrap();
    assert_eq!(v["type"], "pane.opened.result");
    assert_eq!(v["createRequestId"], "req-1");
    assert_eq!(v["success"], true);
    assert!(v.get("error").is_none(), "no error key without a failure");
    let fail: freshell_protocol::ServerMessage = serde_json::from_str(
        r#"{"type":"pane.opened.result","createRequestId":"req-2","success":false,"error":"the open re-assertion could not be written durably"}"#,
    )
    .expect("parse failure shape");
    let v: serde_json::Value = serde_json::to_value(&fail).unwrap();
    assert_eq!(v["success"], false);
    assert_eq!(
        v["error"],
        "the open re-assertion could not be written durably"
    );
}

/// Focused-episode-7 round 3 (Findings F1+F2, protocol v10): the batch
/// tab-close and the durable open re-assertion roundtrip camelCase; the batch
/// result elides the absent error. The in-flight-create linkage elides
/// terminalId.
#[test]
fn panes_closed_batch_and_pane_opened_roundtrip_camel_case() {
    let batch: freshell_protocol::ClientMessage = serde_json::from_str(
        r#"{"type":"panes.closed","requestId":"bc-1","tabId":"tab-9","panes":[{"createRequestId":"req-a","terminalId":"t-a"},{"createRequestId":"req-b"}]}"#,
    )
    .expect("parse batch");
    let v: serde_json::Value = serde_json::to_value(&batch).expect("serialize");
    assert_eq!(v["type"], "panes.closed");
    assert_eq!(v["requestId"], "bc-1");
    assert_eq!(v["tabId"], "tab-9");
    assert_eq!(v["panes"][0]["createRequestId"], "req-a");
    assert_eq!(v["panes"][0]["terminalId"], "t-a");
    assert_eq!(v["panes"][1]["createRequestId"], "req-b");
    assert!(v["panes"][1].get("terminalId").is_none(), "{v}");

    let opened: freshell_protocol::ClientMessage =
        serde_json::from_str(r#"{"type":"pane.opened","createRequestId":"req-a","tabId":"tab-9"}"#)
            .expect("parse opened");
    let v: serde_json::Value = serde_json::to_value(&opened).expect("serialize");
    assert_eq!(v["type"], "pane.opened");
    assert_eq!(v["createRequestId"], "req-a");
    assert_eq!(v["tabId"], "tab-9");

    let result: freshell_protocol::ServerMessage =
        serde_json::from_str(r#"{"type":"panes.closed.result","requestId":"bc-1","success":true}"#)
            .expect("parse result");
    let v: serde_json::Value = serde_json::to_value(&result).expect("serialize");
    assert_eq!(v["type"], "panes.closed.result");
    assert_eq!(v["requestId"], "bc-1");
    assert_eq!(v["success"], true);
    assert!(v.get("error").is_none(), "no error key without a failure");
}

#[test]
fn terminal_kill_accepts_and_carries_the_optional_correlation_fields() {
    // Legacy shape (no new fields) parses unchanged.
    let legacy: freshell_protocol::ClientMessage =
        serde_json::from_str(r#"{"type":"terminal.kill","terminalId":"t-1"}"#)
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
