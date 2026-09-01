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

use freshell_protocol::{ServerMessage, UiCommand, LEGACY_RESUME_IDENTITY_REFUSAL};

use crate::layout_store::RenameOutcome;
use crate::target_resolver::{resolve_target, ResolvedTarget};
use crate::terminal_tabs::{spawn_terminal_pane, TerminalSpawnResult};
use crate::{approx_json, authorized, fail_json, ok_json, parse_required_name, FreshAgentState};

/// Mount the pane + tab lifecycle routes onto an existing router. Split out of
/// [`crate::router`] so `lib.rs`'s route table stays a single glance-able list;
/// call this right after `crate::router(state)` (both share the SAME
/// `FreshAgentState`, so the sub-router composes via axum's `.merge`).
pub fn router(state: FreshAgentState) -> Router {
    Router::new()
        .route("/api/panes/{id}/split", axum::routing::post(split_pane))
        .route("/api/panes/{id}/close", axum::routing::post(close_pane))
        .route("/api/panes/{id}/select", axum::routing::post(select_pane))
        .route(
            "/api/panes/{id}/resize",
            axum::routing::post(crate::pane_resize::resize_pane),
        )
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

// ── shared target resolution (Node `resolvePaneTarget`) ────────────────────

/// The outcome of [`resolve_pane_target`]: a pane id to proceed with, or a
/// ready-made rejection response.
pub(crate) enum PaneTarget {
    Pane {
        /// The owning tab when the resolver found one (`resolved.tabId`).
        tab_id: Option<String>,
        pane_id: String,
        /// The resolver's advisory message (`'tab matched; active pane
        /// used'` / `'active tab used'`) -- Node surfaces it as the response
        /// envelope message (`resolved.message || ...`).
        message: Option<&'static str>,
    },
    /// 409 (ambiguous pane title) or 404 (memberless resolver outcome).
    Reject(Response),
}

/// Node's `resolvePaneTarget` + `rejectPaneTargetError` (`router.ts:530-538,
/// 591-596`) as one helper. The raw `:id` runs through
/// [`crate::target_resolver::resolve_target`] (pane id / tab id / tab title /
/// `tab.pane` / numeric index / pane title); ONLY the bare
/// `'target not resolved'` miss falls back to `{paneId: raw}` -- every other
/// pane-less outcome carries a message and is rejected (409 when the message
/// contains "ambiguous", else 404), exactly like the original.
pub(crate) fn resolve_pane_target(state: &FreshAgentState, raw: &str) -> PaneTarget {
    match resolve_target(&state.layout, raw) {
        ResolvedTarget::Pane {
            tab_id,
            pane_id,
            message,
        } => PaneTarget::Pane {
            tab_id: Some(tab_id),
            pane_id,
            message,
        },
        ResolvedTarget::Ambiguous(message) => {
            PaneTarget::Reject(fail_json(StatusCode::CONFLICT, message.to_string()))
        }
        ResolvedTarget::NotFound("target not resolved") => PaneTarget::Pane {
            tab_id: None,
            pane_id: raw.to_string(),
            message: None,
        },
        ResolvedTarget::NotFound(message) => {
            PaneTarget::Reject(fail_json(StatusCode::NOT_FOUND, message.to_string()))
        }
    }
}

// ── POST /api/panes/:id/split ──────────────────────────────────────────────

/// `POST /api/panes/:id/split` (`router.ts:1250-1394`): the source pane
/// resolves via [`resolve_pane_target`], then the STORE splits FIRST
/// (`layoutStore.splitPane`, `router.ts:1305-1315`) -- the new pane id is
/// store-minted, so the store tree, the legacy bookkeeping, the broadcast and
/// the response all carry the SAME id -- then the pre-existing PTY-side spawn
/// pipeline runs unchanged and the spawned content lands back in the store
/// via `attachPaneContent` (`router.ts:1374`). A store miss (unknown pane)
/// responds Node's `approx('pane split requested; not applied')`
/// (`router.ts:1312-1314`). `agent`-based fresh-agent splits
/// (`router.ts:1258-1285`) remain an explicit, documented deferral (honest
/// 400) -- out of this slice's bounded scope; browser/editor/terminal splits
/// are fully implemented. Response + broadcast shapes are unchanged from
/// Slice 3b-1.
pub(crate) async fn split_pane(
    State(state): State<FreshAgentState>,
    Path(raw_pane_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }
    // ejh6 (finding 3): door-top presence check BEFORE `resolve_pane_target`
    // and `layout.split_pane` so a rejection returns 400 with NO layout
    // mutation.
    if body.get("resumeSessionId").is_some() {
        return fail_json(
            StatusCode::BAD_REQUEST,
            LEGACY_RESUME_IDENTITY_REFUSAL.to_string(),
        );
    }

    let pane_id = match resolve_pane_target(&state, &raw_pane_id) {
        PaneTarget::Pane { pane_id, .. } => pane_id,
        PaneTarget::Reject(resp) => return resp,
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

    let (tab_id, new_pane_id) = match state.layout.split_pane(&pane_id, &direction) {
        Ok(split) => split,
        // Node: `if (!result?.tabId || !result?.newPaneId) res.json(approx(
        // result, 'pane split requested; not applied'))` (router.ts:1312-1314).
        Err(_) => return approx_json(Value::Null, "pane split requested; not applied"),
    };

    let new_content = if body
        .get("hostStats")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        // Stateless cheap content kind (router.ts `wantsHostStats` split branch).
        let content = json!({ "kind": "host-stats" });
        state
            .content_panes
            .lock()
            .expect("content_panes mutex")
            .insert(new_pane_id.clone(), content.clone());
        content
    } else if let Some(url) = body.get("browser").and_then(Value::as_str) {
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

    // `layoutStore.attachPaneContent(tabId, newPaneId, content)`
    // (`router.ts:1374`): replace the store split's placeholder leaf content
    // with what actually spawned.
    state
        .layout
        .attach_pane_content(&tab_id, &new_pane_id, new_content.clone());

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

/// `POST /api/panes/:id/close` (`router.ts:1429-1437`): resolve via
/// [`resolve_pane_target`], then the store's `closePane` drives everything --
/// the layout-tree rebuild, the `'cannot close only pane'` guard and the
/// response `{tabId}`/`{message}` data (Task 15, AUTO-06). PTY-side behavior
/// is unchanged (this module's top doc comment): a successful store close
/// ALSO drops this crate's local bookkeeping for the pane
/// (`terminal_panes`/`content_panes`/`pane_tabs`) and NEVER kills the
/// registry terminal, matching `layoutStore.closePane`'s pure layout-tree
/// mutation exactly. The `ui.command{pane.close}` broadcast stays
/// unconditional (`router.ts:1435`) -- `tabId` is null on the
/// not-found/refused paths, an inert fold on the frozen client.
pub(crate) async fn close_pane(
    State(state): State<FreshAgentState>,
    Path(raw_pane_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }

    let (pane_id, resolve_message) = match resolve_pane_target(&state, &raw_pane_id) {
        PaneTarget::Pane {
            pane_id, message, ..
        } => (pane_id, message),
        PaneTarget::Reject(resp) => return resp,
    };

    let outcome = state.layout.close_pane(&pane_id);
    let (broadcast_tab_id, data, store_message) = match &outcome {
        Ok(tab_id) => {
            // Keep the PTY-side behavior: remove ONLY local bookkeeping;
            // the terminal (if any) keeps running as a background session.
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
            (Some(tab_id.clone()), json!({ "tabId": tab_id }), None)
        }
        Err(message) => (None, json!({ "message": message }), Some(*message)),
    };

    state.broadcast(&ServerMessage::UiCommand(UiCommand {
        command: "pane.close".to_string(),
        payload: Some(json!({ "tabId": broadcast_tab_id, "paneId": pane_id })),
    }));

    // `ok(result, resolved.message || result?.message || 'pane closed')`.
    let message = resolve_message.or(store_message).unwrap_or("pane closed");
    ok_json(data, message)
}

// ── POST /api/panes/:id/select ─────────────────────────────────────────────

/// `POST /api/panes/:id/select` (`router.ts:1439-1450`): resolve via
/// [`resolve_pane_target`], then the store's `selectPane` persists
/// `activePane` (Task 15, AUTO-06). The target tab is `req.body?.tabId ||
/// resolved.tabId`; `selectPane` itself falls back to the pane's owning tab
/// when that tab doesn't exist (`layout-store.ts:526-540`). Only broadcasts
/// `ui.command{pane.select}` when a tab actually resolved
/// (`router.ts:1446`'s `if (result?.tabId)` guard).
pub(crate) async fn select_pane(
    State(state): State<FreshAgentState>,
    Path(raw_pane_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }

    let (resolved_tab_id, pane_id, resolve_message) =
        match resolve_pane_target(&state, &raw_pane_id) {
            PaneTarget::Pane {
                tab_id,
                pane_id,
                message,
            } => (tab_id, pane_id, message),
            PaneTarget::Reject(resp) => return resp,
        };

    let tab_id = body
        .get("tabId")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .or(resolved_tab_id);

    match state.layout.select_pane(tab_id.as_deref(), &pane_id) {
        Ok((tab_id, pane_id)) => {
            state.broadcast(&ServerMessage::UiCommand(UiCommand {
                command: "pane.select".to_string(),
                payload: Some(json!({ "tabId": tab_id, "paneId": pane_id })),
            }));
            ok_json(
                json!({ "tabId": tab_id, "paneId": pane_id }),
                resolve_message.unwrap_or("pane selected"),
            )
        }
        Err(message) => ok_json(
            json!({ "message": message }),
            resolve_message.unwrap_or(message),
        ),
    }
}

// ── POST /api/tabs/:id/select ───────────────────────────────────────────────

/// Fold a store tab mutation into the legacy `ok(result, result.message ||
/// success)` envelope every tab route shares (`router.ts:836,848,854`): the
/// data is the outcome itself — `{tabId}` on success, `{message}` otherwise —
/// and the envelope message mirrors `result.message || <success>`.
fn tab_outcome_response(outcome: RenameOutcome, success_message: &str) -> Response {
    match outcome.tab_id {
        Some(tab_id) => ok_json(json!({ "tabId": tab_id }), success_message),
        None => {
            let message = outcome.message.unwrap_or("tab not found");
            ok_json(json!({ "message": message }), message)
        }
    }
}

/// `POST /api/tabs/:id/select` (`router.ts:834-838`): store `selectTab`
/// (persists `activeTabId` — Task 14, AUTO-03). Always broadcasts
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

    let outcome = state.layout.select_tab(&tab_id);

    state.broadcast(&ServerMessage::UiCommand(UiCommand {
        command: "tab.select".to_string(),
        payload: Some(json!({ "id": tab_id })),
    }));

    tab_outcome_response(outcome, "tab selected")
}

// ── PATCH /api/tabs/:id ─────────────────────────────────────────────────────

/// `PATCH /api/tabs/:id` (`router.ts:840-849`): rename a tab on the store
/// (`renameTab` — single-pane pane-title mirror included; `{message:'no layout
/// snapshot'}` when the store is empty, Node parity for the no-client hole).
/// Broadcasts `ui.command{tab.rename}` ONLY when the rename resolved
/// (`router.ts:845`'s `if (result?.tabId)` guard). Legacy applies no length
/// bound here (unlike `PATCH /api/panes/:id`'s `MAX_TERMINAL_TITLE_OVERRIDE_LENGTH`
/// check) -- mirrored exactly, no bound added. The legacy `TabRecord.title`
/// shadow is kept updated too (nothing reads it in production today; `pane_ops_tab_tests` pins the mirror).
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

    let outcome = state.layout.rename_tab(&tab_id, &name);

    if let Some(record) = state.tabs.lock().expect("tabs mutex").get_mut(&tab_id) {
        record.title = Some(name.clone());
    }

    if outcome.tab_id.is_some() {
        state.broadcast(&ServerMessage::UiCommand(UiCommand {
            command: "tab.rename".to_string(),
            payload: Some(json!({ "id": tab_id, "title": name })),
        }));
    }

    tab_outcome_response(outcome, "tab renamed")
}

// ── DELETE /api/tabs/:id ─────────────────────────────────────────────────────

/// `DELETE /api/tabs/:id` (`router.ts:851-855`): store `closeTab` (drives the
/// response — `{tabId}` / `{message:'tab not found'|'no layout snapshot'}`),
/// plus the pre-existing owned-resource cleanup on the legacy shadow maps
/// (`tabs`/`pane_tabs`/`terminal_panes`/`content_panes` — split/close/respawn
/// continuity still reads them). Always broadcasts `ui.command{tab.close}`
/// regardless of whether the tab existed (matching `router.ts:853`'s
/// unconditional broadcast, same pattern as `select_tab`). See this module's
/// top doc comment: this removes ONLY local bookkeeping for every owned pane
/// -- no `registry.kill` call, so each pane's terminal (if any) keeps running
/// as a background session in the shared registry, exactly like the legacy
/// `closeTab` does.
pub(crate) async fn delete_tab(
    State(state): State<FreshAgentState>,
    Path(tab_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }

    let outcome = state.layout.close_tab(&tab_id);

    // Legacy shadow cleanup, keyed on the legacy maps themselves (a tab can
    // exist there without a store row and vice versa during the AUTO-03
    // transition; the response above stays store-authoritative either way).
    if state
        .tabs
        .lock()
        .expect("tabs mutex")
        .remove(&tab_id)
        .is_some()
    {
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
    }

    state.broadcast(&ServerMessage::UiCommand(UiCommand {
        command: "tab.close".to_string(),
        payload: Some(json!({ "id": tab_id })),
    }));

    tab_outcome_response(outcome, "tab closed")
}

// ── GET /api/tabs/has ───────────────────────────────────────────────────

/// `GET /api/tabs/has?target=` (`router.ts:857-861`): `{ exists }` via the
/// store's `hasTab`, which matches by tab id OR title (`layout-store.ts:336-339`
/// — Task 14, AUTO-03 retires the id-only interim lookup). A missing/empty
/// `target` mirrors the original's `target ? ... : false` short-circuit —
/// normalized HERE, before the store call, so the store never sees a blank
/// target (caller hygiene for `Some("")`).
pub(crate) async fn tabs_has(
    State(state): State<FreshAgentState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }
    let target = params.get("target").map(String::as_str).unwrap_or("");
    let exists = !target.is_empty() && state.layout.has_tab(target);
    ok_json(json!({ "exists": exists }), "")
}

// ── POST /api/tabs/next, POST /api/tabs/prev ───────────────────────────

/// The shared next/prev response fold (`router.ts:863-877`): broadcast
/// `ui.command{tab.select,{id}}` ONLY when a tab resolved (`if (result?.tabId)`),
/// then `ok(result, result?.message || 'tab selected')` — `{tabId}` on a
/// resolve, `{message:'no tabs'}` when the store has no snapshot or no tabs
/// (`selectNextTab`/`selectPrevTab`, `layout-store.ts:589-607`).
fn tab_cycle_response(state: &FreshAgentState, resolved: Option<String>) -> Response {
    match resolved {
        Some(tab_id) => {
            state.broadcast(&ServerMessage::UiCommand(UiCommand {
                command: "tab.select".to_string(),
                payload: Some(json!({ "id": tab_id })),
            }));
            ok_json(json!({ "tabId": tab_id }), "tab selected")
        }
        None => ok_json(json!({ "message": "no tabs" }), "no tabs"),
    }
}

/// `POST /api/tabs/next` (`router.ts:863-869`): ordered active-tab cycling on
/// the shared LayoutStore (Task 14, AUTO-03 — the Slice 3b-1 honest-400
/// deferral dies here: the store IS the ordered tab sequence + active-tab id
/// that deferral was waiting on).
pub(crate) async fn tabs_next(
    State(state): State<FreshAgentState>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }
    let resolved = state.layout.select_next_tab();
    tab_cycle_response(&state, resolved)
}

/// `POST /api/tabs/prev` (`router.ts:871-877`): see [`tabs_next`].
pub(crate) async fn tabs_prev(
    State(state): State<FreshAgentState>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }
    let resolved = state.layout.select_prev_tab();
    tab_cycle_response(&state, resolved)
}

// ── GET /api/layout/snapshot ────────────────────────────────────────────

/// `GET /api/layout/snapshot?tabId=` (`router.ts:885-896`): the store's
/// normalized `{tabs, activeTabId, layouts, activePane, paneTitles,
/// paneTitleSetByUser[, timestamp]}` read model, verbatim
/// (`getNormalizedSnapshot`, `layout-store.ts:191-210`) -- REAL `PaneNode`
/// trees now that the shared `LayoutStore` exists (Tasks 12-14); the Slice
/// 3b-2 `{type:'unknown'}` honest-deferral marker is dead. An empty `tabId=`
/// query param normalizes to no filter.
pub(crate) async fn layout_snapshot(
    State(state): State<FreshAgentState>,
    headers: HeaderMap,
    Query(params): Query<HashMap<String, String>>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }
    let tab_filter = params
        .get("tabId")
        .map(String::as_str)
        .filter(|t| !t.is_empty());
    ok_json(state.layout.get_normalized_snapshot(tab_filter), "")
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
    // ejh6 (finding 3): door-top presence check BEFORE `spawn_terminal_pane`.
    if body.get("resumeSessionId").is_some() {
        return fail_json(
            StatusCode::BAD_REQUEST,
            LEGACY_RESUME_IDENTITY_REFUSAL.to_string(),
        );
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

// ── POST /api/panes/:id/swap ────────────────────────────────────────────

/// `POST /api/panes/:id/swap` (`router.ts:1526-1544`): both `:id` and the
/// body `target`/`otherId` resolve via [`resolve_pane_target`], then the
/// store's `swapPane` exchanges the two leaves' CONTENT plus BOTH title-map
/// entries (Task 15, AUTO-06 -- `layout-store.ts:609-654`). Unknown panes
/// are the store's graceful 200 `{message:'panes not found'}`, fixing the
/// Slice 3b-1 404 divergence (survey B.4). A successful store swap ALSO
/// exchanges this crate's legacy per-kind bookkeeping
/// (`terminal_panes`/`content_panes`) so send-keys/capture/wait-for keep
/// dispatching to the terminal each pane now shows. Broadcast unchanged:
/// `ui.command{pane.swap,{tabId,paneId,otherId}}` only when a tab resolved.
pub(crate) async fn swap_pane(
    State(state): State<FreshAgentState>,
    Path(raw_pane_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }

    let other_raw = body
        .get("target")
        .or_else(|| body.get("otherId"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let Some(other_raw) = other_raw else {
        return approx_json(Value::Null, "swap target missing");
    };

    let (pane_id, resolve_message) = match resolve_pane_target(&state, &raw_pane_id) {
        PaneTarget::Pane {
            pane_id, message, ..
        } => (pane_id, message),
        PaneTarget::Reject(resp) => return resp,
    };
    let (other_id, other_message) = match resolve_pane_target(&state, &other_raw) {
        PaneTarget::Pane {
            pane_id, message, ..
        } => (pane_id, message),
        PaneTarget::Reject(resp) => return resp,
    };

    let requested_tab_id = body
        .get("tabId")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty());

    match state
        .layout
        .swap_pane(requested_tab_id, &pane_id, &other_id)
    {
        Ok(tab_id) => {
            // Legacy per-kind bookkeeping follows the store swap.
            swap_entries(
                &mut state.terminal_panes.lock().expect("terminal_panes mutex"),
                &pane_id,
                &other_id,
            );
            swap_entries(
                &mut state.content_panes.lock().expect("content_panes mutex"),
                &pane_id,
                &other_id,
            );

            state.broadcast(&ServerMessage::UiCommand(UiCommand {
                command: "pane.swap".to_string(),
                payload: Some(json!({ "tabId": tab_id, "paneId": pane_id, "otherId": other_id })),
            }));

            // `resolved.message || otherResolved.message || result?.message
            // || 'panes swapped'`.
            let message = resolve_message.or(other_message).unwrap_or("panes swapped");
            ok_json(json!({ "tabId": tab_id }), message)
        }
        Err(store_message) => {
            let message = resolve_message.or(other_message).unwrap_or(store_message);
            ok_json(json!({ "message": store_message }), message)
        }
    }
}

/// Exchange two keys' entries in a legacy bookkeeping map (a missing entry on
/// one side DELETES the other's, same semantics as the store's title-map
/// swap).
fn swap_entries<V>(map: &mut HashMap<String, V>, a: &str, b: &str) {
    let value_a = map.remove(a);
    let value_b = map.remove(b);
    if let Some(v) = value_b {
        map.insert(a.to_string(), v);
    }
    if let Some(v) = value_a {
        map.insert(b.to_string(), v);
    }
}

#[cfg(test)]
#[path = "pane_ops_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "pane_ops_tab_tests.rs"]
mod tab_tests;

#[cfg(test)]
#[path = "pane_ops_store_tests.rs"]
mod store_tests;
