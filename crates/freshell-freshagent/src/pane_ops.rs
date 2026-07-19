//! Slice 3b-1 of the agent-API + MCP parity spec
//! (`docs/plans/2026-07-18-agent-api-mcp-parity-spec.md` \u00a72.1/\u00a72.2): pane
//! lifecycle routes -- `POST /api/panes/:id/split`, `POST /api/panes/:id/close`,
//! `POST /api/panes/:id/select` -- and the tab-level lifecycle routes --
//! `POST /api/tabs/:id/select`, `PATCH /api/tabs/:id`, `DELETE /api/tabs/:id`.
//!
//! Kept in its own sibling module (not `terminal_tabs.rs`, already 1000+ lines,
//! and not `lib.rs`) per this slice's scope. Reuses [`terminal_tabs::spawn_terminal_pane`]
//! for the terminal-split path -- the SAME registry-create + provider-settings +
//! locator-arm pipeline `POST /api/tabs` uses, so a split terminal pane is
//! spawned through the ONE shared [`freshell_terminal::TerminalRegistry`] the WS
//! `terminal.create` path uses (spec \u00a79 Risk 1: no orphan PTYs from a second
//! spawn path).
//!
//! ## Server-side PTY cleanup parity (pane/tab close -- read before touching)
//!
//! The legacy `layoutStore.closePane`/`closeTab` (`server/agent-api/layout-store.ts:501-587`)
//! are PURE in-memory layout-tree mutations -- neither calls `registry.kill`/
//! `killAndWait` anywhere. The client-side `closePaneWithCleanup` thunk
//! (`src/store/tabsSlice.ts:449-465`) is likewise pure Redux bookkeeping (drafts/
//! attention state), with no terminal-kill dispatch either. This is intentional:
//! Freshell's terminal registry is a "detach, don't kill" design (`AGENTS.md`
//! "PTY Lifecycle": "On detach, process continues running (background
//! session)") -- closing a pane/tab removes it from the visible layout but the
//! spawned process keeps running as a background session, reachable via the
//! terminal registry's own routes (`/api/terminals/*`) until it exits or is
//! explicitly killed there, or reaped by the registry's own idle-timeout policy.
//! **This module mirrors that exactly: `close_pane`/`delete_tab` remove ONLY this
//! crate's local bookkeeping (`terminal_panes`/`content_panes`/`pane_tabs`/`tabs`
//! entries) and never call `registry.kill`/`killAndWait`.** No PTY leak results:
//! the terminal remains tracked by the SAME shared registry every other surface
//! uses, not orphaned outside any registry's view.

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::{Json, Router};
use serde_json::{json, Value};
use uuid::Uuid;

use freshell_protocol::{ServerMessage, UiCommand};

use crate::terminal_tabs::{spawn_terminal_pane, TerminalSpawnResult};
use crate::{authorized, fail_json, ok_json, parse_required_name, FreshAgentState, TabRecord};

/// Mount the pane + tab lifecycle routes onto an existing router. Split out of
/// [`crate::router`] so `lib.rs`'s route table stays a single glance-able list;
/// call this right after `crate::router(state)` (both share the SAME
/// `FreshAgentState`, so the sub-router composes via axum's `.merge`).
pub fn router(state: FreshAgentState) -> Router {
    Router::new()
        .route("/api/panes/{id}/split", axum::routing::post(split_pane))
        .route("/api/panes/{id}/close", axum::routing::post(close_pane))
        .route("/api/panes/{id}/select", axum::routing::post(select_pane))
        .route("/api/tabs/{id}/select", axum::routing::post(select_tab))
        .route("/api/tabs/{id}", axum::routing::patch(rename_tab))
        .route("/api/tabs/{id}", axum::routing::delete(delete_tab))
        .with_state(state)
}

// ── POST /api/panes/:id/split ──────────────────────────────────────────────

/// `POST /api/panes/:id/split` (`router.ts:1250-1394`). This port keeps no
/// server-side layout tree (see `lib.rs::rename_pane`'s doc comment for the
/// established precedent), so the source pane is resolved via
/// [`FreshAgentState::pane_tabs`] rather than `resolvePaneTarget`'s ambiguous-title
/// matching -- an unknown `paneId` is an honest 404, not the original's
/// title-resolution 409. `agent`-based fresh-agent splits (`router.ts:1258-1285`)
/// are an explicit, documented deferral (honest 400) -- out of this slice's
/// bounded scope (reusing the create/send-keys/capture agent machinery for a
/// split target is a separate, larger unit of work); browser/editor/terminal
/// splits are fully implemented.
pub(crate) async fn split_pane(
    State(state): State<FreshAgentState>,
    Path(pane_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }

    let Some(tab_id) = state
        .pane_tabs
        .lock()
        .expect("pane_tabs mutex")
        .get(&pane_id)
        .cloned()
    else {
        return fail_json(StatusCode::NOT_FOUND, "pane not found".to_string());
    };

    if body.get("agent").and_then(Value::as_str).is_some() {
        return fail_json(
            StatusCode::BAD_REQUEST,
            "splitting a fresh-agent pane (\"agent\") is not yet implemented on this server; \
             create a new tab with {\"agent\":...} instead"
                .to_string(),
        );
    }

    let direction = body
        .get("direction")
        .and_then(Value::as_str)
        .filter(|d| !d.is_empty())
        .unwrap_or("horizontal")
        .to_string();

    let new_pane_id = Uuid::new_v4().to_string();

    let new_content = if let Some(url) = body.get("browser").and_then(Value::as_str) {
        let content = json!({
            "kind": "browser",
            "url": url,
            "devToolsOpen": false,
        });
        state
            .content_panes
            .lock()
            .expect("content_panes mutex")
            .insert(new_pane_id.clone(), content.clone());
        content
    } else if let Some(file_path) = body.get("editor").and_then(Value::as_str) {
        let content = json!({
            "kind": "editor",
            "filePath": file_path,
            "language": Value::Null,
            "readOnly": false,
            "content": "",
            "viewMode": "source",
            "wordWrap": true,
        });
        state
            .content_panes
            .lock()
            .expect("content_panes mutex")
            .insert(new_pane_id.clone(), content.clone());
        content
    } else {
        match spawn_terminal_pane(&state, &body, &tab_id, &new_pane_id).await {
            Ok(TerminalSpawnResult { pane_content, .. }) => pane_content,
            Err(resp) => return resp,
        }
    };

    // `spawn_terminal_pane` already records `pane_tabs`/`terminal_panes` for the
    // terminal case; the cheap content kinds (browser/editor) need it recorded
    // here since they bypass that helper entirely.
    state
        .pane_tabs
        .lock()
        .expect("pane_tabs mutex")
        .insert(new_pane_id.clone(), tab_id.clone());

    let terminal_id = new_content.get("terminalId").cloned();

    // `ui.command{pane.split}` payload (`router.ts:1373-1382`): tabId, paneId
    // (the SOURCE pane), direction, newPaneId, newContent.
    state.broadcast(&ServerMessage::UiCommand(UiCommand {
        command: "pane.split".to_string(),
        payload: Some(json!({
            "tabId": tab_id,
            "paneId": pane_id,
            "direction": direction,
            "newPaneId": new_pane_id,
            "newContent": new_content,
        })),
    }));

    let message = if terminal_id.is_some() {
        "pane split"
    } else {
        "pane split (non-terminal)"
    };
    ok_json(
        json!({ "paneId": new_pane_id, "terminalId": terminal_id }),
        message,
    )
}

// ── POST /api/panes/:id/close ──────────────────────────────────────────────

/// `POST /api/panes/:id/close` (`router.ts:1429-1437`). See this module's top
/// doc comment for the PTY-cleanup-parity finding: this NEVER kills the
/// registry terminal, matching `layoutStore.closePane`'s pure layout-tree
/// mutation exactly. Mirrors the original's "cannot close only pane" guard
/// (`layout-store.ts:509`) -- refuses (leaves everything untouched) if this
/// pane is the tab's LAST remaining pane, and mirrors the original's
/// unconditional `ui.command{pane.close}` broadcast (`router.ts:1435`) even on
/// the not-found/refused paths (`tabId` is simply absent from the payload in
/// that case -- an inert fold on the frozen client, since
/// `closePaneWithCleanup({tabId: undefined, paneId})` no-ops when the tab
/// doesn't resolve).
pub(crate) async fn close_pane(
    State(state): State<FreshAgentState>,
    Path(pane_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }

    let tab_id = state
        .pane_tabs
        .lock()
        .expect("pane_tabs mutex")
        .get(&pane_id)
        .cloned();

    let (broadcast_tab_id, message, data) = match &tab_id {
        None => (
            None,
            "pane not found",
            json!({ "message": "pane not found" }),
        ),
        Some(tid) => {
            let siblings = state
                .pane_tabs
                .lock()
                .expect("pane_tabs mutex")
                .values()
                .filter(|t| *t == tid)
                .count();
            if siblings <= 1 {
                (
                    None,
                    "cannot close only pane",
                    json!({ "message": "cannot close only pane" }),
                )
            } else {
                state
                    .terminal_panes
                    .lock()
                    .expect("terminal_panes mutex")
                    .remove(&pane_id);
                state
                    .content_panes
                    .lock()
                    .expect("content_panes mutex")
                    .remove(&pane_id);
                state
                    .pane_tabs
                    .lock()
                    .expect("pane_tabs mutex")
                    .remove(&pane_id);
                (Some(tid.clone()), "pane closed", json!({ "tabId": tid }))
            }
        }
    };

    state.broadcast(&ServerMessage::UiCommand(UiCommand {
        command: "pane.close".to_string(),
        payload: Some(json!({ "tabId": broadcast_tab_id, "paneId": pane_id })),
    }));

    ok_json(data, message)
}

// ── POST /api/panes/:id/select ─────────────────────────────────────────────

/// `POST /api/panes/:id/select` (`router.ts:1439-1450`). Honors an explicit
/// `tabId` in the body when it names a real tab (`selectPane`'s
/// `tabExists`/`targetTab` fallback, `layout-store.ts:526-540`); otherwise
/// resolves the pane's owning tab via [`FreshAgentState::pane_tabs`]. Only
/// broadcasts `ui.command{pane.select}` when a tab actually resolved
/// (`router.ts:1446`'s `if (result?.tabId)` guard).
pub(crate) async fn select_pane(
    State(state): State<FreshAgentState>,
    Path(pane_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }

    let requested_tab_id = body
        .get("tabId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let tabs = state.tabs.lock().expect("tabs mutex");
    let tab_id = requested_tab_id
        .filter(|t| tabs.contains_key(t))
        .or_else(|| drop_and_lookup_pane_tab(&state, &pane_id));
    drop(tabs);

    match tab_id {
        Some(tid) => {
            state.broadcast(&ServerMessage::UiCommand(UiCommand {
                command: "pane.select".to_string(),
                payload: Some(json!({ "tabId": tid, "paneId": pane_id })),
            }));
            ok_json(json!({ "tabId": tid, "paneId": pane_id }), "pane selected")
        }
        None => ok_json(json!({ "message": "pane not found" }), "pane not found"),
    }
}

fn drop_and_lookup_pane_tab(state: &FreshAgentState, pane_id: &str) -> Option<String> {
    state
        .pane_tabs
        .lock()
        .expect("pane_tabs mutex")
        .get(pane_id)
        .cloned()
}

// ── POST /api/tabs/:id/select ───────────────────────────────────────────────

/// `POST /api/tabs/:id/select` (`router.ts:834-838`). Always broadcasts
/// `ui.command{tab.select}` regardless of whether the tab exists, matching the
/// original exactly (`selectTab` returns `{message:'tab not found'}` for an
/// unknown id, but the broadcast fires unconditionally either way).
pub(crate) async fn select_tab(
    State(state): State<FreshAgentState>,
    Path(tab_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }

    let exists = state.tabs.lock().expect("tabs mutex").contains_key(&tab_id);

    state.broadcast(&ServerMessage::UiCommand(UiCommand {
        command: "tab.select".to_string(),
        payload: Some(json!({ "id": tab_id })),
    }));

    if exists {
        ok_json(json!({ "tabId": tab_id }), "tab selected")
    } else {
        ok_json(json!({ "message": "tab not found" }), "tab not found")
    }
}

// ── PATCH /api/tabs/:id ─────────────────────────────────────────────────────

/// `PATCH /api/tabs/:id` (`router.ts:840-849`): rename a tab. Legacy applies no
/// length bound here (unlike `PATCH /api/panes/:id`'s `MAX_TERMINAL_TITLE_OVERRIDE_LENGTH`
/// check) -- mirrored exactly, no bound added.
pub(crate) async fn rename_tab(
    State(state): State<FreshAgentState>,
    Path(tab_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }

    let Some(name) = parse_required_name(body.get("name")) else {
        return fail_json(StatusCode::BAD_REQUEST, "name required".to_string());
    };

    let mut tabs = state.tabs.lock().expect("tabs mutex");
    let Some(record) = tabs.get_mut(&tab_id) else {
        drop(tabs);
        return ok_json(json!({ "message": "tab not found" }), "tab not found");
    };
    record.title = Some(name.clone());
    drop(tabs);

    state.broadcast(&ServerMessage::UiCommand(UiCommand {
        command: "tab.rename".to_string(),
        payload: Some(json!({ "id": tab_id, "title": name })),
    }));

    ok_json(json!({ "tabId": tab_id }), "tab renamed")
}

// ── DELETE /api/tabs/:id ─────────────────────────────────────────────────────

/// `DELETE /api/tabs/:id` (`router.ts:851-855`): close a tab and every pane it
/// owns. Always broadcasts `ui.command{tab.close}` regardless of whether the
/// tab existed (matching `router.ts:853`'s unconditional broadcast, same
/// pattern as `select_tab`). See this module's top doc comment: this removes
/// ONLY local bookkeeping for every owned pane -- no `registry.kill` call, so
/// each pane's terminal (if any) keeps running as a background session in the
/// shared registry, exactly like the legacy `closeTab` does.
pub(crate) async fn delete_tab(
    State(state): State<FreshAgentState>,
    Path(tab_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }

    let removed: Option<TabRecord> = state.tabs.lock().expect("tabs mutex").remove(&tab_id);

    let (message, data) = if removed.is_some() {
        let owned_panes: Vec<String> = state
            .pane_tabs
            .lock()
            .expect("pane_tabs mutex")
            .iter()
            .filter(|(_, t)| *t == &tab_id)
            .map(|(p, _)| p.clone())
            .collect();
        for pane_id in owned_panes {
            state
                .terminal_panes
                .lock()
                .expect("terminal_panes mutex")
                .remove(&pane_id);
            state
                .content_panes
                .lock()
                .expect("content_panes mutex")
                .remove(&pane_id);
            state
                .pane_tabs
                .lock()
                .expect("pane_tabs mutex")
                .remove(&pane_id);
        }
        ("tab closed", json!({ "tabId": tab_id }))
    } else {
        ("tab not found", json!({ "message": "tab not found" }))
    };

    state.broadcast(&ServerMessage::UiCommand(UiCommand {
        command: "tab.close".to_string(),
        payload: Some(json!({ "id": tab_id })),
    }));

    ok_json(data, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use std::sync::Arc;
    use tower::util::ServiceExt;

    fn state_with_registry() -> FreshAgentState {
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
        FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx))
            .with_terminal_registry(freshell_terminal::TerminalRegistry::new())
    }

    fn app(state: FreshAgentState) -> Router {
        crate::router(state)
    }

    async fn body_json(resp: Response) -> Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    async fn post(router: Router, uri: &str, body: Value, auth: bool) -> (StatusCode, Value) {
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

    async fn patch(router: Router, uri: &str, body: Value, auth: bool) -> (StatusCode, Value) {
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

    async fn delete(router: Router, uri: &str, auth: bool) -> (StatusCode, Value) {
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
    async fn create_shell_tab(router: Router) -> (String, String, String) {
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

    #[tokio::test]
    async fn select_tab_requires_auth() {
        let state = state_with_registry();
        let (status, _) = post(app(state), "/api/tabs/nope/select", json!({}), false).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn rename_tab_requires_auth() {
        let state = state_with_registry();
        let (status, _) = patch(app(state), "/api/tabs/nope", json!({"name":"x"}), false).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn delete_tab_requires_auth() {
        let state = state_with_registry();
        let (status, _) = delete(app(state), "/api/tabs/nope", false).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    // ── split ───────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn split_unknown_pane_is_404() {
        let state = state_with_registry();
        let (status, body) = post(
            app(state),
            "/api/panes/does-not-exist/split",
            json!({}),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert_eq!(body["message"], json!("pane not found"));
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

    // ── close ───────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn close_unknown_pane_is_ok_with_not_found_message() {
        let state = state_with_registry();
        let (status, body) = post(
            app(state),
            "/api/panes/does-not-exist/close",
            json!({}),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["data"]["message"], json!("pane not found"));
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
        let state = state_with_registry();
        let mut rx = state.broadcast_tx.subscribe();
        let (status, body) = post(
            app(state),
            "/api/panes/does-not-exist/select",
            json!({}),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["data"]["message"], json!("pane not found"));
        assert!(
            rx.try_recv().is_err(),
            "must not broadcast for unresolved pane"
        );
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

    // ── tab select ──────────────────────────────────────────────────────────

    #[tokio::test]
    async fn select_unknown_tab_still_broadcasts_but_reports_not_found() {
        let state = state_with_registry();
        let mut rx = state.broadcast_tx.subscribe();
        let (status, body) = post(
            app(state),
            "/api/tabs/does-not-exist/select",
            json!({}),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["data"]["message"], json!("tab not found"));
        let frame = rx.recv().await.expect("legacy-exact: always broadcasts");
        let msg: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(msg["command"], json!("tab.select"));
    }

    #[tokio::test]
    async fn select_known_tab_succeeds() {
        let state = state_with_registry();
        let router = app(state.clone());
        let (tab_id, _pane_id, terminal_id) = create_shell_tab(router.clone()).await;

        let (status, body) = post(
            router,
            &format!("/api/tabs/{tab_id}/select"),
            json!({}),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["data"]["tabId"], json!(tab_id));

        state.terminal_registry.clone().unwrap().kill(&terminal_id);
    }

    // ── tab rename ──────────────────────────────────────────────────────────

    #[tokio::test]
    async fn rename_tab_missing_name_is_400() {
        let state = state_with_registry();
        let (status, body) = patch(app(state), "/api/tabs/does-not-exist", json!({}), true).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["message"], json!("name required"));
    }

    #[tokio::test]
    async fn rename_unknown_tab_reports_not_found() {
        let state = state_with_registry();
        let (status, body) = patch(
            app(state),
            "/api/tabs/does-not-exist",
            json!({"name":"New Name"}),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["data"]["message"], json!("tab not found"));
    }

    #[tokio::test]
    async fn rename_known_tab_broadcasts_tab_rename() {
        let state = state_with_registry();
        let router = app(state.clone());
        let mut rx = state.broadcast_tx.subscribe();
        let (tab_id, _pane_id, terminal_id) = create_shell_tab(router.clone()).await;
        let _ = rx.recv().await; // drain tab.create

        let (status, body) = patch(
            router,
            &format!("/api/tabs/{tab_id}"),
            json!({"name":"Renamed"}),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["data"]["tabId"], json!(tab_id));

        let frame = rx.recv().await.expect("tab.rename broadcast");
        let msg: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(msg["command"], json!("tab.rename"));
        assert_eq!(msg["payload"]["id"], json!(tab_id));
        assert_eq!(msg["payload"]["title"], json!("Renamed"));

        state.terminal_registry.clone().unwrap().kill(&terminal_id);
    }

    // ── tab delete ──────────────────────────────────────────────────────────

    #[tokio::test]
    async fn delete_unknown_tab_reports_not_found_but_still_broadcasts() {
        let state = state_with_registry();
        let mut rx = state.broadcast_tx.subscribe();
        let (status, body) = delete(app(state), "/api/tabs/does-not-exist", true).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["data"]["message"], json!("tab not found"));
        let frame = rx.recv().await.expect("legacy-exact: always broadcasts");
        let msg: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(msg["command"], json!("tab.close"));
    }

    #[tokio::test]
    async fn delete_tab_removes_tab_and_every_owned_pane_without_killing_ptys() {
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
        let second_pane_id = split_body["data"]["paneId"].as_str().unwrap().to_string();
        let second_terminal_id = split_body["data"]["terminalId"]
            .as_str()
            .unwrap()
            .to_string();

        let (status, body) = delete(router, &format!("/api/tabs/{tab_id}"), true).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["data"]["tabId"], json!(tab_id));

        assert!(!state.tabs.lock().unwrap().contains_key(&tab_id));
        assert!(!state.pane_tabs.lock().unwrap().contains_key(&first_pane_id));
        assert!(!state
            .pane_tabs
            .lock()
            .unwrap()
            .contains_key(&second_pane_id));

        // No PTY kill on tab close (this module's documented parity finding) --
        // both terminals remain tracked + running in the shared registry.
        let registry = state.terminal_registry.clone().unwrap();
        assert!(registry.is_running(&first_terminal_id));
        assert!(registry.is_running(&second_terminal_id));

        registry.kill(&first_terminal_id);
        registry.kill(&second_terminal_id);
    }
}
