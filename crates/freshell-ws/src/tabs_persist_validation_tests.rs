//! Behavior locks for `createRequestId` in persisted tabs-snapshot pane
//! payloads (Lane A1 Task 4). These tests intentionally add NO validator
//! strictness: `validate_generation` is shared by the write-accept AND read
//! paths, and one strict read failure poisons the whole device
//! (`all_generations_parsed` propagates the first `Err`) plus the cross-device
//! listing (`list_snapshot_devices`). Tolerance here is a design decision —
//! see the Task 4 rationale in
//! docs/plans/2026-07-25-createrequestid-stabilization.md. Sibling file to
//! `tabs_persist_tests.rs` (co-owned by Lane A6, hence the separate file);
//! helper shapes are mirrored from there. Registered from
//! `tabs_persist_validation.rs` (a `#[path]` child of `tabs_persist`) because
//! `tabs_persist.rs` sits at 999 lines against the 1,000-line cap
//! (port/AGENTS.md:81) — hence the double `super` below.

use super::super::*; // grandparent = tabs_persist (this mod lives under its `validation` child)
use crate::tabs::TabsRegistry;
use serde_json::{json, Value};

fn open_record(tab_key: &str, tab_name: &str, updated_at: i64) -> Value {
    json!({ "tabKey": tab_key, "tabId": tab_key, "tabName": tab_name, "status": "open",
            "revision": updated_at, "updatedAt": updated_at, "createdAt": updated_at,
            "titleSetByUser": false, "paneCount": 0, "panes": [] })
}

/// Direct deterministic write (explicit captured_at + revision) — bypasses the
/// WS-handler write gate on purpose, simulating a file that is ALREADY on disk
/// (legacy server, foreign writer, historical corpus).
fn put(
    dir: &std::path::Path,
    device: &str,
    client: &str,
    rev: i64,
    captured: i64,
    recs: Vec<Value>,
) {
    let _ = persist_generation(dir, "srv-1", device, "Dev", client, rev, &recs, captured);
}

fn keyed_panes(terminal_key: Value, fresh_key: Value) -> Value {
    json!([
        { "paneId": "terminal", "kind": "terminal",
          "payload": { "mode": "shell", "shell": "system",
                       "createRequestId": terminal_key } },
        { "paneId": "fresh", "kind": "fresh-agent",
          "payload": { "sessionType": "freshclaude", "provider": "claude",
                       "createRequestId": fresh_key } }
    ])
}

#[test]
fn pane_create_request_id_string_round_trips_push_to_read_unchanged() {
    // Full production write pipeline (registry push -> persist_generation),
    // then the fail-loud read path. The field must survive verbatim.
    let dir = tempfile::tempdir().unwrap();
    let reg = TabsRegistry::with_persist_dir(dir.path().to_path_buf());
    let mut record = open_record("dev:t", "t", 1);
    record["panes"] = keyed_panes(
        json!("a3f2b8d07a98b5fb2f4af05baf580000"), // server-mint shape (32 hex)
        json!("req-fa-1"),                         // client nanoid shape
    );
    reg.replace_client_snapshot("srv-1", "dev", "Dev", "client-1", 1, vec![record])
        .unwrap();
    let union = read_device_union(dir.path(), "dev")
        .expect("read io")
        .expect("one generation");
    let panes = &union["records"][0]["panes"];
    assert_eq!(
        panes[0]["payload"]["createRequestId"],
        "a3f2b8d07a98b5fb2f4af05baf580000"
    );
    assert_eq!(panes[1]["payload"]["createRequestId"], "req-fa-1");
    // And the shared write-accept validator (same validate_generation as the
    // read path) accepts a generation carrying the string field.
    let candidate = json!({
        "deviceId": "dev", "deviceLabel": "Dev", "clientInstanceId": "client-1",
        "serverInstanceId": "srv-1", "snapshotRevision": 1, "capturedAt": 0,
        "records": union["records"],
    });
    assert!(validate_incoming_generation(&candidate).is_ok());
}

#[test]
fn legacy_snapshots_without_create_request_id_stay_valid() {
    let dir = tempfile::tempdir().unwrap();
    let mut record = open_record("dev:legacy", "legacy", 1);
    record["panes"] = json!([
        { "paneId": "terminal", "kind": "terminal",
          "payload": { "mode": "shell", "shell": "system" } },
        { "paneId": "fresh", "kind": "fresh-agent",
          "payload": { "sessionType": "freshclaude", "provider": "claude" } }
    ]);
    put(dir.path(), "dev", "c1", 1, 1000, vec![record]);
    assert!(
        read_device_union(dir.path(), "dev").unwrap().is_some(),
        "snapshots predating createRequestId must remain readable"
    );
}

#[test]
fn wrong_typed_create_request_id_never_poisons_the_device() {
    // THE load-bearing lock: a wrong-typed key on disk (historical corpus,
    // foreign writer, version skew) must NOT convert into device-wide — or
    // via list_snapshot_devices, server-wide — snapshot unreadability. If this
    // test ever goes red because someone added a type check to
    // validate_generation, that check is on the READ path too: remove it.
    let dir = tempfile::tempdir().unwrap();
    let mut record = open_record("dev:t", "t", 1);
    record["panes"] = keyed_panes(json!(42), json!(true));
    put(dir.path(), "dev", "c1", 1, 1000, vec![record]);
    let union = read_device_union(dir.path(), "dev")
        .expect("wrong-typed createRequestId must NOT make the device unreadable")
        .expect("generation present");
    // Current (locked) behavior: the unknown field passes through verbatim —
    // nothing strips it; the CONSUMERS (REST ingress, recovery inventory)
    // drop non-strings, so the only cost is that one pane loses key identity.
    let panes = &union["records"][0]["panes"];
    assert_eq!(panes[0]["payload"]["createRequestId"], 42);
    assert_eq!(panes[1]["payload"]["createRequestId"], true);
    assert!(list_snapshot_devices(dir.path()).is_ok());
}
