//! Restore-hardening tests (cross-model review delta r1): marker ledger
//! idempotency across source switches, fail-loud marker reads, fail-closed
//! body selectors, loud missing-component bundles, full pane-state
//! round-trips, the write-ahead crash window, invocation-unique delivery-ack
//! ids, and the targeted `panes` filter. Nested `#[path]`-included child of
//! `tabs_snapshots_tests.rs` so both files stay under the repo's
//! 1,000-line-per-file limit; helpers (`rig`/`connected`/`post`/`rec`/...)
//! come from the parent test module.

use super::*;

/// Drain every frame currently buffered on a broadcast receiver.
fn drain(rx: &mut tokio::sync::broadcast::Receiver<String>) -> Vec<Value> {
    let mut out = Vec::new();
    while let Ok(frame) = rx.try_recv() {
        if let Ok(v) = serde_json::from_str::<Value>(&frame) {
            out.push(v);
        }
    }
    out
}
fn tab_creates(frames: &[Value]) -> Vec<Value> {
    frames
        .iter()
        .filter(|v| v["type"] == "ui.command" && v["command"] == "tab.create")
        .map(|v| v["payload"].clone())
        .collect()
}
fn ack_request_ids(frames: &[Value]) -> Vec<String> {
    frames
        .iter()
        .filter(|v| v["type"] == "ui.command" && v["command"] == "screenshot.capture")
        .filter_map(|v| v["payload"]["requestId"].as_str().map(str::to_string))
        .collect()
}
fn device_dir(dir: &std::path::Path, device: &str) -> std::path::PathBuf {
    dir.join(freshell_ws::tabs_persist::encode_device_id(device).unwrap())
}
fn union_source_id(dir: &std::path::Path, device: &str) -> String {
    let snap = freshell_ws::tabs_persist::read_device_union(dir, device)
        .unwrap()
        .expect("seeded union");
    freshell_ws::tabs_persist::snapshot_content_id(&snap)
}
fn gen_id(dir: &std::path::Path, device: &str, n: usize) -> String {
    let snap = freshell_ws::tabs_persist::read_generation(dir, device, n)
        .unwrap()
        .expect("generation present");
    freshell_ws::tabs_persist::snapshot_content_id(&snap)
}

#[tokio::test]
async fn restore_history_survives_source_switch_a_b_a() {
    // MARKER LEDGER (`:304`): restore A, then B, then A again — A's panes must
    // be skipped `already-restored`, never duplicated, even though B was
    // restored in between (a single last-source marker would have wiped A).
    let dir = tempfile::tempdir().unwrap();
    seed_records(
        dir.path(),
        "dev-1",
        "c1",
        1,
        vec![rec(
            "tA",
            "terminal",
            json!({ "mode": "shell", "initialCwd": "/tmp" }),
        )],
    );
    let id_a = gen_id(dir.path(), "dev-1", 0);
    seed_records(
        dir.path(),
        "dev-1",
        "c1",
        2,
        vec![rec(
            "tB",
            "terminal",
            json!({ "mode": "shell", "initialCwd": "/tmp" }),
        )],
    );
    let id_b = gen_id(dir.path(), "dev-1", 0);
    assert_ne!(id_a, id_b);
    let (r, _on, _h) = connected(dir.path());
    let go = |gid: String, r: &Rig| {
        let router = router(r.state.clone());
        async move {
            post(
                router,
                "/api/tabs-sync/restore",
                json!({ "deviceId": "dev-1", "generationId": gid }),
                true,
            )
            .await
            .1
        }
    };
    let first_a = go(id_a.clone(), &r).await;
    assert_eq!(
        first_a["restored"].as_array().unwrap().len(),
        1,
        "{first_a}"
    );
    let first_b = go(id_b.clone(), &r).await;
    assert_eq!(
        first_b["restored"].as_array().unwrap().len(),
        1,
        "{first_b}"
    );
    // A again: NOTHING recreated (its history survived B's restore).
    let second_a = go(id_a.clone(), &r).await;
    assert_eq!(
        second_a["restored"].as_array().unwrap().len(),
        0,
        "A's panes must not be duplicated after restoring B: {second_a}"
    );
    assert_eq!(second_a["skipped"][0]["reason"], "already-restored");
}

#[tokio::test]
async fn corrupt_marker_fails_loud_409_and_force_overrides() {
    // FAIL-LOUD MARKER READS (`:306`): a present-but-unparsable marker is a
    // 409 telling the operator how to proceed — never "nothing restored yet".
    let dir = tempfile::tempdir().unwrap();
    seed_records(
        dir.path(),
        "dev-1",
        "c1",
        1,
        vec![rec(
            "t1",
            "terminal",
            json!({ "mode": "shell", "initialCwd": "/tmp" }),
        )],
    );
    let dd = device_dir(dir.path(), "dev-1");
    std::fs::write(dd.join(RESTORE_MARKER), b"{ not json").unwrap();
    let (r, _on, _h) = connected(dir.path());
    let (status, body) = post(
        router(r.state.clone()),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1" }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["markerError"], true);
    assert!(
        body["error"].as_str().unwrap().contains("force"),
        "must tell the operator how to proceed: {body}"
    );
    // force:true is the explicit override: discard the unreadable ledger.
    let (status, body) = post(
        router(r.state.clone()),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1", "force": true }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["restored"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn unreadable_marker_fails_loud_409() {
    // An UNREADABLE (not merely corrupt) marker — here the path is a
    // directory, so read fails with EISDIR — must also refuse loudly.
    let dir = tempfile::tempdir().unwrap();
    seed_records(
        dir.path(),
        "dev-1",
        "c1",
        1,
        vec![rec(
            "t1",
            "terminal",
            json!({ "mode": "shell", "initialCwd": "/tmp" }),
        )],
    );
    std::fs::create_dir(device_dir(dir.path(), "dev-1").join(RESTORE_MARKER)).unwrap();
    let (r, _on, _h) = connected(dir.path());
    let (status, body) = post(
        router(r.state.clone()),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1" }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["markerError"], true);
}

#[tokio::test]
async fn restore_rejects_malformed_body_selectors_with_400_never_broader_union() {
    // FAIL-CLOSED BODY SELECTORS (`:459`): every malformed shape is a 400 —
    // never a silent fall-through to the broader coherent union. dryRun keeps
    // the client gate out of the way (parsing runs regardless).
    let dir = tempfile::tempdir().unwrap();
    seed_records(
        dir.path(),
        "dev-1",
        "c1",
        1,
        vec![rec(
            "t1",
            "terminal",
            json!({ "mode": "shell", "initialCwd": "/tmp" }),
        )],
    );
    for bad in [
        json!({ "deviceId": "dev-1", "dryRun": true, "generation": -1 }),
        json!({ "deviceId": "dev-1", "dryRun": true, "generation": "3" }), // wrong type
        json!({ "deviceId": "dev-1", "dryRun": true, "generation": 1.5 }),
        json!({ "deviceId": "dev-1", "dryRun": true, "generation": true }),
        json!({ "deviceId": "dev-1", "dryRun": true, "generationId": 5 }), // wrong type
        json!({ "deviceId": "dev-1", "dryRun": true, "generationId": "" }),
        json!({ "deviceId": "dev-1", "dryRun": true, "components": "abc" }), // non-array
        json!({ "deviceId": "dev-1", "dryRun": true, "components": [1] }),   // non-string entry
        json!({ "deviceId": "dev-1", "dryRun": true, "components": [""] }),
        json!({ "deviceId": "dev-1", "dryRun": true, "components": [] }),
        json!({ "deviceId": "dev-1", "dryRun": true, "components": ["a"], "generationId": "b" }),
        json!({ "deviceId": "dev-1", "dryRun": true, "panes": "x" }), // non-array
        json!({ "deviceId": "dev-1", "dryRun": true, "panes": [1] }),
        json!({ "deviceId": "dev-1", "dryRun": true, "panes": [] }),
    ] {
        let (status, body) = post(
            router(test_state(dir.path())),
            "/api/tabs-sync/restore",
            bad.clone(),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "must 400: {bad} -> {body}");
    }
}

#[tokio::test]
async fn restore_components_fails_loud_when_any_component_is_pruned() {
    // MISSING COMPONENT BUNDLES (`tabs_persist.rs:232`): one present + one
    // pruned component must refuse loudly NAMING the missing id — a partial
    // union restored with `failed=0` would silently convert an incomplete
    // recovery into success.
    let dir = tempfile::tempdir().unwrap();
    seed_records(
        dir.path(),
        "dev-1",
        "c1",
        1,
        vec![rec(
            "t1",
            "terminal",
            json!({ "mode": "shell", "initialCwd": "/tmp" }),
        )],
    );
    let present = gen_id(dir.path(), "dev-1", 0);
    let pruned = "deadbeefdeadbeefdeadbeefdeadbeef".to_string();
    let (status, body) = post(
        router(test_state(dir.path())),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1", "dryRun": true,
                "components": [present, pruned] }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(
        body["missingComponents"],
        json!(["deadbeefdeadbeefdeadbeefdeadbeef"])
    );
    assert!(body["error"]
        .as_str()
        .unwrap()
        .contains("deadbeefdeadbeefdeadbeefdeadbeef"));
}

#[test]
fn create_body_carries_full_terminal_state_including_codex_durability() {
    // `:245` unit slice: the codex pane's captured shell + codexDurability
    // flow into the create body (the codex CLI itself can't spawn in tests,
    // so the freshagent leg for codexDurability is proven at body level here
    // and end-to-end for shell/browser/editor below).
    let pane = json!({ "paneId": "p1", "kind": "terminal", "payload": {
        "mode": "codex", "shell": "wsl", "initialCwd": "/tmp",
        "codexDurability": { "schemaVersion": 1, "state": "durable" },
        "sessionRef": { "provider": "codex", "sessionId": "s-1" }
    }});
    let body = pane_to_create_body(None, &pane).unwrap();
    assert_eq!(body["shell"], "wsl");
    assert_eq!(body["codexDurability"]["state"], "durable");
    assert_eq!(body["sessionRef"]["sessionId"], "s-1");
}

#[tokio::test]
async fn restore_round_trips_non_default_pane_state_to_the_client() {
    // FULL PANE STATE (`:245`): NON-default captured values must reach the
    // frozen client's `tab.create` paneContent — terminal `shell`, browser
    // `devToolsOpen`, editor `language`/`readOnly`/`viewMode`/`wordWrap`.
    let dir = tempfile::tempdir().unwrap();
    seed_records(
        dir.path(),
        "dev-1",
        "c1",
        1,
        vec![
            rec(
                "t1",
                "terminal",
                json!({ "mode": "shell", "shell": "wsl", "initialCwd": "/tmp" }),
            ),
            rec(
                "t2",
                "browser",
                json!({ "url": "https://example.com", "devToolsOpen": true }),
            ),
            rec(
                "t3",
                "editor",
                json!({ "filePath": "/tmp/x.md", "language": "markdown",
                        "readOnly": true, "viewMode": "rendered", "wordWrap": false }),
            ),
        ],
    );
    let (r, _on, _h) = connected(dir.path());
    let mut rx = r.bus.subscribe();
    let body = post(
        router(r.state.clone()),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1" }),
        true,
    )
    .await
    .1;
    assert_eq!(body["restored"].as_array().unwrap().len(), 3, "{body}");
    let creates = tab_creates(&drain(&mut rx));
    let by_kind = |k: &str| {
        creates
            .iter()
            .find(|p| p["paneContent"]["kind"] == k)
            .unwrap_or_else(|| panic!("no {k} tab.create broadcast"))
            .clone()
    };
    assert_eq!(by_kind("terminal")["paneContent"]["shell"], "wsl");
    assert_eq!(by_kind("browser")["paneContent"]["devToolsOpen"], true);
    let ed = by_kind("editor");
    assert_eq!(ed["paneContent"]["language"], "markdown");
    assert_eq!(ed["paneContent"]["readOnly"], true);
    assert_eq!(ed["paneContent"]["viewMode"], "rendered");
    assert_eq!(ed["paneContent"]["wordWrap"], false);
}

#[tokio::test]
async fn crash_window_terminal_reconciles_via_restore_key_ledger() {
    // CRASH WINDOW (`:632`), terminal leg: the create succeeded but NEITHER
    // marker write after it landed (in-progress entry with NO terminalId on
    // disk). The create was tagged with the deterministic restoreKey, so a
    // same-process retry finds the live terminal in the fresh-agent ledger
    // and RECONCILES it instead of spawning a duplicate.
    let dir = tempfile::tempdir().unwrap();
    seed_records(
        dir.path(),
        "dev-1",
        "c1",
        1,
        vec![rec(
            "t1",
            "terminal",
            json!({ "mode": "shell", "initialCwd": "/tmp" }),
        )],
    );
    let (r, _on, _h) = connected(dir.path());
    let source_id = union_source_id(dir.path(), "dev-1");
    let pk = pane_key("dev-1:t1", "p-t1");
    let key = restore_key_for("dev-1", &source_id, &pk);
    // Simulate the crash-window state: the create ran (tagged with the key)...
    let resp = freshell_freshagent::terminal_tabs::create_terminal_or_content_tab(
        r.state.fresh_agent.clone(),
        json!({ "mode": "shell", "cwd": "/tmp", "restoreKey": key }),
    )
    .await;
    let rbytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let created: Value = serde_json::from_slice(&rbytes).unwrap();
    let tid = created["data"]["terminalId"].as_str().unwrap().to_string();
    assert!(r.terminals.is_running(&tid));
    // ...but the on-disk marker never got past the write-ahead entry.
    let mut doc = MarkerDoc::new();
    let mut panes = Marker::new();
    panes.insert(
        pk.clone(),
        PaneMark {
            state: "in-progress".into(),
            terminal_id: None,
        },
    );
    doc.insert(source_id.clone(), (0, panes));
    write_marker_doc(&device_dir(dir.path(), "dev-1"), &doc).unwrap();
    // Retry: reconciled to the SAME terminal — no duplicate create.
    let body = post(
        router(r.state.clone()),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1" }),
        true,
    )
    .await
    .1;
    let rec0 = &body["restored"][0];
    assert_eq!(rec0["reconciled"], true, "{body}");
    assert_eq!(rec0["terminalId"], tid.as_str(), "no duplicate: {body}");
    assert_eq!(body["failed"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn crash_window_content_pane_fails_needs_operator_not_silent_recreate() {
    // CRASH WINDOW (`:632`), non-terminal leg: browser/editor creates return
    // no terminal id and the client persists tabs locally, so an in-progress
    // entry with no ledger record (process restarted) is UNRECONCILABLE — it
    // must FAIL for the operator, never silently recreate. force recreates.
    let dir = tempfile::tempdir().unwrap();
    seed_records(
        dir.path(),
        "dev-1",
        "c1",
        1,
        vec![rec(
            "t2",
            "browser",
            json!({ "url": "https://example.com" }),
        )],
    );
    let source_id = union_source_id(dir.path(), "dev-1");
    let pk = pane_key("dev-1:t2", "p-t2");
    let mut doc = MarkerDoc::new();
    let mut panes = Marker::new();
    panes.insert(
        pk.clone(),
        PaneMark {
            state: "in-progress".into(),
            terminal_id: None,
        },
    );
    doc.insert(source_id.clone(), (0, panes));
    write_marker_doc(&device_dir(dir.path(), "dev-1"), &doc).unwrap();
    // Fresh rig == fresh process (empty restore-key ledger).
    let (r, _on, _h) = connected(dir.path());
    let mut rx = r.bus.subscribe();
    let body = post(
        router(r.state.clone()),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1" }),
        true,
    )
    .await
    .1;
    assert_eq!(body["restored"].as_array().unwrap().len(), 0, "{body}");
    assert_eq!(body["failed"][0]["reason"], "in-progress-unconfirmed");
    assert!(
        body["failed"][0]["hint"]
            .as_str()
            .unwrap()
            .contains("force"),
        "hint must tell the operator how to proceed: {body}"
    );
    assert!(
        tab_creates(&drain(&mut rx)).is_empty(),
        "nothing may be broadcast for an unconfirmed non-terminal pane"
    );
    // force is the explicit operator override: recreate.
    let forced = post(
        router(r.state.clone()),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1", "force": true }),
        true,
    )
    .await
    .1;
    assert_eq!(forced["restored"].as_array().unwrap().len(), 1, "{forced}");
}

#[tokio::test]
async fn delivery_ack_request_ids_are_invocation_unique() {
    // ACK NONCE (`:403`): two restore attempts over the SAME pane must use
    // DIFFERENT ack request ids, so a stale reply from a timed-out attempt
    // can never resolve a later attempt's registration (the broker resolves
    // by exact id).
    let dir = tempfile::tempdir().unwrap();
    seed_records(
        dir.path(),
        "dev-1",
        "c1",
        1,
        vec![rec(
            "t1",
            "terminal",
            json!({ "mode": "shell", "initialCwd": "/tmp" }),
        )],
    );
    let (r, _on, _h) = connected(dir.path());
    let pk = pane_key("dev-1:t1", "p-t1");
    let mut rx = r.bus.subscribe();
    let _ = post(
        router(r.state.clone()),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1" }),
        true,
    )
    .await;
    let ids1 = ack_request_ids(&drain(&mut rx));
    // force re-acks the (live, already-restored) pane on a SECOND attempt.
    let _ = post(
        router(r.state.clone()),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1", "force": true }),
        true,
    )
    .await;
    let ids2 = ack_request_ids(&drain(&mut rx));
    assert_eq!(ids1.len(), 1, "{ids1:?}");
    assert_eq!(ids2.len(), 1, "{ids2:?}");
    for id in ids1.iter().chain(ids2.iter()) {
        assert!(id.starts_with("restore-ack:"), "{id}");
        assert!(id.ends_with(&pk), "id embeds the paneKey: {id}");
    }
    assert_ne!(
        ids1[0], ids2[0],
        "attempts must not share an ack request id"
    );
}

#[tokio::test]
async fn restore_panes_filter_restores_only_requested_and_rejects_unknown() {
    // TARGETED REMEDIATION (`deploy-tab-diff.sh:175`, server leg): `panes`
    // restores ONLY the named panes (everything else reported skipped
    // `not-selected`), and an unknown pane key is a fail-closed 400 naming it
    // BEFORE any side effect.
    let dir = tempfile::tempdir().unwrap();
    seed_records(
        dir.path(),
        "dev-1",
        "c1",
        1,
        vec![
            rec(
                "t1",
                "terminal",
                json!({ "mode": "shell", "initialCwd": "/tmp" }),
            ),
            rec("t2", "browser", json!({ "url": "https://example.com" })),
        ],
    );
    let (r, _on, _h) = connected(dir.path());
    let browser_pk = pane_key("dev-1:t2", "p-t2");
    let body = post(
        router(r.state.clone()),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1", "panes": [browser_pk] }),
        true,
    )
    .await
    .1;
    let restored = body["restored"].as_array().unwrap();
    assert_eq!(restored.len(), 1, "{body}");
    assert_eq!(restored[0]["kind"], "browser");
    assert!(
        body["skipped"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["reason"] == "not-selected" && s["tabKey"] == "dev-1:t1"),
        "unselected panes are reported, never silently dropped: {body}"
    );
    // Unknown pane key -> 400 naming it (fail-closed, nothing created).
    let (status, err) = post(
        router(r.state.clone()),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1", "panes": ["dev-1:ghost#p-ghost"] }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{err}");
    assert_eq!(err["unknownPanes"], json!(["dev-1:ghost#p-ghost"]));
}
