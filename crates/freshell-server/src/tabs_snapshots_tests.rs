//! Tests for the tabs-sync snapshot REST surface (`tabs_snapshots.rs`).
//! Child `#[cfg(test)]` module (`#[path]`-included) so the production file stays
//! under the repo's 1,000-line-per-file limit.

use super::*;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
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
        rec("t2", "browser", json!({ "url": "https://example.com" })),
        rec(
            "t3",
            "fresh-agent",
            json!({ "provider": "claude",
                "sessionRef": { "provider": "claude", "sessionId": "x" } }),
        ),
    ]
}

// The in-process "browser": subscribes to the SAME broadcast bus the restore
// broadcasts on and answers every `screenshot.capture` (the delivery ack) while
// `on` is true. This is a REAL WS receiver (not a counter): a resolved reply is
// exactly what proves the client received the earlier in-order `tab.create`.
// Subscribing synchronously before returning means frames are buffered, so the
// task can never miss the first capture.
fn spawn_browser(r: &Rig, on: std::sync::Arc<AtomicBool>) -> tokio::task::JoinHandle<()> {
    r.state.screenshots.add_capable_client();
    let mut rx = r.bus.subscribe();
    let broker = r.state.screenshots.clone();
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(frame) => {
                    if !on.load(Ordering::SeqCst) {
                        continue; // silent -> ack times out
                    }
                    let v: Value = match serde_json::from_str(&frame) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    if v["type"] == "ui.command" && v["command"] == "screenshot.capture" {
                        if let Some(rid) = v["payload"]["requestId"].as_str() {
                            broker.resolve(
                                rid,
                                freshell_ws::screenshot::ScreenshotResult {
                                    ok: true,
                                    ..Default::default()
                                },
                            );
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break, // sender dropped
            }
        }
    })
}
// A rig with exactly one connected, RESPONSIVE browser.
fn connected(
    dir: &std::path::Path,
) -> (Rig, std::sync::Arc<AtomicBool>, tokio::task::JoinHandle<()>) {
    let r = rig(dir);
    let on = std::sync::Arc::new(AtomicBool::new(true));
    let h = spawn_browser(&r, on.clone());
    (r, on, h)
}
fn marker_json(dir: &std::path::Path, device: &str) -> Value {
    let enc = freshell_ws::tabs_persist::encode_device_id(device).unwrap();
    serde_json::from_slice(&std::fs::read(dir.join(enc).join(RESTORE_MARKER)).unwrap()).unwrap()
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
    assert_eq!(body["broadcastScope"], "all-connected-clients");
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
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["restored"].as_array().unwrap().len(), 0);
    let failed = body["failed"].as_array().unwrap();
    assert_eq!(failed.len(), 2);
    assert!(failed
        .iter()
        .all(|f| f["reason"] == "session-identity-mismatch"));
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
    two.state.screenshots.add_capable_client(); // count -> 2
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
    let m = marker_json(dir.path(), "dev-1");
    let states: Vec<&str> = m["panes"]
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
        marker_json(dir.path(), "dev-1")["panes"][pane_key("dev-1:t1", "p-t1").as_str()]["state"],
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
    let forced = post(
        router(r.state.clone()),
        "/api/tabs-sync/restore",
        json!({ "deviceId": "dev-1", "force": true }),
        true,
    )
    .await
    .1;
    assert_eq!(
        forced["restored"][0]["reconciled"], true,
        "force must not recreate a live terminal"
    );
    assert_eq!(
        forced["restored"][0]["terminalId"], tid,
        "no duplicate under force"
    );
    // The marker STILL records t1 restored -- force did not discard prior history.
    assert_eq!(
        marker_json(dir.path(), "dev-1")["panes"][pane_key("dev-1:t1", "p-t1").as_str()]["state"],
        "restored"
    );
}
