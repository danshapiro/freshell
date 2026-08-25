//! Tests for [`crate::tabs`] — a `#[path]`-included child module (the
//! `tabs_persist.rs:997-999` pattern) so `tabs.rs` stays under the repo's
//! 1,000-line-per-file limit. Child-module placement keeps private access to
//! `TabsRegistry::inner` for the established backdating pattern.

use super::*;
use crate::tabs_store_model::{
    client_snapshot_key, default_caps, RegistryDeviceEntry, DAY_MS,
    DEFAULT_DEVICE_DISPLAY_TTL_DAYS, MINUTE_MS,
};
use serde_json::{json, Value};

fn open_record(tab_key: &str, tab_name: &str, updated_at: i64) -> Value {
    json!({
        "tabKey": tab_key,
        "tabId": tab_key,
        "tabName": tab_name,
        "status": "open",
        "revision": 1,
        "updatedAt": updated_at,
        "createdAt": updated_at,
        "paneCount": 1,
        "titleSetByUser": true,
        "panes": [],
    })
}

fn closed_record(tab_key: &str, tab_name: &str, updated_at: i64, closed_at: i64) -> Value {
    json!({
        "tabKey": tab_key,
        "tabId": tab_key,
        "tabName": tab_name,
        "status": "closed",
        "revision": 1,
        "updatedAt": updated_at,
        "closedAt": closed_at,
        "createdAt": updated_at,
        "paneCount": 1,
        "titleSetByUser": true,
        "panes": [],
    })
}

#[test]
fn push_then_query_partitions_remote_and_retire_removes() {
    let reg = TabsRegistry::new();
    // Device A (client a1) pushes one open tab.
    let ack = reg
        .replace_client_snapshot(
            "srv-1",
            "device-a",
            "Closing Device",
            "client-a1",
            1,
            vec![open_record("tab-1", "Retire me", 1000)],
        )
        .expect("push accepted");
    assert!(ack.accepted);
    assert_eq!(ack.open_records, 1);

    // Observer B (device-b) queries → the tab is remoteOpen; A is a device.
    let data = reg.query("device-b", "client-b1", 30, now_ms()).unwrap();
    assert_eq!(data["remoteOpen"].as_array().unwrap().len(), 1);
    assert_eq!(data["remoteOpen"][0]["tabName"], "Retire me");
    assert_eq!(data["remoteOpen"][0]["deviceLabel"], "Closing Device");
    assert_eq!(data["localOpen"].as_array().unwrap().len(), 0);
    assert!(!data["devices"].as_array().unwrap().is_empty());

    // A retires (revision advances) → gone from a fresh observer's view.
    assert!(reg.retire_client_snapshot("device-a", "client-a1", 2));
    let after = reg.query("device-c", "client-c1", 30, now_ms()).unwrap();
    assert_eq!(after["remoteOpen"].as_array().unwrap().len(), 0);
}

#[test]
fn local_vs_same_device_partition() {
    let reg = TabsRegistry::new();
    reg.replace_client_snapshot(
        "srv-1",
        "dev",
        "Dev",
        "c1",
        1,
        vec![open_record("t1", "one", 10)],
    )
    .unwrap();
    reg.replace_client_snapshot(
        "srv-1",
        "dev",
        "Dev",
        "c2",
        1,
        vec![open_record("t2", "two", 20)],
    )
    .unwrap();
    let data = reg.query("dev", "c1", 30, now_ms()).unwrap();
    // c1's own tab is local; c2's (same device) is sameDeviceOpen.
    assert_eq!(data["localOpen"].as_array().unwrap().len(), 1);
    assert_eq!(data["localOpen"][0]["tabName"], "one");
    assert_eq!(data["sameDeviceOpen"].as_array().unwrap().len(), 1);
    assert_eq!(data["sameDeviceOpen"][0]["tabName"], "two");
}

#[test]
fn stale_revision_rejected_and_retire_is_monotonic() {
    let reg = TabsRegistry::new();
    reg.replace_client_snapshot(
        "srv-1",
        "dev",
        "Dev",
        "c1",
        5,
        vec![open_record("t1", "one", 10)],
    )
    .unwrap();
    // A lower revision is rejected.
    assert!(reg
        .replace_client_snapshot("srv-1", "dev", "Dev", "c1", 4, vec![])
        .is_err());
    // Retire with a stale revision is not accepted.
    assert!(!reg.retire_client_snapshot("dev", "c1", 5));
    assert!(reg.retire_client_snapshot("dev", "c1", 6));
}

#[test]
fn envelope_records_reads_array() {
    let env = json!({ "type": "tabs.sync.push", "records": [open_record("t", "n", 1)] });
    assert_eq!(envelope_records(&env).len(), 1);
    assert_eq!(
        envelope_records(&json!({ "type": "tabs.sync.push" })).len(),
        0
    );
}

// ---- Node-parity push semantics (Task 11 / AUTO-15) ----

#[test]
fn same_revision_push_with_different_content_is_rejected() {
    let reg = TabsRegistry::new();
    reg.replace_client_snapshot("srv", "d", "D", "c", 1, vec![open_record("a", "One", 10)])
        .unwrap();
    let err = reg
        .replace_client_snapshot(
            "srv",
            "d",
            "D",
            "c",
            1,
            vec![open_record("a", "CHANGED", 11)],
        )
        .unwrap_err();
    assert_eq!(
        err,
        "Duplicate snapshot revision has different tabs registry content"
    );
    // identical re-push is an idempotent accept
    assert!(
        reg.replace_client_snapshot("srv", "d", "D", "c", 1, vec![open_record("a", "One", 10)])
            .unwrap()
            .accepted
    );
}

#[test]
fn closed_record_loses_to_newer_open_winner_elsewhere() {
    let reg = TabsRegistry::new();
    reg.replace_client_snapshot(
        "srv",
        "d1",
        "D1",
        "c1",
        1,
        vec![open_record("a", "Live", 100)],
    )
    .unwrap();
    reg.replace_client_snapshot(
        "srv",
        "d2",
        "D2",
        "c2",
        1,
        vec![closed_record("a", "Old", 50, 50)],
    )
    .unwrap();
    let q = reg.query("d3", "c3", 30, now_ms()).unwrap();
    assert_eq!(q["closed"].as_array().unwrap().len(), 0);
    assert_eq!(q["remoteOpen"].as_array().unwrap().len(), 1);
}

#[test]
fn duplicate_tab_keys_in_one_push_are_rejected() {
    let reg = TabsRegistry::new();
    let err = reg
        .replace_client_snapshot(
            "srv",
            "d",
            "D",
            "c",
            1,
            vec![open_record("a", "One", 10), open_record("a", "Two", 11)],
        )
        .unwrap_err();
    assert!(err.contains("duplicate"), "{err}");
}

#[test]
fn record_ownership_mismatch_is_rejected() {
    let reg = TabsRegistry::new();
    let mut foreign = open_record("a", "One", 10);
    foreign["deviceId"] = json!("other-device");
    let err = reg
        .replace_client_snapshot("srv", "d", "D", "c", 1, vec![foreign])
        .unwrap_err();
    assert_eq!(
        err,
        "Tabs registry record device metadata must match the snapshot device metadata"
    );
}

#[test]
fn query_validates_retention_and_filters_expired_open_snapshots() {
    let reg = TabsRegistry::new();
    let now = now_ms();
    // retention is a validated int 1..=30 (store.ts:411-416)
    assert!(reg.query("d", "c", 0, now).is_err());
    assert!(reg.query("d", "c", 31, now).is_err());

    reg.replace_client_snapshot("srv", "d", "D", "c", 1, vec![open_record("a", "One", now)])
        .unwrap();
    assert_eq!(
        reg.query("d", "c", 30, now).unwrap()["localOpen"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    // Backdate snapshot_received_at past the 30-minute open-snapshot TTL and
    // seed a device past the 7-day display TTL (established backdating
    // pattern: direct private-`inner` access from this child test module).
    {
        let mut state = reg.inner.lock().expect("tabs registry lock");
        let key = client_snapshot_key("d", "c").unwrap();
        state
            .open_snapshots_by_client
            .get_mut(&key)
            .expect("live snapshot")
            .snapshot_received_at = now - 31 * MINUTE_MS;
        state.devices_by_id.insert(
            "device-stale".to_string(),
            RegistryDeviceEntry {
                device_id: "device-stale".to_string(),
                device_label: "Stale Device".to_string(),
                last_seen_at: now - 8 * DAY_MS,
            },
        );
    }

    let q = reg.query("d", "c", 30, now).unwrap();
    assert_eq!(
        q["localOpen"].as_array().unwrap().len(),
        0,
        "open snapshot older than 30 min must be excluded"
    );
    let devices: Vec<&str> = q["devices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["deviceId"].as_str().unwrap())
        .collect();
    assert_eq!(
        devices,
        vec!["d"],
        "devices past the 7-day display TTL must be excluded from query()"
    );
}

// ---- Durable-store backing ----

#[test]
fn durable_registry_survives_reconstruction() {
    let dir = tempfile::tempdir().unwrap();
    let open_store = || {
        crate::tabs_store::DurableTabsStore::open(
            dir.path(),
            crate::tabs_store_model::default_caps(),
            0,
        )
        .unwrap()
    };
    let reg = TabsRegistry::with_durable_store(open_store(), None);
    // NOTE: timestamps are now-based (not the brief's literal 10/5): the
    // Task-11 TTL read-filters + maintenance prune closed tombstones older
    // than the 30-day retention, so epoch-era literals would self-delete.
    let now = now_ms();
    reg.replace_client_snapshot(
        "srv",
        "d",
        "D",
        "c",
        3,
        vec![
            open_record("a", "One", now),
            closed_record("b", "Two", now - 10, now - 10),
        ],
    )
    .unwrap();
    drop(reg);
    let reg2 = TabsRegistry::with_durable_store(open_store(), None);
    let q = reg2.query("d", "c", 30, now_ms()).unwrap();
    assert_eq!(q["localOpen"].as_array().unwrap().len(), 1);
    assert_eq!(q["closed"].as_array().unwrap().len(), 1);
    // stale push after restart still rejected (watermark persisted)
    assert!(reg2
        .replace_client_snapshot("srv", "d", "D", "c", 2, vec![])
        .is_err());
}

#[cfg(unix)]
#[test]
fn commit_failure_leaves_memory_state_unchanged() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let store = crate::tabs_store::DurableTabsStore::open(dir.path(), default_caps(), 0).unwrap();
    let reg = TabsRegistry::with_durable_store(store, None);
    let now = now_ms();
    reg.replace_client_snapshot("srv", "d", "D", "c", 1, vec![open_record("a", "One", now)])
        .unwrap();

    // Make the whole store tree read-only. chmod on the root alone is not
    // enough: commits write under `<root>/v1/{tmp,objects}` and publish
    // `<root>/v1/manifest.json`, so each level must refuse writes.
    let locked = [
        dir.path().to_path_buf(),
        dir.path().join("v1"),
        dir.path().join("v1").join("objects"),
        dir.path().join("v1").join("tmp"),
    ];
    for p in &locked {
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o555)).unwrap();
    }
    // chmod is advisory for root (e.g. containers running as uid 0): if the
    // tree is still writable, the scenario cannot be produced — skip.
    if std::fs::write(dir.path().join("v1").join("tmp").join("probe"), b"x").is_ok() {
        for p in &locked {
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        return;
    }

    let err = reg
        .replace_client_snapshot(
            "srv",
            "d",
            "D",
            "c",
            2,
            vec![open_record("a", "CHANGED", now + 1)],
        )
        .unwrap_err();
    assert!(!err.is_empty());

    for p in &locked {
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    // The failed commit must not have swapped the in-memory state...
    let q = reg.query("d", "c", 30, now_ms()).unwrap();
    assert_eq!(q["localOpen"].as_array().unwrap().len(), 1);
    assert_eq!(q["localOpen"][0]["tabName"], "One");
    // ...nor advanced the revision watermark: the SAME push succeeds once the
    // store is writable again.
    assert!(reg
        .replace_client_snapshot(
            "srv",
            "d",
            "D",
            "c",
            2,
            vec![open_record("a", "CHANGED", now + 1)],
        )
        .is_ok());
}

#[test]
fn concurrent_distinct_client_pushes_both_survive_reopen() {
    // REQUIRED (validator-A6): under the old "derive under the registry lock,
    // release, commit, re-lock, swap" discipline two pushes could derive from
    // the same predecessor state and the second commit published a manifest
    // missing the first push's accepted records (disk AND memory).
    let dir = tempfile::tempdir().unwrap();
    let open_store =
        || crate::tabs_store::DurableTabsStore::open(dir.path(), default_caps(), 0).unwrap();
    let reg = TabsRegistry::with_durable_store(open_store(), None);
    let now = now_ms();

    let mut handles = Vec::new();
    for (device, client, tab) in [("d1", "c1", "tab-a"), ("d2", "c2", "tab-b")] {
        let reg = reg.clone();
        handles.push(std::thread::spawn(move || {
            for rev in 1..=20i64 {
                let ack = reg
                    .replace_client_snapshot(
                        "srv",
                        device,
                        "D",
                        client,
                        rev,
                        vec![open_record(tab, "T", now + rev)],
                    )
                    .expect("every push accepted");
                assert!(ack.accepted);
            }
        }));
    }
    for handle in handles {
        handle.join().unwrap();
    }
    drop(reg);

    let reg2 = TabsRegistry::with_durable_store(open_store(), None);
    let q = reg2.query("d1", "c1", 30, now_ms()).unwrap();
    assert_eq!(
        q["localOpen"].as_array().unwrap().len(),
        1,
        "client c1's records must survive reopen: {q}"
    );
    assert_eq!(
        q["remoteOpen"].as_array().unwrap().len(),
        1,
        "client c2's records must survive reopen: {q}"
    );
}

#[test]
fn push_retire_same_client_race_never_resurrects() {
    // REQUIRED (validator-A6): race push(rev N) against retire(rev N); after
    // EACH round the invariant holds: a retire that was accepted leaves NO
    // live snapshot behind (no resurrection), and the persisted watermark is
    // monotone non-decreasing. (The in-memory watermark read below IS the
    // persisted one: it is only swapped in after a successful commit.)
    let dir = tempfile::tempdir().unwrap();
    let store = crate::tabs_store::DurableTabsStore::open(dir.path(), default_caps(), 0).unwrap();
    let reg = TabsRegistry::with_durable_store(store, None);
    let key = client_snapshot_key("d", "c").unwrap();
    let now = now_ms();

    let mut prev_watermark = -1i64;
    for round in 1..=20i64 {
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let push_reg = reg.clone();
        let push_barrier = std::sync::Arc::clone(&barrier);
        let push = std::thread::spawn(move || {
            push_barrier.wait();
            push_reg
                .replace_client_snapshot(
                    "srv",
                    "d",
                    "D",
                    "c",
                    round,
                    vec![open_record("t", "T", now + round)],
                )
                .is_ok()
        });
        let retire_reg = reg.clone();
        let retire_barrier = std::sync::Arc::clone(&barrier);
        let retire = std::thread::spawn(move || {
            retire_barrier.wait();
            retire_reg.retire_client_snapshot("d", "c", round)
        });
        let push_accepted = push.join().unwrap();
        let retired = retire.join().unwrap();

        let (live_revision, watermark) = {
            let state = reg.inner.lock().expect("tabs registry lock");
            (
                state
                    .open_snapshots_by_client
                    .get(&key)
                    .map(|s| s.snapshot_revision),
                state
                    .client_revisions_by_client
                    .get(&key)
                    .map(|w| w.snapshot_revision)
                    .unwrap_or(-1),
            )
        };
        assert!(
            push_accepted || retired,
            "round {round}: at least one contender wins"
        );
        if retired {
            assert_eq!(
                live_revision, None,
                "round {round}: an accepted retire must never leave a resurrected snapshot"
            );
        }
        assert!(
            watermark >= prev_watermark,
            "round {round}: watermark went backwards ({watermark} < {prev_watermark})"
        );
        assert_eq!(watermark, round, "round {round}: watermark advances");
        prev_watermark = watermark;
    }
}

// ---- Placeholder sessionRef clamp (kata item 1 server-side backstop) ----
//
// Regression scenario (~2026-08-23): a client tabs.sync push re-derived a
// PLACEHOLDER fresh-agent sessionRef (`freshopencode-<createRequestId>`) for a
// pane whose durable identity (`ses_…`) already lived in the registry, and the
// stored snapshot regressed to the placeholder. The clamp substitutes the
// durable sessionRef/sessionId/resumeSessionId from ANY current registry
// snapshot holding one for the same (tabKey, paneId, provider,
// createRequestId); deliberate resets (new createRequestId) pass through.

/// A materialized opencode session id (`ses_…` classifies durable per
/// shared/session-flavor.ts `isDurableProviderSessionId`).
const DURABLE_OPENCODE_SESSION: &str = "ses_01HF5Y2XY7ZQ9V8W7E6R5T4Y3U";
/// A materialized codex session id (non-`freshcodex-` = durable).
const DURABLE_CODEX_SESSION: &str = "0192b8c5-7e3f-7a1d-9c4b-2d8e6f0a1b2c";

fn fresh_agent_pane(
    pane_id: &str,
    provider: &str,
    session_type: &str,
    create_request_id: &str,
    session_ref_session_id: &str,
) -> Value {
    json!({
        "paneId": pane_id,
        "kind": "fresh-agent",
        "payload": {
            "createRequestId": create_request_id,
            "provider": provider,
            "sessionType": session_type,
            "sessionRef": { "provider": provider, "sessionId": session_ref_session_id },
            "sessionId": session_ref_session_id,
            "resumeSessionId": session_ref_session_id,
            "initialCwd": "/repo",
        }
    })
}

fn open_record_with_panes(
    tab_key: &str,
    tab_name: &str,
    updated_at: i64,
    panes: Vec<Value>,
) -> Value {
    json!({
        "tabKey": tab_key,
        "tabId": tab_key,
        "tabName": tab_name,
        "status": "open",
        "revision": 1,
        "updatedAt": updated_at,
        "createdAt": updated_at,
        "paneCount": panes.len(),
        "titleSetByUser": true,
        "panes": panes,
    })
}

/// The first pane payload of (device, client)'s CURRENT stored open snapshot —
/// direct private-`inner` access, the established backdating pattern of this
/// child test module.
fn stored_pane_payload(reg: &TabsRegistry, device: &str, client: &str) -> Value {
    let state = reg.inner.lock().expect("tabs registry lock");
    let key = client_snapshot_key(device, client).unwrap();
    let snapshot = state
        .open_snapshots_by_client
        .get(&key)
        .expect("client has a live snapshot");
    snapshot.records[0]["panes"][0]["payload"].clone()
}

fn push_opencode_durable(
    reg: &TabsRegistry,
    device: &str,
    client: &str,
    revision: i64,
    updated_at: i64,
) {
    reg.replace_client_snapshot(
        "srv-1",
        device,
        "Device",
        client,
        revision,
        vec![open_record_with_panes(
            "tab-1",
            "Agent tab",
            updated_at,
            vec![fresh_agent_pane(
                "pane-1",
                "opencode",
                "freshopencode",
                "crid-1",
                DURABLE_OPENCODE_SESSION,
            )],
        )],
    )
    .expect("durable push accepted");
}

fn push_opencode_placeholder(
    reg: &TabsRegistry,
    device: &str,
    client: &str,
    revision: i64,
    create_request_id: &str,
    updated_at: i64,
) {
    reg.replace_client_snapshot(
        "srv-1",
        device,
        "Device",
        client,
        revision,
        vec![open_record_with_panes(
            "tab-1",
            "Agent tab",
            updated_at,
            vec![fresh_agent_pane(
                "pane-1",
                "opencode",
                "freshopencode",
                create_request_id,
                &format!("freshopencode-{create_request_id}"),
            )],
        )],
    )
    .expect("placeholder push accepted");
}

#[test]
fn cross_client_placeholder_push_is_clamped_to_the_durable_session_ref() {
    let reg = TabsRegistry::new();
    // Client A (device-a) holds the materialized durable identity.
    push_opencode_durable(&reg, "device-a", "client-a1", 1, 10);
    // Client B (device-b) pushes the SAME tab/pane re-derived as a placeholder.
    let ack = reg
        .replace_client_snapshot(
            "srv-1",
            "device-b",
            "Device B",
            "client-b1",
            1,
            vec![open_record_with_panes(
                "tab-1",
                "Agent tab",
                20,
                vec![fresh_agent_pane(
                    "pane-1",
                    "opencode",
                    "freshopencode",
                    "crid-1",
                    "freshopencode-crid-1",
                )],
            )],
        )
        .expect("placeholder push accepted");
    assert!(ack.accepted);

    // The STORED record must carry the durable identity on all three locators.
    let payload = stored_pane_payload(&reg, "device-b", "client-b1");
    assert_eq!(
        payload["sessionRef"],
        json!({ "provider": "opencode", "sessionId": DURABLE_OPENCODE_SESSION })
    );
    assert_eq!(payload["sessionId"], json!(DURABLE_OPENCODE_SESSION));
    assert_eq!(payload["resumeSessionId"], json!(DURABLE_OPENCODE_SESSION));

    // And the winning (newest) record an observer sees is the clamped one.
    let q = reg.query("device-c", "client-c1", 30, now_ms()).unwrap();
    assert_eq!(q["remoteOpen"].as_array().unwrap().len(), 1);
    assert_eq!(
        q["remoteOpen"][0]["panes"][0]["payload"]["sessionRef"]["sessionId"],
        json!(DURABLE_OPENCODE_SESSION)
    );
}

#[test]
fn same_client_repush_is_clamped_from_its_own_current_snapshot() {
    // The exact production regression: ONE client materializes `ses_…`, then a
    // later push of its own re-derives the placeholder.
    let reg = TabsRegistry::new();
    push_opencode_durable(&reg, "device-a", "client-a1", 1, 10);
    push_opencode_placeholder(&reg, "device-a", "client-a1", 2, "crid-1", 20);
    let payload = stored_pane_payload(&reg, "device-a", "client-a1");
    assert_eq!(
        payload["sessionRef"]["sessionId"],
        json!(DURABLE_OPENCODE_SESSION),
        "a client's own prior snapshot must feed the clamp: {payload}"
    );
}

#[test]
fn placeholder_with_a_new_create_request_id_is_not_clamped() {
    // Deliberate reset exemption: a NEW createRequestId (relaunch/fork) keeps
    // its placeholder even though the registry holds a durable identity for
    // the same tab/pane/provider.
    let reg = TabsRegistry::new();
    push_opencode_durable(&reg, "device-a", "client-a1", 1, 10);
    push_opencode_placeholder(&reg, "device-b", "client-b1", 1, "crid-2", 20);
    let payload = stored_pane_payload(&reg, "device-b", "client-b1");
    assert_eq!(
        payload["sessionRef"]["sessionId"],
        json!("freshopencode-crid-2")
    );
}

#[test]
fn placeholder_for_a_different_provider_is_not_clamped() {
    // Same tab/pane/createRequestId but a DIFFERENT provider: the durable
    // opencode identity must never leak into a codex pane.
    let reg = TabsRegistry::new();
    push_opencode_durable(&reg, "device-a", "client-a1", 1, 10);
    reg.replace_client_snapshot(
        "srv-1",
        "device-b",
        "Device B",
        "client-b1",
        1,
        vec![open_record_with_panes(
            "tab-1",
            "Agent tab",
            20,
            vec![fresh_agent_pane(
                "pane-1",
                "codex",
                "freshcodex",
                "crid-1",
                "freshcodex-crid-1",
            )],
        )],
    )
    .expect("placeholder push accepted");
    let payload = stored_pane_payload(&reg, "device-b", "client-b1");
    assert_eq!(
        payload["sessionRef"],
        json!({ "provider": "codex", "sessionId": "freshcodex-crid-1" })
    );
}

#[test]
fn placeholder_without_any_durable_identity_passes_through() {
    let reg = TabsRegistry::new();
    push_opencode_placeholder(&reg, "device-b", "client-b1", 1, "crid-1", 20);
    let payload = stored_pane_payload(&reg, "device-b", "client-b1");
    assert_eq!(
        payload["sessionRef"]["sessionId"],
        json!("freshopencode-crid-1")
    );
}

#[test]
fn codex_placeholder_push_is_clamped_to_the_durable_session_ref() {
    // The codex flavor of the placeholder rule (`freshcodex-…` prefix).
    let reg = TabsRegistry::new();
    reg.replace_client_snapshot(
        "srv-1",
        "device-a",
        "Device A",
        "client-a1",
        1,
        vec![open_record_with_panes(
            "tab-1",
            "Agent tab",
            10,
            vec![fresh_agent_pane(
                "pane-1",
                "codex",
                "freshcodex",
                "crid-5",
                DURABLE_CODEX_SESSION,
            )],
        )],
    )
    .expect("durable push accepted");
    reg.replace_client_snapshot(
        "srv-1",
        "device-b",
        "Device B",
        "client-b1",
        1,
        vec![open_record_with_panes(
            "tab-1",
            "Agent tab",
            20,
            vec![fresh_agent_pane(
                "pane-1",
                "codex",
                "freshcodex",
                "crid-5",
                "freshcodex-crid-5",
            )],
        )],
    )
    .expect("placeholder push accepted");
    let payload = stored_pane_payload(&reg, "device-b", "client-b1");
    assert_eq!(
        payload["sessionRef"],
        json!({ "provider": "codex", "sessionId": DURABLE_CODEX_SESSION })
    );
}

#[test]
fn clamp_falls_back_to_session_ref_id_for_missing_session_id_fields() {
    // A stored durable pane whose payload carries ONLY the sessionRef locator:
    // the clamp must still populate sessionId/resumeSessionId on the pushed
    // record, falling back to the durable sessionRef.sessionId (the
    // `preservedDurableFreshAgentIdentity` field semantics).
    let reg = TabsRegistry::new();
    reg.replace_client_snapshot(
        "srv-1",
        "device-a",
        "Device A",
        "client-a1",
        1,
        vec![open_record_with_panes(
            "tab-1",
            "Agent tab",
            10,
            vec![json!({
                "paneId": "pane-1",
                "kind": "fresh-agent",
                "payload": {
                    "createRequestId": "crid-7",
                    "provider": "opencode",
                    "sessionType": "freshopencode",
                    "sessionRef": { "provider": "opencode", "sessionId": DURABLE_OPENCODE_SESSION },
                }
            })],
        )],
    )
    .expect("durable push accepted");
    push_opencode_placeholder(&reg, "device-b", "client-b1", 1, "crid-7", 20);
    let payload = stored_pane_payload(&reg, "device-b", "client-b1");
    assert_eq!(payload["sessionId"], json!(DURABLE_OPENCODE_SESSION));
    assert_eq!(payload["resumeSessionId"], json!(DURABLE_OPENCODE_SESSION));
}

#[test]
fn clamp_picks_the_newest_durable_identity_across_snapshots() {
    const STALE_DURABLE: &str = "ses_00AASTALE000000000000000000";
    let reg = TabsRegistry::new();
    // Older durable identity on device-a (updatedAt 10)...
    reg.replace_client_snapshot(
        "srv-1",
        "device-a",
        "Device A",
        "client-a1",
        1,
        vec![open_record_with_panes(
            "tab-1",
            "Agent tab",
            10,
            vec![fresh_agent_pane(
                "pane-1",
                "opencode",
                "freshopencode",
                "crid-1",
                STALE_DURABLE,
            )],
        )],
    )
    .expect("older durable push accepted");
    // ...and a NEWER durable identity for the same key on device-b —
    // STRICTLY greater updatedAt (20 > 10), so the winner is pinned by the
    // event-time comparison itself, never by a sourceKey tie-break.
    push_opencode_durable(&reg, "device-b", "client-b1", 1, 20);
    push_opencode_placeholder(&reg, "device-c", "client-c1", 1, "crid-1", 30);
    let payload = stored_pane_payload(&reg, "device-c", "client-c1");
    assert_eq!(
        payload["sessionRef"]["sessionId"],
        json!(DURABLE_OPENCODE_SESSION),
        "the newest event-time durable identity must win: {payload}"
    );
}

#[test]
fn clamped_snapshot_passes_reopen_hash_validation() {
    // `parse_open_snapshot` (tabs_store.rs) rebuilds `open_snapshot_payload_hash`
    // from the STORED records at reopen and rejects a mismatch as corruption:
    // the stored hash must describe the CLAMPED records, not the raw push.
    let dir = tempfile::tempdir().unwrap();
    let open_store =
        || crate::tabs_store::DurableTabsStore::open(dir.path(), default_caps(), 0).unwrap();
    let reg = TabsRegistry::with_durable_store(open_store(), None);
    push_opencode_durable(&reg, "device-a", "client-a1", 1, 10);
    push_opencode_placeholder(&reg, "device-b", "client-b1", 1, "crid-1", 20);
    drop(reg);

    let reg2 = TabsRegistry::with_durable_store(open_store(), None);
    let payload = stored_pane_payload(&reg2, "device-b", "client-b1");
    assert_eq!(
        payload["sessionRef"]["sessionId"],
        json!(DURABLE_OPENCODE_SESSION),
        "reopen must validate AND serve the clamped records: {payload}"
    );
}

#[test]
fn identical_retry_after_a_clamped_push_is_deduped_on_the_raw_push_hash() {
    // Retry identity is the RAW whole-push hash: an identical raw re-push of a
    // payload that was clamped on first store must dedupe as an idempotent
    // retry (never a content-conflict rejection), and the stored snapshot must
    // stay hash-valid across reopen.
    let dir = tempfile::tempdir().unwrap();
    let open_store =
        || crate::tabs_store::DurableTabsStore::open(dir.path(), default_caps(), 0).unwrap();
    let reg = TabsRegistry::with_durable_store(open_store(), None);
    push_opencode_durable(&reg, "device-a", "client-a1", 1, 10);
    let raw_placeholder = || {
        vec![open_record_with_panes(
            "tab-1",
            "Agent tab",
            20,
            vec![fresh_agent_pane(
                "pane-1",
                "opencode",
                "freshopencode",
                "crid-1",
                "freshopencode-crid-1",
            )],
        )]
    };
    reg.replace_client_snapshot(
        "srv-1",
        "device-b",
        "Device B",
        "client-b1",
        1,
        raw_placeholder(),
    )
    .expect("first placeholder push accepted");
    let retry = reg
        .replace_client_snapshot(
            "srv-1",
            "device-b",
            "Device B",
            "client-b1",
            1,
            raw_placeholder(),
        )
        .expect("identical raw retry is an idempotent accept, not a conflict");
    assert!(retry.accepted);
    assert_eq!(retry.open_records, 1);
    let payload = stored_pane_payload(&reg, "device-b", "client-b1");
    assert_eq!(
        payload["sessionRef"]["sessionId"],
        json!(DURABLE_OPENCODE_SESSION)
    );
    drop(reg);
    let reg2 = TabsRegistry::with_durable_store(open_store(), None);
    let payload = stored_pane_payload(&reg2, "device-b", "client-b1");
    assert_eq!(
        payload["sessionRef"]["sessionId"],
        json!(DURABLE_OPENCODE_SESSION),
        "the clamped snapshot must stay hash-valid across reopen after the retry: {payload}"
    );
}

#[test]
fn persisted_generation_carries_the_clamped_records_not_the_raw_push() {
    // Recovery generations reflect registry truth: `persist_generation` must
    // receive the COMMITTED (clamped) records, never the raw pushed payload.
    let dir = tempfile::tempdir().unwrap();
    let reg = TabsRegistry::with_persist_dir(dir.path().to_path_buf());
    push_opencode_durable(&reg, "device-a", "client-a1", 1, 10);
    push_opencode_placeholder(&reg, "device-b", "client-b1", 1, "crid-1", 20);

    let generation = crate::tabs_persist::read_generation(dir.path(), "device-b", 0)
        .expect("generation readable")
        .expect("a generation was persisted for client-b1");
    let payload = &generation["records"][0]["panes"][0]["payload"];
    assert_eq!(
        payload["sessionRef"]["sessionId"],
        json!(DURABLE_OPENCODE_SESSION),
        "the persisted generation must carry the clamped identity: {payload}"
    );
    assert_eq!(payload["resumeSessionId"], json!(DURABLE_OPENCODE_SESSION));
}

// ---- Closed-record placeholder clamp (kata item 1, closed/reopen surface) ----
//
// The clamp's durable sources are the current OPEN snapshots ∪ the current
// CLOSED winners: a stale client closing a materialized tab with a re-derived
// placeholder payload (same tabKey+paneId+provider+createRequestId) must never
// become the closed/reopen winner holding the placeholder identity.

fn closed_record_with_panes(
    tab_key: &str,
    tab_name: &str,
    updated_at: i64,
    closed_at: i64,
    panes: Vec<Value>,
) -> Value {
    json!({
        "tabKey": tab_key,
        "tabId": tab_key,
        "tabName": tab_name,
        "status": "closed",
        "revision": 1,
        "updatedAt": updated_at,
        "closedAt": closed_at,
        "createdAt": updated_at,
        "paneCount": panes.len(),
        "titleSetByUser": true,
        "panes": panes,
    })
}

/// The first pane payload of the CURRENT closed winner stored for `tab_key` —
/// direct private-`inner` access, the established backdating pattern of this
/// child test module.
fn stored_closed_pane_payload(reg: &TabsRegistry, tab_key: &str) -> Value {
    let state = reg.inner.lock().expect("tabs registry lock");
    let winner = state
        .closed_by_tab_key
        .get(tab_key)
        .expect("a closed winner is stored for the tab");
    winner["panes"][0]["payload"].clone()
}

fn push_closed_opencode_placeholder(
    reg: &TabsRegistry,
    device: &str,
    client: &str,
    revision: i64,
    create_request_id: &str,
    updated_at: i64,
) {
    reg.replace_client_snapshot(
        "srv-1",
        device,
        "Device",
        client,
        revision,
        vec![closed_record_with_panes(
            "tab-1",
            "Agent tab",
            updated_at,
            updated_at,
            vec![fresh_agent_pane(
                "pane-1",
                "opencode",
                "freshopencode",
                create_request_id,
                &format!("freshopencode-{create_request_id}"),
            )],
        )],
    )
    .expect("closed placeholder push accepted");
}

#[test]
fn closed_placeholder_push_against_an_open_durable_snapshot_is_clamped() {
    // A stale client CLOSES the materialized tab while re-deriving the
    // placeholder: the closed/reopen winner stored in `closed_by_tab_key`
    // must carry the DURABLE identity the open snapshot holds for the same
    // (tabKey, paneId, provider, createRequestId).
    let reg = TabsRegistry::new();
    push_opencode_durable(&reg, "device-a", "client-a1", 1, 10);
    // The close is NEWER than the open record, so the fold stores it as the
    // closed winner (a newer open winner elsewhere would refuse it). The
    // timestamp is now-based: maintenance prunes closed tombstones beyond the
    // 30-day retention, so epoch-era literals would self-delete.
    push_closed_opencode_placeholder(&reg, "device-b", "client-b1", 1, "crid-1", now_ms());
    let payload = stored_closed_pane_payload(&reg, "tab-1");
    assert_eq!(
        payload["sessionRef"],
        json!({ "provider": "opencode", "sessionId": DURABLE_OPENCODE_SESSION }),
        "the stored closed winner must be clamped to the durable identity: {payload}"
    );
    assert_eq!(payload["sessionId"], json!(DURABLE_OPENCODE_SESSION));
    assert_eq!(payload["resumeSessionId"], json!(DURABLE_OPENCODE_SESSION));
}

#[test]
fn closed_placeholder_reclose_against_a_durable_closed_winner_is_clamped() {
    // NO open snapshot holds the tab; the CURRENT closed winner holds the
    // durable identity for the same key tuple. A placeholder re-close must
    // clamp from that closed winner. Timestamps are now-based (30-day closed
    // retention), with the re-close strictly newer so it wins the fold.
    let reg = TabsRegistry::new();
    let now = now_ms();
    reg.replace_client_snapshot(
        "srv-1",
        "device-a",
        "Device A",
        "client-a1",
        1,
        vec![closed_record_with_panes(
            "tab-1",
            "Agent tab",
            now - 1000,
            now - 1000,
            vec![fresh_agent_pane(
                "pane-1",
                "opencode",
                "freshopencode",
                "crid-1",
                DURABLE_OPENCODE_SESSION,
            )],
        )],
    )
    .expect("closed durable push accepted");
    push_closed_opencode_placeholder(&reg, "device-b", "client-b1", 1, "crid-1", now);
    let payload = stored_closed_pane_payload(&reg, "tab-1");
    assert_eq!(
        payload["sessionRef"],
        json!({ "provider": "opencode", "sessionId": DURABLE_OPENCODE_SESSION }),
        "a placeholder RE-close must clamp from the current closed winner: {payload}"
    );
    assert_eq!(payload["sessionId"], json!(DURABLE_OPENCODE_SESSION));
    assert_eq!(payload["resumeSessionId"], json!(DURABLE_OPENCODE_SESSION));
}

#[test]
fn closed_placeholder_with_a_new_create_request_id_is_not_clamped() {
    // Deliberate reset exemption on the closed surface: a NEW createRequestId
    // (relaunch/fork) keeps its placeholder even though the registry holds a
    // durable identity for the same tab/pane/provider.
    let reg = TabsRegistry::new();
    push_opencode_durable(&reg, "device-a", "client-a1", 1, 10);
    push_closed_opencode_placeholder(&reg, "device-b", "client-b1", 1, "crid-2", now_ms());
    let payload = stored_closed_pane_payload(&reg, "tab-1");
    assert_eq!(
        payload["sessionRef"]["sessionId"],
        json!("freshopencode-crid-2")
    );
}

#[test]
fn closed_placeholder_without_any_durable_identity_passes_through() {
    let reg = TabsRegistry::new();
    push_closed_opencode_placeholder(&reg, "device-b", "client-b1", 1, "crid-1", now_ms());
    let payload = stored_closed_pane_payload(&reg, "tab-1");
    assert_eq!(
        payload["sessionRef"]["sessionId"],
        json!("freshopencode-crid-1")
    );
}

// ---- restoreError-shaped placeholder clamp (kata item 1, identity-erased shape) ----
//
// The incident's full end-state: the client fold that applied a restoreError
// KEPT the placeholder sessionId/resumeSessionId scalars but DROPPED the
// sessionRef locator, so the pushed record carries restoreError + placeholder
// scalars and NO locator — invisible to the locator-only clamp. A record
// provably stale in identity is stale wholesale: on a durable lookup hit the
// durable sessionRef/sessionId/resumeSessionId are substituted AND the
// restoreError is removed (the registry carries the recoverable identity). A
// legitimate restoreError (durable identity, deliberate reset, or no durable
// source) passes through untouched.

/// A fresh-agent pane in the incident's restoreError shape: NO sessionRef
/// locator (the restoreError migration strips it), the placeholder id on the
/// surviving sessionId/resumeSessionId scalars, and a validated restoreError.
fn fresh_agent_pane_restore_error(
    pane_id: &str,
    provider: &str,
    session_type: &str,
    create_request_id: &str,
    scalar_session_id: &str,
    reason: &str,
) -> Value {
    json!({
        "paneId": pane_id,
        "kind": "fresh-agent",
        "payload": {
            "createRequestId": create_request_id,
            "provider": provider,
            "sessionType": session_type,
            "sessionId": scalar_session_id,
            "resumeSessionId": scalar_session_id,
            "restoreError": { "code": "RESTORE_UNAVAILABLE", "reason": reason },
            "initialCwd": "/repo",
        }
    })
}

#[test]
fn open_restore_error_placeholder_record_is_clamped_and_the_error_removed() {
    let reg = TabsRegistry::new();
    push_opencode_durable(&reg, "device-a", "client-a1", 1, 10);
    reg.replace_client_snapshot(
        "srv-1",
        "device-b",
        "Device B",
        "client-b1",
        1,
        vec![open_record_with_panes(
            "tab-1",
            "Agent tab",
            20,
            vec![fresh_agent_pane_restore_error(
                "pane-1",
                "opencode",
                "freshopencode",
                "crid-1",
                "freshopencode-crid-1",
                "dead_live_handle",
            )],
        )],
    )
    .expect("stale restoreError push accepted");
    let payload = stored_pane_payload(&reg, "device-b", "client-b1");
    assert_eq!(
        payload["sessionRef"],
        json!({ "provider": "opencode", "sessionId": DURABLE_OPENCODE_SESSION }),
        "the identity-erased record must be re-clamped to the durable identity: {payload}"
    );
    assert_eq!(payload["sessionId"], json!(DURABLE_OPENCODE_SESSION));
    assert_eq!(payload["resumeSessionId"], json!(DURABLE_OPENCODE_SESSION));
    assert!(
        payload.get("restoreError").is_none(),
        "a record stale in identity is stale wholesale — restoreError removed: {payload}"
    );
}

#[test]
fn closed_restore_error_placeholder_record_is_clamped_and_the_error_removed() {
    // The closed/reopen surface of the identity-erased shape: a stale client
    // closing the materialized tab with restoreError + placeholder scalars
    // and no locator must not become the stored closed winner. now-based so
    // the 30-day closed retention keeps the tombstone.
    let reg = TabsRegistry::new();
    push_opencode_durable(&reg, "device-a", "client-a1", 1, 10);
    reg.replace_client_snapshot(
        "srv-1",
        "device-b",
        "Device B",
        "client-b1",
        1,
        vec![closed_record_with_panes(
            "tab-1",
            "Agent tab",
            now_ms(),
            now_ms(),
            vec![fresh_agent_pane_restore_error(
                "pane-1",
                "opencode",
                "freshopencode",
                "crid-1",
                "freshopencode-crid-1",
                "dead_live_handle",
            )],
        )],
    )
    .expect("stale restoreError closed push accepted");
    let payload = stored_closed_pane_payload(&reg, "tab-1");
    assert_eq!(
        payload["sessionRef"],
        json!({ "provider": "opencode", "sessionId": DURABLE_OPENCODE_SESSION }),
        "the closed winner must be clamped to the durable identity: {payload}"
    );
    assert_eq!(payload["sessionId"], json!(DURABLE_OPENCODE_SESSION));
    assert_eq!(payload["resumeSessionId"], json!(DURABLE_OPENCODE_SESSION));
    assert!(
        payload.get("restoreError").is_none(),
        "the stored closed winner must not carry the stale restoreError: {payload}"
    );
}

#[test]
fn restore_error_record_with_durable_identity_passes_through() {
    // A restoreError on a genuinely broken DURABLE pane is legitimate: no
    // placeholder anywhere present, so nothing is stale and the record —
    // restoreError included — passes through untouched.
    let reg = TabsRegistry::new();
    push_opencode_durable(&reg, "device-a", "client-a1", 1, 10);
    reg.replace_client_snapshot(
        "srv-1",
        "device-b",
        "Device B",
        "client-b1",
        1,
        vec![open_record_with_panes(
            "tab-1",
            "Agent tab",
            20,
            vec![json!({
                "paneId": "pane-1",
                "kind": "fresh-agent",
                "payload": {
                    "createRequestId": "crid-1",
                    "provider": "opencode",
                    "sessionType": "freshopencode",
                    "sessionRef": { "provider": "opencode", "sessionId": DURABLE_OPENCODE_SESSION },
                    "sessionId": DURABLE_OPENCODE_SESSION,
                    "resumeSessionId": DURABLE_OPENCODE_SESSION,
                    "restoreError": { "code": "RESTORE_UNAVAILABLE", "reason": "provider_runtime_failed" },
                    "initialCwd": "/repo",
                }
            })],
        )],
    )
    .expect("durable restoreError push accepted");
    let payload = stored_pane_payload(&reg, "device-b", "client-b1");
    assert_eq!(
        payload["restoreError"],
        json!({ "code": "RESTORE_UNAVAILABLE", "reason": "provider_runtime_failed" }),
        "a legitimate restoreError must survive: {payload}"
    );
    assert_eq!(payload["sessionId"], json!(DURABLE_OPENCODE_SESSION));
    assert_eq!(payload["resumeSessionId"], json!(DURABLE_OPENCODE_SESSION));
}

#[test]
fn restore_error_placeholder_without_any_durable_identity_passes_through() {
    // No durable source anywhere: the restoreError record is all the registry
    // knows, so it passes through untouched (a legitimate restoreError).
    let reg = TabsRegistry::new();
    reg.replace_client_snapshot(
        "srv-1",
        "device-b",
        "Device B",
        "client-b1",
        1,
        vec![open_record_with_panes(
            "tab-1",
            "Agent tab",
            20,
            vec![fresh_agent_pane_restore_error(
                "pane-1",
                "opencode",
                "freshopencode",
                "crid-1",
                "freshopencode-crid-1",
                "dead_live_handle",
            )],
        )],
    )
    .expect("restoreError push accepted");
    let payload = stored_pane_payload(&reg, "device-b", "client-b1");
    assert_eq!(payload["sessionId"], json!("freshopencode-crid-1"));
    assert_eq!(
        payload["restoreError"],
        json!({ "code": "RESTORE_UNAVAILABLE", "reason": "dead_live_handle" }),
        "nothing durable to clamp from — the record stands: {payload}"
    );
}

#[test]
fn restore_error_placeholder_with_a_new_create_request_id_passes_through() {
    // Deliberate-reset exemption on the restoreError shape: a NEW
    // createRequestId keeps its placeholder identity AND its restoreError
    // even though the registry holds a durable identity for the same
    // tab/pane/provider.
    let reg = TabsRegistry::new();
    push_opencode_durable(&reg, "device-a", "client-a1", 1, 10);
    reg.replace_client_snapshot(
        "srv-1",
        "device-b",
        "Device B",
        "client-b1",
        1,
        vec![open_record_with_panes(
            "tab-1",
            "Agent tab",
            20,
            vec![fresh_agent_pane_restore_error(
                "pane-1",
                "opencode",
                "freshopencode",
                "crid-2",
                "freshopencode-crid-2",
                "dead_live_handle",
            )],
        )],
    )
    .expect("restoreError push accepted");
    let payload = stored_pane_payload(&reg, "device-b", "client-b1");
    assert_eq!(payload["sessionId"], json!("freshopencode-crid-2"));
    assert!(payload.get("sessionRef").is_none());
    assert_eq!(
        payload["restoreError"],
        json!({ "code": "RESTORE_UNAVAILABLE", "reason": "dead_live_handle" }),
        "a deliberate reset is never clamped: {payload}"
    );
}

// ---- diagnostic_counts (DEFECT 1 + DEFECT 2 regression coverage) ----

#[test]
fn diagnostic_counts_recordcount_is_raw_undeduplicated_sum_like_legacy_count() {
    // Legacy `TabsRegistryStore.count()` (server/tabs-registry/store.ts:1306-1309)
    // is `sum(records.length across EVERY client's stored open snapshot)
    // + closedByTabKey.length` -- it does NOT dedup by tabKey across
    // clients/devices the way `query()`'s winner-per-tabKey merge does.
    let reg = TabsRegistry::new();
    // Timestamps are now-based so the Task-11 retention maintenance/read
    // filters (30-day tombstone TTL) keep the closed record visible.
    let now = now_ms();

    // Device A, client a1: two open records ("t1", "t2").
    reg.replace_client_snapshot(
        "srv-1",
        "device-a",
        "Device A",
        "client-a1",
        1,
        vec![
            open_record("t1", "from A", now - 200),
            open_record("t2", "solo", now - 200),
        ],
    )
    .expect("push accepted");

    // Device B, client b1: one open record with the SAME tabKey "t1"
    // (the normal multi-device case: the same logical tab open on two
    // devices) plus one closed record.
    reg.replace_client_snapshot(
        "srv-1",
        "device-b",
        "Device B",
        "client-b1",
        1,
        vec![
            open_record("t1", "from B", now - 100),
            closed_record("closed-1", "was open", now - 300, now - 250),
        ],
    )
    .expect("push accepted");

    // Hand-computed expected, per legacy's raw-sum arithmetic:
    //   openSnapshotsByClient: { a1: [t1, t2] (len 2), b1: [t1] (len 1) }
    //     -> sum = 2 + 1 = 3
    //   closedByTabKey: { closed-1 } -> len = 1
    //   expected recordCount = 3 + 1 = 4
    let (record_count, _device_count) = reg.diagnostic_counts();
    assert_eq!(
        record_count, 4,
        "recordCount must be the raw undeduplicated sum (legacy store.ts:1306-1309), \
         not query()'s winner-per-tabKey count"
    );

    // Prove the two APIs genuinely diverge: query()'s dedup collapses
    // the shared "t1" tabKey down to a single winner, undercounting by
    // exactly the 1 duplicate record relative to the raw sum above.
    let queried = reg.query("", "", 30, now).unwrap();
    let via_query = queried["remoteOpen"].as_array().unwrap().len()
        + queried["closed"].as_array().unwrap().len();
    assert_eq!(
        via_query, 3,
        "query() dedups the shared 't1' tabKey down to one winner (t1, t2, closed-1 = 3), \
         undercounting relative to the raw sum of 4"
    );
}

#[test]
fn diagnostic_counts_devicecount_excludes_devices_past_the_display_ttl_like_legacy_list_devices() {
    // Legacy `listDevices()` (server/tabs-registry/store.ts:1298-1304)
    // filters by `deviceDisplayTtlDays` BEFORE counting: `cutoff = now -
    // deviceDisplayTtlDays * DAY_MS`, `lastSeenAt >= cutoff` survives.
    // The TTL value itself is `DEFAULT_DEVICE_DISPLAY_TTL_DAYS = 7`
    // (store.ts:13), and the schema pins `deviceDisplayTtlDays` to a
    // `z.literal(DEFAULT_DEVICE_DISPLAY_TTL_DAYS)` (store.ts:221) -- it
    // is not actually settings-configurable, so mirroring the constant
    // directly is a complete port.
    let reg = TabsRegistry::new();

    // A "fresh" device via the real push path (lastSeenAt = now).
    reg.replace_client_snapshot(
        "srv-1",
        "device-fresh",
        "Fresh Device",
        "client-1",
        1,
        vec![open_record("t-fresh", "fresh tab", 1)],
    )
    .expect("push accepted");

    // A "stale" device, seeded directly via the private `inner` state
    // (same-file access from the child `tests` module -- there is no public
    // API to backdate `lastSeenAt`, and waiting 7 real days in a test is not
    // an option).
    {
        let mut state = reg.inner.lock().expect("tabs registry lock");
        let eight_days_ago = now_ms() - 8 * DAY_MS;
        state.devices_by_id.insert(
            "device-stale".to_string(),
            RegistryDeviceEntry {
                device_id: "device-stale".to_string(),
                device_label: "Stale Device".to_string(),
                last_seen_at: eight_days_ago,
            },
        );
    }

    let (_record_count, device_count) = reg.diagnostic_counts();
    assert_eq!(
        device_count, 1,
        "the device last seen 8 days ago must be excluded by the {DEFAULT_DEVICE_DISPLAY_TTL_DAYS}-day TTL, \
         leaving only the fresh device"
    );
}
