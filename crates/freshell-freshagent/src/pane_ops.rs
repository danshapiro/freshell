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

use freshell_protocol::{ServerMessage, SessionLocator, UiCommand, LEGACY_RESUME_IDENTITY_REFUSAL};

use crate::layout_store::RenameOutcome;
use crate::target_resolver::{resolve_target, ResolvedTarget};
use crate::terminal_tabs::{spawn_terminal_pane, TerminalSpawnResult};
use crate::{
    approx_json, authorized, fail_json, hosted_rest, ok_json, parse_required_name, rest_agent_mode,
    FreshAgentState, PaneEntry, PaneNameResolution,
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
/// (`router.ts:1312-1314`). `agent`-based fresh-agent splits route through the
/// same typed hosted gateway used by tab creation, roll the tentative layout
/// mutation back on launch failure, and attach the returned provider-native
/// session to the store-minted pane. Response + broadcast shapes remain
/// compatible with Slice 3b-1.
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

    let new_content = if let Some(agent) = body.get("agent").and_then(Value::as_str) {
        let Some((provider, session_type)) = rest_agent_mode(agent) else {
            let _ = state.layout.close_pane(&new_pane_id);
            return fail_json(
                StatusCode::BAD_REQUEST,
                format!("unknown agent \"{agent}\""),
            );
        };
        let Some(gateway) = state.hosted_rest_gateway() else {
            let _ = state.layout.close_pane(&new_pane_id);
            return fail_json(
                StatusCode::SERVICE_UNAVAILABLE,
                "durable fresh-agent gateway is not installed".to_string(),
            );
        };
        let native_session_id = match body.get("sessionRef") {
            None => None,
            Some(value) => match serde_json::from_value::<SessionLocator>(value.clone()) {
                Ok(locator) if locator.provider == provider && !locator.session_id.is_empty() => {
                    Some(locator.session_id)
                }
                _ => {
                    let _ = state.layout.close_pane(&new_pane_id);
                    return fail_json(
                        StatusCode::BAD_REQUEST,
                        format!("sessionRef must identify a {provider} session"),
                    );
                }
            },
        };
        let request_id = uuid::Uuid::new_v4().simple().to_string();
        let provider_inputs = match hosted_rest::provider_inputs(&body) {
            Ok(inputs) => inputs,
            Err(error) => {
                let _ = state.layout.close_pane(&new_pane_id);
                return fail_json(StatusCode::BAD_REQUEST, error);
            }
        };
        let cwd = body.get("cwd").and_then(Value::as_str).map(str::to_string);
        let model = body
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string);
        let effort = body
            .get("effort")
            .and_then(Value::as_str)
            .map(str::to_string);
        let created = match gateway
            .create_agent(hosted_rest::HostedRestCreate {
                request_id: request_id.clone(),
                provider: provider.into(),
                session_type: session_type.into(),
                cwd: cwd.clone(),
                model: model.clone(),
                effort: effort.clone(),
                native_session_id,
                plugins: provider_inputs.plugins,
                model_selection: provider_inputs.model_selection,
                permission_mode: provider_inputs.permission_mode,
                sandbox: provider_inputs.sandbox,
            })
            .await
        {
            Ok(created) => created,
            Err(()) => {
                let _ = state.layout.close_pane(&new_pane_id);
                return fail_json(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "durable fresh-agent host could not be created".to_string(),
                );
            }
        };
        let mut content = json!({
            "kind":"fresh-agent",
            "sessionType":session_type,
            "provider":provider,
            "sessionId":created.session_id,
            "createRequestId":request_id,
            "status":"connected",
        });
        if let Some(value) = &cwd {
            content["initialCwd"] = json!(value);
        }
        if let Some(value) = &model {
            content["model"] = json!(value);
        }
        if let Some(value) = &effort {
            content["effort"] = json!(value);
        }
        state.panes.lock().expect("panes mutex").insert(
            new_pane_id.clone(),
            PaneEntry {
                placeholder_id: created.session_id.clone(),
                provider: provider.into(),
                session_type: session_type.into(),
                cwd,
                model,
                effort,
                durable_id: Some(created.session_id),
            },
        );
        content
    } else if body
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

    // Unified agent names (Task 2): a session-owned tab has NO separately
    // stored name — its display IS its source pane's canonical session name,
    // so a rename targets that pane's saved session (the stable source the
    // mirror recorded, never the active pane or last activity). The shared
    // helper owns the scoped blank/reset refusal (`NAME_RESET_UNSUPPORTED`),
    // so this resolution runs BEFORE the legacy `name required` gate. Legacy
    // tabs keep the existing layout rename.
    //
    // Task 8 acceptance: the Session source pointer AND the source pane's
    // content come from the SAME lagging mirror — the ui.layout.sync carrying
    // the post-selection pointer lands seconds after the editor could open.
    // Two capture-wins rules keep a stale mirror from downgrading the rename
    // to the legacy tab-title write (the tab route's twin of
    // `effective_pane_name_resolution`): (1) a Session pointer with a scoped
    // pane whose binding rungs are missing falls back to the request's
    // capture; (2) with the pointer itself still stale (the pre-selection
    // window), a scoped capture asserts session ownership for this tab. A
    // pointer that EXISTS while its pane resolves unscoped is a REAL kind
    // switch, not staleness — that tab keeps its legacy rename, capture or
    // not (the tab's name is no longer the captured conversation's).
    let captured = crate::scoped_capture_of(&body);
    if let Some(freshell_protocol::session_names::TabNameSource::Session {
        pane_id: source_pane_id,
    }) = state.layout.tab_name_source(&tab_id)
    {
        if let Some(resolution) = crate::resolve_pane_name_target(&state, &source_pane_id) {
            if resolution.scoped {
                return crate::rename_scoped_session(
                    &state,
                    &PaneNameResolution {
                        scoped: true,
                        target: resolution.target.clone().or(captured),
                    },
                    Some(&tab_id),
                    Some(&source_pane_id),
                    &body,
                )
                .await;
            }
        }
    } else if let Some(target) = captured {
        // The stale-pointer window: the capture is the client's assertion
        // that this tab's name is a session's name with that binding. The
        // response envelope carries the tab's sole pane so the client's
        // rename receipt check (`data.paneId`) still passes.
        let pane_id = state.layout.get_single_pane_id(&tab_id);
        return crate::rename_scoped_session(
            &state,
            &PaneNameResolution {
                scoped: true,
                target: Some(target),
            },
            Some(&tab_id),
            pane_id.as_deref(),
            &body,
        )
        .await;
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

/// kata b8ke Task 10 (round-1 review): the re-sync handshake's bounded
/// window — 1.5s, above the layout mirror's 1s first-sync debounce (T6's
/// quantified windows), polled at 100ms.
const LAYOUT_RESYNC_WINDOW: std::time::Duration = std::time::Duration::from_millis(1500);
const LAYOUT_RESYNC_POLL: std::time::Duration = std::time::Duration::from_millis(100);

/// The miss half of [`respawn_pane`]'s resolution (kata b8ke Task 10,
/// round-1 review): broadcast `ui.command { command: "layout.resync" }`
/// asking the owner client to re-send its layout (its mirror is change-
/// gated and debounce-windowed, so a just-created pane may not have landed
/// yet), then poll `LayoutStore::find_pane_tab` for a bounded window.
/// Returns `Some(tab_id)` the moment the pane resolves, `None` on window
/// expiry (the caller answers the typed `PANE_NOT_FOUND`).
async fn try_layout_resync_then_find(state: &FreshAgentState, pane_id: &str) -> Option<String> {
    state.broadcast(&ServerMessage::UiCommand(UiCommand {
        command: "layout.resync".to_string(),
        payload: None,
    }));
    let deadline = tokio::time::Instant::now() + LAYOUT_RESYNC_WINDOW;
    loop {
        tokio::time::sleep(LAYOUT_RESYNC_POLL).await;
        if let Some(tab_id) = state.layout.find_pane_tab(pane_id) {
            return Some(tab_id);
        }
        if tokio::time::Instant::now() >= deadline {
            return None;
        }
    }
}

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
///
/// kata b8ke Task 10: pane resolution goes through the AUTHORITATIVE pane
/// registry — `pane_tabs` FIRST (REST-minted panes), then the durable
/// LayoutStore (`find_pane_tab`: browser-created/error panes that live only
/// in layout syncs, retained across server restarts by disk persistence),
/// then the re-sync handshake (round-1 review) before the typed
/// `PANE_NOT_FOUND` 404. The spawn itself claims through the ONE ownership
/// coordinator inside [`spawn_terminal_pane`] (Task 4's D8 rung — the
/// body's `observedEpoch`/`observedGeneration` fence pair threads to the
/// claim, so a stale request can never recreate old-generation ownership),
/// producing the typed 409 owner-conflict envelopes.
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

    let tab_id = state
        .pane_tabs
        .lock()
        .expect("pane_tabs mutex")
        .get(&pane_id)
        .cloned()
        .or_else(|| state.layout.find_pane_tab(&pane_id));
    // Round-1 review: an authoritative registry misses only when no connected
    // browser has synced the pane -- ask the owner client to re-sync before
    // giving up (bounded window, above the mirror's debounce).
    let tab_id = match tab_id {
        Some(tab_id) => tab_id,
        None => match try_layout_resync_then_find(&state, &pane_id).await {
            Some(tab_id) => tab_id,
            None => {
                return crate::fail_json_code(
                    StatusCode::NOT_FOUND,
                    "PANE_NOT_FOUND",
                    format!(
                        "pane {pane_id} not found in the pane registry, any synced layout, \
                         or the re-sync handshake"
                    ),
                );
            }
        },
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

    // b8ke ext r21 F1: the recovered content is written through the
    // AUTHORITATIVE LayoutStore at the moment of the reply — the snapshot
    // (and the persisted layout a restart would load) carries the respawn
    // result even with NO connected browser to mirror the pane.attach
    // broadcast back (pre-r21 the broadcast was the only write, so a
    // headless REST/MCP recovery, reconnect, or restart re-exposed the
    // stale browser/error/detached content).
    state
        .layout
        .attach_pane_content(&tab_id, &pane_id, pane_content.clone());

    state.broadcast(&ServerMessage::UiCommand(UiCommand {
        command: "pane.attach".to_string(),
        payload: Some(json!({ "tabId": tab_id, "paneId": pane_id, "content": pane_content })),
    }));

    ok_json(json!({ "terminalId": terminal_id }), "pane respawned")
}

// ── POST /api/panes/:id/attach ─────────────────────────────────────────

/// `POST /api/panes/:id/attach` (`router.ts:1619-1652`): re-bind an EXISTING
/// (already-running, e.g. previously-detached) terminal to a pane.
///
/// kata b8ke Task 10: implemented. The OLD deferral note ("the identity
/// guard reads TerminalIdentityRegistry inside freshell-ws -- unreachable
/// without a circular dependency") is resolved by the seams that now exist:
/// the OWNERSHIP COORDINATOR (`FreshAgentState::ownership_snapshot`, the
/// one server-wide authority kata b8ke Tasks 3-6 wired) answers who owns
/// `(provider, sessionId)`, and the `SessionIdentityLookup` seam
/// (`freshell-terminal`'s registry.rs, wired by `freshell-server::main`
/// across the crate boundary exactly for this purpose) resolves the
/// terminal id for a terminal-owned session. Design: the coordinator
/// decides FIRST — a terminal-owned session resolves its terminal id
/// (owner identity, else the seam) and broadcasts the reattach content
/// (`ui.command{pane.attach}`, terminal content carrying `terminalId` +
/// the additive `liveTerminal` handle); every other owner or in-flight
/// transition answers the TYPED 409 with the coordinator's owner fields —
/// never a blind rebind, never a bare "pane not found".
pub(crate) async fn attach_pane(
    State(state): State<FreshAgentState>,
    Path(pane_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }
    // Body: { sessionRef: { provider, sessionId } } (typed 400 otherwise).
    let Some(session_ref) = body
        .get("sessionRef")
        .cloned()
        .and_then(|v| serde_json::from_value::<freshell_protocol::SessionLocator>(v).ok())
    else {
        return crate::fail_json_code(
            StatusCode::BAD_REQUEST,
            "BAD_REQUEST",
            "body must carry sessionRef { provider, sessionId }".to_string(),
        );
    };

    // The coordinator decides; the identity seam resolves the terminal.
    // b8ke ext r7 F3: the caller's raw id resolves through the
    // coordinator's ALIAS CHAIN first — a superseded (rekeyed) session
    // follows the CANONICAL live owner (the old key is Aliased forever;
    // observing it raw dead-ends on the alias state instead of attaching).
    let canonical_session_id =
        state.resolve_canonical_session(&session_ref.provider, &session_ref.session_id);
    let session_ref = freshell_protocol::SessionLocator {
        provider: session_ref.provider.clone(),
        session_id: canonical_session_id,
    };
    let snapshot =
        state.canonical_ownership_snapshot(&session_ref.provider, &session_ref.session_id);
    match snapshot.state {
        freshell_ownership::OwnershipState::Live {
            ref owner,
            generation: _,
            ..
        } if owner.kind == freshell_ownership::RuntimeOwnerKind::Terminal => {
            let Some(terminal_id) = owner.terminal_id.clone().or_else(|| {
                state.session_identity.as_ref().and_then(|lookup| {
                    lookup.terminal_for_session(&session_ref.provider, &session_ref.session_id)
                })
            }) else {
                return crate::fail_json_conflict_with_owner(
                    "RESTORE_UNAVAILABLE",
                    format!(
                        "Session {} is terminal-owned but its terminal id is unresolvable.",
                        session_ref.session_id
                    ),
                    None,
                    None,
                );
            };
            // The pane resolves through the same authoritative registry
            // respawn uses (`pane_tabs` first, then the durable LayoutStore).
            let Some(tab_id) = state
                .pane_tabs
                .lock()
                .expect("pane_tabs mutex")
                .get(&pane_id)
                .cloned()
                .or_else(|| state.layout.find_pane_tab(&pane_id))
            else {
                return crate::fail_json_code(
                    StatusCode::NOT_FOUND,
                    "PANE_NOT_FOUND",
                    format!("pane {pane_id} not found in the pane registry or any synced layout"),
                );
            };
            // b8ke ext r23 F3: the attach consumes the probe's STATUS —
            // a dead or absent terminal row answers the typed
            // RESTORE_UNAVAILABLE, never a successful attachment to a
            // dead terminal (pre-r23 the attach defaulted the mode to
            // "shell" and persisted/broadcast status "running" for a row
            // that had already exited — the pane needed another repair
            // cycle). The mode comes from the LIVE row only.
            let probe = state
                .terminal_registry
                .as_ref()
                .and_then(|registry| registry.probe(&terminal_id));
            let mode = match &probe {
                Some(row) if row.status == freshell_protocol::TerminalRunStatus::Running => {
                    row.mode.clone()
                }
                Some(_) | None => {
                    return crate::fail_json_conflict_with_owner(
                        "RESTORE_UNAVAILABLE",
                        format!(
                            "Session {} is terminal-owned but the terminal has exited or its row is absent — \
                             no live terminal to attach.",
                            session_ref.session_id
                        ),
                        None,
                        None,
                    );
                }
            };
            // b8ke ext r12 F2: the REST attach's REAL claim — the guard
            // arms under the coordinator lock and is held ACROSS the pane
            // resolution + the pane.attach broadcast, so a handoff/stop
            // begin inside the window answers the typed Blocked outcome
            // (the coordinator covers the attach through completion;
            // pre-r12 the point-in-time snapshot closed no window — a
            // handoff could commit between the snapshot and the
            // broadcast, attaching a superseded runtime).
            let attach_guard = match crate::ownership_lane::arm_attach_guard(
                &state.ownership,
                &session_ref.provider,
                &session_ref.session_id,
                &format!("rest-attach-{pane_id}"),
                Some(snapshot.generation),
                "rest/pane-attach",
            ) {
                crate::ownership_lane::LaneAttachGuard::Armed(guard) => Some(guard),
                crate::ownership_lane::LaneAttachGuard::Unwired => None,
                crate::ownership_lane::LaneAttachGuard::Refused => {
                    return crate::fail_json_code(
                        StatusCode::CONFLICT,
                        "SESSION_RESERVED",
                        "A lifecycle operation owns this session; retry after it settles"
                            .to_string(),
                    );
                }
            };
            let content = json!({
                "kind": "terminal",
                "terminalId": terminal_id,
                "mode": mode,
                "sessionRef": {
                    "provider": session_ref.provider,
                    "sessionId": session_ref.session_id,
                },
                "liveTerminal": { "terminalId": terminal_id },
                "status": "running",
                "createRequestId": uuid::Uuid::new_v4().simple().to_string(),
            });
            // b8ke ext r21 F1: the re-bound content is written through the
            // AUTHORITATIVE LayoutStore here too — the snapshot (and the
            // persisted layout a restart would load) carries the attach
            // result at the moment of the reply, no browser observer
            // required.
            state
                .layout
                .attach_pane_content(&tab_id, &pane_id, content.clone());
            state.broadcast(&ServerMessage::UiCommand(UiCommand {
                command: "pane.attach".to_string(),
                payload: Some(json!({ "tabId": tab_id, "paneId": pane_id, "content": content })),
            }));
            drop(attach_guard);
            ok_json(
                json!({ "ok": true, "terminalId": terminal_id }),
                "pane attached",
            )
        }
        freshell_ownership::OwnershipState::Live { .. } => {
            // A live fresh-agent owner: the typed 409 with the coordinator's
            // owner fields (the same envelope every ownership-conflict door
            // shares).
            let owner_fields = state.ownership.as_ref().and_then(|ownership| {
                crate::ownership_lane::terminal_owner_fields_from_snapshot(
                    &ownership.observe(&session_ref.provider, &session_ref.session_id),
                )
            });
            crate::fail_json_conflict_with_owner(
                "RESTORE_UNAVAILABLE",
                format!(
                    "Session {} is still running on the server.",
                    session_ref.session_id
                ),
                None,
                owner_fields.as_ref(),
            )
        }
        freshell_ownership::OwnershipState::Vacant => crate::fail_json_code(
            StatusCode::CONFLICT,
            "SESSION_NOT_OWNED",
            "no live runtime owns this session; respawn instead".to_string(),
        ),
        _ => crate::fail_json_code(
            StatusCode::CONFLICT,
            "HANDOFF_IN_PROGRESS",
            "a lifecycle operation is in flight for this session".to_string(),
        ),
    }
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
