//! Tests for [`super`] (the legacy `tabs-registry.jsonl` migration), split
//! out of `tabs_store_migrate.rs` per the crate's 1,000-line file cap (same
//! precedent as `tabs_store/tests.rs`).
//!
//! The golden fixture mirrors scenario F of the a8a9 Node harness
//! (`.worktrees/.the-usual-logs/naming-persistence-sweep/artifacts/a8a9-harness/`)
//! byte-for-byte in shape, so the payload hashes below are pinned to the REAL
//! Node implementation's output at the fixed clock 1_750_000_000_000.

use std::path::Path;

use serde_json::{json, Value};

use super::*;
use crate::tabs_store::{DurableTabsStore, TabsStoreOpenError};
use crate::tabs_store_model::{
    archive_timestamp, client_snapshot_key, default_caps, DAY_MS, DEFAULT_CLOSED_RETENTION_DAYS,
};

/// The golden harness' fixed clock (`NOW = 1_750_000_000_000`).
const NOW: i64 = 1_750_000_000_000;

/// Golden Node `snapA.openSnapshotPayloadHash` (harness output, scenario F).
const GOLDEN_SNAP_A_HASH: &str = "d7304a3a73d48d1417661e0cd3b1f696bf42ae6b065aa918ea99b1ebb86b865c";
/// Golden Node `snapB.openSnapshotPayloadHash` (harness output, scenario F).
const GOLDEN_SNAP_B_HASH: &str = "0fb29d631c8257861f60371576fc458dbd626817c135b888d508027a90e6dcbc";

/// The harness' `openRecord` base (harness.mts:29-38) with overrides.
fn legacy_record(overrides: &[(&str, Value)]) -> Value {
    let mut record = json!({
        "tabKey": "tk1",
        "tabId": "tab1",
        "serverInstanceId": "srv1",
        "deviceId": "devA",
        "deviceLabel": "Device A",
        "clientInstanceId": "cliA",
        "tabName": "Tab One",
        "status": "open",
        "revision": 1,
        "createdAt": NOW - 1000,
        "updatedAt": NOW - 500,
        "paneCount": 1,
        "titleSetByUser": false,
        "panes": [{ "paneId": "p1", "kind": "terminal", "payload": {} }],
    });
    for (key, value) in overrides {
        record[*key] = value.clone();
    }
    record
}

fn legacy_line(overrides: &[(&str, Value)]) -> String {
    serde_json::to_string(&legacy_record(overrides)).unwrap()
}

/// Scenario F's legacy file (harness.mts:198-212): 3 LWW contenders for
/// tabKey "a", a malformed line, a schema-invalid line, a blank line, a CRLF
/// line, one in-retention + one out-of-retention closed record, and a second
/// devB record whose label DIFFERS ("Device B RENAMED").
fn write_golden_legacy_fixture(root: &Path) {
    let lines = [
        legacy_line(&[
            ("tabKey", json!("a")),
            ("tabId", json!("t-a")),
            ("tabName", json!("A v1")),
            ("updatedAt", json!(NOW - 3000)),
            ("revision", json!(1)),
        ]),
        legacy_line(&[
            ("tabKey", json!("a")),
            ("tabId", json!("t-a")),
            ("tabName", json!("A v3 WINNER")),
            ("updatedAt", json!(NOW - 1000)),
            ("revision", json!(3)),
        ]),
        legacy_line(&[
            ("tabKey", json!("a")),
            ("tabId", json!("t-a")),
            ("tabName", json!("A v2")),
            ("updatedAt", json!(NOW - 2000)),
            ("revision", json!(2)),
        ]),
        "{ this is not json".to_string(),
        r#"{"tabKey":"x","nope":true}"#.to_string(),
        String::new(),
        legacy_line(&[
            ("tabKey", json!("crlf")),
            ("tabId", json!("t-crlf")),
            ("deviceId", json!("devB")),
            ("deviceLabel", json!("Device B")),
            ("tabName", json!("CRLF tab")),
            ("updatedAt", json!(NOW - 400)),
        ]) + "\r",
        legacy_line(&[
            ("tabKey", json!("closed-in")),
            ("tabId", json!("t-ci")),
            ("status", json!("closed")),
            ("closedAt", json!(NOW - DAY_MS)),
            ("updatedAt", json!(NOW - DAY_MS)),
            ("tabName", json!("closed in retention")),
        ]),
        legacy_line(&[
            ("tabKey", json!("closed-out")),
            ("tabId", json!("t-co")),
            ("status", json!("closed")),
            ("closedAt", json!(NOW - 40 * DAY_MS)),
            ("updatedAt", json!(NOW - 40 * DAY_MS)),
            ("tabName", json!("closed out of retention")),
        ]),
        legacy_line(&[
            ("tabKey", json!("b2")),
            ("tabId", json!("t-b2")),
            ("deviceId", json!("devB")),
            ("deviceLabel", json!("Device B RENAMED")),
            ("tabName", json!("B two")),
            ("updatedAt", json!(NOW - 300)),
        ]),
    ];
    std::fs::write(root.join("tabs-registry.jsonl"), lines.join("\n") + "\n").unwrap();
}

fn migrated_archives(root: &Path) -> Vec<String> {
    std::fs::read_dir(root)
        .unwrap()
        .filter_map(|entry| entry.unwrap().file_name().into_string().ok())
        .filter(|name| name.starts_with("tabs-registry.jsonl.migrated-"))
        .collect()
}

#[test]
fn migrates_legacy_jsonl_lww_per_tab_key_and_archives_after_publish() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write_golden_legacy_fixture(root);

    let store = DurableTabsStore::open(root, default_caps(), NOW).unwrap();
    let state = store.state();

    // Per-device synthetic snapshots under b64url snapshot keys (golden f4).
    let key_a = client_snapshot_key("devA", "legacy-migration").unwrap();
    let key_b = client_snapshot_key("devB", "legacy-migration").unwrap();
    assert_eq!(key_a, "ZGV2QQ:bGVnYWN5LW1pZ3JhdGlvbg");
    assert_eq!(key_b, "ZGV2Qg:bGVnYWN5LW1pZ3JhdGlvbg");
    assert_eq!(state.open_snapshots_by_client.len(), 2, "one per deviceId");

    let snap_a = &state.open_snapshots_by_client[&key_a];
    assert_eq!(snap_a.client_instance_id, "legacy-migration");
    assert_eq!(snap_a.snapshot_revision, 1);
    assert_eq!(snap_a.device_label, "Device A");
    assert_eq!(snap_a.snapshot_received_at, NOW);
    assert_eq!(snap_a.records.len(), 1, "LWW keeps ONE winner for 'a'");
    assert_eq!(snap_a.records[0]["tabName"], json!("A v3 WINNER"));
    assert_eq!(snap_a.records[0]["updatedAt"], json!(NOW - 1000));
    assert_eq!(
        snap_a.records[0]["clientInstanceId"],
        json!("legacy-migration"),
        "record clientInstanceId rewritten"
    );
    assert_eq!(snap_a.open_snapshot_payload_hash, GOLDEN_SNAP_A_HASH);
    assert_eq!(
        snap_a.last_push_payload_hash, snap_a.open_snapshot_payload_hash,
        "both payload hashes = the open-records hash"
    );

    let snap_b = &state.open_snapshots_by_client[&key_b];
    assert_eq!(snap_b.device_label, "Device B", "group's FIRST label");
    assert_eq!(snap_b.records.len(), 2);
    assert!(
        snap_b
            .records
            .iter()
            .all(|record| record["deviceLabel"] == json!("Device B")),
        "first-label rewrite applies to ALL records incl. the renamed one"
    );
    assert_eq!(snap_b.records[0]["tabKey"], json!("crlf"), "CRLF tolerated");
    assert_eq!(snap_b.records[1]["tabKey"], json!("b2"));
    assert_eq!(snap_b.open_snapshot_payload_hash, GOLDEN_SNAP_B_HASH);
    assert_eq!(
        snap_b.last_push_payload_hash,
        snap_b.open_snapshot_payload_hash
    );

    // A matching watermark per device (golden f10).
    assert_eq!(state.client_revisions_by_client.len(), 2);
    for key in [&key_a, &key_b] {
        let watermark = &state.client_revisions_by_client[key.as_str()];
        assert_eq!(watermark.client_instance_id, "legacy-migration");
        assert_eq!(watermark.snapshot_revision, 1);
        assert_eq!(watermark.last_seen_at, NOW);
    }

    // In-retention tombstone kept; out-of-retention dropped; junk absent
    // (golden f11).
    let tombstone_keys: Vec<&String> = state.closed_by_tab_key.keys().collect();
    assert_eq!(tombstone_keys, ["closed-in"]);

    // devices_by_id (contract clause 6, validator-A8-A9): LAST-label-wins,
    // diverging from the snapshot's FIRST-label rewrite (golden devices.devB
    // "Device B RENAMED" vs snapB "Device B").
    assert_eq!(state.devices_by_id.len(), 2);
    assert_eq!(state.devices_by_id["devA"].device_label, "Device A");
    assert_eq!(state.devices_by_id["devB"].device_label, "Device B RENAMED");
    assert!(state
        .devices_by_id
        .values()
        .all(|device| device.last_seen_at == NOW));

    // Published: manifestRevision 1 on disk; archive strictly after publish.
    assert_eq!(store.manifest_revision(), 1);
    let manifest: Value = serde_json::from_str(
        &std::fs::read_to_string(root.join("v1").join("manifest.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(manifest["manifestRevision"], json!(1));
    assert!(
        !root.join("tabs-registry.jsonl").exists(),
        "legacy file renamed away after publish"
    );
    let archives = migrated_archives(root);
    assert_eq!(archives.len(), 1, "exactly one migrated-* archive");
    assert_eq!(
        archives[0],
        format!("tabs-registry.jsonl.migrated-{}", archive_timestamp(NOW))
    );
}

#[test]
fn oversized_legacy_line_is_a_hard_error() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let big = legacy_line(&[
        ("tabKey", json!("big")),
        ("tabName", json!("x".repeat(300 * 1024))),
    ]);
    std::fs::write(root.join("tabs-registry.jsonl"), big + "\n").unwrap();

    let err = DurableTabsStore::open(root, default_caps(), NOW).unwrap_err();
    match err {
        TabsStoreOpenError::Corrupt(message) => {
            assert!(message.contains("larger than 256 KiB"), "{message}");
        }
        other => panic!("expected Corrupt, got {other:?}"),
    }
    assert!(
        root.join("tabs-registry.jsonl").exists(),
        "legacy file NOT archived on failure"
    );
    assert!(
        !root.join("v1").join("manifest.json").exists(),
        "nothing published on failure"
    );
}

#[test]
fn crash_between_publish_and_archive_replays_harmlessly() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    // Simulate the crash window: run migrate + commit manually, but do NOT
    // rename the legacy file (the store.ts:697-698 ordering guarantee).
    let mut store = DurableTabsStore::open(root, default_caps(), NOW).unwrap();
    write_golden_legacy_fixture(root);
    let migrated = migrate_legacy_jsonl(
        &root.join("tabs-registry.jsonl"),
        NOW,
        &default_caps(),
        DEFAULT_CLOSED_RETENTION_DAYS,
    )
    .unwrap();
    store.commit(migrated.clone(), NOW).unwrap();
    drop(store);
    assert!(root.join("tabs-registry.jsonl").exists());

    // Reopen: the manifest wins over legacy (open checks the manifest FIRST),
    // so the stale legacy file is inert — no double migration.
    let reopened = DurableTabsStore::open(root, default_caps(), NOW + 1).unwrap();
    assert_eq!(reopened.manifest_revision(), 1);
    assert_eq!(
        serde_json::to_value(&reopened.state().open_snapshots_by_client).unwrap(),
        serde_json::to_value(&migrated.open_snapshots_by_client).unwrap(),
        "open snapshots match the migrated state"
    );
    assert_eq!(
        serde_json::to_value(&reopened.state().closed_by_tab_key).unwrap(),
        serde_json::to_value(&migrated.closed_by_tab_key).unwrap(),
        "tombstones match the migrated state"
    );
    assert_eq!(
        serde_json::to_value(&reopened.state().devices_by_id).unwrap(),
        serde_json::to_value(&migrated.devices_by_id).unwrap(),
        "devices match the migrated state"
    );
    assert!(
        root.join("tabs-registry.jsonl").exists(),
        "reopen neither replays nor archives the stale legacy file"
    );
}
