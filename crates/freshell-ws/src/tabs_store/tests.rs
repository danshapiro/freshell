//! Tests for [`super`] (the durable tabs-registry on-disk store), split out
//! of `tabs_store.rs` per the crate's 1,000-line file cap (same precedent as
//! `tabs_store_model/tests.rs`).

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::*;
use crate::tabs_store_model::{
    build_snapshot_payload_hash, client_snapshot_key, default_caps, empty_state, sha256_hex_full,
    ClientOpenSnapshot, ClientRevisionWatermark, CompactState, RegistryDeviceEntry,
};

/// A fixed wall-clock instant (ms) — the store never reads real time.
const NOW: i64 = 1_700_000_000_000;

/// The `open_record` helper of `tabs.rs`' tests (tabs.rs:479), extended with
/// the FULL required field set of `validate_registry_record` (types.ts:57-83)
/// plus the `clientInstanceId` the snapshot identity check requires.
fn open_record(tab_key: &str, tab_name: &str, updated_at: i64) -> Value {
    json!({
        "tabKey": tab_key,
        "tabId": tab_key,
        "serverInstanceId": "srv-1",
        "deviceId": "dev-1",
        "deviceLabel": "Device One",
        "clientInstanceId": "cli-1",
        "tabName": tab_name,
        "status": "open",
        "revision": 1,
        "createdAt": 100,
        "updatedAt": updated_at,
        "paneCount": 1,
        "titleSetByUser": false,
        "panes": [{ "paneId": "p1", "kind": "terminal", "payload": { "mode": "shell" } }],
    })
}

fn closed_record(tab_key: &str, tab_name: &str, closed_at: i64) -> Value {
    let mut record = open_record(tab_key, tab_name, closed_at);
    record["status"] = json!("closed");
    record["closedAt"] = json!(closed_at);
    record
}

/// 1 open snapshot (2 records), 1 watermark, 1 tombstone, 1 device — every
/// component map populated, with a REAL `openSnapshotPayloadHash` (load
/// re-verifies it against the snapshot content).
fn populated_state(now: i64) -> CompactState {
    let records = vec![open_record("t1", "one", now), open_record("t2", "two", now)];
    let hash = build_snapshot_payload_hash("dev-1", "Device One", "cli-1", 3, &records);
    let key = client_snapshot_key("dev-1", "cli-1").unwrap();
    let mut state = empty_state(now, 30);
    state.open_snapshots_by_client.insert(
        key.clone(),
        ClientOpenSnapshot {
            device_id: "dev-1".into(),
            device_label: "Device One".into(),
            client_instance_id: "cli-1".into(),
            snapshot_revision: 3,
            last_push_payload_hash: hash.clone(),
            open_snapshot_payload_hash: hash,
            snapshot_received_at: now,
            records,
        },
    );
    state.client_revisions_by_client.insert(
        key,
        ClientRevisionWatermark {
            device_id: "dev-1".into(),
            client_instance_id: "cli-1".into(),
            snapshot_revision: 3,
            last_seen_at: now,
        },
    );
    state.closed_by_tab_key.insert(
        "t-closed".into(),
        closed_record("t-closed", "gone", now - 100),
    );
    state.devices_by_id.insert(
        "dev-1".into(),
        RegistryDeviceEntry {
            device_id: "dev-1".into(),
            device_label: "Device One".into(),
            last_seen_at: now,
        },
    );
    state
}

fn manifest_path(root: &Path) -> PathBuf {
    root.join("v1").join("manifest.json")
}

fn read_manifest_json(root: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(manifest_path(root)).unwrap()).unwrap()
}

fn object_files(root: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(root.join("v1").join("objects"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    files.sort();
    files
}

fn invalid_archives(root: &Path) -> Vec<String> {
    std::fs::read_dir(root.join("v1"))
        .unwrap()
        .filter_map(|entry| entry.unwrap().file_name().into_string().ok())
        .filter(|name| name.starts_with("manifest.json.invalid-"))
        .collect()
}

/// Deep equality of the four component maps (the durable payload; `saved_at`
/// round-trips as `committedAt` and is pinned by the manifest assertions).
fn assert_states_equal(actual: &CompactState, expected: &CompactState) {
    assert_eq!(
        serde_json::to_value(&actual.open_snapshots_by_client).unwrap(),
        serde_json::to_value(&expected.open_snapshots_by_client).unwrap(),
        "open snapshots differ"
    );
    assert_eq!(
        serde_json::to_value(&actual.client_revisions_by_client).unwrap(),
        serde_json::to_value(&expected.client_revisions_by_client).unwrap(),
        "client revision watermarks differ"
    );
    assert_eq!(
        serde_json::to_value(&actual.closed_by_tab_key).unwrap(),
        serde_json::to_value(&expected.closed_by_tab_key).unwrap(),
        "closed tombstones differ"
    );
    assert_eq!(
        serde_json::to_value(&actual.devices_by_id).unwrap(),
        serde_json::to_value(&expected.devices_by_id).unwrap(),
        "devices differ"
    );
}

#[test]
fn fresh_open_writes_nothing_until_first_commit() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let mut store = DurableTabsStore::open(root, default_caps(), NOW).unwrap();
    assert!(
        !manifest_path(root).exists(),
        "open() must not write a manifest"
    );
    assert!(
        object_files(root).is_empty(),
        "open() must not write objects"
    );

    store.commit(empty_state(NOW, 30), NOW).unwrap();
    assert!(manifest_path(root).exists());
    let manifest = read_manifest_json(root);
    assert_eq!(manifest["version"], json!(1));
    assert_eq!(manifest["manifestRevision"], json!(1));
}

#[test]
fn commit_then_reopen_roundtrips_state() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let state = populated_state(NOW);
    let mut store = DurableTabsStore::open(root, default_caps(), NOW).unwrap();
    store.commit(state.clone(), NOW).unwrap();
    drop(store);

    let reopened = DurableTabsStore::open(root, default_caps(), NOW + 60_000).unwrap();
    assert_states_equal(reopened.state(), &state);
    assert_eq!(
        reopened.manifest_revision(),
        1,
        "manifest revision preserved"
    );
}

#[test]
fn objects_are_content_addressed_and_deduped() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let state = populated_state(NOW);
    let mut store = DurableTabsStore::open(root, default_caps(), NOW).unwrap();
    store.commit(state.clone(), NOW).unwrap();

    let first = object_files(root);
    assert!(!first.is_empty());
    for path in &first {
        let name = path.file_name().unwrap().to_str().unwrap();
        let stem = name
            .strip_suffix(".json")
            .expect("object files end in .json");
        assert_eq!(stem.len(), 64, "object name is 64-hex: {name}");
        assert!(
            stem.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')),
            "object name is 64-hex: {name}"
        );
        let content = std::fs::read_to_string(path).unwrap();
        assert_eq!(
            sha256_hex_full(&content),
            stem,
            "object name matches content sha"
        );
    }

    store.commit(state, NOW + 1).unwrap();
    assert_eq!(object_files(root), first, "identical state adds no objects");
}

#[test]
fn manifest_referencing_missing_object_archives_and_starts_empty() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    {
        let mut store = DurableTabsStore::open(root, default_caps(), NOW).unwrap();
        store.commit(populated_state(NOW), NOW).unwrap();
    }
    let manifest = read_manifest_json(root);
    let (_, snapshot_ref) = manifest["openSnapshots"]
        .as_object()
        .unwrap()
        .iter()
        .next()
        .unwrap();
    let relative = snapshot_ref["path"].as_str().unwrap();
    std::fs::remove_file(root.join("v1").join(relative)).unwrap();

    let reopened = DurableTabsStore::open(root, default_caps(), NOW + 1).unwrap();
    assert!(reopened.state().open_snapshots_by_client.is_empty());
    assert!(reopened.state().client_revisions_by_client.is_empty());
    assert!(reopened.state().closed_by_tab_key.is_empty());
    assert!(reopened.state().devices_by_id.is_empty());
    assert_eq!(reopened.manifest_revision(), 0);
    assert!(
        !manifest_path(root).exists(),
        "invalid manifest is archived away"
    );
    assert_eq!(
        invalid_archives(root).len(),
        1,
        "exactly one manifest.json.invalid-* archive exists"
    );
}

#[test]
fn corrupt_object_bytes_fail_boot_loudly() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    {
        let mut store = DurableTabsStore::open(root, default_caps(), NOW).unwrap();
        store.commit(populated_state(NOW), NOW).unwrap();
    }
    let manifest = read_manifest_json(root);
    let relative = manifest["closedTombstones"]["path"].as_str().unwrap();
    // Truncate the object IN PLACE: the file still exists, so this is NOT the
    // missing-object self-heal — boot must fail.
    std::fs::write(root.join("v1").join(relative), "{").unwrap();

    let err = DurableTabsStore::open(root, default_caps(), NOW + 1).unwrap_err();
    assert!(matches!(err, TabsStoreOpenError::Corrupt(_)), "{err:?}");
    assert!(
        manifest_path(root).exists(),
        "manifest NOT archived on non-ENOENT corruption"
    );
    assert!(invalid_archives(root).is_empty());
}

#[test]
fn corrupt_manifest_json_fails_boot_loudly() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join("v1")).unwrap();
    std::fs::write(manifest_path(root), "not json {{").unwrap();

    let err = DurableTabsStore::open(root, default_caps(), NOW).unwrap_err();
    assert!(matches!(err, TabsStoreOpenError::Corrupt(_)), "{err:?}");
}

#[test]
fn partial_writes_are_invisible() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join("v1").join("tmp")).unwrap();
    std::fs::create_dir_all(root.join("v1").join("objects")).unwrap();
    // A crashed writer's leftover tmp file + an orphan (unreferenced) object.
    std::fs::write(root.join("v1").join("tmp").join("xx.tmp"), "partial").unwrap();
    let orphan = root
        .join("v1")
        .join("objects")
        .join(format!("{}.json", "a".repeat(64)));
    std::fs::write(&orphan, "orphan bytes").unwrap();

    let mut store = DurableTabsStore::open(root, default_caps(), NOW).unwrap();
    assert!(
        store.state().open_snapshots_by_client.is_empty(),
        "partials are invisible"
    );

    store.commit(populated_state(NOW), NOW).unwrap();
    assert_eq!(
        std::fs::read_dir(root.join("v1").join("tmp"))
            .unwrap()
            .count(),
        0,
        "commit clears v1/tmp"
    );
    assert!(
        orphan.exists(),
        "GC never deletes objects/* (overlapping-restart safety)"
    );
}

#[test]
fn oversized_component_object_fails_commit_without_swapping_state() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let mut caps = default_caps();
    caps.max_serialized_client_snapshot_object_bytes = 32;
    let mut store = DurableTabsStore::open(root, caps.clone(), NOW).unwrap();

    let full = populated_state(NOW);
    let mut base = full.clone();
    base.open_snapshots_by_client.clear();
    store.commit(base.clone(), NOW).unwrap();

    let err = store.commit(full, NOW + 1);
    assert!(
        err.is_err(),
        "oversized snapshot object must fail the commit"
    );
    assert_states_equal(store.state(), &base);
    drop(store);

    let reopened = DurableTabsStore::open(root, caps, NOW + 2).unwrap();
    assert_eq!(
        reopened.manifest_revision(),
        1,
        "failed commit published no manifest"
    );
    assert_states_equal(reopened.state(), &base);
}

/// The legacy arm is live (Task 10): a legacy log containing ONLY
/// schema-invalid lines migrates to an EMPTY state, publishes
/// `manifestRevision: 1`, and archives the legacy file. Full migration
/// coverage lives in `tabs_store_migrate/tests.rs`.
#[test]
fn legacy_jsonl_with_only_invalid_lines_migrates_to_empty_state() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root).unwrap();
    std::fs::write(root.join("tabs-registry.jsonl"), "{}\n").unwrap();

    let store = DurableTabsStore::open(root, default_caps(), NOW).unwrap();
    assert!(store.state().open_snapshots_by_client.is_empty());
    assert!(store.state().closed_by_tab_key.is_empty());
    assert_eq!(
        store.manifest_revision(),
        1,
        "migration commits manifestRevision 1"
    );
    assert!(manifest_path(root).exists());
    assert!(
        !root.join("tabs-registry.jsonl").exists(),
        "legacy file archived after publish"
    );
}
