use super::*;
use serde_json::{json, Value};

fn open_record(tab_key: &str) -> Value {
    json!({
        "tabKey": tab_key,
        "tabId": tab_key,
        "serverInstanceId": "srv",
        "deviceId": "dev-1",
        "deviceLabel": "Device One",
        "tabName": "Tab",
        "status": "open",
        "revision": 1,
        "createdAt": 100,
        "updatedAt": 200,
        "paneCount": 1,
        "titleSetByUser": false,
        "panes": [{ "paneId": "p1", "kind": "terminal", "payload": { "mode": "shell" } }],
    })
}

fn tombstone(tab_key: &str, closed_at: i64) -> Value {
    let mut record = open_record(tab_key);
    record["status"] = json!("closed");
    record["closedAt"] = json!(closed_at);
    record["updatedAt"] = json!(closed_at);
    record
}

fn snapshot(received_at: i64) -> ClientOpenSnapshot {
    ClientOpenSnapshot {
        device_id: "d".into(),
        device_label: "D".into(),
        client_instance_id: "c".into(),
        snapshot_revision: 1,
        last_push_payload_hash: "0".repeat(64),
        open_snapshot_payload_hash: "0".repeat(64),
        snapshot_received_at: received_at,
        records: vec![],
    }
}

#[test]
fn payload_hash_matches_node_stable_stringify_fixture() {
    let fx: serde_json::Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/node-tabs-registry-hash.json"
    ))
    .unwrap();
    let input = &fx["input"];
    let records: Vec<serde_json::Value> = input["records"].as_array().unwrap().clone();
    let hash = build_snapshot_payload_hash(
        input["deviceId"].as_str().unwrap(),
        input["deviceLabel"].as_str().unwrap(),
        input["clientInstanceId"].as_str().unwrap(),
        input["snapshotRevision"].as_i64().unwrap(),
        &records,
    );
    assert_eq!(hash, fx["sha256"].as_str().unwrap());
}

#[test]
fn client_snapshot_key_is_base64url_and_rejects_blank() {
    let k = client_snapshot_key("dev:1", "cli:2").unwrap();
    assert!(!k[..k.rfind(':').unwrap()].contains("dev:1")); // encoded, ':' unambiguous
    assert_ne!(
        client_snapshot_key("a", "b:c").unwrap(),
        client_snapshot_key("a:b", "c").unwrap()
    );
    assert!(client_snapshot_key("  ", "x").is_err());
}

#[test]
fn base64url_no_pad_matches_node_buffer_base64url() {
    // Golden vectors: Node `Buffer.from(v, "utf-8").toString("base64url")`.
    // "devA"/"legacy-migration" are the a8a9-harness golden snapshot key parts.
    assert_eq!(base64url_no_pad(b"devA"), "ZGV2QQ");
    assert_eq!(
        base64url_no_pad(b"legacy-migration"),
        "bGVnYWN5LW1pZ3JhdGlvbg"
    );
    assert_eq!(base64url_no_pad(b"a"), "YQ");
    assert_eq!(base64url_no_pad(b""), "");
    // URL-safe alphabet: 62 -> '-', 63 -> '_' (never '+'/'/'), no padding.
    assert_eq!(base64url_no_pad(&[0xfb]), "-w");
    assert_eq!(base64url_no_pad(&[0xff]), "_w");
    // The full golden migration snapshot key.
    assert_eq!(
        client_snapshot_key("devA", "legacy-migration").unwrap(),
        "ZGV2QQ:bGVnYWN5LW1pZ3JhdGlvbg"
    );
}

#[test]
fn sha256_hex_full_is_64_hex_of_the_full_digest() {
    // FIPS 180-4 test vector: SHA-256 of the empty string.
    assert_eq!(
        sha256_hex_full(""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(sha256_hex_full("abc").len(), 64);
}

#[test]
fn archive_timestamp_is_local_yyyymmdd_hhmmss() {
    let ts = archive_timestamp(1_750_000_000_000);
    assert_eq!(ts.len(), 15, "{ts}");
    assert_eq!(&ts[8..9], "-");
    assert!(ts[..8].bytes().all(|b| b.is_ascii_digit()), "{ts}");
    assert!(ts[9..].bytes().all(|b| b.is_ascii_digit()), "{ts}");
}

#[test]
fn maintenance_expires_open_snapshots_after_30_minutes_but_keeps_watermarks_7_days() {
    let caps = default_caps();
    let mut st = empty_state(0, 30);
    st.open_snapshots_by_client.insert(
        "k".into(),
        ClientOpenSnapshot {
            device_id: "d".into(),
            device_label: "D".into(),
            client_instance_id: "c".into(),
            snapshot_revision: 1,
            last_push_payload_hash: "0".repeat(64),
            open_snapshot_payload_hash: "0".repeat(64),
            snapshot_received_at: 0,
            records: vec![],
        },
    );
    st.client_revisions_by_client.insert(
        "k".into(),
        ClientRevisionWatermark {
            device_id: "d".into(),
            client_instance_id: "c".into(),
            snapshot_revision: 1,
            last_seen_at: 0,
        },
    );
    apply_queued_maintenance(&mut st, 31 * 60_000, &caps);
    assert!(st.open_snapshots_by_client.is_empty());
    assert_eq!(st.client_revisions_by_client.len(), 1); // survives past open TTL (store.test.ts:418)
    apply_queued_maintenance(&mut st, 8 * DAY_MS, &caps);
    assert!(st.client_revisions_by_client.is_empty());
}

#[test]
fn state_caps_reject_snapshot_ref_overflow_instead_of_truncating() {
    let caps = TabsStoreCaps {
        max_client_snapshot_refs: 1,
        ..default_caps()
    };
    let mut st = empty_state(0, 30);
    for i in 0..2 {
        st.open_snapshots_by_client
            .insert(format!("k{i}"), snapshot(1));
    }
    apply_queued_maintenance(&mut st, 1, &caps);
    assert_eq!(st.open_snapshots_by_client.len(), 2); // maintenance NEVER slices open snapshots
    assert!(validate_state_caps(&st, &caps).is_err()); // the push is REJECTED instead
}

#[test]
fn tombstones_prune_to_newest_closed_first_2000_cap() {
    let caps = TabsStoreCaps {
        max_closed_tombstones: 2,
        ..default_caps()
    };
    let mut st = empty_state(0, 30);
    for (key, closed_at) in [("t1", 100), ("t2", 200), ("t3", 300)] {
        st.closed_by_tab_key
            .insert(key.to_string(), tombstone(key, closed_at));
    }
    apply_queued_maintenance(&mut st, 1000, &caps);
    assert_eq!(st.closed_by_tab_key.len(), 2);
    assert!(st.closed_by_tab_key.contains_key("t3"));
    assert!(st.closed_by_tab_key.contains_key("t2"));
    assert!(
        !st.closed_by_tab_key.contains_key("t1"),
        "oldest closedAt pruned first"
    );
}

#[test]
fn maintenance_drops_tombstones_past_the_retention_window() {
    let caps = default_caps();
    let mut st = empty_state(0, 30);
    st.closed_by_tab_key
        .insert("old".into(), tombstone("old", 0));
    st.closed_by_tab_key
        .insert("fresh".into(), tombstone("fresh", 20 * DAY_MS));
    apply_queued_maintenance(&mut st, 31 * DAY_MS, &caps);
    assert!(
        !st.closed_by_tab_key.contains_key("old"),
        "closedAt 31d ago > 30d retention"
    );
    assert!(st.closed_by_tab_key.contains_key("fresh"));
}

#[test]
fn record_validation_rejects_duplicate_tab_keys_and_pane_cap() {
    let caps = default_caps();
    // Two records with the SAME tabKey -> Err (store.ts:422-427).
    assert!(validate_record_caps(&[open_record("dup"), open_record("dup")], &caps).is_err());
    assert!(validate_record_caps(&[open_record("a"), open_record("b")], &caps).is_ok());
    // 21 panes -> Err (panes.length side of store.ts:433).
    let mut fat = open_record("fat");
    let pane = json!({ "paneId": "p", "kind": "terminal", "payload": {} });
    fat["panes"] = json!(vec![pane; 21]);
    fat["paneCount"] = json!(21);
    assert!(validate_record_caps(&[fat], &caps).is_err());
    // paneCount=21 with 1 pane -> Err (the paneCount side is checked too).
    let mut lying = open_record("lying");
    lying["paneCount"] = json!(21);
    assert!(validate_record_caps(&[lying], &caps).is_err());
    // Boundary: exactly 20 panes / paneCount 20 is allowed.
    let mut full = open_record("full");
    let pane = json!({ "paneId": "p", "kind": "terminal", "payload": {} });
    full["panes"] = json!(vec![pane; 20]);
    full["paneCount"] = json!(20);
    assert!(validate_record_caps(&[full], &caps).is_ok());
}

#[test]
fn record_validation_requires_closed_at_on_closed_records() {
    assert!(validate_registry_record(&open_record("ok")).is_ok());
    // status closed WITHOUT closedAt -> Err (types.ts:75-83 superRefine).
    let mut closed = open_record("c1");
    closed["status"] = json!("closed");
    assert!(validate_registry_record(&closed).is_err());
    // With closedAt it passes.
    closed["closedAt"] = json!(300);
    assert!(validate_registry_record(&closed).is_ok());
    // Schema basics: blank tabName and unknown pane kind are rejected.
    let mut blank = open_record("b1");
    blank["tabName"] = json!("");
    assert!(validate_registry_record(&blank).is_err());
    let mut bad_kind = open_record("k1");
    bad_kind["panes"][0]["kind"] = json!("mystery");
    assert!(validate_registry_record(&bad_kind).is_err());
}

#[test]
fn agent_chat_pane_kind_migrates_to_fresh_agent() {
    // Happy path: legacy agent-chat pane with a canonical claude resume id
    // -> fresh-agent kind + rewritten payload (provider/sessionType/sessionRef).
    let uuid = "6b1b3c6e-8f2d-4c6a-9e0a-1234567890ab";
    let mut record = open_record("t1");
    record["panes"] = json!([{
        "paneId": "p1",
        "kind": "agent-chat",
        "payload": {
            "provider": "claude",
            "sessionId": "s-1",
            "resumeSessionId": uuid,
            "timelineSessionId": "stale",
            "style": "compact"
        }
    }]);
    normalize_registry_pane_kinds(&mut record);
    let pane = &record["panes"][0];
    assert_eq!(pane["kind"], "fresh-agent");
    let payload = &pane["payload"];
    assert_eq!(payload["provider"], "claude");
    assert_eq!(payload["sessionType"], "freshclaude");
    assert_eq!(payload["resumeSessionId"], uuid);
    assert_eq!(
        payload["sessionRef"],
        json!({ "provider": "claude", "sessionId": uuid })
    );
    assert_eq!(
        payload["style"], "compact",
        "non-legacy payload keys carried through"
    );
    assert_eq!(payload["sessionId"], "s-1");
    assert!(
        payload.get("timelineSessionId").is_none(),
        "legacy alias keys stripped"
    );
    assert!(payload.get("restoreError").is_none());
    assert!(
        payload.get("kind").is_none(),
        "kind lives on the pane, not the payload"
    );
    // Unusable legacy identity -> fresh-agent with restoreError, resume dropped.
    let mut dead = open_record("t2");
    dead["panes"] = json!([{
        "paneId": "p1",
        "kind": "agent-chat",
        "payload": { "provider": "claude", "resumeSessionId": "not-a-uuid" }
    }]);
    normalize_registry_pane_kinds(&mut dead);
    let payload = &dead["panes"][0]["payload"];
    assert_eq!(dead["panes"][0]["kind"], "fresh-agent");
    assert_eq!(
        payload["restoreError"],
        json!({ "code": "RESTORE_UNAVAILABLE", "reason": "invalid_legacy_restore_target" })
    );
    assert!(payload.get("resumeSessionId").is_none());
    assert!(payload.get("sessionRef").is_none());
    // Non-agent panes are untouched.
    let mut term = open_record("t3");
    let before = term.clone();
    normalize_registry_pane_kinds(&mut term);
    assert_eq!(term, before);
}

#[test]
fn divergent_order_map_keys_roundtrip_self_consistently_in_byte_order() {
    // The divergent-map-keys fixture from Step 1: mixed-case base64url
    // snapshot keys; tabKeys `<uuid>:--0MNzJnmn-oNjHjMXnPf` vs
    // `<uuid>:_fuUJwgE1XOONeyzvyZMk` (the real-store divergence class from
    // validator-A2). Cross-impl hash equality is deliberately NOT asserted
    // here (ledger A2-R1).
    let fx: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/node-tabs-registry-hash.json"
    ))
    .unwrap();
    let input = &fx["divergent"]["input"];
    let canon = canonical_stringify(input);
    // Sibling keys in BYTE order: '-' 0x2D < 'A-Z' < '_' 0x5F < 'a-z'.
    let uuid = "6b1b3c6e-8f2d-4c6a-9e0a-1234567890ab";
    let dashes = format!("{uuid}:--0MNzJnmn-oNjHjMXnPf");
    let underscore = format!("{uuid}:_fuUJwgE1XOONeyzvyZMk");
    assert!(
        canon.find(&dashes).unwrap() < canon.find(&underscore).unwrap(),
        "'-' (0x2D) must sort before '_' (0x5F): {canon}"
    );
    assert!(
        canon.find("ZGV2QQ:").unwrap() < canon.find("ZGV2qQ:").unwrap(),
        "'Q' (0x51) must sort before 'q' (0x71): {canon}"
    );
    // Re-parsing the canonical output and re-stringifying is a FIXED POINT
    // (Rust's self-consistent write/read roundtrip).
    let reparsed: Value = serde_json::from_str(&canon).unwrap();
    assert_eq!(canonical_stringify(&reparsed), canon);
    // Documented divergence: Node's ICU localeCompare ordered these keys
    // DIFFERENTLY (recorded in the fixture for documentation only).
    assert_ne!(canon, fx["divergent"]["nodeCanonical"].as_str().unwrap());
}

#[test]
fn adversarial_payload_keys_pin_rust_byte_order_canonical_output() {
    // Cross-impl hash compatibility is NOT claimed for such keys — Node's
    // ICU localeCompare orders them differently (known divergence class,
    // ledger A2-R1); this pins Rust's deterministic byte-order output only.
    let v = serde_json::json!({"Zebra": 1, "a-b": 1, "a_b": 1, "é": 1});
    assert_eq!(
        canonical_stringify(&v),
        "{\"Zebra\":1,\"a-b\":1,\"a_b\":1,\"é\":1}"
    );
}

#[test]
fn state_caps_reject_aggregate_byte_overflow() {
    let caps = TabsStoreCaps {
        max_compact_state_bytes: 64,
        ..default_caps()
    };
    let mut st = empty_state(0, 30);
    let mut snap = snapshot(1);
    snap.records = vec![open_record("t1")];
    st.open_snapshots_by_client.insert("k".into(), snap);
    assert!(validate_state_caps(&st, &caps).is_err());
    assert!(validate_state_caps(&empty_state(0, 30), &caps).is_ok());
}

#[test]
fn state_caps_reject_per_snapshot_open_record_overflow() {
    let caps = TabsStoreCaps {
        max_open_records_per_client_snapshot: 1,
        ..default_caps()
    };
    let mut st = empty_state(0, 30);
    let mut snap = snapshot(1);
    snap.records = vec![open_record("t1"), open_record("t2")];
    st.open_snapshots_by_client.insert("k".into(), snap);
    assert!(validate_state_caps(&st, &caps).is_err());
}

#[test]
fn maintenance_lru_slices_devices_and_watermarks_newest_first() {
    let caps = TabsStoreCaps {
        max_devices: 1,
        max_client_revision_watermarks: 1,
        ..default_caps()
    };
    let mut st = empty_state(0, 30);
    for (id, seen) in [("d-old", 10), ("d-new", 20)] {
        st.devices_by_id.insert(
            id.to_string(),
            RegistryDeviceEntry {
                device_id: id.to_string(),
                device_label: id.to_string(),
                last_seen_at: seen,
            },
        );
        st.client_revisions_by_client.insert(
            id.to_string(),
            ClientRevisionWatermark {
                device_id: id.to_string(),
                client_instance_id: "c".into(),
                snapshot_revision: 1,
                last_seen_at: seen,
            },
        );
    }
    apply_queued_maintenance(&mut st, 30, &caps);
    assert_eq!(st.devices_by_id.len(), 1);
    assert!(
        st.devices_by_id.contains_key("d-new"),
        "LRU keeps the newest"
    );
    assert_eq!(st.client_revisions_by_client.len(), 1);
    assert!(st.client_revisions_by_client.contains_key("d-new"));
    assert_eq!(st.saved_at, 30, "maintenance stamps savedAt = now");
}

#[test]
fn moved_ordering_helpers_match_store_ts_semantics() {
    // compareRegistryRecordsByEventTime (store.ts:345): updatedAt, then
    // revision, then closed-after-open, then sourceKey.
    let mut older = open_record("t");
    older["updatedAt"] = json!(100);
    let mut newer = open_record("t");
    newer["updatedAt"] = json!(200);
    assert_eq!(
        compare_by_event_time(&older, &newer),
        std::cmp::Ordering::Less
    );
    assert_eq!(pick_event_winner(&older, &newer)["updatedAt"], json!(200));
    assert_eq!(pick_event_winner(&newer, &older)["updatedAt"], json!(200));
    // Tie on updatedAt+revision: closed sorts AFTER open (wins).
    let mut closed = tombstone("t", 100);
    closed["updatedAt"] = json!(100);
    closed["revision"] = json!(1);
    assert_eq!(
        compare_by_event_time(&older, &closed),
        std::cmp::Ordering::Less
    );
}
