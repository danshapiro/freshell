use super::*;
use crate::tabs::TabsRegistry;
use serde_json::{json, Value};

fn open_record(tab_key: &str, tab_name: &str, updated_at: i64) -> Value {
    json!({ "tabKey": tab_key, "tabId": tab_key, "tabName": tab_name, "status": "open",
            "revision": updated_at, "updatedAt": updated_at, "paneCount": 0, "panes": [] })
}
fn codex_pane_record(tab_key: &str, session_id: &str, rev_updated: i64) -> Value {
    let mut rec = open_record(tab_key, "codex tab", rev_updated);
    rec["revision"] = json!(rev_updated);
    rec["panes"] = json!([{
        "paneId": "pane-1", "kind": "terminal",
        "payload": {
            "mode": "codex",
            "sessionRef": { "provider": "codex", "sessionId": session_id },
            "initialCwd": "/tmp/proj",
            "liveTerminal": { "terminalId": "term-1", "serverInstanceId": "srv-1" }
        }
    }]);
    rec
}
// Direct deterministic write (explicit captured_at + revision).
fn put(
    dir: &std::path::Path,
    device: &str,
    client: &str,
    rev: i64,
    captured: i64,
    recs: Vec<Value>,
) {
    persist_generation(dir, "srv-1", device, "Dev", client, rev, &recs, captured);
}
// Result-unwrapping helpers so the tests read cleanly (readers are fail-loud).
fn union(dir: &std::path::Path, device: &str) -> Option<Value> {
    read_device_union(dir, device).expect("read_device_union io")
}
fn gen_n(dir: &std::path::Path, device: &str, n: usize) -> Option<Value> {
    read_generation(dir, device, n).expect("read_generation io")
}
fn gen_by_id(dir: &std::path::Path, device: &str, id: &str) -> Option<Value> {
    read_generation_by_id(dir, device, id).expect("read_generation_by_id io")
}
fn devices(dir: &std::path::Path) -> Vec<String> {
    list_snapshot_devices(dir).expect("list_snapshot_devices io")
}

#[test]
fn persisted_generation_written_with_session_ref_preserved() {
    let dir = tempfile::tempdir().unwrap();
    let reg = TabsRegistry::with_persist_dir(dir.path().to_path_buf());
    reg.replace_client_snapshot(
        "srv-1",
        "dev a/1",
        "Device A",
        "client-a1",
        1,
        vec![codex_pane_record("dev-a:tab-1", "abc-123", 1000)],
    )
    .unwrap();
    let gens = list_generations(dir.path(), "dev a/1", "client-a1");
    assert_eq!(gens.len(), 1);
    let snap = union(dir.path(), "dev a/1").expect("newest generation");
    assert_eq!(snap["deviceId"], "dev a/1");
    assert_eq!(snap["snapshotRevision"], 1);
    assert_eq!(
        snap["records"][0]["panes"][0]["payload"]["sessionRef"]["sessionId"],
        "abc-123"
    );
    // list_snapshot_devices returns the RAW id, not the encoded folder name.
    assert_eq!(devices(dir.path()), vec!["dev a/1".to_string()]);
}

#[test]
fn encode_id_is_injective_containment_safe_escapes_hyphen_and_rejects_empty() {
    // No `.`, `/`, or `-` survives -> no traversal, no shared-dir collapse,
    // and `-` is reserved as the filename field delimiter.
    for raw in ["..", ".", "../../etc", "a/b", "a-b", "", "  "] {
        if let Some(enc) = encode_device_id(raw) {
            assert!(
                !enc.contains('.')
                    && !enc.contains('/')
                    && !enc.contains('\\')
                    && !enc.contains('-'),
                "{raw} -> {enc}"
            );
        }
    }
    assert_eq!(
        encode_device_id(""),
        None,
        "empty id is rejected (never persisted)"
    );
    assert_ne!(encode_device_id("dev a/1"), encode_device_id("dev_a_1"));
    assert_ne!(encode_device_id("a"), encode_device_id("a-b")); // hyphen collision pair maps apart
                                                                // Containment incl. a NESTED external traversal id: `../../escape/deep`
                                                                // resolves to a SINGLE direct child of <root> and writes nothing above it.
                                                                // (<root> is nested one level INSIDE the tempdir so its parent is a dir
                                                                // this test fully controls — scanning the raw tempdir parent would be
                                                                // /tmp itself, where unrelated processes' *.json files live and would
                                                                // make the stray-file assertion flaky.)
    let dir = tempfile::tempdir().unwrap();
    let nested_root = dir.path().join("snapshot-root");
    std::fs::create_dir(&nested_root).unwrap();
    let root = nested_root.as_path();
    let reg = TabsRegistry::with_persist_dir(root.to_path_buf());
    reg.replace_client_snapshot(
        "srv",
        "../../escape/deep",
        "x",
        "c1",
        1,
        vec![open_record("t:1", "t", 1)],
    )
    .unwrap();
    // The encoded dir is a DIRECT child of <root> (parent == root), so it
    // cannot escape; and <root> has exactly ONE device subdir.
    let device_dir = device_dir_for(root, "../../escape/deep").unwrap();
    assert_eq!(device_dir.parent(), Some(root));
    let subdirs: Vec<_> = std::fs::read_dir(root)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    assert_eq!(
        subdirs.len(),
        1,
        "traversal id must not fan out or escape: {subdirs:?}"
    );
    // Nothing landed directly in <root>'s parent as a stray *.json.
    let parent = root.parent().unwrap();
    let stray: Vec<_> = std::fs::read_dir(parent)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|x| x == "json"))
        .collect();
    assert!(
        stray.is_empty(),
        "traversal id wrote a stray json into the root's parent: {stray:?}"
    );
    assert_eq!(devices(root), vec!["../../escape/deep".to_string()]);
}

#[test]
fn client_hyphen_ownership_is_unambiguous() {
    // Real client-id shapes: `client-a` is a PREFIX substring of `client-a-b`.
    // With `-` escaped, list_generations/prune for one never selects the other.
    let dir = tempfile::tempdir().unwrap();
    put(
        dir.path(),
        "dev",
        "client-a",
        1,
        1000,
        vec![open_record("dev:t1", "a", 1)],
    );
    put(
        dir.path(),
        "dev",
        "client-a-b",
        1,
        1001,
        vec![open_record("dev:t2", "b", 1)],
    );
    assert_eq!(
        list_generations(dir.path(), "dev", "client-a").len(),
        1,
        "client-a must NOT match client-a-b's files"
    );
    assert_eq!(list_generations(dir.path(), "dev", "client-a-b").len(), 1);
}

#[test]
fn generations_pruned_per_client_padded_ordering() {
    // EQUAL capturedAt for every write so ONLY the zero-padded revision can
    // decide order -> this actually proves r9 < r10 (not timestamp order).
    let dir = tempfile::tempdir().unwrap();
    for rev in 1..=(MAX_SNAPSHOT_GENERATIONS as i64 + 7) {
        put(
            dir.path(),
            "dev",
            "c1",
            rev,
            5000,
            vec![open_record("dev:t1", "x", rev)],
        );
    }
    let gens = list_generations(dir.path(), "dev", "c1");
    assert_eq!(gens.len(), MAX_SNAPSHOT_GENERATIONS);
    assert_eq!(
        gen_n(dir.path(), "dev", 0).unwrap()["snapshotRevision"],
        MAX_SNAPSHOT_GENERATIONS as i64 + 7
    );
    let oldest = gen_n(dir.path(), "dev", MAX_SNAPSHOT_GENERATIONS - 1).unwrap();
    assert_eq!(
        oldest["snapshotRevision"],
        (MAX_SNAPSHOT_GENERATIONS as i64 + 7) - 4
    );
}

#[test]
fn union_newest_per_client_tiebreak_is_deterministic_on_equal_capturedat() {
    // Same client, two files at the SAME capturedAt, revisions 9 and 10 ->
    // the newest-per-client pick must be r10 (padded revision, then filename),
    // never arbitrary read_dir order.
    let dir = tempfile::tempdir().unwrap();
    put(
        dir.path(),
        "dev",
        "c1",
        9,
        7000,
        vec![codex_pane_record("dev:t", "sess-9", 9)],
    );
    put(
        dir.path(),
        "dev",
        "c1",
        10,
        7000,
        vec![codex_pane_record("dev:t", "sess-10", 10)],
    );
    let u = union(dir.path(), "dev").unwrap();
    assert_eq!(
        u["records"][0]["panes"][0]["payload"]["sessionRef"]["sessionId"],
        "sess-10"
    );
}

#[test]
fn content_id_is_key_order_independent_and_collision_distinct() {
    // `preserve_order` is enabled workspace-wide, so two records with the SAME
    // fields inserted in a DIFFERENT key order serialize to different bytes;
    // canonicalization must make them hash IDENTICALLY, and distinct content
    // must still hash apart (a real 256-bit digest, no accidental collisions).
    let a = json!({ "records": [ { "tabKey": "k", "revision": 1, "updatedAt": 2 } ] });
    let mut rec = serde_json::Map::new();
    rec.insert("updatedAt".into(), json!(2));
    rec.insert("revision".into(), json!(1));
    rec.insert("tabKey".into(), json!("k"));
    let b = json!({ "records": [ Value::Object(rec) ] });
    assert_eq!(
        snapshot_content_id(&a),
        snapshot_content_id(&b),
        "key insertion order must not change the content id"
    );
    assert_eq!(
        snapshot_content_id(&a).len(),
        32,
        "128-bit digest = 32 hex chars"
    );
    let c = json!({ "records": [ { "tabKey": "k", "revision": 1, "updatedAt": 3 } ] });
    assert_ne!(
        snapshot_content_id(&a),
        snapshot_content_id(&c),
        "distinct content hashes apart"
    );
}

#[test]
fn union_exact_tie_equal_rev_and_updatedat_resolves_deterministically() {
    // Same tabKey, EQUAL revision AND equal updatedAt AND equal capturedAt but
    // different owning client + different sessionRef -> the (revision,
    // updatedAt) rank ties; the winner is decided by the SOURCE
    // (clientInstanceId, generationId) and MUST be identical on every read and
    // identical between the union and overview paths (they share one routine).
    let dir = tempfile::tempdir().unwrap();
    put(
        dir.path(),
        "dev",
        "clientA",
        5,
        6000,
        vec![codex_pane_record("dev:shared", "sess-A", 5)],
    );
    put(
        dir.path(),
        "dev",
        "clientB",
        5,
        6000,
        vec![codex_pane_record("dev:shared", "sess-B", 5)],
    );
    let winner = union(dir.path(), "dev").unwrap()["records"][0]["panes"][0]["payload"]
        ["sessionRef"]["sessionId"]
        .clone();
    assert!(winner == "sess-A" || winner == "sess-B");
    for _ in 0..20 {
        assert_eq!(
            union(dir.path(), "dev").unwrap()["records"][0]["panes"][0]["payload"]["sessionRef"]
                ["sessionId"],
            winner,
            "exact-tie winner must be deterministic across reads"
        );
    }
    let (ov_union, _) = read_device_overview(dir.path(), "dev").unwrap().unwrap();
    assert_eq!(
        ov_union["records"][0]["panes"][0]["payload"]["sessionRef"]["sessionId"], winner,
        "overview and union paths must agree on the tie winner"
    );
}

#[test]
fn two_clients_same_device_equal_capturedat_union_keeps_both() {
    // FORCE equal capturedAt across the two clients.
    let dir = tempfile::tempdir().unwrap();
    put(
        dir.path(),
        "dev",
        "clientA",
        1,
        8000,
        vec![codex_pane_record("dev:tabA", "sess-A", 1)],
    );
    put(
        dir.path(),
        "dev",
        "clientB",
        1,
        8000,
        vec![codex_pane_record("dev:tabB", "sess-B", 1)],
    );
    assert_eq!(list_generations(dir.path(), "dev", "clientA").len(), 1);
    assert_eq!(list_generations(dir.path(), "dev", "clientB").len(), 1);
    let u = union(dir.path(), "dev").unwrap();
    let keys: Vec<String> = u["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["tabKey"].as_str().unwrap().to_string())
        .collect();
    assert!(
        keys.contains(&"dev:tabA".to_string()) && keys.contains(&"dev:tabB".to_string()),
        "union dropped a client's tabs: {keys:?}"
    );
}

#[test]
fn union_dedupes_shared_tabkey_keeping_highest_revision() {
    let dir = tempfile::tempdir().unwrap();
    put(
        dir.path(),
        "dev",
        "clientA",
        7,
        9000,
        vec![codex_pane_record("dev:shared", "sess-new", 7)],
    );
    put(
        dir.path(),
        "dev",
        "clientB",
        3,
        9000,
        vec![codex_pane_record("dev:shared", "sess-old", 3)],
    );
    let u = union(dir.path(), "dev").unwrap();
    let recs = u["records"].as_array().unwrap();
    assert_eq!(recs.len(), 1, "shared tabKey must dedupe");
    assert_eq!(
        recs[0]["panes"][0]["payload"]["sessionRef"]["sessionId"],
        "sess-new"
    );
}

#[test]
fn empty_snapshot_does_not_overwrite_last_good_generation() {
    let dir = tempfile::tempdir().unwrap();
    let reg = TabsRegistry::with_persist_dir(dir.path().to_path_buf());
    reg.replace_client_snapshot(
        "srv-1",
        "dev",
        "Dev",
        "c1",
        1,
        vec![open_record("dev:t1", "good", 1000)],
    )
    .unwrap();
    reg.replace_client_snapshot("srv-1", "dev", "Dev", "c1", 2, vec![])
        .unwrap();
    assert_eq!(list_generations(dir.path(), "dev", "c1").len(), 1);
    assert_eq!(gen_n(dir.path(), "dev", 0).unwrap()["snapshotRevision"], 1);
}

#[test]
fn stale_revision_persists_nothing_and_no_dir_persists_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let reg = TabsRegistry::with_persist_dir(dir.path().to_path_buf());
    reg.replace_client_snapshot(
        "srv-1",
        "dev",
        "Dev",
        "c1",
        5,
        vec![open_record("dev:t1", "one", 10)],
    )
    .unwrap();
    assert!(reg
        .replace_client_snapshot("srv-1", "dev", "Dev", "c1", 4, vec![])
        .is_err());
    assert_eq!(list_generations(dir.path(), "dev", "c1").len(), 1);
    let plain = TabsRegistry::new(); // no persist dir -> Option path is a no-op
    plain
        .replace_client_snapshot(
            "srv-1",
            "dev",
            "Dev",
            "c1",
            1,
            vec![open_record("dev:t1", "one", 10)],
        )
        .unwrap();
}

#[test]
fn device_cap_evicts_least_recently_written_device() {
    // Explicit ascending capturedAt -> the victim is deterministically dev-000.
    let dir = tempfile::tempdir().unwrap();
    for n in 0..=(MAX_SNAPSHOT_DEVICES) {
        let dev = format!("dev-{n:03}");
        put(
            dir.path(),
            &dev,
            "c1",
            1,
            1000 + n as i64,
            vec![open_record(&format!("{dev}:t"), "t", 1)],
        );
    }
    assert_eq!(devices(dir.path()).len(), MAX_SNAPSHOT_DEVICES);
    assert!(union(dir.path(), "dev-000").is_none());
    assert!(union(dir.path(), &format!("dev-{:03}", MAX_SNAPSHOT_DEVICES)).is_some());
}

#[test]
fn global_per_device_cap_holds_across_rotating_client_ids() {
    // THE CRITICAL BOUND: a single device cycling many per-window client ids
    // must never accumulate more than MAX_SNAPSHOT_FILES_PER_DEVICE files.
    let dir = tempfile::tempdir().unwrap();
    for n in 0..(MAX_SNAPSHOT_FILES_PER_DEVICE * 3) {
        let client = format!("client-{n}"); // rotates every write, like a new window
        put(
            dir.path(),
            "dev",
            &client,
            1,
            1000 + n as i64,
            vec![open_record("dev:t", "t", 1)],
        );
    }
    let enc = encode_device_id("dev").unwrap();
    let count = std::fs::read_dir(dir.path().join(enc))
        .unwrap()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .count();
    assert!(
        count <= MAX_SNAPSHOT_FILES_PER_DEVICE,
        "global-per-device file cap breached: {count} > {MAX_SNAPSHOT_FILES_PER_DEVICE}"
    );
}

#[test]
fn content_id_is_stable_and_selects_the_right_generation() {
    let dir = tempfile::tempdir().unwrap();
    put(
        dir.path(),
        "dev",
        "c1",
        1,
        1000,
        vec![codex_pane_record("dev:t", "sess-old", 1)],
    );
    put(
        dir.path(),
        "dev",
        "c1",
        2,
        2000,
        vec![codex_pane_record("dev:t", "sess-new", 2)],
    );
    let old = gen_n(dir.path(), "dev", 1).unwrap();
    let id = snapshot_content_id(&old);
    // Stable: recomputing over the re-read file yields the same id.
    assert_eq!(
        id,
        snapshot_content_id(&gen_n(dir.path(), "dev", 1).unwrap())
    );
    // Selecting by id returns the OLD generation regardless of index shifts.
    let by_id = gen_by_id(dir.path(), "dev", &id).unwrap();
    assert_eq!(
        by_id["records"][0]["panes"][0]["payload"]["sessionRef"]["sessionId"],
        "sess-old"
    );
}

#[test]
fn oversize_snapshot_is_skipped_not_written() {
    let dir = tempfile::tempdir().unwrap();
    // Seed a good generation, then an oversize push must NOT overwrite/delete it.
    put(
        dir.path(),
        "dev",
        "c1",
        1,
        1000,
        vec![open_record("dev:t1", "good", 1)],
    );
    let big = "x".repeat(MAX_SNAPSHOT_BYTES + 10);
    let mut rec = open_record("dev:t1", "big", 2);
    rec["blob"] = json!(big);
    put(dir.path(), "dev", "c1", 2, 2000, vec![rec]);
    assert_eq!(
        list_generations(dir.path(), "dev", "c1").len(),
        1,
        "oversize generation must be skipped (WARN); last-good stays intact"
    );
    assert_eq!(gen_n(dir.path(), "dev", 0).unwrap()["snapshotRevision"], 1);
}

#[test]
fn concurrent_pushes_same_and_different_devices_stay_consistent() {
    // CONCURRENCY (`:678`): threads persist to the SAME device (distinct
    // clients) AND to DIFFERENT devices at once. The process-wide persist lock
    // must serialize the whole filesystem cycle so no read_dir/eviction race
    // corrupts state: every device stays readable and within its caps, and no
    // orphaned `.tmp` survives.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let mut handles = Vec::new();
    for n in 0..24usize {
        let root = root.clone();
        handles.push(std::thread::spawn(move || {
            let device = if n % 2 == 0 {
                "shared-dev".to_string()
            } else {
                format!("dev-{n}")
            };
            let client = format!("client-{n}");
            for rev in 1..=6i64 {
                persist_generation(
                    &root,
                    "srv",
                    &device,
                    "D",
                    &client,
                    rev,
                    &[open_record(&format!("{device}:t{n}"), "t", rev)],
                    1000 + rev,
                );
            }
        }));
    }
    for h in handles {
        h.join().unwrap();
    }
    let enc = encode_device_id("shared-dev").unwrap();
    let device_dir = root.join(&enc);
    let json_count = std::fs::read_dir(&device_dir)
        .unwrap()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .count();
    assert!(
        json_count <= MAX_SNAPSHOT_FILES_PER_DEVICE,
        "global-per-device cap breached under concurrency: {json_count}"
    );
    assert!(
        union(&root, "shared-dev").is_some(),
        "shared device union unreadable after concurrent writes"
    );
    let tmp_count = std::fs::read_dir(&device_dir)
        .unwrap()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "tmp"))
        .count();
    assert_eq!(tmp_count, 0, "orphaned .tmp left after concurrent writes");
}

#[test]
fn orphan_tmp_is_reaped_before_cap_math() {
    // FAILURE INJECTION (`:678`): a crashed write left a `.tmp`. The next
    // persist reaps it (it never lingers outside the caps), and reading the
    // device still returns the newest good generation.
    let dir = tempfile::tempdir().unwrap();
    put(
        dir.path(),
        "dev",
        "c1",
        1,
        1000,
        vec![open_record("dev:t", "t", 1)],
    );
    let enc = encode_device_id("dev").unwrap();
    let device_dir = dir.path().join(&enc);
    std::fs::write(device_dir.join(".c1-orphan.tmp"), b"partial write").unwrap();
    put(
        dir.path(),
        "dev",
        "c1",
        2,
        2000,
        vec![open_record("dev:t", "t", 2)],
    );
    let tmp = std::fs::read_dir(&device_dir)
        .unwrap()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "tmp"))
        .count();
    assert_eq!(tmp, 0, "orphan .tmp must be reaped before cap math");
    assert_eq!(gen_n(dir.path(), "dev", 0).unwrap()["snapshotRevision"], 2);
}

#[test]
fn restore_marker_in_flight_temp_survives_the_sweep_while_stray_tmp_is_reaped() {
    // CROSS-CRATE INVARIANT: freshell-server's restore handler writes its
    // write-ahead marker atomically via an in-flight temp file in this SAME
    // device dir (`tabs_snapshots.rs::write_marker`), WITHOUT holding
    // PERSIST_LOCK (it is ws-crate-internal). Restore provokes concurrent
    // pushes (each tab.create broadcast triggers a client tabs-sync push ->
    // persist_generation -> sweep), so the sweep must NEVER reap the marker's
    // in-flight temp: doing so between the marker's write and rename can leave
    // an `in-progress` marker with no terminalId, and a rerun would duplicate
    // the live terminal. The marker temp is therefore named `*.new` (NOT
    // `*.tmp`) precisely so this sweep cannot see it.
    let dir = tempfile::tempdir().unwrap();
    put(
        dir.path(),
        "dev",
        "c1",
        1,
        1000,
        vec![open_record("dev:t", "t", 1)],
    );
    let enc = encode_device_id("dev").unwrap();
    let device_dir = dir.path().join(&enc);
    // The marker's in-flight temp filename (see tabs_snapshots.rs
    // RESTORE_MARKER_TMP) -- must survive.
    let marker_tmp = device_dir.join(".last-restore.marker.new");
    std::fs::write(&marker_tmp, b"{\"sourceId\":\"gen-1\"}").unwrap();
    // A stray crashed-write generation temp -- must still be reaped.
    std::fs::write(device_dir.join(".c1-orphan.tmp"), b"partial write").unwrap();
    put(
        dir.path(),
        "dev",
        "c1",
        2,
        2000,
        vec![open_record("dev:t", "t", 2)],
    );
    assert!(
        marker_tmp.exists(),
        "the restore marker's in-flight temp file must be invisible to the sweep"
    );
    assert!(
        !device_dir.join(".c1-orphan.tmp").exists(),
        "a stray generation .tmp must still be reaped"
    );
}

#[test]
fn union_by_ids_restores_the_multi_client_bundle_not_a_single_client() {
    // Two clients, each newest generation is one bundle COMPONENT. The
    // union-by-ids of BOTH ids yields BOTH clients' tabs (:2621); a single
    // component id yields only that client's tab.
    let dir = tempfile::tempdir().unwrap();
    put(
        dir.path(),
        "dev",
        "clientA",
        1,
        1000,
        vec![codex_pane_record("dev:tabA", "sess-A", 1)],
    );
    put(
        dir.path(),
        "dev",
        "clientB",
        1,
        1001,
        vec![codex_pane_record("dev:tabB", "sess-B", 1)],
    );
    let a_id = snapshot_content_id(&gen_by_id_scan(dir.path(), "dev", "clientA"));
    let b_id = snapshot_content_id(&gen_by_id_scan(dir.path(), "dev", "clientB"));
    let both = read_generations_union_by_ids(dir.path(), "dev", &[a_id.clone(), b_id.clone()])
        .unwrap()
        .unwrap();
    let keys: Vec<String> = both["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["tabKey"].as_str().unwrap().to_string())
        .collect();
    assert!(
        keys.contains(&"dev:tabA".to_string()) && keys.contains(&"dev:tabB".to_string()),
        "bundle must union ALL components: {keys:?}"
    );
    let only_a = read_generations_union_by_ids(dir.path(), "dev", &[a_id])
        .unwrap()
        .unwrap();
    assert_eq!(
        only_a["records"].as_array().unwrap().len(),
        1,
        "single component = one client only"
    );
    assert!(
        read_generations_union_by_ids(dir.path(), "dev", &["nope".to_string()])
            .unwrap()
            .is_none()
    );
}
// Helper: the parsed generation owned by a given client (there is one each here).
fn gen_by_id_scan(dir: &std::path::Path, device: &str, client: &str) -> Value {
    let path = list_generations(dir, device, client)
        .into_iter()
        .next()
        .unwrap();
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn corrupt_generation_file_reads_as_error_not_absence() {
    // FAIL-LOUD (`:480`): a present-but-unparseable generation is an ERROR,
    // never silently treated as "no backup". A device with NO dir is genuine
    // absence (Ok(None)).
    let dir = tempfile::tempdir().unwrap();
    put(
        dir.path(),
        "dev",
        "c1",
        1,
        1000,
        vec![open_record("dev:t", "t", 1)],
    );
    let enc = encode_device_id("dev").unwrap();
    let file = std::fs::read_dir(dir.path().join(&enc))
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .find(|p| p.extension().is_some_and(|x| x == "json"))
        .unwrap();
    std::fs::write(&file, b"{ not valid json").unwrap();
    assert!(
        read_device_union(dir.path(), "dev").is_err(),
        "corrupt file -> Err, not Ok(None)"
    );
    assert!(read_generation(dir.path(), "dev", 0).is_err());
    assert!(list_snapshot_devices(dir.path()).is_err());
    assert!(
        read_device_union(dir.path(), "ghost").unwrap().is_none(),
        "absent device is Ok(None)"
    );
}
