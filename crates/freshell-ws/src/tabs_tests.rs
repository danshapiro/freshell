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
