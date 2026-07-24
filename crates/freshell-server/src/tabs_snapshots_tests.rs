//! Tests for the tabs-sync snapshot REST surface (`tabs_snapshots.rs`).
//! Child `#[cfg(test)]` module (`#[path]`-included) so the production file stays
//! under the repo's 1,000-line-per-file limit.

use super::*;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use tower::ServiceExt;

const TOKEN: &str = "test-token";

fn codex_record(session_id: &str, rev: i64) -> serde_json::Value {
    json!({
        "tabKey": "dev-1:tab-1", "tabId": "tab-1", "tabName": "codex",
        "status": "open", "revision": rev, "updatedAt": 1000 + rev, "paneCount": 1,
        "panes": [{ "paneId": "p1", "kind": "terminal", "payload": {
            "mode": "codex",
            "sessionRef": { "provider": "codex", "sessionId": session_id },
            "initialCwd": "/tmp"
        }}]
    })
}

// Seed real generations through the registry so the on-disk (encoded,
// per-client) layout matches what the read helpers expect.
fn seed(dir: &std::path::Path, device: &str, client: &str, rev: i64, session_id: &str) {
    let reg = freshell_ws::tabs::TabsRegistry::with_persist_dir(dir.to_path_buf());
    reg.replace_client_snapshot(
        "srv",
        device,
        "Dev One",
        client,
        rev,
        vec![codex_record(session_id, rev)],
    )
    .unwrap();
}

// A test rig wiring the screenshot broker + the fresh-agent create pipeline to
// ONE shared broadcast bus (exactly as `main.rs:196,202,232` do), plus the ONE
// shared TerminalRegistry restore uses for marker reconciliation. `bus` is kept
// so a test can subscribe an in-process "browser" that answers the delivery-ack
// screenshot round-trip. Ack timeout is short so the connection-drop test is fast.
struct Rig {
    state: TabsSnapshotsState,
    bus: std::sync::Arc<tokio::sync::broadcast::Sender<String>>,
    terminals: freshell_terminal::TerminalRegistry,
}
fn rig(dir: &std::path::Path) -> Rig {
    let bus = std::sync::Arc::new(tokio::sync::broadcast::channel::<String>(256).0);
    let terminals = freshell_terminal::TerminalRegistry::new();
    let fresh_agent = freshell_freshagent::FreshAgentState::new(
        std::sync::Arc::new(TOKEN.to_string()),
        bus.clone(),
    )
    .with_terminal_registry(terminals.clone());
    let state = TabsSnapshotsState {
        auth_token: std::sync::Arc::new(TOKEN.to_string()),
        snapshots_dir: Some(dir.to_path_buf()),
        fresh_agent,
        screenshots: freshell_ws::screenshot::ScreenshotBroker::new(bus.clone()),
        terminals: terminals.clone(),
        restore_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
        restore_ack_timeout: std::time::Duration::from_millis(300),
    };
    Rig {
        state,
        bus,
        terminals,
    }
}
// Back-compat helper for the read-endpoint tests (no delivery needed).
fn test_state(dir: &std::path::Path) -> TabsSnapshotsState {
    rig(dir).state
}

async fn get(router: axum::Router, uri: &str, auth: bool) -> (StatusCode, serde_json::Value) {
    let mut req = Request::builder().method("GET").uri(uri);
    if auth {
        req = req.header("x-auth-token", TOKEN);
    }
    let resp = router
        .oneshot(req.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
    )
}

#[tokio::test]
async fn snapshots_list_requires_auth_and_lists_devices_with_generations() {
    let dir = tempfile::tempdir().unwrap();
    seed(dir.path(), "dev-1", "c1", 1, "s-old");
    seed(dir.path(), "dev-1", "c1", 2, "s-new");
    let (status, _) = get(
        router(test_state(dir.path())),
        "/api/tabs-sync/snapshots",
        false,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, body) = get(
        router(test_state(dir.path())),
        "/api/tabs-sync/snapshots",
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["devices"][0]["deviceId"], "dev-1"); // RAW id, not encoded
    let gens = body["devices"][0]["generations"].as_array().unwrap();
    assert_eq!(gens.len(), 2);
    assert_eq!(gens[0]["generation"], 0);
    assert_eq!(gens[0]["snapshotRevision"], 2); // newest first
    assert!(
        gens[0]["generationId"].is_string(),
        "stable content digest exposed"
    );
    assert_ne!(gens[0]["generationId"], gens[1]["generationId"]);
    assert_eq!(body["devices"][0]["recordCount"], 1); // union view
}

#[tokio::test]
async fn snapshot_fetch_union_and_nth_and_404() {
    let dir = tempfile::tempdir().unwrap();
    seed(dir.path(), "dev-1", "c1", 1, "s-old");
    seed(dir.path(), "dev-1", "c1", 2, "s-new");
    // no generation param -> coherent union (newest per client)
    let (status, body) = get(
        router(test_state(dir.path())),
        "/api/tabs-sync/snapshots/dev-1",
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["records"][0]["panes"][0]["payload"]["sessionRef"]["sessionId"],
        "s-new"
    );
    // generation=1 -> the older point-in-time file
    let (_, body) = get(
        router(test_state(dir.path())),
        "/api/tabs-sync/snapshots/dev-1?generation=1",
        true,
    )
    .await;
    assert_eq!(
        body["records"][0]["panes"][0]["payload"]["sessionRef"]["sessionId"],
        "s-old"
    );
    // generationId=<digest of the older file> -> the SAME older file (stable selector)
    let (_, list) = get(
        router(test_state(dir.path())),
        "/api/tabs-sync/snapshots",
        true,
    )
    .await;
    let old_id = list["devices"][0]["generations"][1]["generationId"]
        .as_str()
        .unwrap()
        .to_string();
    let (_, by_id) = get(
        router(test_state(dir.path())),
        &format!("/api/tabs-sync/snapshots/dev-1?generationId={old_id}"),
        true,
    )
    .await;
    assert_eq!(
        by_id["records"][0]["panes"][0]["payload"]["sessionRef"]["sessionId"],
        "s-old"
    );
    let (status, _) = get(
        router(test_state(dir.path())),
        "/api/tabs-sync/snapshots/nope",
        true,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn fetch_rejects_malformed_selectors_with_400_never_union_fallback() {
    let dir = tempfile::tempdir().unwrap();
    seed(dir.path(), "dev-1", "c1", 1, "s-old");
    for bad in [
        "/api/tabs-sync/snapshots/dev-1?generation=-1", // negative
        "/api/tabs-sync/snapshots/dev-1?generation=abc", // non-numeric
        "/api/tabs-sync/snapshots/dev-1?generation=1.5", // non-integer
        "/api/tabs-sync/snapshots/dev-1?generation=1&generation=2", // duplicated
        "/api/tabs-sync/snapshots/dev-1?generation=0&generationId=abc", // conflicting
        "/api/tabs-sync/snapshots/dev-1?generationId=", // empty id
    ] {
        let (status, _) = get(router(test_state(dir.path())), bad, true).await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "must 400 (never silent union): {bad}"
        );
    }
}

#[tokio::test]
async fn corrupt_generation_file_returns_500_not_404() {
    // A PRESENT but unparseable backup is an ERROR (500), never "not found".
    let dir = tempfile::tempdir().unwrap();
    seed(dir.path(), "dev-1", "c1", 1, "s-old");
    let enc = freshell_ws::tabs_persist::encode_device_id("dev-1").unwrap();
    let file = std::fs::read_dir(dir.path().join(&enc))
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .find(|p| p.extension().is_some_and(|x| x == "json"))
        .unwrap();
    std::fs::write(&file, b"{ corrupt").unwrap();
    let (status, _) = get(
        router(test_state(dir.path())),
        "/api/tabs-sync/snapshots/dev-1",
        true,
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    let (status, _) = get(
        router(test_state(dir.path())),
        "/api/tabs-sync/snapshots",
        true,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::INTERNAL_SERVER_ERROR,
        "list must also 500 on a corrupt store"
    );
}

// ── POST /api/tabs-sync/restore (Task 3) ────────────────────────────────────

async fn post(
    router: axum::Router,
    uri: &str,
    body: serde_json::Value,
    auth: bool,
) -> (StatusCode, serde_json::Value) {
    let mut req = Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json");
    if auth {
        req = req.header("x-auth-token", TOKEN);
    }
    let resp = router
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
    )
}

// Seed a real generation (encoded layout) via the registry.
fn seed_records(dir: &std::path::Path, device: &str, client: &str, rev: i64, records: Vec<Value>) {
    let reg = freshell_ws::tabs::TabsRegistry::with_persist_dir(dir.to_path_buf());
    reg.replace_client_snapshot("srv", device, "Dev One", client, rev, records)
        .unwrap();
}

// NOTE: every shell payload below carries an explicit `initialCwd: "/tmp"`.
// Sibling tests in this binary (`files.rs`) set `HOME=/home/tester` (nonexistent)
// process-wide and never restore it, and portable-pty falls back to the child
// env's HOME as the spawn cwd when none is given — a cwd-less shell spawn then
// fails ENOENT under the full suite. An explicit, always-present cwd keeps these
// tests deterministic regardless of sibling env pollution.
fn rec(tab: &str, kind: &str, payload: Value) -> Value {
    json!({ "tabKey": format!("dev-1:{tab}"), "tabId": tab, "tabName": tab, "status": "open",
            "revision": 1, "updatedAt": 2000, "paneCount": 1,
            "panes": [{ "paneId": format!("p-{tab}"), "kind": kind, "payload": payload }] })
}

fn mixed_records() -> Vec<Value> {
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
        rec(
            "t3",
            "fresh-agent",
            json!({ "provider": "claude", "sessionType": "freshclaude",
                "sessionRef": { "provider": "claude", "sessionId": "x" } }),
        ),
    ]
}

// The in-process "browser" registers the same per-connection sink a real WS
// connection does and answers every targeted `screenshot.capture` while `on`
// is true. The connection id is carried into `resolve_from`, so another
// browser cannot acknowledge this target's restore.
fn spawn_browser(r: &Rig, on: std::sync::Arc<AtomicBool>) -> u64 {
    static NEXT_CLIENT_ID: AtomicU64 = AtomicU64::new(1);
    let client_id = NEXT_CLIENT_ID.fetch_add(1, Ordering::SeqCst);
    let broker = r.state.screenshots.clone();
    let observed = r.bus.clone();
    r.state.screenshots.add_capable_client(
        client_id,
        std::sync::Arc::new(move |message| {
            if !on.load(Ordering::SeqCst) {
                return true;
            }
            let v = serde_json::to_value(message).expect("server message serializes");
            let _ = observed.send(v.to_string());
            if v["type"] == "ui.command" && v["command"] == "screenshot.capture" {
                if let Some(request_id) = v["payload"]["requestId"].as_str() {
                    broker.resolve_from(
                        client_id,
                        request_id,
                        freshell_ws::screenshot::ScreenshotResult {
                            ok: true,
                            ..Default::default()
                        },
                    );
                }
            }
            true
        }),
    );
    client_id
}
// A rig with exactly one connected, RESPONSIVE browser.
fn connected(dir: &std::path::Path) -> (Rig, std::sync::Arc<AtomicBool>, u64) {
    let r = rig(dir);
    let on = std::sync::Arc::new(AtomicBool::new(true));
    let h = spawn_browser(&r, on.clone());
    (r, on, h)
}
fn marker_json(dir: &std::path::Path, device: &str) -> Value {
    let enc = freshell_ws::tabs_persist::encode_device_id(device).unwrap();
    serde_json::from_slice(&std::fs::read(dir.join(enc).join(RESTORE_MARKER)).unwrap()).unwrap()
}
// The v2 marker is a per-source LEDGER (`tabs_snapshots_marker.rs`); these
// tests restore exactly one source, so return that single source's panes map.
fn marker_panes(dir: &std::path::Path, device: &str) -> Value {
    let doc = marker_json(dir, device);
    let sources = doc["sources"].as_object().expect("v2 marker sources");
    assert_eq!(sources.len(), 1, "single-source test marker: {doc}");
    sources.values().next().unwrap()["panes"].clone()
}

#[tokio::test]
async fn restore_rebuilds_supported_panes_and_reports_skips() {
    let dir = tempfile::tempdir().unwrap();
    seed_records(dir.path(), "dev-1", "c1", 3, mixed_records());
    let (r, _on, _h) = connected(dir.path());
    let (status, body) = post(
        router(r.state.clone()),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1" }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["broadcastScope"], "target-client");
    assert_eq!(
        body["deliveryConfirmed"], true,
        "single responsive browser acked every tab.create"
    );
    assert!(body["sourceId"].is_string());
    let restored = body["restored"].as_array().unwrap();
    assert_eq!(
        restored.len(),
        2,
        "shell terminal + browser restored: {body}"
    );
    assert!(restored
        .iter()
        .any(|r| r["kind"] == "terminal" && r["terminalId"].is_string()));
    assert!(restored
        .iter()
        .any(|r| r["kind"] == "browser" && r["tabId"].is_string()));
    let skipped = body["skipped"].as_array().unwrap();
    assert_eq!(skipped.len(), 1);
    assert_eq!(skipped[0]["reason"], "unsupported-kind");
    assert_eq!(body["failed"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn restore_rejects_non_boolean_control_flags() {
    let dir = tempfile::tempdir().unwrap();
    seed_records(
        dir.path(),
        "dev-1",
        "c1",
        1,
        vec![rec(
            "t1",
            "browser",
            json!({ "url": "https://example.com", "devToolsOpen": false }),
        )],
    );
    for (field, value) in [
        ("dryRun", json!("true")),
        ("dryRun", json!(1)),
        ("dryRun", Value::Null),
        ("force", json!("true")),
        ("force", json!(1)),
        ("force", Value::Null),
    ] {
        let mut request = json!({ "deviceId": "dev-1", "dryRun": true });
        request[field] = value;
        let (status, body) = post(
            router(test_state(dir.path())),
            "/api/tabs-sync/restore",
            request,
            true,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{field}: {body}");
        assert_eq!(
            body["error"],
            format!("{field} must be a boolean"),
            "{field}: {body}"
        );
    }
}

#[tokio::test]
async fn dry_run_reads_and_classifies_the_restore_marker() {
    let dir = tempfile::tempdir().unwrap();
    seed_records(
        dir.path(),
        "dev-1",
        "c1",
        1,
        vec![rec(
            "t1",
            "browser",
            json!({ "url": "https://example.com", "devToolsOpen": false }),
        )],
    );
    let (connected_rig, _on, _client) = connected(dir.path());
    let (_, first) = post(
        router(connected_rig.state.clone()),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1" }),
        true,
    )
    .await;
    assert_eq!(first["restored"].as_array().unwrap().len(), 1, "{first}");

    let (_, preview) = post(
        router(test_state(dir.path())),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1", "dryRun": true }),
        true,
    )
    .await;
    assert_eq!(
        preview["restored"].as_array().unwrap().len(),
        0,
        "{preview}"
    );
    assert_eq!(preview["skipped"][0]["reason"], "already-restored");

    let marker_path = dir
        .path()
        .join(freshell_ws::tabs_persist::encode_device_id("dev-1").unwrap())
        .join(RESTORE_MARKER);
    let mut marker = marker_json(dir.path(), "dev-1");
    let pane = marker["sources"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .next()
        .unwrap()["panes"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .next()
        .unwrap();
    pane["state"] = json!("in-progress");
    std::fs::write(&marker_path, serde_json::to_vec(&marker).unwrap()).unwrap();

    let (_, reconciled) = post(
        router(connected_rig.state),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1", "dryRun": true }),
        true,
    )
    .await;
    assert_eq!(
        reconciled["restored"][0]["reconciled"], true,
        "{reconciled}"
    );

    let (_, unconfirmed) = post(
        router(test_state(dir.path())),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1", "dryRun": true }),
        true,
    )
    .await;
    assert_eq!(
        unconfirmed["failed"][0]["reason"], "in-progress-unconfirmed",
        "{unconfirmed}"
    );

    std::fs::write(&marker_path, b"{corrupt").unwrap();
    let (status, corrupt) = post(
        router(test_state(dir.path())),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1", "dryRun": true }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{corrupt}");
    assert_eq!(corrupt["markerError"], true);
}

#[tokio::test]
async fn connection_churn_cannot_redirect_delivery_or_acknowledgement() {
    let dir = tempfile::tempdir().unwrap();
    seed_records(
        dir.path(),
        "dev-1",
        "c1",
        1,
        vec![rec(
            "t1",
            "browser",
            json!({ "url": "https://example.com", "devToolsOpen": false }),
        )],
    );
    let r = rig(dir.path());
    let target_id = 71;
    let late_id = 72;
    let broker = r.state.screenshots.clone();
    let late_frames = std::sync::Arc::new(AtomicUsize::new(0));
    let late_frames_for_sink = late_frames.clone();
    r.state.screenshots.add_capable_client(
        target_id,
        std::sync::Arc::new(move |message| {
            let value = serde_json::to_value(message).unwrap();
            if value["command"] == "tab.create" {
                let late_frames = late_frames_for_sink.clone();
                broker.add_capable_client(
                    late_id,
                    std::sync::Arc::new(move |_| {
                        late_frames.fetch_add(1, Ordering::SeqCst);
                        true
                    }),
                );
            }
            if value["command"] == "screenshot.capture" {
                let request_id = value["payload"]["requestId"].as_str().unwrap();
                // A late client guesses the request id, but cannot satisfy the
                // target-bound pending request.
                broker.resolve_from(
                    late_id,
                    request_id,
                    freshell_ws::screenshot::ScreenshotResult {
                        ok: true,
                        ..Default::default()
                    },
                );
            }
            true
        }),
    );

    let (status, body) = post(
        router(r.state),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1" }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["restored"].as_array().unwrap().len(), 0, "{body}");
    assert_eq!(body["failed"][0]["reason"], "delivery-unconfirmed");
    assert_eq!(late_frames.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn restore_rejects_mismatched_or_malformed_session_ref_before_spawning() {
    let dir = tempfile::tempdir().unwrap();
    // (a) codex mode + CLAUDE sessionRef; (b) codex mode + sessionRef object
    // MISSING sessionId -> both must FAIL (never silently spawn fresh).
    seed_records(
        dir.path(),
        "dev-1",
        "c1",
        1,
        vec![
            rec(
                "t1",
                "terminal",
                json!({ "mode": "codex",
                "sessionRef": { "provider": "claude", "sessionId": "z" } }),
            ),
            rec(
                "t2",
                "terminal",
                json!({ "mode": "codex",
                "sessionRef": { "provider": "codex" } }),
            ),
        ],
    ); // no sessionId
    let (r, _on, _h) = connected(dir.path());
    let (status, body) = post(
        router(r.state.clone()),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1" }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    assert_eq!(body["error"], "snapshot store unreadable");
    assert!(
        r.terminals.inventory().is_empty(),
        "semantic validation must fail before spawning"
    );
}

#[tokio::test]
async fn restore_is_idempotent_and_force_bypasses_skip() {
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
    // Run 1: restore (marker persisted on disk).
    let (r1, _on1, _h1) = connected(dir.path());
    let first = post(
        router(r1.state.clone()),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1" }),
        true,
    )
    .await
    .1;
    assert_eq!(first["restored"].as_array().unwrap().len(), 1);
    // Run 2: a DIFFERENT server instance (fresh TerminalRegistry, SAME on-disk
    // marker dir). The restored terminal isn't in THIS registry, so live-reconcile
    // can't fire -> the pane is skipped `already-restored` (idempotent), nothing
    // recreated. Deterministic (no reliance on kill-exit timing).
    let (r2, _on2, _h2) = connected(dir.path());
    let second = post(
        router(r2.state.clone()),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1" }),
        true,
    )
    .await
    .1;
    assert_eq!(second["restored"].as_array().unwrap().len(), 0);
    assert_eq!(second["skipped"][0]["reason"], "already-restored");
    // force bypasses the skip -> re-creates (the terminal is not live in r2).
    let forced = post(
        router(r2.state.clone()),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1", "force": true }),
        true,
    )
    .await
    .1;
    assert_eq!(forced["restored"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn restore_refuses_unless_exactly_one_browser_connected() {
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
    // ZERO clients -> 409.
    let (status, body) = post(
        router(test_state(dir.path())),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1" }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "zero clients must be refused");
    assert_eq!(body["connectedClients"], 0);
    // TWO clients -> 409 (would duplicate onto the bystander).
    let two = rig(dir.path());
    let on2 = std::sync::Arc::new(AtomicBool::new(true));
    let _h2 = spawn_browser(&two, on2); // count -> 1 (responsive)
    two.state
        .screenshots
        .add_capable_client(9_999_999, std::sync::Arc::new(|_| true)); // count -> 2
    let (status, body) = post(
        router(two.state.clone()),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1" }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["connectedClients"], 2);
    // force overrides the gate even at 2 (the responsive browser still acks).
    let (status, _) = post(
        router(two.state.clone()),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1", "force": true }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // EXACTLY ONE -> OK.
    let (r, _on, _h) = connected(dir.path());
    let (status, _) = post(
        router(r.state.clone()),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1" }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn restore_dry_run_creates_nothing_and_404_on_missing_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    seed_records(dir.path(), "dev-1", "c1", 3, mixed_records());
    // dryRun is allowed regardless of client count (creates nothing).
    let (status, body) = post(
        router(test_state(dir.path())),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1", "dryRun": true }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["deliveryConfirmed"], true,
        "dryRun is trivially confirmed"
    );
    assert_eq!(body["restored"].as_array().unwrap().len(), 2);
    assert!(body["restored"][0]["tabId"].is_null());
    // dryRun writes no marker.
    assert!(!dir
        .path()
        .join(freshell_ws::tabs_persist::encode_device_id("dev-1").unwrap())
        .join(RESTORE_MARKER)
        .exists());
    // Missing snapshot -> 404 even under dryRun (gate bypassed, lookup fails).
    let (status, _) = post(
        router(test_state(dir.path())),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "ghost", "dryRun": true }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn delivery_drop_fails_remaining_panes_and_writes_in_progress_marker() {
    // VERIFIED DELIVERY (:1460): one connected but UNRESPONSIVE browser. The
    // first pane's create succeeds but its delivery ack times out -> that pane
    // AND every remaining pane are FAILED (not restored), deliveryConfirmed is
    // false, and the created terminal is recorded IN-PROGRESS (with its id) for
    // reconciliation -- NOT restored.
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
    let off = std::sync::Arc::new(AtomicBool::new(false)); // never answers
    let _h = spawn_browser(&r, off); // count 1, unresponsive
    let body = post(
        router(r.state.clone()),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1" }),
        true,
    )
    .await
    .1;
    assert_eq!(body["restored"].as_array().unwrap().len(), 0);
    assert_eq!(body["deliveryConfirmed"], false);
    let failed = body["failed"].as_array().unwrap();
    assert!(failed.iter().any(|f| f["reason"] == "delivery-unconfirmed"));
    assert!(
        failed.iter().any(|f| f["reason"] == "connection-dropped"),
        "the pane after the drop must be FAILED, never restored"
    );
    // The created terminal is recorded IN-PROGRESS in the marker.
    let m = marker_panes(dir.path(), "dev-1");
    let states: Vec<&str> = m
        .as_object()
        .unwrap()
        .values()
        .filter_map(|p| p["state"].as_str())
        .collect();
    assert!(
        states.iter().all(|s| *s == "in-progress"),
        "nothing marked restored: {m}"
    );
}

#[tokio::test]
async fn write_ahead_reconciles_live_terminal_no_duplicate_on_retry() {
    // MARKER-BEFORE-SIDE-EFFECTS (:1532): run 1 drops delivery after creating
    // the terminal (write-ahead in-progress). Run 2 (now responsive) must
    // RECONCILE that still-live terminal -- promote to restored WITHOUT creating
    // a duplicate. The same terminalId proves no second create happened.
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
    let on = std::sync::Arc::new(AtomicBool::new(false));
    let _h = spawn_browser(&r, on.clone());
    let first = post(
        router(r.state.clone()),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1" }),
        true,
    )
    .await
    .1;
    let tid = first["failed"][0]["terminalId"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        r.terminals.is_running(&tid),
        "terminal created despite delivery drop"
    );
    on.store(true, Ordering::SeqCst); // browser comes back
    let second = post(
        router(r.state.clone()),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1" }),
        true,
    )
    .await
    .1;
    let rec0 = &second["restored"][0];
    assert_eq!(
        rec0["reconciled"], true,
        "in-progress live pane reconciled, not recreated"
    );
    assert_eq!(
        rec0["terminalId"], tid,
        "SAME terminal -> no duplicate create"
    );
    assert_eq!(second["failed"].as_array().unwrap().len(), 0);
    assert_eq!(
        marker_panes(dir.path(), "dev-1")[pane_key("dev-1:t1", "p-t1").as_str()]["state"],
        "restored"
    );
}

#[tokio::test]
async fn force_preserves_prior_marker_and_never_duplicates_live_terminal() {
    // FORCE PRESERVES HISTORY (:1497): a normal restore records t1 restored.
    // A subsequent FORCE restore must LOAD + preserve that record and must NOT
    // duplicate the still-live terminal (reconciled), so a later ordinary
    // restore still sees t1 restored (no re-create).
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
    let first = post(
        router(r.state.clone()),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1" }),
        true,
    )
    .await
    .1;
    let tid = first["restored"][0]["terminalId"]
        .as_str()
        .unwrap()
        .to_string();
    let first_tab_id = first["restored"][0]["tabId"].as_str().unwrap().to_string();
    let forced = post(
        router(r.state.clone()),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1", "force": true }),
        true,
    )
    .await
    .1;
    assert_eq!(forced["restored"][0]["forcedReplacement"], true);
    assert_eq!(
        forced["restored"][0]["terminalId"], tid,
        "no duplicate under force"
    );
    assert_eq!(
        forced["restored"][0]["tabId"], first_tab_id,
        "the reused PTY must keep the ids injected into its environment"
    );
    // The marker STILL records t1 restored -- force did not discard prior history.
    assert_eq!(
        marker_panes(dir.path(), "dev-1")[pane_key("dev-1:t1", "p-t1").as_str()]["state"],
        "restored"
    );
}

#[test]
fn marker_in_flight_temp_is_invisible_to_the_ws_orphan_tmp_sweep() {
    // freshell-ws's `sweep_orphan_tmp` reaps every `*.tmp` in the device dir
    // without any lock shared with the restore path, so the marker's in-flight
    // temp must never carry the `tmp` extension (see RESTORE_MARKER_TMP docs
    // and the freshell-ws test
    // `restore_marker_in_flight_temp_survives_the_sweep_while_stray_tmp_is_reaped`).
    assert!(
        std::path::Path::new(RESTORE_MARKER_TMP)
            .extension()
            .is_none_or(|e| e != "tmp"),
        "RESTORE_MARKER_TMP must not use the .tmp extension: freshell-ws's \
         orphan-tmp sweep would reap it mid-write"
    );
    // And it must still be a hidden dotfile so the *.json generation listing
    // never sees it either.
    assert!(RESTORE_MARKER_TMP.starts_with('.'));
}

// Restore-hardening tests (cross-model review delta r1) live in a sibling file
// so both test files stay under the repo's 1,000-line-per-file limit.
#[path = "tabs_snapshots_restore_tests.rs"]
mod restore_tests;
