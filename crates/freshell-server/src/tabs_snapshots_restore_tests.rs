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
    freshell_ws::tabs_persist::snapshot_generation_id(&snap)
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

#[test]
fn semantically_corrupt_marker_documents_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let dd = device_dir(dir.path(), "dev-1");
    std::fs::create_dir_all(&dd).unwrap();
    for bad in [
        json!({ "version": 99, "sources": {} }),
        json!({ "version": 2, "sources": { "source": {} } }),
        json!({ "version": 2, "sources": { "source": { "at": 1 } } }),
        json!({ "version": 2, "sources": { "source": { "panes": {} } } }),
        json!({ "version": 2, "sources": { "source": {
            "at": 1, "panes": { "tab#pane": { "state": "garbage", "terminalId": null } }
        } } }),
    ] {
        std::fs::write(
            dd.join(RESTORE_MARKER),
            serde_json::to_vec_pretty(&bad).unwrap(),
        )
        .unwrap();
        assert!(
            read_marker_doc(&dd).is_err(),
            "semantically corrupt marker was accepted: {bad}"
        );
    }
}

#[test]
fn marker_ledger_retention_bounds_sources_and_keeps_the_newest() {
    let dir = tempfile::tempdir().unwrap();
    let dd = device_dir(dir.path(), "dev-1");
    let mut doc = MarkerDoc::new();
    for n in 0..(MAX_RESTORE_MARKER_SOURCES + 7) {
        let mut panes = Marker::new();
        panes.insert(
            format!("tab-{n}#pane"),
            PaneMark {
                state: "restored".into(),
                terminal_id: Some(format!("terminal-{n}")),
            },
        );
        doc.insert(format!("source-{n:03}"), (n as i64, panes));
    }
    write_marker_doc(&dd, &doc).unwrap();
    let retained = read_marker_doc(&dd).unwrap();
    assert_eq!(retained.len(), MAX_RESTORE_MARKER_SOURCES);
    assert!(retained.contains_key(&format!("source-{:03}", MAX_RESTORE_MARKER_SOURCES + 6)));
    assert!(!retained.contains_key("source-000"));

    // The source currently being updated remains even when it is older than
    // every other entry; pruning may evict the next-oldest source instead.
    let mut with_active = doc;
    prune_marker_doc(&mut with_active, Some("source-000"));
    assert_eq!(with_active.len(), MAX_RESTORE_MARKER_SOURCES);
    assert!(with_active.contains_key("source-000"));
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
                        "readOnly": true, "viewMode": "preview", "wordWrap": false }),
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
    assert_eq!(ed["paneContent"]["viewMode"], "preview");
    assert_eq!(ed["paneContent"]["wordWrap"], false);
}

#[tokio::test]
async fn crash_window_terminal_reconciles_via_restore_key_ledger() {
    // CRASH WINDOW (`:632`), terminal leg: the create succeeded but NEITHER
    // marker write after it landed (in-progress entry with NO terminalId on
    // disk). The create was tagged with the deterministic restoreKey, so a
    // same-process retry finds the live terminal and its DEFERRED tab.create
    // in the fresh-agent ledger. The retry must deliver that command before
    // accepting the screenshot fence, without spawning a duplicate.
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
    let mut rx = r.bus.subscribe();
    // Exercise the production restore create path: the process was created,
    // but the deferred tab.create was never sent.
    let resp = freshell_freshagent::terminal_tabs::create_terminal_or_content_tab_deferred(
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
    let creates = tab_creates(&drain(&mut rx));
    assert_eq!(
        creates.len(),
        1,
        "retry must deliver deferred create: {body}"
    );
    assert_eq!(creates[0]["terminalId"], tid);
}

#[tokio::test]
async fn reconciled_delivery_drop_fails_and_stops_before_later_panes() {
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
            rec(
                "t2",
                "terminal",
                json!({ "mode": "shell", "initialCwd": "/tmp" }),
            ),
        ],
    );
    let r = rig(dir.path());
    let source_id = union_source_id(dir.path(), "dev-1");
    let first_pk = pane_key("dev-1:t1", "p-t1");
    let key = restore_key_for("dev-1", &source_id, &first_pk);
    let resp = freshell_freshagent::terminal_tabs::create_terminal_or_content_tab_deferred(
        r.state.fresh_agent.clone(),
        json!({ "mode": "shell", "cwd": "/tmp", "restoreKey": key }),
    )
    .await;
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let created: Value = serde_json::from_slice(&bytes).unwrap();
    let first_tid = created["data"]["terminalId"].as_str().unwrap().to_string();
    let mut panes = Marker::new();
    panes.insert(
        first_pk,
        PaneMark {
            state: "in-progress".into(),
            terminal_id: Some(first_tid.clone()),
        },
    );
    let mut doc = MarkerDoc::new();
    doc.insert(source_id, (0, panes));
    write_marker_doc(&device_dir(dir.path(), "dev-1"), &doc).unwrap();

    let frames = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let frames_for_sink = frames.clone();
    r.state.screenshots.add_capable_client(
        811,
        std::sync::Arc::new(move |message| {
            frames_for_sink
                .lock()
                .unwrap()
                .push(serde_json::to_value(message).unwrap());
        }),
    );
    let body = post(
        router(r.state.clone()),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1" }),
        true,
    )
    .await
    .1;

    assert_eq!(body["restored"].as_array().unwrap().len(), 0, "{body}");
    assert_eq!(body["skipped"].as_array().unwrap().len(), 0, "{body}");
    assert_eq!(
        body["failed"][0]["reason"], "delivery-unconfirmed",
        "{body}"
    );
    assert_eq!(body["failed"][0]["terminalId"], first_tid, "{body}");
    assert_eq!(body["failed"][1]["reason"], "connection-dropped", "{body}");
    let creates = tab_creates(&frames.lock().unwrap());
    assert_eq!(creates.len(), 1, "later pane must not be created: {body}");
    assert_eq!(
        r.terminals.inventory().len(),
        1,
        "only reconciled terminal exists"
    );
}

#[tokio::test]
async fn retry_replays_create_when_target_connection_changes() {
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
    let r = rig(dir.path());
    let first_on = std::sync::Arc::new(AtomicBool::new(false));
    let first_client = spawn_browser(&r, first_on);
    let first = post(
        router(r.state.clone()),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1" }),
        true,
    )
    .await
    .1;
    let terminal_id = first["failed"][0]["terminalId"]
        .as_str()
        .unwrap()
        .to_string();
    r.state.screenshots.remove_capable_client(first_client);

    let second_on = std::sync::Arc::new(AtomicBool::new(true));
    let _second_client = spawn_browser(&r, second_on);
    let mut rx = r.bus.subscribe();
    let second = post(
        router(r.state.clone()),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1" }),
        true,
    )
    .await
    .1;

    assert_eq!(second["restored"][0]["terminalId"], terminal_id, "{second}");
    let creates = tab_creates(&drain(&mut rx));
    assert_eq!(
        creates.len(),
        1,
        "new target must receive the existing terminal's create: {second}"
    );
    assert_eq!(creates[0]["terminalId"], terminal_id);
}

#[tokio::test]
async fn force_recreates_content_pane_in_same_server_process() {
    for (kind, payload) in [
        (
            "browser",
            json!({ "url": "https://example.com", "devToolsOpen": false }),
        ),
        (
            "editor",
            json!({ "filePath": "/tmp/x.md", "language": "markdown", "readOnly": false,
                    "viewMode": "preview", "wordWrap": true }),
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        seed_records(dir.path(), "dev-1", "c1", 1, vec![rec("t1", kind, payload)]);
        let (r, _on, _client) = connected(dir.path());
        let first = post(
            router(r.state.clone()),
            "/api/tabs-sync/restore",
            json!({ "deviceId": "dev-1" }),
            true,
        )
        .await
        .1;
        let original_tab_id = first["restored"][0]["tabId"].as_str().unwrap().to_string();
        let mut rx = r.bus.subscribe();
        let forced = post(
            router(r.state.clone()),
            "/api/tabs-sync/restore",
            json!({ "deviceId": "dev-1", "force": true }),
            true,
        )
        .await
        .1;

        assert_eq!(forced["restored"].as_array().unwrap().len(), 1, "{forced}");
        assert_ne!(forced["restored"][0]["tabId"], original_tab_id, "{forced}");
        assert_ne!(forced["restored"][0]["reconciled"], true, "{forced}");
        let frames = drain(&mut rx);
        let closes: Vec<_> = frames
            .iter()
            .filter(|v| v["command"] == "tab.close")
            .collect();
        assert_eq!(closes.len(), 1, "{kind}: force should retire stale tab");
        assert_eq!(closes[0]["payload"]["id"], original_tab_id);
        assert_eq!(tab_creates(&frames).len(), 1, "{kind}: missing create");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn active_restore_survives_production_device_eviction_interleaving() {
    let dir = tempfile::tempdir().unwrap();
    for n in 0..freshell_ws::tabs_persist::MAX_SNAPSHOT_DEVICES {
        let device = format!("dev-{n:03}");
        seed_records(
            dir.path(),
            &device,
            "c1",
            1,
            vec![rec(
                "t1",
                "terminal",
                json!({ "mode": "shell", "initialCwd": "/tmp" }),
            )],
        );
        let device_dir = device_dir(dir.path(), &device);
        let generation = std::fs::read_dir(&device_dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .find(|path| path.extension().is_some_and(|ext| ext == "json"))
            .unwrap();
        let mut value: Value =
            serde_json::from_slice(&std::fs::read(&generation).unwrap()).unwrap();
        value["capturedAt"] = json!(n as i64 + 1);
        std::fs::write(generation, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    }
    let source_dir = device_dir(dir.path(), "dev-000");
    let r = rig(dir.path());
    let (fence_tx, fence_rx) = tokio::sync::oneshot::channel();
    let fence_tx = std::sync::Arc::new(std::sync::Mutex::new(Some(fence_tx)));
    let fence_for_sink = fence_tx.clone();
    r.state.screenshots.add_capable_client(
        912,
        std::sync::Arc::new(move |message| {
            let value = serde_json::to_value(message).unwrap();
            if value["command"] == "screenshot.capture" {
                if let Some(tx) = fence_for_sink.lock().unwrap().take() {
                    let _ = tx.send(());
                }
            }
        }),
    );
    let app = router(r.state.clone());
    let restore = tokio::spawn(async move {
        post(
            app,
            "/api/tabs-sync/restore",
            json!({ "deviceId": "dev-000" }),
            true,
        )
        .await
        .1
    });
    fence_rx.await.expect("restore reached delivery fence");

    seed_records(
        dir.path(),
        "dev-new-1",
        "c1",
        1,
        vec![rec(
            "new1",
            "terminal",
            json!({ "mode": "shell", "initialCwd": "/tmp" }),
        )],
    );
    assert!(source_dir.exists(), "active restore source was evicted");
    assert!(
        source_dir.join(RESTORE_MARKER).exists(),
        "active restore marker was evicted"
    );
    let body = restore.await.unwrap();
    assert_eq!(
        body["failed"][0]["reason"], "delivery-unconfirmed",
        "{body}"
    );

    seed_records(
        dir.path(),
        "dev-new-2",
        "c1",
        1,
        vec![rec(
            "new2",
            "terminal",
            json!({ "mode": "shell", "initialCwd": "/tmp" }),
        )],
    );
    assert!(
        !source_dir.exists(),
        "source should be evictable after restore lease release"
    );
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
            json!({ "url": "https://example.com", "devToolsOpen": false }),
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
            rec(
                "t2",
                "browser",
                json!({ "url": "https://example.com", "devToolsOpen": false }),
            ),
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
