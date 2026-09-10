//! Pane-route tests for [`crate::pane_ops`], split out of `pane_ops.rs` per
//! this branch's precedent (`layout_store_tests.rs`) to keep the route module
//! under the 1,000-line ceiling. Tab-route tests live in
//! `pane_ops_tab_tests.rs` (a sibling `#[path]` module that reuses this
//! module's `pub(super)` helpers).

use super::*;
use crate::hosted_rest;
use axum::body::Body;
use axum::http::Request;
use std::sync::Arc;
use tower::util::ServiceExt;

struct SplitHostedGateway;

#[async_trait::async_trait]
impl hosted_rest::HostedFreshAgentRestGateway for SplitHostedGateway {
    async fn create_agent(
        self: Arc<Self>,
        request: hosted_rest::HostedRestCreate,
    ) -> Result<hosted_rest::HostedRestCreated, ()> {
        assert_eq!(
            (request.provider.as_str(), request.session_type.as_str()),
            ("claude", "freshclaude")
        );
        Ok(hosted_rest::HostedRestCreated {
            session_id: "managed-split-claude".into(),
        })
    }

    async fn send_agent(
        &self,
        _request: hosted_rest::HostedRestSend,
    ) -> Result<hosted_rest::HostedRestSendResult, ()> {
        unreachable!("split creation does not send a prompt")
    }
}

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
async fn split_agent_without_durable_gateway_is_503_and_rolls_back_layout() {
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
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    let msg = body["message"].as_str().unwrap();
    assert!(msg.contains("gateway"), "{msg}");
    assert_eq!(state.layout.list_panes(None).unwrap().len(), 1);
}

#[tokio::test]
async fn split_agent_routes_to_durable_gateway_and_attaches_fresh_content() {
    let state = state_with_registry();
    state
        .set_hosted_rest_gateway(Arc::new(SplitHostedGateway))
        .unwrap();
    let router = app(state.clone());
    let (tab_id, pane_id, _terminal_id) = create_shell_tab(router.clone()).await;
    let (status, body) = post(
        router,
        &format!("/api/panes/{pane_id}/split"),
        json!({ "agent": "claude", "cwd": "/workspace" }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let new_pane_id = body["data"]["paneId"].as_str().unwrap();
    let rows = state.layout.list_panes(Some(&tab_id)).unwrap();
    let created = rows.iter().find(|row| row.id == new_pane_id).unwrap();
    assert_eq!(created.kind.as_deref(), Some("fresh-agent"));
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

/// kata b8ke Task 10: a pane that never populated `pane_tabs` AND is absent
/// from every synced layout answers the TYPED 404 (`PANE_NOT_FOUND` JSON
/// envelope) — only after the re-sync handshake fired and found nothing.
#[tokio::test]
async fn respawn_for_a_pane_that_never_populated_pane_tabs_is_typed_not_found() {
    let state = state_with_registry();
    let router = app(state.clone());
    let mut rx = state.broadcast_tx.subscribe();

    let (status, body) = post(router, "/api/panes/does-not-exist/respawn", json!({}), true).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    // Typed JSON envelope, not the legacy bare "pane not found" string.
    assert_eq!(body["status"], json!("error"));
    assert_eq!(body["code"], json!("PANE_NOT_FOUND"));
    assert!(
        body["message"].as_str().unwrap().contains("does-not-exist"),
        "{body}"
    );

    // The re-sync handshake FIRED before the typed 404: the ui.command frame
    // was broadcast (no connected client answered it in this harness).
    let mut saw_resync = false;
    while let Ok(frame) = rx.try_recv() {
        let msg: Value = serde_json::from_str(&frame).unwrap();
        if msg["command"] == json!("layout.resync") {
            saw_resync = true;
        }
    }
    assert!(
        saw_resync,
        "the layout.resync handshake must fire before the typed 404"
    );
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

// ── attach (kata b8ke Task 10: implemented via the ownership coordinator
//    + the SessionIdentityLookup seam) ────────────────────────────────────

#[tokio::test]
async fn attach_pane_requires_auth() {
    let state = state_with_registry();
    let (status, _) = post(app(state), "/api/panes/nope/attach", json!({}), false).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

/// kata b8ke Task 10: a body without a well-formed `sessionRef { provider,
/// sessionId }` is the typed 400 naming exactly what the endpoint needs
/// (replacing the old unstructured honest-deferral 400).
#[tokio::test]
async fn attach_pane_without_session_ref_is_typed_bad_request() {
    let state = state_with_registry();
    let (status, body) = post(app(state), "/api/panes/nope/attach", json!({}), true).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["status"], json!("error"));
    assert_eq!(body["code"], json!("BAD_REQUEST"));
    let msg = body["message"].as_str().unwrap();
    assert!(msg.contains("sessionRef"), "{msg}");
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

// ── kata b8ke Task 10: respawn via LayoutStore + typed ownership + attach ──

/// A spawnable `claude` CLI spec (the terminal_tabs test-suite's sleeper
/// idiom, scoped here): a real `/bin/sh` sleeper so `registry.create`
/// genuinely spawns, with both resume and create-session args so every
/// LaunchIntent resolves.
fn task10_claude_spec() -> freshell_platform::CliCommandSpec {
    let script_path = std::env::temp_dir().join(format!(
        "freshell-task10-claude-{}-{}.sh",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::write(&script_path, "#!/bin/sh\nexec sleep 30\n").expect("write sleeper script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script_path).unwrap().permissions();
        perms.set_mode(0o755);
        let _ = std::fs::set_permissions(&script_path, perms);
    }
    freshell_platform::CliCommandSpec {
        name: "claude".to_string(),
        label: "Claude CLI".to_string(),
        env_var: None,
        default_cmd: script_path.to_string_lossy().to_string(),
        base_args: vec![],
        base_env: Default::default(),
        resume_args: Some(vec!["--resume".to_string(), "{{sessionId}}".to_string()]),
        create_session_args: Some(vec![
            "--session-id".to_string(),
            "{{sessionId}}".to_string(),
        ]),
        model_args: None,
        effort_args: None,
        sandbox_args: None,
        permission_mode_args: None,
    }
}

/// A browser-shaped `ui.layout.sync` carrying one terminal pane (the
/// client-minted id shape: the pane exists ONLY in the synced layout,
/// never in this crate's REST-side `pane_tabs`).
fn task10_ui_layout_sync(pane_id: &str, tab_id: &str) -> freshell_protocol::UiLayoutSync {
    task10_ui_layout_sync_with_status(pane_id, tab_id, "running")
}

/// The status-parameterized variant (round-2 review M3): the leaf walk is
/// status-blind, and error-status leaves (create-failed / restoreError
/// panes) are first-class resolution cases the brief names.
fn task10_ui_layout_sync_with_status(
    pane_id: &str,
    tab_id: &str,
    status: &str,
) -> freshell_protocol::UiLayoutSync {
    freshell_protocol::UiLayoutSync {
        tabs: vec![freshell_protocol::UiLayoutTab {
            name_source: None,
            id: tab_id.to_string(),
            title: Some("Task 10".to_string()),
            fallback_session_ref: None,
        }],
        layouts: json!({
            tab_id: {
                "type": "leaf",
                "id": pane_id,
                "content": {
                    "kind": "terminal",
                    "mode": "claude",
                    "status": status,
                    "createRequestId": "r-task10",
                },
            },
        }),
        active_pane: [(tab_id.to_string(), pane_id.to_string())]
            .into_iter()
            .collect(),
        timestamp: 1,
        active_tab_id: Some(Some(tab_id.to_string())),
        pane_titles: None,
        pane_title_set_by_user: None,
    }
}

/// Seed the coordinator with a LIVE owner of `kind` for `(provider, sid)`
/// and return the committed generation (the Task 3/6 lane test idiom).
fn task10_seed_live_owner(
    ownership: &Arc<freshell_ownership::RuntimeOwnershipRegistry>,
    provider: &str,
    sid: &str,
    kind: freshell_ownership::RuntimeOwnerKind,
    terminal_id: Option<&str>,
) -> u64 {
    let freshell_ownership::BeginOutcome::Granted { generation } =
        ownership.begin_start(provider, sid, kind, "op-task10", None, "test", 1)
    else {
        panic!("seed claim granted");
    };
    ownership.commit_live(
        provider,
        sid,
        "op-task10",
        generation,
        freshell_ownership::OwnerIdentity {
            kind,
            terminal_id: terminal_id.map(str::to_string),
            live_session_key: Some("task10-live-key".to_string()),
            pid: None,
            ownership_id: None,
        },
    );
    generation
}

/// The read-side identity seam stub (terminal_tabs' `StubSessionIdentity`
/// idiom, scoped here): answers `terminal_for_session` for ONE pair.
#[derive(Debug)]
struct Task10SessionIdentity {
    provider: &'static str,
    session_id: &'static str,
    terminal_id: &'static str,
}

impl freshell_terminal::registry::SessionIdentityLookup for Task10SessionIdentity {
    fn terminal_for_session(&self, provider: &str, session_id: &str) -> Option<String> {
        (self.provider == provider && self.session_id == session_id)
            .then(|| self.terminal_id.to_string())
    }
}

/// kata b8ke Task 10: a BROWSER-CREATED pane (client-minted id, synced via
/// `ui.layout.sync`, never in `pane_tabs`) respawns IN PLACE through the
/// LayoutStore — 200 + `ui.command{pane.attach}` carrying the same
/// client-minted tabId/paneId.
#[tokio::test]
async fn respawn_resolves_a_browser_created_pane_through_the_layout_store() {
    let state = state_with_registry().with_cli_commands(Arc::new(vec![task10_claude_spec()]));
    let router = app(state.clone());
    let mut rx = state.broadcast_tx.subscribe();

    // Simulate the browser sync: the pane exists ONLY in the layout store.
    state.layout.update_from_ui(
        &task10_ui_layout_sync("pane-browser-1", "tab-browser-1"),
        "client-a",
    );
    assert!(
        state
            .pane_tabs
            .lock()
            .unwrap()
            .get("pane-browser-1")
            .is_none(),
        "harness sanity: browser-created panes never enter pane_tabs"
    );

    let tmp = std::env::temp_dir();
    let (status, body) = post(
        router,
        "/api/panes/pane-browser-1/respawn",
        json!({
            "mode": "claude",
            "cwd": tmp.to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": "sid-r10-browser" },
        }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let terminal_id = body["data"]["terminalId"].as_str().unwrap().to_string();
    assert!(!terminal_id.is_empty());

    // Recovery IN PLACE: the broadcast carries the SAME client-minted ids.
    let frame = rx.recv().await.expect("pane.attach broadcast");
    let msg: Value = serde_json::from_str(&frame).unwrap();
    assert_eq!(msg["command"], json!("pane.attach"));
    assert_eq!(msg["payload"]["tabId"], json!("tab-browser-1"));
    assert_eq!(msg["payload"]["paneId"], json!("pane-browser-1"));
    assert_eq!(msg["payload"]["content"]["terminalId"], json!(terminal_id));

    // The REST bookkeeping now knows the pane (replace-in-place).
    assert_eq!(
        state
            .pane_tabs
            .lock()
            .unwrap()
            .get("pane-browser-1")
            .map(String::as_str),
        Some("tab-browser-1")
    );
    state.terminal_registry.clone().unwrap().kill(&terminal_id);
}

/// kata b8ke Task 10 (round-2 review M3): an ERROR-STATUS leaf — the
/// brief's create-failed / restoreError case (a pane whose spawn or
/// restore failed, so it never carries a live terminalId) — resolves
/// through the layout store exactly like a running one and respawns IN
/// PLACE. The leaf walk is status-blind by construction; this test pins
/// that contract directly.
#[tokio::test]
async fn respawn_resolves_a_create_failed_pane_through_the_layout_store() {
    let state = state_with_registry().with_cli_commands(Arc::new(vec![task10_claude_spec()]));
    let router = app(state.clone());
    let mut rx = state.broadcast_tx.subscribe();

    // A create-failed pane: error status + a restoreError marker, no
    // terminalId — the exact shape a failed spawn leaves in the mirror.
    let mut sync = task10_ui_layout_sync_with_status("pane-err-1", "tab-err-1", "create-failed");
    sync.layouts["tab-err-1"]["content"]["restoreError"] = json!({
        "code": "RESTORE_UNAVAILABLE",
        "reason": "spawn_failed"
    });
    state.layout.update_from_ui(&sync, "client-a");

    let tmp = std::env::temp_dir();
    let (status_code, body) = post(
        router,
        "/api/panes/pane-err-1/respawn",
        json!({
            "mode": "claude",
            "cwd": tmp.to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": "sid-r10-err" },
        }),
        true,
    )
    .await;
    assert_eq!(status_code, StatusCode::OK, "{body}");
    let terminal_id = body["data"]["terminalId"].as_str().unwrap().to_string();
    assert!(!terminal_id.is_empty());

    // Recovery IN PLACE: the broadcast carries the SAME client-minted ids.
    let frame = rx.recv().await.expect("pane.attach broadcast");
    let msg: Value = serde_json::from_str(&frame).unwrap();
    assert_eq!(msg["command"], json!("pane.attach"));
    assert_eq!(msg["payload"]["tabId"], json!("tab-err-1"));
    assert_eq!(msg["payload"]["paneId"], json!("pane-err-1"));
    assert_eq!(msg["payload"]["content"]["terminalId"], json!(terminal_id));

    assert_eq!(
        state
            .pane_tabs
            .lock()
            .unwrap()
            .get("pane-err-1")
            .map(String::as_str),
        Some("tab-err-1"),
        "recovery IN PLACE for an error-status leaf"
    );
    state.terminal_registry.clone().unwrap().kill(&terminal_id);
}

/// b8ke ext r21 F1: a browser-content pane seed — the stale shape the
/// authoritative snapshot must NOT keep after a respawn/attach recovers
/// the pane (the finding's "old browser/error/detached content").
fn r21_browser_content_ui_layout_sync(
    pane_id: &str,
    tab_id: &str,
) -> freshell_protocol::UiLayoutSync {
    freshell_protocol::UiLayoutSync {
        tabs: vec![freshell_protocol::UiLayoutTab {
            name_source: None,
            id: tab_id.to_string(),
            title: Some("R21".to_string()),
            fallback_session_ref: None,
        }],
        layouts: json!({
            tab_id: {
                "type": "leaf",
                "id": pane_id,
                "content": {
                    "kind": "browser",
                    "url": "https://example.com/stale",
                    "devToolsOpen": false,
                },
            },
        }),
        active_pane: [(tab_id.to_string(), pane_id.to_string())]
            .into_iter()
            .collect(),
        timestamp: 1,
        active_tab_id: Some(Some(tab_id.to_string())),
        pane_titles: None,
        pane_title_set_by_user: None,
    }
}

/// b8ke ext r21 F1: a HEADLESS respawn writes the recovered content through
/// the AUTHORITATIVE LayoutStore at the moment of the reply — the snapshot
/// (and the persisted layout a restart would load) carries the recovered
/// terminal content (mode, cwd, sessionRef, terminalId) even with NO
/// connected browser to mirror the pane.attach broadcast back. Pre-r21 the
/// broadcast was the only write: lost with no observer, the snapshot kept
/// the stale browser content.
#[tokio::test]
async fn respawn_writes_the_recovered_content_through_the_layout_store_headless() {
    let state = state_with_registry().with_cli_commands(Arc::new(vec![task10_claude_spec()]));
    let router = app(state.clone());

    // A browser-created pane whose snapshot content is BROWSER content.
    state.layout.update_from_ui(
        &r21_browser_content_ui_layout_sync("pane-r21-f1-respawn", "tab-r21-f1-respawn"),
        "client-r21-a",
    );
    let before = state
        .layout
        .get_pane_snapshot("pane-r21-f1-respawn")
        .expect("the seeded pane resolves");
    assert_eq!(
        before.kind.as_deref(),
        Some("browser"),
        "red-harness sanity: the seed holds the stale browser content"
    );

    let tmp = std::env::temp_dir();
    let (status, body) = post(
        router,
        "/api/panes/pane-r21-f1-respawn/respawn",
        json!({
            "mode": "claude",
            "cwd": tmp.to_string_lossy(),
            "sessionRef": { "provider": "claude", "sessionId": "sid-r21-f1-respawn" },
        }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let terminal_id = body["data"]["terminalId"].as_str().unwrap().to_string();
    assert!(!terminal_id.is_empty());

    // THE AUTHORITATIVE SNAPSHOT (no browser ever observed the broadcast):
    // the recovered terminal content — never the stale browser content.
    let pane = state
        .layout
        .get_pane_snapshot("pane-r21-f1-respawn")
        .expect("the pane stays resolvable in the authoritative store");
    assert_eq!(
        pane.kind.as_deref(),
        Some("terminal"),
        "the snapshot carries the recovered terminal content, not the stale browser content"
    );
    assert_eq!(pane.terminal_id.as_deref(), Some(terminal_id.as_str()));
    let content = pane.pane_content.expect("the recovered content");
    assert_eq!(content["mode"], json!("claude"));
    assert_eq!(
        content["sessionRef"]["sessionId"],
        json!("sid-r21-f1-respawn")
    );
    assert_eq!(content["initialCwd"], json!(tmp.to_string_lossy()));
    assert_eq!(content["terminalId"], json!(terminal_id));

    state.terminal_registry.clone().unwrap().kill(&terminal_id);
}

/// b8ke ext r21 F1: the DIRECT ATTACH path writes through the authoritative
/// LayoutStore too — a headless attach of a browser-content pane replaces
/// the stale snapshot content with the bound terminal content at the moment
/// of the reply (pre-r21 the broadcast was the only write).
#[tokio::test]
async fn attach_writes_the_rebound_content_through_the_layout_store_headless() {
    const SID: &str = "33333333-4444-5555-8666-777777777777";
    const TID: &str = "t-r21-live-owner";
    let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    let state = state_with_registry()
        .with_ownership(ownership.clone())
        .with_session_identity(Arc::new(Task10SessionIdentity {
            provider: "claude",
            session_id: SID,
            terminal_id: TID,
        }));
    let registry = state.terminal_registry.clone().unwrap();
    registry.register_headless(freshell_terminal::registry::HeadlessTerminal {
        terminal_id: TID.to_string(),
        stream_id: "s-r21".to_string(),
        mode: "claude".to_string(),
        resume_session_id: Some(SID.to_string()),
        create_request_id: None,
        created_at: None,
    });
    task10_seed_live_owner(
        &ownership,
        "claude",
        SID,
        freshell_ownership::RuntimeOwnerKind::Terminal,
        None,
    );

    let router = app(state.clone());

    // The pane exists ONLY in the synced layout, with stale browser content.
    state.layout.update_from_ui(
        &r21_browser_content_ui_layout_sync("pane-r21-f1-attach", "tab-r21-f1-attach"),
        "client-r21-b",
    );

    let (status, body) = post(
        router,
        "/api/panes/pane-r21-f1-attach/attach",
        json!({ "sessionRef": { "provider": "claude", "sessionId": SID } }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["ok"], json!(true));
    assert_eq!(body["data"]["terminalId"], json!(TID));

    // THE AUTHORITATIVE SNAPSHOT: the re-bound terminal content.
    let pane = state
        .layout
        .get_pane_snapshot("pane-r21-f1-attach")
        .expect("the pane stays resolvable in the authoritative store");
    assert_eq!(
        pane.kind.as_deref(),
        Some("terminal"),
        "the snapshot carries the re-bound terminal content, not the stale browser content"
    );
    assert_eq!(pane.terminal_id.as_deref(), Some(TID));
    let content = pane.pane_content.expect("the re-bound content");
    assert_eq!(content["mode"], json!("claude"));
    assert_eq!(content["terminalId"], json!(TID));
    assert_eq!(content["liveTerminal"]["terminalId"], json!(TID));
    assert_eq!(content["sessionRef"]["sessionId"], json!(SID));
}

/// kata b8ke Task 10 (round-1 review, authoritative registry): a pane that
/// exists in a CONNECTED browser but missed the mirror debounce
/// (create-then-immediately-respawn) is recovered by the re-sync
/// handshake, not 404'd — the owner client answers the `layout.resync`
/// broadcast and the bounded poll finds the pane.
#[tokio::test]
async fn respawn_miss_triggers_the_layout_resync_handshake_and_recovers_the_pane() {
    let state = state_with_registry().with_cli_commands(Arc::new(vec![task10_claude_spec()]));
    let router = app(state.clone());
    let mut rx = state.broadcast_tx.subscribe();

    // No layout synced yet — the handler must ASK before giving up.
    let router_for_task = router.clone();
    let respawn = tokio::spawn(async move {
        post(
            router_for_task,
            "/api/panes/pane-resync-1/respawn",
            json!({
                "mode": "claude",
                "cwd": std::env::temp_dir().to_string_lossy(),
                "sessionRef": { "provider": "claude", "sessionId": "sid-r10-resync" },
            }),
            true,
        )
        .await
    });

    // The handshake broadcast arrives; this test acts as the owner client.
    let frame = loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
            .await
            .expect("broadcast within 5s")
            .expect("stream open");
        let msg: Value = serde_json::from_str(&frame).unwrap();
        if msg["command"] == json!("layout.resync") {
            break frame;
        }
    };
    let _ = frame;
    state.layout.update_from_ui(
        &task10_ui_layout_sync("pane-resync-1", "tab-resync-1"),
        "client-a",
    );

    let (status, body) = respawn.await.expect("respawn task joined");
    assert_eq!(status, StatusCode::OK, "{body}");
    let terminal_id = body["data"]["terminalId"].as_str().unwrap().to_string();
    assert_eq!(
        state
            .pane_tabs
            .lock()
            .unwrap()
            .get("pane-resync-1")
            .map(String::as_str),
        Some("tab-resync-1"),
        "recovery IN PLACE, no 404"
    );
    state.terminal_registry.clone().unwrap().kill(&terminal_id);
}

/// kata b8ke Task 10 (round-1 review, DURABILITY): the multi-client
/// snapshot persists to disk on update (atomic temp+rename) and a NEW
/// store on the SAME path loads it on boot — a server restart no longer
/// loses the pane registry.
#[tokio::test]
async fn layout_store_survives_a_server_restart_via_disk_persistence() {
    let dir = std::env::temp_dir().join(format!(
        "freshell-task10-persist-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("layout-store.json");

    {
        let store = crate::layout_store::LayoutStore::with_persistence(path.clone());
        store.update_from_ui(&task10_ui_layout_sync("p1", "t1"), "client-a");
        // The persisted file is valid JSON in the snapshot shape.
        let raw = std::fs::read_to_string(&path).expect("persisted on update");
        let body: Value = serde_json::from_str(&raw).expect("valid JSON");
        assert_eq!(body["version"], json!(1));
        let clients = body["clients"].as_array().expect("clients array");
        assert!(!clients.is_empty(), "one entry per synced client: {raw}");
        assert!(clients[0]["snapshot"]["layouts"]["t1"].is_object());
        // No partial-write residue: the atomic-rename temp file is gone.
        assert!(!path.with_extension("tmp").exists());
    } // drop = the "restart"

    let reloaded = crate::layout_store::LayoutStore::with_persistence(path.clone());
    assert_eq!(
        reloaded.find_pane_tab("p1").as_deref(),
        Some("t1"),
        "the reloaded store resolves the pane from disk"
    );
    std::fs::remove_dir_all(&dir).ok();
}

/// kata b8ke Task 10 (REST-door D7 parity with the WS door's Task 13b
/// cross-kind live-guard): a session LIVE inside a fresh-agent sidecar
/// (the fresh create lane — no coordinator record by design, the D7 probe
/// backstop covers it) refuses a REST respawn with the same typed
/// RESTORE_UNAVAILABLE, and never spawns a second writer.
#[tokio::test]
async fn respawn_for_a_session_live_in_a_fresh_agent_sidecar_is_refused() {
    let state = state_with_registry()
        .with_cli_commands(Arc::new(vec![task10_claude_spec()]))
        .with_sidecar_liveness(Arc::new(|mode: &str, sid: &str| {
            let live = mode == "claude" && sid == "sid-r10-sidecar-live";
            Box::pin(std::future::ready(live))
                as std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>>
        }));
    let router = app(state.clone());

    let (_tab_id, pane_id, shell_terminal_id) = create_shell_tab(router.clone()).await;
    let rows_before = state
        .terminal_registry
        .clone()
        .unwrap()
        .identity_probe_rows()
        .len();

    let (status, body) = post(
        router,
        &format!("/api/panes/{pane_id}/respawn"),
        json!({
            "mode": "claude",
            "sessionRef": { "provider": "claude", "sessionId": "sid-r10-sidecar-live" },
        }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["status"], json!("error"));
    assert_eq!(body["code"], json!("RESTORE_UNAVAILABLE"));
    assert!(
        body["message"]
            .as_str()
            .unwrap()
            .contains("sid-r10-sidecar-live"),
        "{body}"
    );
    // No terminal spawned: the sidecar stays the one writer.
    assert_eq!(
        state
            .terminal_registry
            .clone()
            .unwrap()
            .identity_probe_rows()
            .len(),
        rows_before,
        "a sidecar-owned session must not gain a second writer"
    );
    state
        .terminal_registry
        .clone()
        .unwrap()
        .kill(&shell_terminal_id);
}

/// kata b8ke Task 10: a respawn whose sessionRef is owned by a live
/// fresh-agent runtime answers the TYPED 409 with the coordinator's owner
/// fields — and never spawns a second runtime.
#[tokio::test]
async fn respawn_ownership_conflict_returns_typed_owner_info() {
    let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    let state = state_with_registry()
        .with_cli_commands(Arc::new(vec![task10_claude_spec()]))
        .with_ownership(ownership.clone());
    let router = app(state.clone());

    let (_tab_id, pane_id, shell_terminal_id) = create_shell_tab(router.clone()).await;
    let sid = "sid-r10-conflict";
    let generation = task10_seed_live_owner(
        &ownership,
        "claude",
        sid,
        freshell_ownership::RuntimeOwnerKind::FreshAgent,
        None,
    );
    let rows_before = state
        .terminal_registry
        .clone()
        .unwrap()
        .identity_probe_rows()
        .len();

    let (status, body) = post(
        router,
        &format!("/api/panes/{pane_id}/respawn"),
        json!({
            "mode": "claude",
            "sessionRef": { "provider": "claude", "sessionId": sid },
        }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["status"], json!("error"));
    assert_eq!(body["code"], json!("RESTORE_UNAVAILABLE"));
    assert_eq!(body["ownerKind"], json!("fresh-agent"));
    assert_eq!(body["ownerGeneration"], json!(generation));
    // The sessionId is echoed unchanged in the envelope's message.
    assert!(body["message"].as_str().unwrap().contains(sid), "{body}");
    // No terminal spawned: the registry row count is unchanged.
    assert_eq!(
        state
            .terminal_registry
            .clone()
            .unwrap()
            .identity_probe_rows()
            .len(),
        rows_before,
        "a refused respawn must not spawn"
    );
    state
        .terminal_registry
        .clone()
        .unwrap()
        .kill(&shell_terminal_id);
}

/// kata b8ke Task 10 (round-2 review, lifecycle-message fence audit):
/// respawn is a runtime-creating lifecycle message — the body's
/// `observedEpoch`/`observedGeneration` pair threads to the coordinator
/// claim, so a stale request can never recreate ownership.
#[tokio::test]
async fn respawn_with_a_stale_observed_fence_cannot_recreate_ownership() {
    let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    let state = state_with_registry()
        .with_cli_commands(Arc::new(vec![task10_claude_spec()]))
        .with_ownership(ownership.clone());
    let router = app(state.clone());

    let (_tab_id, pane_id, shell_terminal_id) = create_shell_tab(router.clone()).await;
    let sid = "sid-r10-stale-fence";
    let generation = task10_seed_live_owner(
        &ownership,
        "claude",
        sid,
        freshell_ownership::RuntimeOwnerKind::FreshAgent,
        None,
    );

    // An observed pair from BEFORE the current owner's generation.
    let (status, body) = post(
        router,
        &format!("/api/panes/{pane_id}/respawn"),
        json!({
            "mode": "claude",
            "sessionRef": { "provider": "claude", "sessionId": sid },
            "observedEpoch": ownership.boot_epoch(),
            "observedGeneration": generation - 1,
        }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    let msg = body["message"].as_str().unwrap();
    assert!(msg.contains("stale observed generation"), "{body}");
    // b8ke ext r15 F2: the machine-readable ownership code rides the
    // envelope — REST/MCP callers distinguish stale ownership from other
    // failures (pre-r15 the stale refusal used the bare {status,message}
    // fail_json shape with NO code).
    assert_eq!(
        body["code"],
        json!("SESSION_RESERVED"),
        "the stale-generation refusal carries the typed ownership code: {body}"
    );
    // The current owner is untouched.
    let snap = ownership.observe("claude", sid);
    assert!(matches!(
        snap.state,
        freshell_ownership::OwnershipState::Live { .. }
    ));
    state
        .terminal_registry
        .clone()
        .unwrap()
        .kill(&shell_terminal_id);
}

/// kata b8ke Task 10: attach binds a TERMINAL-owned session to the pane —
/// the terminal id resolves through the `SessionIdentityLookup` seam (the
/// coordinator's owner carries no terminal id here, exactly the
/// cross-crate hole the seam was wired for), and the broadcast carries the
/// reattach content.
#[tokio::test]
async fn attach_pane_binds_a_terminal_owned_session_and_broadcasts_pane_attach() {
    const SID: &str = "33333333-4444-5555-8666-777777777777";
    const TID: &str = "t-r10-live-owner";
    let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    let state = state_with_registry()
        .with_ownership(ownership.clone())
        .with_session_identity(Arc::new(Task10SessionIdentity {
            provider: "claude",
            session_id: SID,
            terminal_id: TID,
        }));
    let registry = state.terminal_registry.clone().unwrap();
    // A Running claude-mode registry row for the terminal (headless: no PTY).
    registry.register_headless(freshell_terminal::registry::HeadlessTerminal {
        terminal_id: TID.to_string(),
        stream_id: "s-r10".to_string(),
        mode: "claude".to_string(),
        resume_session_id: Some(SID.to_string()),
        create_request_id: None,
        created_at: None,
    });
    // The terminal owns (claude, SID) — committed WITHOUT a terminal id so
    // the identity seam is the resolving surface this test pins.
    task10_seed_live_owner(
        &ownership,
        "claude",
        SID,
        freshell_ownership::RuntimeOwnerKind::Terminal,
        None,
    );

    let router = app(state.clone());
    let mut rx = state.broadcast_tx.subscribe();
    let (tab_id, pane_id, shell_terminal_id) = create_shell_tab(router.clone()).await;
    let _ = rx.recv().await; // drain tab.create

    let (status, body) = post(
        router,
        &format!("/api/panes/{pane_id}/attach"),
        json!({ "sessionRef": { "provider": "claude", "sessionId": SID } }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["ok"], json!(true));
    assert_eq!(body["data"]["terminalId"], json!(TID));

    // The broadcast re-binds the pane to the LIVE terminal.
    let frame = rx.recv().await.expect("pane.attach broadcast");
    let msg: Value = serde_json::from_str(&frame).unwrap();
    assert_eq!(msg["command"], json!("pane.attach"));
    assert_eq!(msg["payload"]["tabId"], json!(tab_id));
    assert_eq!(msg["payload"]["paneId"], json!(pane_id));
    assert_eq!(msg["payload"]["content"]["kind"], json!("terminal"));
    assert_eq!(msg["payload"]["content"]["mode"], json!("claude"));
    assert_eq!(msg["payload"]["content"]["terminalId"], json!(TID));
    assert_eq!(
        msg["payload"]["content"]["liveTerminal"]["terminalId"],
        json!(TID)
    );
    assert_eq!(
        msg["payload"]["content"]["sessionRef"]["sessionId"],
        json!(SID)
    );
    state
        .terminal_registry
        .clone()
        .unwrap()
        .kill(&shell_terminal_id);
}

// ── b8ke ext r23 F3: the attach consumes the probe status ─────────────

/// b8ke ext r23 F3: a terminal-owner attach against a DEAD or ABSENT
/// terminal row answers the typed RESTORE_UNAVAILABLE — never a
/// successful attachment of a running pane to a terminal that has
/// exited (pre-r23 the probe's status was ignored, the mode defaulted
/// to "shell", and the attach persisted + broadcast status "running"
/// for a dead terminal).
#[tokio::test]
async fn attach_pane_against_a_dead_terminal_answers_typed_restore_unavailable() {
    const SID: &str = "33333333-4444-5555-8666-7777777777aa";
    const TID: &str = "t-r23f3-dead-owner";
    let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    let state = state_with_registry()
        .with_ownership(ownership.clone())
        .with_session_identity(Arc::new(Task10SessionIdentity {
            provider: "claude",
            session_id: SID,
            terminal_id: TID,
        }));

    // The terminal OWNS the session on the coordinator — but its
    // registry row is ABSENT (it exited and was removed before the
    // attach).
    let freshell_ownership::BeginOutcome::Granted { generation } = ownership.begin_start(
        "claude",
        SID,
        freshell_ownership::RuntimeOwnerKind::Terminal,
        "op-r23f3",
        None,
        "test",
        0,
    ) else {
        panic!("expected Granted")
    };
    assert!(matches!(
        ownership.commit_live(
            "claude",
            SID,
            "op-r23f3",
            generation,
            freshell_ownership::OwnerIdentity {
                kind: freshell_ownership::RuntimeOwnerKind::Terminal,
                terminal_id: Some(TID.to_string()),
                live_session_key: None,
                pid: None,
                ownership_id: None,
            },
        ),
        freshell_ownership::CommitOutcome::Committed
    ));

    let router = app(state.clone());
    let mut rx = state.broadcast_tx.subscribe();
    let (_tab_id, pane_id, _shell) = create_shell_tab(router.clone()).await;
    let _ = rx.recv().await; // drain tab.create

    // THE ATTACH against the dead terminal: the typed refusal.
    let (status, body) = post(
        router,
        &format!("/api/panes/{pane_id}/attach"),
        json!({ "sessionRef": { "provider": "claude", "sessionId": SID } }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["status"], json!("error"), "{body}");
    assert_eq!(body["code"], json!("RESTORE_UNAVAILABLE"), "{body}");
    assert!(
        body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("exited or its row is absent"),
        "the typed refusal carries the dead-terminal reason: {body}"
    );

    // NO layout write or broadcast of a running attachment — the pane
    // never left its shell state (the broadcast channel carries only
    // the tab.create frame).
    let mut saw_pane_attach = false;
    while let Ok(frame) = rx.try_recv() {
        let msg: Value = serde_json::from_str(&frame).expect("json frame");
        if msg["command"] == json!("pane.attach") {
            saw_pane_attach = true;
        }
    }
    assert!(
        !saw_pane_attach,
        "no pane.attach broadcast may occur for a dead-terminal attach"
    );
    // The coordinator's owner record is UNCHANGED (the attach never
    // entered — no generation bump, no Handoff).
    assert!(matches!(
        ownership.observe("claude", SID).state,
        freshell_ownership::OwnershipState::Live { owner, .. }
            if owner.kind == freshell_ownership::RuntimeOwnerKind::Terminal
    ));
}

/// b8ke ext r7 F3: pane recovery resolves the coordinator's ALIAS CHAIN —
/// a pre-rekey sessionRef follows the canonical live owner and ATTACHES,
/// never the raw key's Aliased→HANDOFF_IN_PROGRESS dead end (the rekey
/// mirrors the canonical owner state onto the old key, so a superseded
/// pane holding the pre-rekey sessionRef must converge on the canonical
/// runtime).
#[tokio::test]
async fn attach_pane_for_a_rekeyed_session_resolves_the_canonical_owner() {
    const OLD_SID: &str = "33333333-4444-5555-8666-777777777777";
    const CANONICAL_SID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const TID: &str = "t-r7-canonical-owner";
    let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    let state = state_with_registry()
        .with_ownership(ownership.clone())
        .with_session_identity(Arc::new(Task10SessionIdentity {
            provider: "claude",
            session_id: CANONICAL_SID,
            terminal_id: TID,
        }));
    let registry = state.terminal_registry.clone().unwrap();
    registry.register_headless(freshell_terminal::registry::HeadlessTerminal {
        terminal_id: TID.to_string(),
        stream_id: "s-r7".to_string(),
        mode: "claude".to_string(),
        resume_session_id: Some(CANONICAL_SID.to_string()),
        create_request_id: None,
        created_at: None,
    });
    // The live terminal owner under the OLD key, then the rekey: OLD becomes
    // Aliased{to: CANONICAL} and the CANONICAL key holds Live{Terminal}
    // (committed without a terminal id so the identity seam is the
    // resolving surface).
    let generation = task10_seed_live_owner(
        &ownership,
        "claude",
        OLD_SID,
        freshell_ownership::RuntimeOwnerKind::Terminal,
        None,
    );
    assert!(matches!(
        ownership.rekey_live(
            "claude",
            OLD_SID,
            CANONICAL_SID,
            "task10-live-key",
            freshell_ownership::OwnerIdentity {
                kind: freshell_ownership::RuntimeOwnerKind::Terminal,
                terminal_id: None,
                live_session_key: Some("task10-live-key".to_string()),
                pid: None,
                ownership_id: Some("op-task10".to_string()),
            },
            "test-rekey",
            "op-rekey-r7",
        ),
        freshell_ownership::CommitOutcome::Committed
    ));
    assert!(matches!(
        ownership.observe("claude", OLD_SID).state,
        freshell_ownership::OwnershipState::Aliased { .. }
    ));

    let router = app(state.clone());
    let (tab_id, pane_id, shell_terminal_id) = create_shell_tab(router.clone()).await;

    // THE CONTRACT: the pre-rekey sessionRef's recovery follows the alias
    // chain to the CANONICAL owner and attaches (pre-r7 the raw Aliased
    // state fell to HANDOFF_IN_PROGRESS).
    let (status, body) = post(
        router,
        &format!("/api/panes/{pane_id}/attach"),
        json!({ "sessionRef": { "provider": "claude", "sessionId": OLD_SID } }),
        true,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "the rekeyed session's recovery attaches through the canonical owner: {body}"
    );
    assert_eq!(body["data"]["ok"], json!(true));
    assert_eq!(body["data"]["terminalId"], json!(TID));
    let _ = generation;
    let _ = tab_id;
    state
        .terminal_registry
        .clone()
        .unwrap()
        .kill(&shell_terminal_id);
}

/// kata b8ke Task 10: attach for a session owned by a live FRESH-AGENT
/// runtime answers the typed 409 owner info — never a blind rebind, and
/// (per the ownership-first contract) never a "pane not found" even for a
/// pane id that resolves nowhere.
#[tokio::test]
async fn attach_pane_for_a_fresh_owned_session_returns_typed_owner_info() {
    let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    let state = state_with_registry().with_ownership(ownership.clone());
    let sid = "sid-r10-attach-conflict";
    let generation = task10_seed_live_owner(
        &ownership,
        "claude",
        sid,
        freshell_ownership::RuntimeOwnerKind::FreshAgent,
        None,
    );

    let (status, body) = post(
        app(state),
        "/api/panes/pane-that-resolves-nowhere/attach",
        json!({ "sessionRef": { "provider": "claude", "sessionId": sid } }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["status"], json!("error"));
    assert_eq!(body["code"], json!("RESTORE_UNAVAILABLE"));
    assert_eq!(body["ownerKind"], json!("fresh-agent"));
    assert_eq!(body["ownerGeneration"], json!(generation));
    assert!(
        body["message"].as_str().unwrap().contains(sid),
        "sessionId echoed unchanged: {body}"
    );
}

/// kata b8ke Task 10: attach for a session NO runtime owns is the typed
/// SESSION_NOT_OWNED conflict (the caller should respawn instead).
#[tokio::test]
async fn attach_pane_for_an_unowned_session_is_typed_conflict() {
    let state = state_with_registry();
    let (status, body) = post(
        app(state),
        "/api/panes/any-pane/attach",
        json!({ "sessionRef": { "provider": "claude", "sessionId": "sid-unowned" } }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["status"], json!("error"));
    assert_eq!(body["code"], json!("SESSION_NOT_OWNED"));
}

/// kata b8ke Task 10: attach while a lifecycle operation is in flight
/// (Starting) is the typed HANDOFF_IN_PROGRESS conflict.
#[tokio::test]
async fn attach_pane_during_a_lifecycle_transition_is_typed_conflict() {
    let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    let state = state_with_registry().with_ownership(ownership.clone());
    let sid = "sid-r10-attach-starting";
    let freshell_ownership::BeginOutcome::Granted { .. } = ownership.begin_start(
        "claude",
        sid,
        freshell_ownership::RuntimeOwnerKind::FreshAgent,
        "op-in-flight",
        None,
        "test",
        1,
    ) else {
        panic!("seed claim granted");
    };

    let (status, body) = post(
        app(state),
        "/api/panes/any-pane/attach",
        json!({ "sessionRef": { "provider": "claude", "sessionId": sid } }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["status"], json!("error"));
    assert_eq!(body["code"], json!("HANDOFF_IN_PROGRESS"));
}
