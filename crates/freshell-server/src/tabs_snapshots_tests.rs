//! Tests for the tabs-sync snapshot REST surface (`tabs_snapshots.rs`).
//! Child `#[cfg(test)]` module (`#[path]`-included) so the production file stays
//! under the repo's 1,000-line-per-file limit.

use super::*;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::json;
use tower::ServiceExt;

const TOKEN: &str = "test-token";

fn codex_record(session_id: &str, rev: i64) -> serde_json::Value {
    json!({
        "tabKey": "dev-1:tab-1", "tabId": "tab-1", "tabName": "codex",
        "status": "open", "revision": rev, "updatedAt": 1000 + rev, "createdAt": 1000 + rev,
        "titleSetByUser": false, "paneCount": 1,
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

fn test_state(dir: &std::path::Path) -> TabsSnapshotsState {
    TabsSnapshotsState {
        auth_token: std::sync::Arc::new(TOKEN.to_string()),
        snapshots_dir: Some(dir.to_path_buf()),
    }
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
