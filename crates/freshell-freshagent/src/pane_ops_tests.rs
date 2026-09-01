//! Pane-route tests for [`crate::pane_ops`], split out of `pane_ops.rs` per
//! this branch's precedent (`layout_store_tests.rs`) to keep the route module
//! under the 1,000-line ceiling. Tab-route tests live in
//! `pane_ops_tab_tests.rs` (a sibling `#[path]` module that reuses this
//! module's `pub(super)` helpers).

use super::*;
use axum::body::Body;
use axum::http::Request;
use std::sync::Arc;
use tower::util::ServiceExt;

pub(super) fn state_with_registry() -> FreshAgentState {
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
    FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx))
        .with_terminal_registry(freshell_terminal::TerminalRegistry::new())
}

pub(super) fn app(state: FreshAgentState) -> Router {
    crate::router(state)
}

pub(super) async fn body_json(resp: Response) -> Value {
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

pub(super) async fn post(
    router: Router,
    uri: &str,
    body: Value,
    auth: bool,
) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json");
    if auth {
        req = req.header("x-auth-token", "tok");
    }
    let resp = router
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = resp.status();
    (status, body_json(resp).await)
}

pub(super) async fn patch(
    router: Router,
    uri: &str,
    body: Value,
    auth: bool,
) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method("PATCH")
        .uri(uri)
        .header("content-type", "application/json");
    if auth {
        req = req.header("x-auth-token", "tok");
    }
    let resp = router
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = resp.status();
    (status, body_json(resp).await)
}

pub(super) async fn delete(router: Router, uri: &str, auth: bool) -> (StatusCode, Value) {
    let mut req = Request::builder().method("DELETE").uri(uri);
    if auth {
        req = req.header("x-auth-token", "tok");
    }
    let resp = router
        .oneshot(req.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = resp.status();
    (status, body_json(resp).await)
}

/// Create a real shell tab via the existing Slice-1 create route, returning
/// (tabId, paneId, terminalId).
pub(super) async fn create_shell_tab(router: Router) -> (String, String, String) {
    let tmp = std::env::temp_dir();
    let (status, body) = post(
        router,
        "/api/tabs",
        json!({ "mode": "shell", "cwd": tmp.to_string_lossy() }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    (
        body["data"]["tabId"].as_str().unwrap().to_string(),
        body["data"]["paneId"].as_str().unwrap().to_string(),
        body["data"]["terminalId"].as_str().unwrap().to_string(),
    )
}

// ── shared GET helper (slice 3b-2) ──────────────────────────────────

pub(super) async fn get(router: Router, uri: &str, auth: bool) -> (StatusCode, Value) {
    let mut req = Request::builder().method("GET").uri(uri);
    if auth {
        req = req.header("x-auth-token", "tok");
    }
    let resp = router
        .oneshot(req.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = resp.status();
    (status, body_json(resp).await)
}

// ── auth ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn split_pane_requires_auth() {
    let state = state_with_registry();
    let (status, _) = post(app(state), "/api/panes/nope/split", json!({}), false).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn close_pane_requires_auth() {
    let state = state_with_registry();
    let (status, _) = post(app(state), "/api/panes/nope/close", json!({}), false).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn select_pane_requires_auth() {
    let state = state_with_registry();
    let (status, _) = post(app(state), "/api/panes/nope/select", json!({}), false).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

// ── split ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn split_unknown_pane_on_empty_store_is_404_no_layout_snapshot() {
    // Node parity: with no snapshot, `layoutStore.resolveTarget` yields
    // `{message:'no layout snapshot'}` -> `rejectPaneTargetError` 404
    // (`router.ts:530-538, 591-596`). The snapshot-present miss is the
    // approx path (see `store_tests`).
    let state = state_with_registry();
    let (status, body) = post(
        app(state),
        "/api/panes/does-not-exist/split",
        json!({}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["message"], json!("no layout snapshot"));
}

#[tokio::test]
async fn split_agent_pane_is_honest_400() {
    let state = state_with_registry();
    let router = app(state.clone());
    let (_tab_id, pane_id, _terminal_id) = create_shell_tab(router.clone()).await;

    let (status, body) = post(
        router,
        &format!("/api/panes/{pane_id}/split"),
        json!({ "agent": "opencode" }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let msg = body["message"].as_str().unwrap();
    assert!(msg.contains("fresh-agent"), "{msg}");
}

#[tokio::test]
async fn split_terminal_pane_spawns_real_pty_and_broadcasts_pane_split() {
    let state = state_with_registry();
    let router = app(state.clone());
    let mut rx = state.broadcast_tx.subscribe();
    let (tab_id, pane_id, _terminal_id) = create_shell_tab(router.clone()).await;
    // Drain the tab.create broadcast so we only see this split's frame.
    let _ = rx.recv().await;

    let tmp = std::env::temp_dir();
    let (status, body) = post(
        router,
        &format!("/api/panes/{pane_id}/split"),
        json!({ "direction": "vertical", "cwd": tmp.to_string_lossy() }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let new_pane_id = body["data"]["paneId"].as_str().unwrap().to_string();
    let new_terminal_id = body["data"]["terminalId"].as_str().unwrap().to_string();
    assert_ne!(new_pane_id, pane_id);
    assert!(state
        .terminal_registry
        .clone()
        .unwrap()
        .is_running(&new_terminal_id));

    let frame = rx.recv().await.expect("pane.split broadcast");
    let msg: Value = serde_json::from_str(&frame).unwrap();
    assert_eq!(msg["command"], json!("pane.split"));
    assert_eq!(msg["payload"]["tabId"], json!(tab_id));
    assert_eq!(msg["payload"]["paneId"], json!(pane_id));
    assert_eq!(msg["payload"]["direction"], json!("vertical"));
    assert_eq!(msg["payload"]["newPaneId"], json!(new_pane_id));
    assert_eq!(
        msg["payload"]["newContent"]["terminalId"],
        json!(new_terminal_id)
    );
    let crid = msg["payload"]["newContent"]["createRequestId"]
        .as_str()
        .expect("split newContent.createRequestId missing");
    assert_eq!(crid.len(), 32);

    state
        .terminal_registry
        .clone()
        .unwrap()
        .kill(&new_terminal_id);
}

#[tokio::test]
async fn split_browser_pane_registers_cheap_content_no_terminal() {
    let state = state_with_registry();
    let router = app(state.clone());
    let (_tab_id, pane_id, _terminal_id) = create_shell_tab(router.clone()).await;

    let (status, body) = post(
        router,
        &format!("/api/panes/{pane_id}/split"),
        json!({ "browser": "https://example.com" }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["data"]["terminalId"].is_null());
    assert_eq!(body["message"], json!("pane split (non-terminal)"));
}

#[tokio::test]
async fn split_host_stats_pane_registers_cheap_content_no_terminal() {
    let state = state_with_registry();
    let router = app(state.clone());
    let (_tab_id, pane_id, _terminal_id) = create_shell_tab(router.clone()).await;

    let (status, body) = post(
        router,
        &format!("/api/panes/{pane_id}/split"),
        json!({ "hostStats": true }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body["data"]["terminalId"].is_null());
    assert_eq!(body["message"], json!("pane split (non-terminal)"));
}

/// kata ejh6: `POST /api/panes/:id/split` REFUSES a body carrying the legacy
/// `resumeSessionId` field at the door-top — 400 with the frozen text,
/// presence-based for EVERY JSON value type, and (finding 3) the layout must
/// NOT mutate on the rejected split.
#[tokio::test]
async fn legacy_reject_split() {
    let state = state_with_registry();
    let router = app(state);
    let (_tab_id, pane_id, _terminal_id) = create_shell_tab(router.clone()).await;
    for (label, val) in [
        ("string", json!("legacy-split")),
        ("empty-string", json!("")),
        ("null", json!(null)),
        ("number", json!(42)),
    ] {
        let (s1, before) = get(router.clone(), "/api/tabs", true).await;
        assert_eq!(s1, StatusCode::OK);
        let (status, body) = post(
            router.clone(),
            &format!("/api/panes/{pane_id}/split"),
            json!({"direction": "horizontal", "mode": "claude", "resumeSessionId": val}),
            true,
        )
        .await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "{label} split legacy reject: {body}"
        );
        assert_eq!(
            body["message"],
            json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."),
            "{label}: {body}"
        );
        let (s2, after) = get(router.clone(), "/api/tabs", true).await;
        assert_eq!(s2, StatusCode::OK);
        // Finding 3: layout MUST be unchanged — the door-top check fires
        // BEFORE layout.split_pane.
        assert_eq!(
            before["data"]["tabs"], after["data"]["tabs"],
            "{label}: layout must not mutate on a rejected split"
        );
    }
}

// ── close ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn close_unknown_pane_is_ok_with_not_found_message() {
    // With a snapshot present, an unresolvable target falls back to the raw
    // pane id (Node `resolvePaneTarget`) and the STORE reports the graceful
    // `{message:'pane not found'}` (the empty-store 404 lives in
    // `store_tests`).
    let state = state_with_registry();
    let router = app(state.clone());
    let (_tab_id, _pane_id, terminal_id) = create_shell_tab(router.clone()).await;

    let (status, body) = post(router, "/api/panes/does-not-exist/close", json!({}), true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["message"], json!("pane not found"));

    state.terminal_registry.clone().unwrap().kill(&terminal_id);
}

#[tokio::test]
async fn close_only_pane_in_tab_is_refused() {
    let state = state_with_registry();
    let router = app(state.clone());
    let (_tab_id, pane_id, terminal_id) = create_shell_tab(router.clone()).await;

    let (status, body) = post(
        router,
        &format!("/api/panes/{pane_id}/close"),
        json!({}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["message"], json!("cannot close only pane"));
    // Untouched: the pane is still resolvable and its terminal still runs.
    assert!(state.pane_tabs.lock().unwrap().contains_key(&pane_id));
    assert!(state
        .terminal_registry
        .clone()
        .unwrap()
        .is_running(&terminal_id));

    state.terminal_registry.clone().unwrap().kill(&terminal_id);
}

/// The required split-then-close lifecycle: split creates a second real
/// pane/PTY, close removes ONLY this crate's bookkeeping for it -- the PTY
/// keeps running in the shared registry (this module's documented
/// PTY-cleanup-parity finding: legacy never kills on pane close), so
/// there is no orphan (it remains tracked by the SAME registry every
/// other surface uses) and no leak of crate-local bookkeeping either.
#[tokio::test]
async fn split_then_close_removes_bookkeeping_but_keeps_pty_alive_no_orphan() {
    let state = state_with_registry();
    let router = app(state.clone());
    let (tab_id, first_pane_id, first_terminal_id) = create_shell_tab(router.clone()).await;

    let tmp = std::env::temp_dir();
    let (status, split_body) = post(
        router.clone(),
        &format!("/api/panes/{first_pane_id}/split"),
        json!({ "cwd": tmp.to_string_lossy() }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{split_body}");
    let new_pane_id = split_body["data"]["paneId"].as_str().unwrap().to_string();
    let new_terminal_id = split_body["data"]["terminalId"]
        .as_str()
        .unwrap()
        .to_string();

    let (status, close_body) = post(
        router,
        &format!("/api/panes/{new_pane_id}/close"),
        json!({}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{close_body}");
    assert_eq!(close_body["data"]["tabId"], json!(tab_id));

    // Bookkeeping removed: the closed pane no longer resolves.
    assert!(!state.pane_tabs.lock().unwrap().contains_key(&new_pane_id));
    assert!(!state
        .terminal_panes
        .lock()
        .unwrap()
        .contains_key(&new_pane_id));

    // No orphan PTY: registry state proves BOTH terminals are still
    // tracked and running (background-session semantics, not a leak).
    let registry = state.terminal_registry.clone().unwrap();
    assert!(registry.is_running(&first_terminal_id));
    assert!(registry.is_running(&new_terminal_id));

    registry.kill(&first_terminal_id);
    registry.kill(&new_terminal_id);
}

// ── select ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn select_unknown_pane_is_ok_with_not_found_message_and_no_broadcast() {
    // Snapshot present (create seeds the store), unresolvable target ->
    // raw-id fallback -> the STORE's graceful `{message:'pane not found'}`
    // (the empty-store 404 lives in `store_tests`).
    let state = state_with_registry();
    let router = app(state.clone());
    let (_tab_id, _pane_id, terminal_id) = create_shell_tab(router.clone()).await;
    let mut rx = state.broadcast_tx.subscribe();

    let (status, body) = post(router, "/api/panes/does-not-exist/select", json!({}), true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["message"], json!("pane not found"));
    assert!(
        rx.try_recv().is_err(),
        "must not broadcast for unresolved pane"
    );

    state.terminal_registry.clone().unwrap().kill(&terminal_id);
}

#[tokio::test]
async fn select_pane_resolves_tab_via_pane_tabs_and_broadcasts() {
    let state = state_with_registry();
    let router = app(state.clone());
    let mut rx = state.broadcast_tx.subscribe();
    let (tab_id, pane_id, terminal_id) = create_shell_tab(router.clone()).await;
    let _ = rx.recv().await; // drain tab.create

    let (status, body) = post(
        router,
        &format!("/api/panes/{pane_id}/select"),
        json!({}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["tabId"], json!(tab_id));
    assert_eq!(body["data"]["paneId"], json!(pane_id));

    let frame = rx.recv().await.expect("pane.select broadcast");
    let msg: Value = serde_json::from_str(&frame).unwrap();
    assert_eq!(msg["command"], json!("pane.select"));
    assert_eq!(msg["payload"]["tabId"], json!(tab_id));
    assert_eq!(msg["payload"]["paneId"], json!(pane_id));

    state.terminal_registry.clone().unwrap().kill(&terminal_id);
}

// ── layout/snapshot ──────────────────────────────────────────────────

#[tokio::test]
async fn layout_snapshot_requires_auth() {
    let state = state_with_registry();
    let (status, _) = get(app(state), "/api/layout/snapshot", false).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn layout_snapshot_empty_state_has_legacy_exact_top_level_keys() {
    let state = state_with_registry();
    let (status, body) = get(app(state), "/api/layout/snapshot", true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let data = &body["data"];
    assert_eq!(data["tabs"], json!([]));
    assert!(data["activeTabId"].is_null());
    assert_eq!(data["layouts"], json!({}));
    assert_eq!(data["activePane"], json!({}));
    assert_eq!(data["paneTitles"], json!({}));
    assert_eq!(data["paneTitleSetByUser"], json!({}));
}

#[tokio::test]
async fn layout_snapshot_single_pane_tab_is_a_real_leaf_node() {
    let state = state_with_registry();
    let router = app(state.clone());
    let (tab_id, pane_id, terminal_id) = create_shell_tab(router.clone()).await;

    let (status, body) = get(router, "/api/layout/snapshot", true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let data = &body["data"];
    assert_eq!(data["tabs"][0]["id"], json!(tab_id));
    let leaf = &data["layouts"][&tab_id];
    assert_eq!(leaf["type"], json!("leaf"));
    assert_eq!(leaf["id"], json!(pane_id));
    assert_eq!(leaf["content"]["kind"], json!("terminal"));
    assert_eq!(leaf["content"]["terminalId"], json!(terminal_id));

    state.terminal_registry.clone().unwrap().kill(&terminal_id);
}

#[tokio::test]
async fn layout_snapshot_multi_pane_tab_is_a_real_split_node() {
    // The Slice 3b-2 `{type:'unknown'}` honest-deferral marker is dead: the
    // shared LayoutStore tracks real split geometry now (Task 15, AUTO-06).
    let state = state_with_registry();
    let router = app(state.clone());
    let (tab_id, first_pane_id, first_terminal_id) = create_shell_tab(router.clone()).await;

    let tmp = std::env::temp_dir();
    let (status, split_body) = post(
        router.clone(),
        &format!("/api/panes/{first_pane_id}/split"),
        json!({ "cwd": tmp.to_string_lossy(), "direction": "vertical" }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{split_body}");
    let second_pane_id = split_body["data"]["paneId"].as_str().unwrap().to_string();
    let second_terminal_id = split_body["data"]["terminalId"]
        .as_str()
        .unwrap()
        .to_string();

    let (status, body) = get(router, "/api/layout/snapshot", true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let node = &body["data"]["layouts"][&tab_id];
    assert_eq!(node["type"], json!("split"), "{body}");
    assert_eq!(node["direction"], json!("vertical"));
    assert_eq!(node["sizes"], json!([50, 50]));
    assert_eq!(node["children"][0]["id"], json!(first_pane_id));
    assert_eq!(node["children"][1]["id"], json!(second_pane_id));

    let registry = state.terminal_registry.clone().unwrap();
    registry.kill(&first_terminal_id);
    registry.kill(&second_terminal_id);
}

#[tokio::test]
async fn layout_snapshot_tab_id_filter_narrows_to_one_tab() {
    let state = state_with_registry();
    let router = app(state.clone());
    let (tab_a, _pane_a, terminal_a) = create_shell_tab(router.clone()).await;
    let (_tab_b, _pane_b, terminal_b) = create_shell_tab(router.clone()).await;

    let (status, body) = get(router, &format!("/api/layout/snapshot?tabId={tab_a}"), true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let tabs = body["data"]["tabs"].as_array().unwrap();
    assert_eq!(tabs.len(), 1, "{body}");
    assert_eq!(tabs[0]["id"], json!(tab_a));

    let registry = state.terminal_registry.clone().unwrap();
    registry.kill(&terminal_a);
    registry.kill(&terminal_b);
}

// ── navigate ─────────────────────────────────────────────────────────

#[tokio::test]
async fn navigate_pane_requires_auth() {
    let state = state_with_registry();
    let (status, _) = post(app(state), "/api/panes/nope/navigate", json!({}), false).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn navigate_pane_missing_url_is_400() {
    let state = state_with_registry();
    let (status, body) = post(app(state), "/api/panes/nope/navigate", json!({}), true).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["message"], json!("url required"));
}

#[tokio::test]
async fn navigate_unknown_pane_is_404() {
    let state = state_with_registry();
    let (status, body) = post(
        app(state),
        "/api/panes/does-not-exist/navigate",
        json!({ "url": "https://example.com" }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["message"], json!("pane not found"));
}

#[tokio::test]
async fn navigate_pane_success_sets_browser_content_and_broadcasts_pane_attach() {
    let state = state_with_registry();
    let router = app(state.clone());
    let mut rx = state.broadcast_tx.subscribe();
    let (tab_id, pane_id, terminal_id) = create_shell_tab(router.clone()).await;
    let _ = rx.recv().await; // drain tab.create

    let (status, body) = post(
        router,
        &format!("/api/panes/{pane_id}/navigate"),
        json!({ "url": "https://example.com" }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["message"], json!("navigate requested"));

    let frame = rx.recv().await.expect("pane.attach broadcast");
    let msg: Value = serde_json::from_str(&frame).unwrap();
    assert_eq!(msg["command"], json!("pane.attach"));
    assert_eq!(msg["payload"]["tabId"], json!(tab_id));
    assert_eq!(msg["payload"]["paneId"], json!(pane_id));
    assert_eq!(msg["payload"]["content"]["kind"], json!("browser"));
    assert_eq!(
        msg["payload"]["content"]["url"],
        json!("https://example.com")
    );

    assert!(state.content_panes.lock().unwrap().get(&pane_id).is_some());
    assert!(!state.terminal_panes.lock().unwrap().contains_key(&pane_id));

    state.terminal_registry.clone().unwrap().kill(&terminal_id);
}

// ── respawn ──────────────────────────────────────────────────────────

#[tokio::test]
async fn respawn_pane_requires_auth() {
    let state = state_with_registry();
    let (status, _) = post(app(state), "/api/panes/nope/respawn", json!({}), false).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn respawn_unknown_pane_is_404() {
    let state = state_with_registry();
    let (status, body) = post(
        app(state),
        "/api/panes/does-not-exist/respawn",
        json!({}),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["message"], json!("pane not found"));
}

#[tokio::test]
async fn respawn_pane_replaces_terminal_in_place_and_broadcasts_pane_attach() {
    let state = state_with_registry();
    let router = app(state.clone());
    let mut rx = state.broadcast_tx.subscribe();
    let (tab_id, pane_id, old_terminal_id) = create_shell_tab(router.clone()).await;
    let _ = rx.recv().await; // drain tab.create

    let tmp = std::env::temp_dir();
    let (status, body) = post(
        router,
        &format!("/api/panes/{pane_id}/respawn"),
        json!({ "cwd": tmp.to_string_lossy() }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let new_terminal_id = body["data"]["terminalId"].as_str().unwrap().to_string();
    assert_ne!(new_terminal_id, old_terminal_id);

    let frame = rx.recv().await.expect("pane.attach broadcast");
    let msg: Value = serde_json::from_str(&frame).unwrap();
    assert_eq!(msg["command"], json!("pane.attach"));
    assert_eq!(msg["payload"]["tabId"], json!(tab_id));
    assert_eq!(msg["payload"]["paneId"], json!(pane_id));
    assert_eq!(
        msg["payload"]["content"]["terminalId"],
        json!(new_terminal_id)
    );
    // Task 3: respawn ROTATES the pane key — the broadcast content carries
    // a fresh server-minted 32-hex createRequestId. Intentional legacy
    // parity (router.ts:1602 mints per respawn) and required so
    // reconcile's newest_live_by_create_request_id resolves the pane to
    // the REPLACEMENT terminal, not the detached old one.
    let crid = msg["payload"]["content"]["createRequestId"]
        .as_str()
        .expect("respawn content.createRequestId missing");
    assert_eq!(crid.len(), 32, "expected Uuid::simple format, got {crid:?}");
    assert!(crid.chars().all(|c| c.is_ascii_hexdigit()));

    // Bookkeeping now points the SAME pane id at the NEW terminal --
    // "replace in place", not a second pane.
    assert_eq!(
        state
            .terminal_panes
            .lock()
            .unwrap()
            .get(&pane_id)
            .unwrap()
            .terminal_id,
        new_terminal_id
    );

    // Old terminal is orphaned-from-this-pane but still running in the
    // shared registry (detach, don't kill -- this module's documented
    // PTY-cleanup-parity finding, which this route also honors).
    let registry = state.terminal_registry.clone().unwrap();
    assert!(registry.is_running(&old_terminal_id));
    assert!(registry.is_running(&new_terminal_id));

    // The NEW terminal's registry row was stamped with the SAME key
    // (atomic insert) — the old terminal keeps its own lineage.
    assert_eq!(
        registry
            .probe_create_request_id(&new_terminal_id)
            .as_deref(),
        Some(crid),
    );

    registry.kill(&old_terminal_id);
    registry.kill(&new_terminal_id);
}

/// kata ejh6: `POST /api/panes/:id/respawn` REFUSES a body carrying the
/// legacy `resumeSessionId` field at the door-top — 400 with the frozen
/// text, presence-based for EVERY JSON value type, BEFORE any spawn.
#[tokio::test]
async fn legacy_reject_respawn() {
    let state = state_with_registry();
    let router = app(state);
    let (_tab_id, pane_id, _terminal_id) = create_shell_tab(router.clone()).await;
    for (label, val) in [
        ("string", json!("legacy-respawn")),
        ("empty-string", json!("")),
        ("null", json!(null)),
        ("number", json!(42)),
    ] {
        let (status, body) = post(
            router.clone(),
            &format!("/api/panes/{pane_id}/respawn"),
            json!({"mode": "claude", "resumeSessionId": val}),
            true,
        )
        .await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "{label} respawn legacy reject: {body}"
        );
        assert_eq!(
            body["message"],
            json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."),
            "{label}: {body}"
        );
    }
}

// ── attach (honest deferral) ─────────────────────────────────────────

#[tokio::test]
async fn attach_pane_requires_auth() {
    let state = state_with_registry();
    let (status, _) = post(app(state), "/api/panes/nope/attach", json!({}), false).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn attach_pane_is_honest_400_deferral() {
    let state = state_with_registry();
    let (status, body) = post(app(state), "/api/panes/nope/attach", json!({}), true).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let msg = body["message"].as_str().unwrap();
    assert!(msg.contains("TerminalIdentityRegistry"), "{msg}");
}

// ── resize (honest deferral) ─────────────────────────────────────────

#[tokio::test]
async fn resize_pane_requires_auth() {
    let state = state_with_registry();
    let (status, _) = post(app(state), "/api/panes/nope/resize", json!({}), false).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

// ── swap ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn swap_pane_requires_auth() {
    let state = state_with_registry();
    let (status, _) = post(app(state), "/api/panes/nope/swap", json!({}), false).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn swap_pane_missing_target_is_approx() {
    let state = state_with_registry();
    let (status, body) = post(app(state), "/api/panes/nope/swap", json!({}), true).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], json!("approx"));
    assert_eq!(body["message"], json!("swap target missing"));
}

#[tokio::test]
async fn swap_unknown_pane_is_ok_with_panes_not_found_message() {
    // Node parity fix (survey B.4): unknown panes are the store's graceful
    // 200 `{message:'panes not found'}`, not the Slice 3b-1 404.
    let state = state_with_registry();
    let router = app(state.clone());
    let (_tab_id, pane_id, terminal_id) = create_shell_tab(router.clone()).await;

    let (status, body) = post(
        router,
        "/api/panes/does-not-exist/swap",
        json!({ "target": pane_id }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["message"], json!("panes not found"));

    state.terminal_registry.clone().unwrap().kill(&terminal_id);
}

#[tokio::test]
async fn swap_unknown_other_is_ok_with_panes_not_found_message() {
    let state = state_with_registry();
    let router = app(state.clone());
    let (_tab_id, pane_id, terminal_id) = create_shell_tab(router.clone()).await;

    let (status, body) = post(
        router,
        &format!("/api/panes/{pane_id}/swap"),
        json!({ "target": "does-not-exist" }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["message"], json!("panes not found"));

    state.terminal_registry.clone().unwrap().kill(&terminal_id);
}

#[tokio::test]
async fn swap_cross_tab_panes_reports_panes_not_found() {
    let state = state_with_registry();
    let router = app(state.clone());
    let (_tab_a, pane_a, terminal_a) = create_shell_tab(router.clone()).await;
    let (_tab_b, pane_b, terminal_b) = create_shell_tab(router.clone()).await;

    let (status, body) = post(
        router,
        &format!("/api/panes/{pane_a}/swap"),
        json!({ "target": pane_b }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["message"], json!("panes not found"));

    let registry = state.terminal_registry.clone().unwrap();
    registry.kill(&terminal_a);
    registry.kill(&terminal_b);
}

#[tokio::test]
async fn swap_two_terminal_panes_in_same_tab_exchanges_bookkeeping_and_broadcasts() {
    let state = state_with_registry();
    let router = app(state.clone());
    let mut rx = state.broadcast_tx.subscribe();
    let (tab_id, first_pane_id, first_terminal_id) = create_shell_tab(router.clone()).await;
    let _ = rx.recv().await; // drain tab.create

    let tmp = std::env::temp_dir();
    let (status, split_body) = post(
        router.clone(),
        &format!("/api/panes/{first_pane_id}/split"),
        json!({ "cwd": tmp.to_string_lossy() }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{split_body}");
    let second_pane_id = split_body["data"]["paneId"].as_str().unwrap().to_string();
    let second_terminal_id = split_body["data"]["terminalId"]
        .as_str()
        .unwrap()
        .to_string();
    let _ = rx.recv().await; // drain pane.split

    let (status, body) = post(
        router,
        &format!("/api/panes/{first_pane_id}/swap"),
        json!({ "target": second_pane_id }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["tabId"], json!(tab_id));
    assert_eq!(body["message"], json!("panes swapped"));

    let frame = rx.recv().await.expect("pane.swap broadcast");
    let msg: Value = serde_json::from_str(&frame).unwrap();
    assert_eq!(msg["command"], json!("pane.swap"));
    assert_eq!(msg["payload"]["tabId"], json!(tab_id));
    assert_eq!(msg["payload"]["paneId"], json!(first_pane_id));
    assert_eq!(msg["payload"]["otherId"], json!(second_pane_id));

    // Bookkeeping exchanged: first pane id now owns the SECOND terminal
    // and vice versa.
    let terminal_panes = state.terminal_panes.lock().unwrap();
    assert_eq!(
        terminal_panes.get(&first_pane_id).unwrap().terminal_id,
        second_terminal_id
    );
    assert_eq!(
        terminal_panes.get(&second_pane_id).unwrap().terminal_id,
        first_terminal_id
    );
    drop(terminal_panes);

    let registry = state.terminal_registry.clone().unwrap();
    registry.kill(&first_terminal_id);
    registry.kill(&second_terminal_id);
}
