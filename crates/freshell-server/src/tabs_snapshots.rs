//! Tabs-sync snapshot REST surface (continuity trio,
//! docs/plans/2026-07-22-continuity-safety-trio.md). PURELY ADDITIVE: the legacy
//! server has no on-disk snapshot generations and no snapshot/restore routes, so
//! this diverges from no ported behavior and gets no DEVIATIONS ledger entry.
//! Read endpoints serve the generations `freshell_ws::tabs_persist` persists;
//! POST /api/tabs-sync/restore (Task 3) rebuilds tabs by driving the SAME
//! `POST /api/tabs` create pipeline.

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::get;
use axum::Router;
use serde_json::{json, Value};

use crate::boot::is_authed; // pub(crate) in boot.rs:686 — same crate, no copy

#[derive(Clone)]
pub struct TabsSnapshotsState {
    pub auth_token: Arc<String>,
    pub snapshots_dir: Option<PathBuf>,
    pub fresh_agent: freshell_freshagent::FreshAgentState,
    pub screenshots: freshell_ws::screenshot::ScreenshotBroker,
    /// The SAME `TerminalRegistry` (`main.rs:246`) the WS handler + `fresh_agent`
    /// use. Restore reconciles write-ahead marker entries against it by
    /// `is_running(terminalId)` so a crash between create and marker-promotion
    /// can't cause a duplicate on retry (Task 3, `:1532`).
    pub terminals: freshell_terminal::TerminalRegistry,
    /// Serializes restores so two concurrent requests can't both read an empty
    /// marker and duplicate tabs (Task 3). One process-wide lock is sufficient —
    /// restores are rare, operator-triggered recovery actions.
    pub restore_lock: Arc<tokio::sync::Mutex<()>>,
    /// Bounds each per-pane delivery-ack round-trip (Task 3, `:1460`). Production
    /// ~5s; tests set it short so the connection-drop path is fast.
    pub restore_ack_timeout: std::time::Duration,
}

pub fn router(state: TabsSnapshotsState) -> Router {
    Router::new()
        .route("/api/tabs-sync/snapshots", get(list_snapshots))
        .route("/api/tabs-sync/snapshots/{device_id}", get(get_snapshot))
        .with_state(state)
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "Unauthorized" })),
    )
        .into_response()
}

/// A backup is PRESENT but unreadable/corrupt, OR a `spawn_blocking` task failed:
/// 500 + structured log with the store path + error (`:480`). NEVER 404 (that is
/// reserved for genuine absence) and never a silent empty success. `err` accepts
/// both `std::io::Error` and `tokio::task::JoinError` (both `Display`).
fn snapshots_read_error(dir: &std::path::Path, err: &dyn std::fmt::Display) -> Response {
    tracing::error!(target: "freshell_server::tabs_snapshots", path = %dir.display(),
        error = %err, "tabs_snapshot_store_unreadable");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "snapshot store unreadable" })),
    )
        .into_response()
}

/// The parsed generation selector, or a 400 response. FAIL-CLOSED (`:1101`): an
/// invalid, negative, duplicated, or conflicting selector is a 400, never a
/// silent fall-through to the (broader) coherent union.
enum Selector {
    Union,
    Index(usize),
    Id(String),
}

fn parse_selector(params: &[(String, String)]) -> Result<Selector, Response> {
    let gens: Vec<&String> = params
        .iter()
        .filter(|(k, _)| k == "generation")
        .map(|(_, v)| v)
        .collect();
    let ids: Vec<&String> = params
        .iter()
        .filter(|(k, _)| k == "generationId")
        .map(|(_, v)| v)
        .collect();
    let bad = |msg: &str| (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response();
    if gens.len() > 1 {
        return Err(bad("duplicate `generation` selector"));
    }
    if ids.len() > 1 {
        return Err(bad("duplicate `generationId` selector"));
    }
    if !gens.is_empty() && !ids.is_empty() {
        return Err(bad("provide `generation` OR `generationId`, not both"));
    }
    if let Some(v) = gens.first() {
        // usize::from_str rejects negatives, non-numerics, and empty -> 400.
        return v
            .parse::<usize>()
            .map(Selector::Index)
            .map_err(|_| bad("`generation` must be a non-negative integer"));
    }
    if let Some(v) = ids.first() {
        if v.is_empty() {
            return Err(bad("`generationId` must be non-empty"));
        }
        return Ok(Selector::Id((*v).clone()));
    }
    Ok(Selector::Union)
}

async fn list_snapshots(State(state): State<TabsSnapshotsState>, headers: HeaderMap) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let Some(dir) = state.snapshots_dir.clone() else {
        return Json(json!({ "devices": [] })).into_response();
    };
    let dir_for_log = dir.clone();
    // All filesystem work runs off the async runtime (blocking read_dir/parse).
    let result = tokio::task::spawn_blocking(move || -> std::io::Result<Vec<Value>> {
        let mut out = Vec::new();
        for device in freshell_ws::tabs_persist::list_snapshot_devices(&dir)? {
            // ONE directory scan per device -> (union, generation index).
            let (union, generations) =
                match freshell_ws::tabs_persist::read_device_overview(&dir, &device)? {
                    Some(pair) => pair,
                    None => (Value::Null, Vec::new()),
                };
            out.push(json!({
                "deviceId": device,
                "deviceLabel": union.get("deviceLabel").cloned().unwrap_or(Value::Null),
                "recordCount": union.get("records").and_then(Value::as_array).map(|r| r.len()).unwrap_or(0),
                "capturedAt": union.get("capturedAt").cloned().unwrap_or(Value::Null),
                "generations": generations,
            }));
        }
        Ok(out)
    })
    .await;
    match result {
        Ok(Ok(devices)) => Json(json!({ "devices": devices })).into_response(),
        Ok(Err(err)) => snapshots_read_error(&dir_for_log, &err),
        Err(join_err) => snapshots_read_error(&dir_for_log, &join_err),
    }
}

async fn get_snapshot(
    State(state): State<TabsSnapshotsState>,
    AxumPath(device_id): AxumPath<String>,
    headers: HeaderMap,
    Query(params): Query<Vec<(String, String)>>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let Some(dir) = state.snapshots_dir.clone() else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Snapshot not found" })),
        )
            .into_response();
    };
    let selector = match parse_selector(&params) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let dir_for_log = dir.clone();
    // No selector -> coherent device union; generationId -> stable-digest file;
    // generation=N -> Nth-newest point-in-time file. All reads off-runtime, fail-loud.
    let result = tokio::task::spawn_blocking(move || -> std::io::Result<Option<Value>> {
        match selector {
            Selector::Id(id) => {
                freshell_ws::tabs_persist::read_generation_by_id(&dir, &device_id, &id)
            }
            Selector::Index(n) => freshell_ws::tabs_persist::read_generation(&dir, &device_id, n),
            Selector::Union => freshell_ws::tabs_persist::read_device_union(&dir, &device_id),
        }
    })
    .await;
    match result {
        Ok(Ok(Some(snap))) => Json(snap).into_response(),
        Ok(Ok(None)) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Snapshot not found" })),
        )
            .into_response(),
        Ok(Err(err)) => snapshots_read_error(&dir_for_log, &err),
        Err(join_err) => snapshots_read_error(&dir_for_log, &join_err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use serde_json::json;
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
    // `bus`/`terminals` are consumed by Task 3's restore tests; constructed now so
    // the rig is built once (hence the narrow dead_code allowance).
    #[allow(dead_code)]
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
}
