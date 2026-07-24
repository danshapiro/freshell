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

use std::collections::HashMap;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::{Json, Router};
use serde_json::{json, Value};
use uuid::Uuid;

use freshell_protocol::{ServerMessage, UiCommand};

use crate::terminal_tabs::{spawn_terminal_pane, TerminalSpawnResult};
use crate::{
    approx_json, authorized, fail_json, ok_json, parse_required_name, FreshAgentState, TabRecord,
};

/// Mount the pane + tab lifecycle routes onto an existing router. Split out of
/// [`crate::router`] so `lib.rs`'s route table stays a single glance-able list;
/// call this right after `crate::router(state)` (both share the SAME
/// `FreshAgentState`, so the sub-router composes via axum's `.merge`).
pub fn router(state: FreshAgentState) -> Router {
    Router::new()
        .route("/api/panes/{id}/split", axum::routing::post(split_pane))
        .route("/api/panes/{id}/close", axum::routing::post(close_pane))
        .route("/api/panes/{id}/select", axum::routing::post(select_pane))
        .route("/api/panes/{id}/resize", axum::routing::post(resize_pane))
        .route("/api/panes/{id}/swap", axum::routing::post(swap_pane))
        .route("/api/panes/{id}/respawn", axum::routing::post(respawn_pane))
        .route("/api/panes/{id}/attach", axum::routing::post(attach_pane))
        .route(
            "/api/panes/{id}/navigate",
            axum::routing::post(navigate_pane),
        )
        .route("/api/tabs/{id}/select", axum::routing::post(select_tab))
        .route("/api/tabs/{id}", axum::routing::patch(rename_tab))
        .route("/api/tabs/{id}", axum::routing::delete(delete_tab))
        .route("/api/tabs/has", axum::routing::get(tabs_has))
        .route("/api/tabs/next", axum::routing::post(tabs_next))
        .route("/api/tabs/prev", axum::routing::post(tabs_prev))
        .route("/api/layout/snapshot", axum::routing::get(layout_snapshot))
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

// ── GET /api/tabs/has ───────────────────────────────────────────────────

/// `GET /api/tabs/has?target=` (`router.ts:857-861`): `{ exists }`. Legacy's
/// `layoutStore.hasTab` matches by id OR title (ambiguous-title resolution);
/// this port has no title-based lookup anywhere (the established precedent
/// across every route in this module -- `select_pane`/`rename_tab`/etc. all
/// resolve strictly by id via [`FreshAgentState::tabs`]/[`FreshAgentState::pane_tabs`]),
/// so `target` is matched against tab id ONLY. A missing/empty `target`
/// mirrors the original's `target ? ... : false` short-circuit.
pub(crate) async fn tabs_has(
    State(state): State<FreshAgentState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }
    let target = params.get("target").map(String::as_str).unwrap_or("");
    let exists = !target.is_empty() && state.tabs.lock().expect("tabs mutex").contains_key(target);
    ok_json(json!({ "exists": exists }), "")
}

// ── POST /api/tabs/next, POST /api/tabs/prev (honest deferral) ─────────

/// `POST /api/tabs/next` / `POST /api/tabs/prev` (`router.ts:863-877`): cycle
/// the active tab through an ORDERED tab list. Deferred: this port's
/// [`FreshAgentState::tabs`] is an unordered `HashMap` with no active-tab-id
/// concept at all -- `terminal_tabs::list_tabs` already hard-codes
/// `"activeTabId": Value::Null` for `GET /api/tabs` (an established Slice 1
/// reduced-fidelity precedent this route would need to break). Implementing
/// real cycling needs an ordered tab sequence + an active-tab pointer added
/// to the shared `FreshAgentState` struct in `lib.rs` -- out of this slice's
/// owned-file scope (`pane_ops.rs` + route registration + `terminal_tabs.rs`
/// only) while five other agents work concurrently in this same crate.
/// Returns an honest 400 naming exactly this gap rather than silently
/// no-op-ing or fabricating an ordering.
const TAB_CYCLE_DEFERRAL_MESSAGE: &str = "tab cycling (next/prev) is not implemented on this \
     server: it requires an ordered tab sequence + an active-tab id that FreshAgentState does \
     not model (GET /api/tabs already reports activeTabId: null, an established Slice 1 \
     precedent). Adding that state means extending FreshAgentState in lib.rs, which is out of \
     this slice's owned-file scope. Deferred pending tab-ordering/active-tab state landing.";

pub(crate) async fn tabs_next(
    State(state): State<FreshAgentState>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }
    fail_json(
        StatusCode::BAD_REQUEST,
        TAB_CYCLE_DEFERRAL_MESSAGE.to_string(),
    )
}

pub(crate) async fn tabs_prev(
    State(state): State<FreshAgentState>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }
    fail_json(
        StatusCode::BAD_REQUEST,
        TAB_CYCLE_DEFERRAL_MESSAGE.to_string(),
    )
}

// ── GET /api/layout/snapshot ────────────────────────────────────────────

/// `GET /api/layout/snapshot?tabId=` (`router.ts:885-896`): the normalized
/// `{tabs, activeTabId, layouts, activePane, paneTitles, paneTitleSetByUser}`
/// read model. Legacy's `layouts[tabId]` is a REAL binary split tree (nested
/// `{type:'split', direction, sizes, children}` nodes) -- this port keeps no
/// such tree (see this module's top doc comment and `rename_pane`'s doc
/// comment in `lib.rs` for the established precedent: no server-side layout
/// store at all). Rather than fabricate split geometry (direction/sizes)
/// this port never tracked, `layouts[tabId]` is built HONESTLY from what
/// bookkeeping actually exists: a single-pane tab (the common case, and the
/// only case any OTHER route in this module can meaningfully mutate) gets a
/// real `{type:'leaf', id, content}` node; a tab with more than one owned
/// pane (post-split, geometry unknown) gets a self-describing
/// `{type:'unknown', paneIds:[...]}` marker instead of a lying `'split'`
/// node with invented direction/sizes. `activeTabId`/`paneTitles`/
/// `paneTitleSetByUser` mirror `terminal_tabs::list_tabs`'s existing
/// reduced-fidelity choices (`null`/`{}`) since this port tracks neither.
pub(crate) async fn layout_snapshot(
    State(state): State<FreshAgentState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }
    let tab_filter = params.get("tabId").cloned();

    let tabs_map = state.tabs.lock().expect("tabs mutex").clone();
    let pane_tabs = state.pane_tabs.lock().expect("pane_tabs mutex").clone();
    let terminal_panes = state
        .terminal_panes
        .lock()
        .expect("terminal_panes mutex")
        .clone();
    let content_panes = state
        .content_panes
        .lock()
        .expect("content_panes mutex")
        .clone();

    let mut panes_by_tab: HashMap<String, Vec<String>> = HashMap::new();
    for (pane_id, tab_id) in pane_tabs.iter() {
        if tab_filter.as_ref().is_some_and(|f| f != tab_id) {
            continue;
        }
        panes_by_tab
            .entry(tab_id.clone())
            .or_default()
            .push(pane_id.clone());
    }

    let tabs_list: Vec<Value> = tabs_map
        .values()
        .filter(|t| tab_filter.as_ref().is_none_or(|f| f == &t.id))
        .map(|t| json!({ "id": t.id, "title": t.title }))
        .collect();

    let mut layouts = serde_json::Map::new();
    for (tab_id, mut pane_ids) in panes_by_tab {
        pane_ids.sort();
        let value = if pane_ids.len() == 1 {
            let pane_id = &pane_ids[0];
            let (kind, terminal_id) = if let Some(tp) = terminal_panes.get(pane_id) {
                ("terminal", Some(tp.terminal_id.clone()))
            } else if let Some(content) = content_panes.get(pane_id) {
                (
                    content
                        .get("kind")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown"),
                    None,
                )
            } else {
                ("fresh-agent", None)
            };
            json!({
                "type": "leaf",
                "id": pane_id,
                "content": { "kind": kind, "terminalId": terminal_id },
            })
        } else {
            json!({ "type": "unknown", "paneIds": pane_ids })
        };
        layouts.insert(tab_id, value);
    }

    ok_json(
        json!({
            "tabs": tabs_list,
            "activeTabId": Value::Null,
            "layouts": Value::Object(layouts),
            "activePane": {},
            "paneTitles": {},
            "paneTitleSetByUser": {},
        }),
        "",
    )
}

// ── POST /api/panes/:id/navigate ────────────────────────────────────────

/// `POST /api/panes/:id/navigate` (`router.ts:1654-1667`): re-point a
/// browser pane at a new `url`. Resolved via [`FreshAgentState::pane_tabs`]
/// (no ambiguous title matching, matching this module's established
/// precedent). Broadcasts `ui.command{pane.attach}` -- the client folds it
/// via `updatePaneContent` regardless of the pane's PREVIOUS kind, so
/// navigating a currently-terminal/editor pane into a browser is honored
/// the same way legacy's unconditional `layoutStore.attachPaneContent` is.
pub(crate) async fn navigate_pane(
    State(state): State<FreshAgentState>,
    Path(pane_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }

    let url = body
        .get("url")
        .or_else(|| body.get("target"))
        .and_then(Value::as_str)
        .filter(|u| !u.is_empty());
    let Some(url) = url else {
        return fail_json(StatusCode::BAD_REQUEST, "url required".to_string());
    };

    let Some(tab_id) = state
        .pane_tabs
        .lock()
        .expect("pane_tabs mutex")
        .get(&pane_id)
        .cloned()
    else {
        return fail_json(StatusCode::NOT_FOUND, "pane not found".to_string());
    };

    let content = json!({ "kind": "browser", "url": url, "devToolsOpen": false });
    state
        .content_panes
        .lock()
        .expect("content_panes mutex")
        .insert(pane_id.clone(), content.clone());
    state
        .terminal_panes
        .lock()
        .expect("terminal_panes mutex")
        .remove(&pane_id);

    state.broadcast(&ServerMessage::UiCommand(UiCommand {
        command: "pane.attach".to_string(),
        payload: Some(json!({ "tabId": tab_id, "paneId": pane_id, "content": content })),
    }));

    // Legacy's `res.json(ok(undefined, 'navigate requested'))` drops the
    // `data` KEY entirely (JSON.stringify skips `undefined` properties);
    // `ok_json`'s shared signature (lib.rs) always serializes a `data` key,
    // so this is `"data":null` rather than an absent key -- a pre-existing,
    // minor envelope shape limitation of the shared helper (not introduced
    // here, and out of this slice's owned-file scope to change in lib.rs).
    ok_json(Value::Null, "navigate requested")
}

// ── POST /api/panes/:id/respawn ─────────────────────────────────────────

/// `POST /api/panes/:id/respawn` (`router.ts:1546-1617`): replace a pane's
/// terminal in place with a freshly-spawned one (same `{mode?, shell?, cwd?,
/// resumeSessionId?, sessionRef?}` body shape [`spawn_terminal_pane`]
/// already accepts). Reuses that ONE shared spawn pipeline directly, passing
/// the EXISTING `tab_id`/`pane_id` instead of minting new ones --
/// `spawn_terminal_pane`'s `terminal_panes`/`pane_tabs` bookkeeping inserts
/// OVERWRITE whatever was there for this `pane_id`, which is exactly
/// respawn's "replace in place" semantic. Mirrors this module's documented
/// PTY-cleanup-parity finding (top doc comment): the OLD terminal is never
/// killed here either (legacy's respawn handler contains no kill of a prior
/// terminal at this pane), so it keeps running as an orphaned-from-this-pane
/// background session in the SAME shared registry -- no leak, matching
/// "detach, don't kill." Broadcasts `ui.command{pane.attach}` (per the
/// parity spec's route table), not `pane.split` -- respawn replaces content
/// on an EXISTING pane, it does not mint a new one.
pub(crate) async fn respawn_pane(
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

    let spawned = match spawn_terminal_pane(&state, &body, &tab_id, &pane_id).await {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let TerminalSpawnResult {
        pane_content,
        terminal_id,
        ..
    } = spawned;

    // Tidy any stale non-terminal bookkeeping for this pane id (respawn can
    // target a pane that was previously browser/editor content) -- harmless
    // either way since `terminal_panes` is checked first everywhere this
    // port resolves a pane's kind, but leaving it around would be drift.
    state
        .content_panes
        .lock()
        .expect("content_panes mutex")
        .remove(&pane_id);

    state.broadcast(&ServerMessage::UiCommand(UiCommand {
        command: "pane.attach".to_string(),
        payload: Some(json!({ "tabId": tab_id, "paneId": pane_id, "content": pane_content })),
    }));

    ok_json(json!({ "terminalId": terminal_id }), "pane respawned")
}

// ── POST /api/panes/:id/attach (honest deferral) ────────────────────────

/// `POST /api/panes/:id/attach` (`router.ts:1619-1652`): re-bind an EXISTING
/// (already-running, e.g. previously-detached) terminal to a pane. Deferred:
/// legacy's identity guard (`terminalMatchesExpectedSession`,
/// `expectedPaneSessionRefForTerminal`) verifies the target terminal's
/// ACTUAL durable Codex/session identity before allowing the bind, rejecting
/// with 409 on a mismatch (parity spec `\u00a79` Risk 4: "Getting this wrong
/// breaks Codex resume"). That actual-identity data lives in
/// `TerminalIdentityRegistry`, which is `freshell-ws`-owned and unreachable
/// from THIS crate without a circular dependency -- already documented at
/// this exact boundary by `terminal_tabs.rs`'s `arm_locators_for_fresh_pane`
/// doc comment. Implementing attach's re-bind mechanics while silently
/// skipping the identity guard would ship a route that LOOKS like parity
/// but can silently rebind a session-mismatched Codex terminal -- worse than
/// an honest gap. Returns 400 naming exactly this instead.
pub(crate) async fn attach_pane(
    State(state): State<FreshAgentState>,
    Path(_pane_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }
    fail_json(
        StatusCode::BAD_REQUEST,
        "pane attach is not implemented on this server: the Codex session-identity-mismatch \
         guard this route requires (terminalMatchesExpectedSession) reads the target \
         terminal's ACTUAL durable session identity, which lives in TerminalIdentityRegistry \
         inside freshell-ws -- unreachable from this crate without a circular dependency \
         (documented precedent: terminal_tabs.rs's arm_locators_for_fresh_pane). Implementing \
         attach without that guard risks silently rebinding a session-mismatched Codex \
         terminal (parity spec Risk 4). Deferred."
            .to_string(),
    )
}

// ── POST /api/panes/:id/resize (honest deferral) ────────────────────────

/// `POST /api/panes/:id/resize` (`router.ts:1452-1524`): resize a split by
/// `splitId` (or a pane id whose PARENT split is resized). Deferred: the
/// `splitId` legacy targets is a real, server-tracked split-tree node id.
/// In THIS port, a split node id is minted CLIENT-SIDE ONLY -- the frozen
/// `splitPane` reducer (`src/store/panesSlice.ts`) calls its own `nanoid()`
/// for the new split node and never sends it back to the server (the
/// `pane.split` ui.command payload this port emits carries `newPaneId`, not
/// a split id). The one channel that WOULD let the server learn the real
/// id -- `ui.layout.sync`, the client-to-server layout mirror
/// (`src/store/layoutMirrorMiddleware.ts`, `ClientMessage::UiLayoutSync` in
/// `freshell-protocol`) -- is not consumed anywhere in this port yet (no
/// `freshell-ws`/`freshell-server` handler reads it). A server-issued resize
/// would therefore target a splitId the connected client has never seen,
/// silently no-op on fold (`resizePanes` finds no matching `node.id`), and
/// falsely report success. Returns 400 naming exactly this rather than
/// shipping a call that always 200s and never visibly resizes anything.
pub(crate) async fn resize_pane(
    State(state): State<FreshAgentState>,
    Path(_pane_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }
    fail_json(
        StatusCode::BAD_REQUEST,
        "pane resize is not implemented on this server: legacy targets a server-tracked \
         split-tree node id (splitId) that this port never learns -- it is minted \
         client-side only (splitPane's reducer calls its own nanoid()) and the one channel \
         that could report it back (ui.layout.sync, the client->server layout mirror) is not \
         yet consumed anywhere in this port. A server-issued resize would target a splitId \
         the connected client has never seen and silently no-op. Deferred pending \
         ui.layout.sync ingestion (AUTO-01)."
            .to_string(),
    )
}

// ── POST /api/panes/:id/swap ────────────────────────────────────────────

/// `POST /api/panes/:id/swap` (`router.ts:1526-1544`): exchange the CONTENT
/// of two panes (not their tree position -- legacy's `swapPane`/the frozen
/// client's `swapPanes` reducer both search the tree by id and swap
/// `.content`, no split geometry involved). Unlike resize, this needs no
/// split-tree/splitId knowledge at all, so it is fully implementable: both
/// `pane_id` (path) and `target`/`otherId` (body) resolve via
/// [`FreshAgentState::pane_tabs`] (404 "pane not found" on a miss, matching
/// `split_pane`'s established precedent); a resolved pair in DIFFERENT tabs
/// mirrors legacy's own `{message:'panes not found'}` (200, not an error --
/// `swapPane`'s tree search only ever finds both leaves within a SINGLE
/// tab). The actual exchange swaps whichever bookkeeping bucket
/// (`terminal_panes` or `content_panes`) each pane occupies; a pane
/// resolving to NEITHER (a fresh-agent pane -- tracked in
/// `FreshAgentState`'s private `panes` map, unreachable from this module)
/// is out of this slice's reach and reported the same graceful
/// `{message:'panes not found'}` way, never a hard error.
pub(crate) async fn swap_pane(
    State(state): State<FreshAgentState>,
    Path(pane_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }

    let other_id = body
        .get("target")
        .or_else(|| body.get("otherId"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let Some(other_id) = other_id else {
        return approx_json(Value::Null, "swap target missing");
    };

    let (tab_a, tab_b) = {
        let pane_tabs = state.pane_tabs.lock().expect("pane_tabs mutex");
        let Some(tab_a) = pane_tabs.get(&pane_id).cloned() else {
            return fail_json(StatusCode::NOT_FOUND, "pane not found".to_string());
        };
        let Some(tab_b) = pane_tabs.get(&other_id).cloned() else {
            return fail_json(StatusCode::NOT_FOUND, "pane not found".to_string());
        };
        (tab_a, tab_b)
    };

    if tab_a != tab_b {
        return ok_json(json!({ "message": "panes not found" }), "panes not found");
    }

    let (a_terminal, b_terminal, a_content, b_content) = {
        let terminal_panes = state.terminal_panes.lock().expect("terminal_panes mutex");
        let content_panes = state.content_panes.lock().expect("content_panes mutex");
        (
            terminal_panes.get(&pane_id).cloned(),
            terminal_panes.get(&other_id).cloned(),
            content_panes.get(&pane_id).cloned(),
            content_panes.get(&other_id).cloned(),
        )
    };

    if (a_terminal.is_none() && a_content.is_none())
        || (b_terminal.is_none() && b_content.is_none())
    {
        return ok_json(json!({ "message": "panes not found" }), "panes not found");
    }

    {
        let mut terminal_panes = state.terminal_panes.lock().expect("terminal_panes mutex");
        match (a_terminal, b_terminal) {
            (Some(a), Some(b)) => {
                terminal_panes.insert(pane_id.clone(), b);
                terminal_panes.insert(other_id.clone(), a);
            }
            (Some(a), None) => {
                terminal_panes.remove(&pane_id);
                terminal_panes.insert(other_id.clone(), a);
            }
            (None, Some(b)) => {
                terminal_panes.remove(&other_id);
                terminal_panes.insert(pane_id.clone(), b);
            }
            (None, None) => {}
        }
    }
    {
        let mut content_panes = state.content_panes.lock().expect("content_panes mutex");
        match (a_content, b_content) {
            (Some(a), Some(b)) => {
                content_panes.insert(pane_id.clone(), b);
                content_panes.insert(other_id.clone(), a);
            }
            (Some(a), None) => {
                content_panes.remove(&pane_id);
                content_panes.insert(other_id.clone(), a);
            }
            (None, Some(b)) => {
                content_panes.remove(&other_id);
                content_panes.insert(pane_id.clone(), b);
            }
            (None, None) => {}
        }
    }

    state.broadcast(&ServerMessage::UiCommand(UiCommand {
        command: "pane.swap".to_string(),
        payload: Some(json!({ "tabId": tab_a, "paneId": pane_id, "otherId": other_id })),
    }));

    ok_json(json!({ "tabId": tab_a }), "panes swapped")
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

    // ── shared GET helper (slice 3b-2) ──────────────────────────────────

    async fn get(router: Router, uri: &str, auth: bool) -> (StatusCode, Value) {
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

    // ── tabs/has ─────────────────────────────────────────────────────────

    #[tokio::test]
    async fn tabs_has_requires_auth() {
        let state = state_with_registry();
        let (status, _) = get(app(state), "/api/tabs/has?target=nope", false).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn tabs_has_false_for_missing_target() {
        let state = state_with_registry();
        let (status, body) = get(app(state), "/api/tabs/has", true).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["data"]["exists"], json!(false));
    }

    #[tokio::test]
    async fn tabs_has_true_for_known_tab_id() {
        let state = state_with_registry();
        let router = app(state.clone());
        let (tab_id, _pane_id, terminal_id) = create_shell_tab(router.clone()).await;

        let (status, body) = get(router, &format!("/api/tabs/has?target={tab_id}"), true).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["data"]["exists"], json!(true));

        state.terminal_registry.clone().unwrap().kill(&terminal_id);
    }

    #[tokio::test]
    async fn tabs_has_false_for_unknown_tab_id() {
        let state = state_with_registry();
        let (status, body) = get(app(state), "/api/tabs/has?target=does-not-exist", true).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["data"]["exists"], json!(false));
    }

    // ── tabs next/prev (honest deferral) ────────────────────────────────

    #[tokio::test]
    async fn tabs_next_requires_auth() {
        let state = state_with_registry();
        let (status, _) = post(app(state), "/api/tabs/next", json!({}), false).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn tabs_next_is_honest_400_deferral() {
        let state = state_with_registry();
        let (status, body) = post(app(state), "/api/tabs/next", json!({}), true).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        let msg = body["message"].as_str().unwrap();
        assert!(msg.contains("ordered tab sequence"), "{msg}");
    }

    #[tokio::test]
    async fn tabs_prev_requires_auth() {
        let state = state_with_registry();
        let (status, _) = post(app(state), "/api/tabs/prev", json!({}), false).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn tabs_prev_is_honest_400_deferral() {
        let state = state_with_registry();
        let (status, body) = post(app(state), "/api/tabs/prev", json!({}), true).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        let msg = body["message"].as_str().unwrap();
        assert!(msg.contains("ordered tab sequence"), "{msg}");
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
    async fn layout_snapshot_multi_pane_tab_is_an_honest_unknown_marker_not_a_fabricated_split() {
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

        let (status, body) = get(router, "/api/layout/snapshot", true).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let node = &body["data"]["layouts"][&tab_id];
        assert_eq!(node["type"], json!("unknown"));
        let mut ids: Vec<String> = node["paneIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        ids.sort();
        let mut expected = vec![first_pane_id.clone(), second_pane_id.clone()];
        expected.sort();
        assert_eq!(ids, expected);

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

        let (status, body) =
            get(router, &format!("/api/layout/snapshot?tabId={tab_a}"), true).await;
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

        registry.kill(&old_terminal_id);
        registry.kill(&new_terminal_id);
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

    #[tokio::test]
    async fn resize_pane_is_honest_400_deferral() {
        let state = state_with_registry();
        let (status, body) = post(app(state), "/api/panes/nope/resize", json!({}), true).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        let msg = body["message"].as_str().unwrap();
        assert!(msg.contains("splitId"), "{msg}");
        assert!(msg.contains("ui.layout.sync"), "{msg}");
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
    async fn swap_unknown_pane_is_404() {
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
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert_eq!(body["message"], json!("pane not found"));

        state.terminal_registry.clone().unwrap().kill(&terminal_id);
    }

    #[tokio::test]
    async fn swap_unknown_other_is_404() {
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
        assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        assert_eq!(body["message"], json!("pane not found"));

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
}
