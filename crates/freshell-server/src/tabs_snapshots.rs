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
        .route("/api/tabs-sync/restore", axum::routing::post(restore_tabs))
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

// Fail-closed selector parsing (GET query params AND the restore body share
// ONE code path) — see `tabs_snapshots_selectors.rs`.
#[path = "tabs_snapshots_selectors.rs"]
mod selectors_mod;
use selectors_mod::{parse_restore_selection, parse_selector, Selector};

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

// ── POST /api/tabs-sync/restore ─────────────────────────────────────────────
// Rebuilds open panes through the normal create pipeline. A per-source
// write-ahead ledger makes each `(device, source, tabKey, paneId)` idempotent;
// targeted delivery plus a screenshot fence proves the selected connection
// received each replayable tab.create. Selectors and marker corruption fail
// closed, while unsupported pane kinds are reported as skips.

#[path = "tabs_snapshots_marker.rs"]
mod marker_mod;
use marker_mod::{
    prune_marker_doc, read_marker_doc, validate_restore_projection, write_marker_doc, Marker,
    MarkerDoc, PaneMark, RESTORE_MARKER,
};
#[cfg(test)]
use marker_mod::{
    validate_marker_pane_count, MAX_RESTORE_MARKER_BYTES, MAX_RESTORE_MARKER_PANES_PER_SOURCE,
    MAX_RESTORE_MARKER_PANE_KEY_BYTES, MAX_RESTORE_MARKER_SOURCES,
    MAX_RESTORE_MARKER_SOURCE_ID_BYTES, MAX_RESTORE_MARKER_TERMINAL_ID_BYTES, RESTORE_MARKER_TMP,
};

/// Map a snapshot pane to its `POST /api/tabs` body. Invalid session identity
/// fails before spawn; unsupported kinds are skips. Captured terminal, browser,
/// and editor options pass through to the restored pane.
fn pane_to_create_body(tab_name: Option<&Value>, pane: &Value) -> Result<Value, &'static str> {
    let payload = pane.get("payload").cloned().unwrap_or_else(|| json!({}));
    let kind = pane.get("kind").and_then(Value::as_str).unwrap_or("");
    let name = tab_name.cloned().unwrap_or(Value::Null);
    match kind {
        "terminal" => {
            let mode = payload
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or("shell");
            let mut b = json!({ "mode": mode, "name": name });
            if let Some(cwd) = payload.get("initialCwd").filter(|v| v.is_string()) {
                b["cwd"] = cwd.clone();
            }
            if let Some(shell) = payload.get("shell").filter(|v| v.is_string()) {
                b["shell"] = shell.clone();
            }
            if let Some(cd) = payload.get("codexDurability").filter(|v| v.is_object()) {
                if mode == "codex" {
                    b["codexDurability"] = cd.clone();
                }
            }
            // Present identity must be nonempty and match the terminal mode.
            if let Some(sref) = payload.get("sessionRef").filter(|v| !v.is_null()) {
                let ok = sref.is_object()
                    && sref.get("provider").and_then(Value::as_str) == Some(mode)
                    && sref
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .is_some_and(|s| !s.is_empty());
                if !ok {
                    return Err("session-identity-mismatch");
                }
                b["sessionRef"] = sref.clone();
            }
            Ok(b)
        }
        "browser" => match payload.get("url").and_then(Value::as_str) {
            Some(url) => {
                let mut b = json!({ "browser": url, "name": name });
                if let Some(dt) = payload.get("devToolsOpen").filter(|v| v.is_boolean()) {
                    b["devToolsOpen"] = dt.clone();
                }
                Ok(b)
            }
            None => Err("missing-url"),
        },
        "editor" => match payload.get("filePath") {
            Some(file_path) if file_path.is_string() || file_path.is_null() => {
                let mut b = json!({ "editor": file_path, "name": name });
                if let Some(lang) = payload.get("language").filter(|v| v.is_string()) {
                    b["language"] = lang.clone();
                }
                if let Some(ro) = payload.get("readOnly").filter(|v| v.is_boolean()) {
                    b["readOnly"] = ro.clone();
                }
                if let Some(vm) = payload.get("viewMode").filter(|v| v.is_string()) {
                    b["viewMode"] = vm.clone();
                }
                if let Some(ww) = payload.get("wordWrap").filter(|v| v.is_boolean()) {
                    b["wordWrap"] = ww.clone();
                }
                Ok(b)
            }
            _ => Err("missing-filePath"),
        },
        _ => Err("unsupported-kind"),
    }
}

/// Stable per-pane identity key (content-derived, NOT a positional index).
fn pane_key(tab_key: &str, pane_id: &str) -> String {
    format!("{tab_key}#{pane_id}")
}

/// Deterministic key for reconciling a create whose marker promotion did not land.
fn restore_key_for(device_id: &str, source_id: &str, pane_key: &str) -> String {
    format!("restore:{device_id}:{source_id}:{pane_key}")
}

/// Read the whole marker ledger off-runtime under the persistence lock.
async fn read_marker_doc_async(device_dir: &std::path::Path) -> std::io::Result<MarkerDoc> {
    let dd = device_dir.to_path_buf();
    match tokio::task::spawn_blocking(move || {
        freshell_ws::tabs_persist::with_persist_lock(|| read_marker_doc(&dd))
    })
    .await
    {
        Ok(r) => r,
        Err(join) => Err(std::io::Error::other(join.to_string())),
    }
}

/// Persist the updated source ledger under the shared persistence lock.
async fn persist_marker(
    device_dir: Option<&std::path::Path>,
    doc: &mut MarkerDoc,
    source_id: &str,
    panes: &Marker,
    at: i64,
) -> std::io::Result<()> {
    let Some(dd) = device_dir else { return Ok(()) };
    doc.insert(source_id.to_string(), (at, panes.clone()));
    prune_marker_doc(doc, Some(source_id));
    let (dd, doc) = (dd.to_path_buf(), doc.clone());
    match tokio::task::spawn_blocking(move || {
        freshell_ws::tabs_persist::with_persist_lock(|| write_marker_doc(&dd, &doc))
    })
    .await
    {
        Ok(r) => r,
        Err(join) => Err(std::io::Error::other(join.to_string())),
    }
}

/// Fence tab.create with a screenshot reply from the same selected connection.
/// A per-attempt nonce prevents a stale response from confirming a retry.
async fn confirm_delivery(
    state: &TabsSnapshotsState,
    target_client_id: u64,
    nonce: &str,
    pane_key: &str,
) -> bool {
    let request_id = format!("restore-ack:{nonce}:{pane_key}");
    let rx = state
        .screenshots
        .register_for_client(request_id.clone(), target_client_id);
    if !state
        .screenshots
        .send_capture_to(target_client_id, &request_id, "view", None, None)
    {
        state.screenshots.cancel(&request_id);
        return false;
    }
    match tokio::time::timeout(state.restore_ack_timeout, rx).await {
        Ok(Ok(_)) => true, // ANY resolved result (ok OR error) == received
        // A dropped sender (pending entry cancelled/purged before the client
        // answered) is NOT an ack; its removal already dropped the entry.
        Ok(Err(_)) => false,
        Err(_) => {
            state.screenshots.cancel(&request_id);
            false
        }
    }
}

#[allow(clippy::result_large_err)]
fn optional_bool(body: &Value, field: &str) -> Result<bool, Response> {
    match body.get(field) {
        None => Ok(false),
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => Err((
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("{field} must be a boolean") })),
        )
            .into_response()),
    }
}

async fn restore_tabs(
    State(state): State<TabsSnapshotsState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let device_id = match body.get("deviceId").and_then(Value::as_str) {
        Some(d) if !d.is_empty() => d.to_string(),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "deviceId is required" })),
            )
                .into_response()
        }
    };
    let dry_run = match optional_bool(&body, "dryRun") {
        Ok(value) => value,
        Err(response) => return response,
    };
    let force = match optional_bool(&body, "force") {
        Ok(value) => value,
        Err(response) => return response,
    };

    let Some(dir) = state.snapshots_dir.clone() else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Snapshot not found" })),
        )
            .into_response();
    };
    // Malformed selectors fail closed; components have highest priority.
    let selection = match parse_restore_selection(&body) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    // Protect the source generation and its write-ahead marker for the WHOLE
    // restore, including async create and delivery waits between locked IO.
    let _snapshot_lease = freshell_ws::tabs_persist::protect_snapshot_device(&dir, &device_id);
    let (generation_n, generation_id_req) = match &selection.selector {
        Selector::Index(n) => (Some(*n), None),
        Selector::Id(id) => (None, Some(id.clone())),
        Selector::Union => (None, None),
    };
    // Snapshot selection off the runtime (fail-loud). Errors -> 500.
    enum Read {
        Snap(Option<Value>),
        MissingComponents(Vec<String>),
    }
    let sel = (
        dir.clone(),
        device_id.clone(),
        selection.components.clone(),
        generation_id_req.clone(),
        generation_n,
    );
    let read = tokio::task::spawn_blocking(move || -> std::io::Result<Read> {
        let (dir, device_id, comps, gid, gn) = sel;
        if !comps.is_empty() {
            // Every requested component must resolve; partial unions fail.
            return Ok(
                match freshell_ws::tabs_persist::read_generations_union_by_ids(
                    &dir, &device_id, &comps,
                )? {
                    freshell_ws::tabs_persist::ComponentsUnion::Found(v) => Read::Snap(Some(v)),
                    freshell_ws::tabs_persist::ComponentsUnion::Missing(m) => {
                        Read::MissingComponents(m)
                    }
                },
            );
        }
        Ok(Read::Snap(if let Some(id) = gid {
            freshell_ws::tabs_persist::read_generation_by_id(&dir, &device_id, &id)?
        } else if let Some(g) = gn {
            freshell_ws::tabs_persist::read_generation(&dir, &device_id, g)?
        } else {
            freshell_ws::tabs_persist::read_device_union(&dir, &device_id)?
        }))
    })
    .await;
    let snap = match read {
        Ok(Ok(Read::Snap(Some(snap)))) => snap,
        Ok(Ok(Read::Snap(None))) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "Snapshot not found" })),
            )
                .into_response()
        }
        Ok(Ok(Read::MissingComponents(missing))) => {
            return (
                StatusCode::CONFLICT,
                Json(json!({
                    "error": format!(
                        "restore refused: requested component generation(s) not found for device {device_id}: {} (pruned or never captured). Re-capture, or pick available generations via GET /api/tabs-sync/snapshots.",
                        missing.join(", ")
                    ),
                    "missingComponents": missing,
                })),
            )
                .into_response()
        }
        Ok(Err(err)) => return snapshots_read_error(&dir, &err),
        Err(join) => return snapshots_read_error(&dir, &join),
    };
    // Validate every targeted pane key before any side effect.
    if let Some(filter) = &selection.panes {
        let mut known: std::collections::HashSet<String> = std::collections::HashSet::new();
        for record in snap
            .get("records")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if record.get("status").and_then(Value::as_str) != Some("open") {
                continue;
            }
            let tk = record.get("tabKey").and_then(Value::as_str).unwrap_or("");
            for pane in record
                .get("panes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let pid = pane.get("paneId").and_then(Value::as_str).unwrap_or("");
                known.insert(pane_key(tk, pid));
            }
        }
        let mut unknown: Vec<String> = filter
            .iter()
            .filter(|k| !known.contains(*k))
            .cloned()
            .collect();
        unknown.sort();
        if !unknown.is_empty() {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": format!(
                        "restore refused: requested pane(s) not present in the selected snapshot: {}",
                        unknown.join(", ")
                    ),
                    "unknownPanes": unknown,
                })),
            )
                .into_response();
        }
    }
    let source_id = freshell_ws::tabs_persist::snapshot_content_id(&snap);
    let captured_at = snap.get("capturedAt").and_then(Value::as_i64).unwrap_or(0);
    // Distinguish delivery fences from replies to earlier attempts.
    let nonce = uuid::Uuid::new_v4().to_string();

    let _guard = state.restore_lock.lock().await;

    // Bind all delivery and acknowledgements to this exact connection.
    let (connected, target_client_id) = state.screenshots.client_snapshot();
    if !dry_run && !force && target_client_id.is_none() {
        return (StatusCode::CONFLICT, Json(json!({
            "error": format!("restore requires exactly one connected browser (found {connected}); connect the target device only, or pass force"),
            "connectedClients": connected,
        }))).into_response();
    }

    let device_dir = freshell_ws::tabs_persist::encode_device_id(&device_id).map(|e| dir.join(e));
    // Preserve per-source history, including under force. Corrupt idempotency
    // state fails closed unless force explicitly rebuilds it.
    let mut doc: MarkerDoc = match &device_dir {
        Some(dd) => match read_marker_doc_async(dd).await {
            Ok(doc) => doc,
            Err(err) if force => {
                tracing::warn!(target: "freshell_server::tabs_snapshots", device_id = %device_id,
                    error = %err, "restore_marker_unreadable_force_override: rebuilding ledger");
                MarkerDoc::new()
            }
            Err(err) => {
                tracing::error!(target: "freshell_server::tabs_snapshots", device_id = %device_id,
                    error = %err, "restore_marker_unreadable");
                return (StatusCode::CONFLICT, Json(json!({
                    "error": format!(
                        "restore refused: the restore marker for device {device_id} is unreadable or corrupt ({err}). It is the sole idempotency record, so proceeding could duplicate previously-restored tabs. Inspect/repair or delete the marker file, or rerun with force:true to explicitly discard it."
                    ),
                    "markerError": true,
                }))).into_response();
            }
        },
        None => MarkerDoc::new(),
    };
    let prior: Marker = doc
        .get(&source_id)
        .map(|(_, panes)| panes.clone())
        .unwrap_or_default();
    let mut marker: Marker = prior.clone(); // the union we will persist
    let records = snap
        .get("records")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    // Preflight the projected ledger, including UUID-sized terminal ids.
    if !dry_run {
        if let Some(device_dir) = &device_dir {
            if let Err(error) = validate_restore_projection(
                &device_dir.join(RESTORE_MARKER),
                &doc,
                &source_id,
                captured_at,
                force,
                selection.panes.as_ref(),
                &records,
            ) {
                return marker_preflight_error(&device_id, &error);
            }
        }
    }

    let mut restored = Vec::new();
    let mut skipped = Vec::new();
    let mut failed = Vec::new();
    let mut delivery_confirmed = true;
    let mut connection_dropped = false; // once true, remaining panes are FAILED
    for record in &records {
        if record.get("status").and_then(Value::as_str) != Some("open") {
            continue;
        }
        let tab_key = record.get("tabKey").cloned().unwrap_or(Value::Null);
        let tab_key_str = tab_key.as_str().unwrap_or("").to_string();
        let tab_name = record.get("tabName");
        for pane in record
            .get("panes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .iter()
        {
            let pane_id = pane.get("paneId").cloned().unwrap_or(Value::Null);
            let pane_id_str = pane_id.as_str().unwrap_or("").to_string();
            let kind = pane.get("kind").cloned().unwrap_or(Value::Null);
            let kind_str = kind.as_str().unwrap_or("").to_string();
            let pk = pane_key(&tab_key_str, &pane_id_str);

            // Report unselected panes without touching state or the connection.
            if selection
                .panes
                .as_ref()
                .is_some_and(|filter| !filter.contains(&pk))
            {
                skipped.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                    "reason": "not-selected" }));
                continue;
            }

            // Classify before touching the marker or connection.
            let create_body = match pane_to_create_body(tab_name, pane) {
                Err("unsupported-kind") => {
                    skipped.push(json!({ "tabKey": tab_key, "paneId": pane_id,
                        "kind": kind, "reason": "unsupported-kind" }));
                    continue;
                }
                Err(reason) => {
                    failed.push(json!({ "tabKey": tab_key, "paneId": pane_id,
                        "kind": kind, "reason": reason }));
                    continue;
                }
                Ok(b) => b,
            };
            let prior_mark = prior.get(&pk).cloned();
            // Ordinary reruns report restored panes as no-ops. Force bypasses
            // that skip and either replaces the UI identity or recreates.
            if !force {
                if let Some(pm) = &prior_mark {
                    if pm.state == "restored" {
                        skipped.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                            "reason": "already-restored" }));
                        continue;
                    }
                }
            }
            if connection_dropped {
                failed.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                    "reason": "connection-dropped" }));
                continue;
            }

            // Reconcile a prior live process/tab through its replayable command.
            // A new target receives tab.create before its fence. Force replaces
            // no-process content tabs instead.
            let restore_key = restore_key_for(&device_id, &source_id, &pk);
            let ledger = state.fresh_agent.lookup_restore_key(&restore_key);
            let ledger_live_terminal = ledger
                .as_ref()
                .and_then(|entry| entry.terminal_id.clone())
                .filter(|terminal_id| state.terminals.is_running(terminal_id));
            if force && !dry_run && kind_str == "terminal" && ledger_live_terminal.is_some() {
                let (old_tab_id, replacement) = state
                    .fresh_agent
                    .reissue_restore_key_terminal(&restore_key)
                    .expect("live restore-key terminal has tab bookkeeping");
                let close =
                    freshell_protocol::ServerMessage::UiCommand(freshell_protocol::UiCommand {
                        command: "tab.close".to_string(),
                        payload: Some(json!({ "id": old_tab_id })),
                    });
                let delivered = target_client_id.is_some_and(|target| {
                    state.screenshots.send_to_client(target, close)
                        && state
                            .screenshots
                            .send_to_client(target, replacement.ui_command.clone())
                });
                if delivered {
                    state
                        .fresh_agent
                        .mark_restore_key_delivered(&restore_key, target_client_id.unwrap());
                }
                let confirmed = delivered
                    && confirm_delivery(
                        &state,
                        target_client_id.expect("delivered requires a target"),
                        &nonce,
                        &pk,
                    )
                    .await;
                if confirmed {
                    marker.insert(
                        pk.clone(),
                        PaneMark {
                            state: "restored".into(),
                            terminal_id: replacement.terminal_id.clone(),
                        },
                    );
                    restored.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                        "terminalId": replacement.terminal_id, "tabId": replacement.tab_id,
                        "forcedReplacement": true }));
                } else if target_client_id.is_some() {
                    delivery_confirmed = false;
                    connection_dropped = true;
                    failed.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                        "reason": "delivery-unconfirmed",
                        "terminalId": replacement.terminal_id }));
                } else {
                    delivery_confirmed = false;
                    restored.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                        "terminalId": replacement.terminal_id, "tabId": replacement.tab_id,
                        "forcedReplacement": true }));
                }
                continue;
            }
            if force && !dry_run && kind_str != "terminal" {
                if let Some(entry) = ledger.as_ref().filter(|e| e.terminal_id.is_none()) {
                    let close =
                        freshell_protocol::ServerMessage::UiCommand(freshell_protocol::UiCommand {
                            command: "tab.close".to_string(),
                            payload: Some(json!({ "id": entry.tab_id })),
                        });
                    if target_client_id
                        .is_some_and(|target| !state.screenshots.send_to_client(target, close))
                    {
                        delivery_confirmed = false;
                        connection_dropped = true;
                        failed.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                            "reason": "delivery-unconfirmed" }));
                        continue;
                    }
                    state.fresh_agent.retire_restore_key_content(&restore_key);
                }
            } else if let Some(pm) = &prior_mark {
                let live_terminal_id = pm
                    .terminal_id
                    .clone()
                    .filter(|t| state.terminals.is_running(t))
                    .or_else(|| {
                        ledger
                            .as_ref()
                            .and_then(|e| e.terminal_id.clone())
                            .filter(|t| state.terminals.is_running(t))
                    });
                let ledger_content_tab = ledger
                    .as_ref()
                    .filter(|e| e.terminal_id.is_none())
                    .map(|e| e.tab_id.clone());
                if live_terminal_id.is_some() || ledger_content_tab.is_some() {
                    if dry_run {
                        restored.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                            "terminalId": live_terminal_id,
                            "tabId": ledger_content_tab.map(Value::from).unwrap_or(Value::Null),
                            "reconciled": true, "dryRun": true }));
                        continue;
                    }
                    let ready_for_fence = target_client_id.is_some_and(|target| {
                        if ledger
                            .as_ref()
                            .is_some_and(|entry| entry.delivered_to.contains(&target))
                        {
                            return true;
                        }
                        let sent = ledger.as_ref().is_some_and(|entry| {
                            state
                                .screenshots
                                .send_to_client(target, entry.ui_command.clone())
                        });
                        if sent {
                            state
                                .fresh_agent
                                .mark_restore_key_delivered(&restore_key, target);
                        }
                        sent
                    });
                    let acked = ready_for_fence
                        && confirm_delivery(
                            &state,
                            target_client_id.expect("checked Some"),
                            &nonce,
                            &pk,
                        )
                        .await;
                    if !acked {
                        delivery_confirmed = false;
                        connection_dropped = target_client_id.is_some();
                        marker.insert(pk.clone(), pm.clone());
                        failed.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                            "reason": "delivery-unconfirmed",
                            "terminalId": live_terminal_id }));
                    } else {
                        marker.insert(
                            pk.clone(),
                            PaneMark {
                                state: "restored".into(),
                                terminal_id: live_terminal_id.clone(),
                            },
                        );
                        restored.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                            "terminalId": live_terminal_id,
                            "tabId": ledger_content_tab.map(Value::from).unwrap_or(Value::Null),
                            "reconciled": true }));
                    }
                    continue;
                }
                if pm.state == "in-progress" && kind_str != "terminal" && !force {
                    marker.insert(pk.clone(), pm.clone());
                    failed.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                        "reason": "in-progress-unconfirmed",
                        "hint": "an earlier attempt's tab.create may have reached the client; verify the pane in the target browser, then rerun with force:true to recreate it" }));
                    continue;
                }
            }
            if dry_run {
                restored.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                    "request": create_body, "tabId": Value::Null, "dryRun": true }));
                continue;
            }

            // Write ahead before create; restoreKey reconciles the crash window.
            marker.insert(
                pk.clone(),
                PaneMark {
                    state: "in-progress".into(),
                    terminal_id: None,
                },
            );
            if let Err(err) = persist_marker(
                device_dir.as_deref(),
                &mut doc,
                &source_id,
                &marker,
                captured_at,
            )
            .await
            {
                return marker_error(
                    &device_id,
                    &snap,
                    connected,
                    delivery_confirmed,
                    restored,
                    skipped,
                    failed,
                    &err,
                );
            }

            let mut tagged_body = create_body.clone();
            tagged_body["restoreKey"] = json!(restore_key);
            let resp = freshell_freshagent::terminal_tabs::create_terminal_or_content_tab_deferred(
                state.fresh_agent.clone(),
                tagged_body,
            )
            .await;
            let status = resp.status();
            let rbytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
                .await
                .unwrap_or_default();
            let resp_body: Value = serde_json::from_slice(&rbytes).unwrap_or(Value::Null);
            if !(status.is_success()
                && resp_body.get("status").and_then(Value::as_str) == Some("ok"))
            {
                // A failed create restores any prior marker entry.
                match &prior_mark {
                    Some(pm) => {
                        marker.insert(pk.clone(), pm.clone());
                    }
                    None => {
                        marker.remove(&pk);
                    }
                }
                failed.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                    "status": status.as_u16(), "error": resp_body }));
                continue;
            }
            let data = resp_body.get("data").cloned().unwrap_or(Value::Null);
            let terminal_id = data
                .get("terminalId")
                .and_then(Value::as_str)
                .map(str::to_string);
            let ui_command = data.get("uiCommand").cloned().and_then(|value| {
                serde_json::from_value::<freshell_protocol::ServerMessage>(value).ok()
            });
            // The durable pre-create record preserves write-ahead safety. Batch
            // this terminal id into the next write-ahead or final marker write.
            marker.insert(
                pk.clone(),
                PaneMark {
                    state: "in-progress".into(),
                    terminal_id: terminal_id.clone(),
                },
            );
            // Deliver and fence on the exact selected target.
            let delivered = target_client_id
                .zip(ui_command)
                .is_some_and(|(target, command)| {
                    let sent = state.screenshots.send_to_client(target, command);
                    if sent {
                        state
                            .fresh_agent
                            .mark_restore_key_delivered(&restore_key, target);
                    }
                    sent
                });
            let confirmed = if delivered {
                confirm_delivery(
                    &state,
                    target_client_id.expect("delivered requires a target"),
                    &nonce,
                    &pk,
                )
                .await
            } else {
                false
            };
            if confirmed {
                marker.insert(
                    pk.clone(),
                    PaneMark {
                        state: "restored".into(),
                        terminal_id: terminal_id.clone(),
                    },
                );
                restored.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                    "tabId": data.get("tabId").cloned().unwrap_or(Value::Null), "terminalId": terminal_id }));
            } else if target_client_id.is_some() {
                // Keep the created terminal in-progress for a safe retry.
                delivery_confirmed = false;
                connection_dropped = true;
                failed.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                    "reason": "delivery-unconfirmed", "terminalId": terminal_id }));
            } else {
                // force + 0 clients: created but delivery cannot be confirmed.
                delivery_confirmed = false;
                restored.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                    "tabId": data.get("tabId").cloned().unwrap_or(Value::Null), "terminalId": terminal_id }));
            }
        }
    }

    if !dry_run {
        if let Err(err) = persist_marker(
            device_dir.as_deref(),
            &mut doc,
            &source_id,
            &marker,
            captured_at,
        )
        .await
        {
            return marker_error(
                &device_id,
                &snap,
                connected,
                delivery_confirmed,
                restored,
                skipped,
                failed,
                &err,
            );
        }
    }

    Json(json!({
        "deviceId": device_id,
        "generation": generation_n,
        "generationId": generation_id_req,
        "sourceId": source_id,
        "sourceCapturedAt": snap.get("capturedAt").cloned().unwrap_or(Value::Null),
        "broadcastScope": if target_client_id.is_some() { "target-client" } else { "none" },
        "connectedClients": connected,
        "deliveryConfirmed": dry_run || delivery_confirmed,
        "restored": restored,
        "skipped": skipped,
        "failed": failed,
    }))
    .into_response()
}

fn marker_preflight_error(device_id: &str, error: &dyn std::fmt::Display) -> Response {
    tracing::warn!(target: "freshell_server::tabs_snapshots", device_id = %device_id,
        error = %error, "restore_marker_limit_rejected");
    (
        StatusCode::CONFLICT,
        Json(json!({
            "error": format!("restore refused: restore marker limit exceeded ({error})"),
            "markerError": true,
        })),
    )
        .into_response()
}

/// A marker write failed AFTER side-effects: 500, fail LOUDLY, echoing what was
/// done so a lost marker can never read as a clean success.
#[allow(clippy::too_many_arguments)]
fn marker_error(
    device_id: &str,
    snap: &Value,
    connected: i64,
    delivery_confirmed: bool,
    restored: Vec<Value>,
    skipped: Vec<Value>,
    failed: Vec<Value>,
    err: &dyn std::fmt::Display,
) -> Response {
    tracing::error!(target: "freshell_server::tabs_snapshots", device_id = %device_id,
        error = %err, "restore_marker_write_failed");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({
            "deviceId": device_id,
            "sourceCapturedAt": snap.get("capturedAt").cloned().unwrap_or(Value::Null),
            "connectedClients": connected,
            "deliveryConfirmed": delivery_confirmed,
            "error": format!("restore marker write failed: {err}"),
            "markerError": true,
            "restored": restored, "skipped": skipped, "failed": failed,
        })),
    )
        .into_response()
}

#[cfg(test)]
#[path = "tabs_snapshots_tests.rs"]
mod tests;
