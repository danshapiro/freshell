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
//
// Rebuilds a device's tabs from a persisted snapshot by driving the SAME
// `POST /api/tabs` create pipeline per snapshot pane (one new tab per OPEN
// pane — the layout tree is client-owned, not restorable server-side). Each
// pane has a STABLE idempotency key `paneKey = "{tabKey}#{paneId}"`; combined
// with the marker's per-source ledger the effective server-side create
// identity is `(deviceId, sourceId/generationId, paneKey)`. Semantics:
// - Target gate: EXACTLY ONE capable client (409 otherwise); `force`
//   overrides, `dryRun` bypasses (creates nothing).
// - Fail-closed selectors: malformed `generation`/`generationId`/`components`
//   /`panes` are a 400, never a silent fallback to the broader union.
// - Strict session-identity preflight: a present-but-invalid `sessionRef`
//   fails the pane (`session-identity-mismatch`) BEFORE spawning.
// - Verified delivery: after each create, a screenshot round-trip to the
//   single target client acks receipt of the in-order `tab.create`; a timeout
//   fails that pane (`delivery-unconfirmed`) and every remaining supported
//   pane (`connection-dropped`). Ack request ids carry a per-attempt nonce so
//   a stale reply from a timed-out attempt can never resolve a later one.
// - Write-ahead per-source marker ledger (see `tabs_snapshots_marker.rs`):
//   `in-progress` before the create (the create itself is tagged with a
//   deterministic `restoreKey` so a retry can reconcile an unconfirmed
//   create), `terminalId` recorded after it, promoted to `restored` on ack.
//   Reruns skip `restored` panes (`already-restored`), reconcile `in-progress`
//   panes against the live registry AND the restore-key ledger (never
//   duplicate a still-live create), fail-loud on non-terminal panes they
//   cannot prove undelivered (`in-progress-unconfirmed`), and retry dead
//   ones. A failed marker write is a LOUD 500 (`markerError`); an unreadable
//   or corrupt marker is a LOUD 409 (force overrides explicitly).
// - `force` preserves history: it unions the prior marker into what it writes;
//   it only bypasses the already-restored skip, the target gate, the
//   corrupt-marker refusal, and the `in-progress-unconfirmed` refusal.
// - `kind:"fresh-agent"` (and unknown kinds) are `skipped{unsupported-kind}` —
//   reported loudly, never silent.

#[path = "tabs_snapshots_marker.rs"]
mod marker_mod;
use marker_mod::{
    prune_marker_doc, read_marker_doc, write_marker_doc, Marker, MarkerDoc, PaneMark,
};
#[cfg(test)]
use marker_mod::{MAX_RESTORE_MARKER_SOURCES, RESTORE_MARKER, RESTORE_MARKER_TMP};

/// Map one snapshot pane to its `POST /api/tabs` body, or Err(reason). A terminal
/// pane whose `sessionRef` is present-but-invalid (not an object, missing a
/// nonempty `sessionId`, or `provider != mode`) is rejected HERE (reason
/// `"session-identity-mismatch"`) so the create pipeline can never mint a fresh
/// identity-less session and call it restored. `"unsupported-kind"` is a SKIP;
/// every other Err is a FAIL (classified by the caller).
///
/// FULL captured pane state round-trips (`:245`): everything the frozen
/// client's `tab.create` handler folds (ui-commands.ts — `paneContent` is
/// applied verbatim via initLayout) is passed through the create pipeline:
/// terminal `shell` + `codexDurability`, browser `devToolsOpen`, editor
/// `language`/`readOnly`/`viewMode`/`wordWrap` — so a restored PowerShell/WSL
/// CLI pane comes back under its captured launch environment, not defaults.
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
            // STRICT identity preflight: a NULL/absent sessionRef is fine (no
            // identity to lose); a PRESENT one must be an object with a nonempty
            // sessionId AND provider == mode, else the pane FAILS (never spawns
            // fresh under a "restored" label).
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
        "editor" => match payload.get("filePath").and_then(Value::as_str) {
            Some(fp) => {
                let mut b = json!({ "editor": fp, "name": name });
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
            None => Err("missing-filePath"),
        },
        _ => Err("unsupported-kind"),
    }
}

/// Stable per-pane identity key (content-derived, NOT a positional index).
fn pane_key(tab_key: &str, pane_id: &str) -> String {
    format!("{tab_key}#{pane_id}")
}

/// Deterministic idempotency key a restore-driven create is tagged with
/// (`restoreKey` in the `POST /api/tabs` body). Derivable on RETRY from the
/// same `(deviceId, sourceId, paneKey)` identity, so a rerun can query the
/// fresh-agent restore-key ledger for a create whose marker promotion never
/// landed (the crash window between the pre-create marker write and the
/// post-create terminalId record — `:632`).
fn restore_key_for(device_id: &str, source_id: &str, pane_key: &str) -> String {
    format!("restore:{device_id}:{source_id}:{pane_key}")
}

/// Read the WHOLE marker ledger off-runtime, under the SHARED persistence lock
/// (mutually exclusive with generation writes/pruning and device eviction —
/// `tabs_persist.rs:421`). `Err` = unreadable/corrupt (fail LOUD — `:306`).
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

/// Persist the marker ledger (our source's pane map folded in) when a device
/// dir exists (`None` = nothing to write). ONE home for the write-ahead
/// sequence the handler runs repeatedly. Runs under the SHARED persistence
/// lock, like the read above.
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

/// Delivery ack: send `screenshot.capture` to the selected target connection
/// and await a reply from that same connection within `timeout`. A reply proves the client received every
/// earlier in-order frame (incl. this pane's `tab.create`); a timeout means the
/// connection dropped/stalled. The request id carries the caller's PER-ATTEMPT
/// `nonce` (`restore-ack:{nonce}:{paneKey}`), so a stale reply from a
/// timed-out earlier attempt (same paneKey, different nonce) can never resolve
/// a later attempt's registration (`:403`). Returns `true` iff delivery was
/// confirmed.
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
        Ok(_) => true, // ANY resolve (ok OR error) == received
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
    // FAIL-CLOSED selection parsing (`:459`): malformed selectors are a 400,
    // never a silent fall-through to the broader union. Priority when valid:
    // components (immutable multi-client bundle, :2621) > generationId >
    // generation > coherent union.
    let selection = match parse_restore_selection(&body) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
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
            // EVERY unique requested component must resolve, else fail loudly
            // (`tabs_persist.rs:232` — never a silent partial union).
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
    // Fail-closed `panes` preflight (`:175` targeted remediation): every
    // requested pane key must exist among the snapshot's OPEN panes, BEFORE any
    // side effect. Unknown keys are a 400 naming them, never silently ignored.
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
    // STABLE content identity of the chosen snapshot -> the marker keys off this.
    let source_id = freshell_ws::tabs_persist::snapshot_content_id(&snap);
    let captured_at = snap.get("capturedAt").and_then(Value::as_i64).unwrap_or(0);
    // Per-restore-attempt nonce for delivery-ack request ids (`:403`): a stale
    // ack from a timed-out earlier attempt can never resolve this attempt's
    // registration, because the ids differ in the nonce.
    let nonce = uuid::Uuid::new_v4().to_string();

    // Serialize: hold the lock across read-marker -> create -> ack -> write-marker.
    let _guard = state.restore_lock.lock().await;

    // Bind the whole restore attempt to the exact connection selected while
    // holding the restore lock. A later connection cannot receive its tab.create
    // frames or satisfy its delivery acknowledgements.
    let (connected, target_client_id) = state.screenshots.client_snapshot();
    if !dry_run && !force && target_client_id.is_none() {
        return (StatusCode::CONFLICT, Json(json!({
            "error": format!("restore requires exactly one connected browser (found {connected}); connect the target device only, or pass force"),
            "connectedClients": connected,
        }))).into_response();
    }

    let device_dir = freshell_ws::tabs_persist::encode_device_id(&device_id).map(|e| dir.join(e));
    // ALWAYS load the prior marker LEDGER (force too, so history is preserved —
    // :1497). It is kept per (deviceId, sourceId): restoring source A, then B,
    // then A again still sees A's history and cannot duplicate A's panes
    // (`:304`). An unreadable/corrupt marker is a LOUD 409 (`:306`) — the
    // marker is the sole idempotency record, so "can't read it" must never be
    // treated as "nothing restored yet". `force` is the explicit operator
    // override: it discards the unreadable ledger and rebuilds it.
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

    let mut restored = Vec::new();
    let mut skipped = Vec::new();
    let mut failed = Vec::new();
    let mut delivery_confirmed = true;
    let mut connection_dropped = false; // once true, remaining panes are FAILED
    let records = snap
        .get("records")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
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

            // Targeted-restore filter (`:175`): when the caller named specific
            // panes, everything else is REPORTED as skipped (never silently
            // dropped) and never touches the marker or the connection.
            if selection
                .panes
                .as_ref()
                .is_some_and(|filter| !filter.contains(&pk))
            {
                skipped.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                    "reason": "not-selected" }));
                continue;
            }

            // Preflight/kind classification first (a bad-kind pane never touches
            // the marker or the connection).
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
            // (1) already-restored SKIP first when !force (:1623): a rerun over a
            // fully-restored pane is a no-op and must REPORT as a skip, whether or
            // not its terminal is still running (nothing is re-created either way;
            // `marker` already carries the prior record via the `prior` clone).
            // force bypasses this skip (re-creates a restored-but-dead pane) and
            // falls through to reconciliation, which still prevents duplicating a
            // live terminal (:1497).
            if !force {
                if let Some(pm) = &prior_mark {
                    if pm.state == "restored" {
                        skipped.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                            "reason": "already-restored" }));
                        continue;
                    }
                }
            }
            // (2) Reconciliation for everything that got past the skip
            // (crash-window `in-progress` panes always; `restored` panes only
            // under force): a prior create that is STILL LIVE must NEVER be
            // recreated (that is the duplicate the crash-window and blind
            // force would cause). Sources of truth, in order:
            //   (a) the marker's recorded terminalId against the live registry;
            //   (b) the restore-key ledger (`:632`): the create was TAGGED with
            //       a deterministic restoreKey before it ran, so even when the
            //       post-create marker promotion never landed (crash/IO-error
            //       window between the write-ahead entry and the terminalId
            //       record), a same-process retry still finds what it made —
            //       terminals by their live id, browser/editor panes by their
            //       recorded tab.
            //   (c) neither knows the pane: a terminal pane is safe to
            //       re-create (in-process terminals die with the process); a
            //       browser/editor pane is NOT (the client persists tabs
            //       locally, so the earlier `tab.create` may have landed) —
            //       it FAILS `in-progress-unconfirmed` for the operator unless
            //       `force` explicitly recreates it.
            let restore_key = restore_key_for(&device_id, &source_id, &pk);
            let ledger = state.fresh_agent.lookup_restore_key(&restore_key);
            if let Some(pm) = &prior_mark {
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
                    // Re-ack only when a client is present (blind force has no target).
                    let acked = target_client_id.is_some_and(|target| {
                        !connection_dropped && state.screenshots.has_client(target)
                    }) && confirm_delivery(
                        &state,
                        target_client_id.expect("checked Some"),
                        &nonce,
                        &pk,
                    )
                    .await;
                    if !acked {
                        delivery_confirmed = false;
                        marker.insert(pk.clone(), pm.clone()); // keep the prior record
                        skipped.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                            "reason": "reconciled-live" }));
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
                // (c) unconfirmed non-terminal pane: fail loud, never silently
                // recreate what the client may already have (`:632`).
                if pm.state == "in-progress" && kind_str != "terminal" && !force {
                    marker.insert(pk.clone(), pm.clone()); // keep the prior record
                    failed.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                        "reason": "in-progress-unconfirmed",
                        "hint": "an earlier attempt's tab.create may have reached the client; verify the pane in the target browser, then rerun with force:true to recreate it" }));
                    continue;
                }
            }
            if connection_dropped {
                failed.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                    "reason": "connection-dropped" }));
                continue;
            }
            if dry_run {
                restored.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                    "request": create_body, "tabId": Value::Null, "dryRun": true }));
                continue;
            }

            // WRITE-AHEAD: record in-progress BEFORE the side-effect (:1532).
            // The create body carries the deterministic restoreKey recorded in
            // the fresh-agent ledger, closing the crash window between THIS
            // write and the post-create terminalId record (`:632`).
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
                // Create failed -> no NEW side-effect. Restore the PRIOR marker entry
                // (never DISCARD a previously-restored record — :1497); drop the
                // write-ahead placeholder only when there was no prior entry.
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
            // Record the terminalId (still in-progress until acked) and PERSIST it
            // IMMEDIATELY — this shrinks the crash-between-create-and-marker window
            // to a single fsync-rename, so a retry reconciles the live terminal by
            // its recorded id instead of duplicating it (:1532).
            marker.insert(
                pk.clone(),
                PaneMark {
                    state: "in-progress".into(),
                    terminal_id: terminal_id.clone(),
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

            // Deliver and acknowledge on the exact target selected above. A
            // newly-connected socket cannot receive or acknowledge this frame.
            let delivered = target_client_id
                .zip(ui_command)
                .is_some_and(|(target, command)| state.screenshots.send_to_client(target, command));
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
                // A real client that stopped answering == dropped mid-restore. The
                // terminal WAS created (recorded in-progress with its id for the
                // next run's reconciliation); it is reported failed, NOT restored.
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
