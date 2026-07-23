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

// ── POST /api/tabs-sync/restore ─────────────────────────────────────────────
//
// Rebuilds a device's tabs from a persisted snapshot by driving the SAME
// `POST /api/tabs` create pipeline per snapshot pane (one new tab per OPEN
// pane — the layout tree is client-owned, not restorable server-side). Each
// pane has a STABLE idempotency key `paneKey = "{tabKey}#{paneId}"`; combined
// with the per-device marker's `sourceId` the effective server-side create
// identity is `(deviceId, generationId, paneKey)`. Semantics:
// - Target gate: EXACTLY ONE capable client (409 otherwise); `force`
//   overrides, `dryRun` bypasses (creates nothing).
// - Strict session-identity preflight: a present-but-invalid `sessionRef`
//   fails the pane (`session-identity-mismatch`) BEFORE spawning.
// - Verified delivery: after each create, a screenshot round-trip to the
//   single target client acks receipt of the in-order `tab.create`; a timeout
//   fails that pane (`delivery-unconfirmed`) and every remaining supported
//   pane (`connection-dropped`).
// - Write-ahead per-device marker (`last-restore.marker`, atomic tmp+rename,
//   invisible to the `*.json` generation listing): `in-progress` before the
//   create, `terminalId` recorded after it, promoted to `restored` on ack.
//   Reruns skip `restored` panes (`already-restored`), reconcile `in-progress`
//   panes against the live registry (never duplicate a still-live terminal),
//   and retry dead ones. A failed marker write is a LOUD 500 (`markerError`).
// - `force` preserves history: it unions the prior marker into what it writes;
//   it only bypasses the already-restored skip and the target gate.
// - `kind:"fresh-agent"` (and unknown kinds) are `skipped{unsupported-kind}` —
//   reported loudly, never silent.

const RESTORE_MARKER: &str = "last-restore.marker"; // .marker ext -> invisible to *.json listing

/// Map one snapshot pane to its `POST /api/tabs` body, or Err(reason). A terminal
/// pane whose `sessionRef` is present-but-invalid (not an object, missing a
/// nonempty `sessionId`, or `provider != mode`) is rejected HERE (reason
/// `"session-identity-mismatch"`) so the create pipeline can never mint a fresh
/// identity-less session and call it restored. `"unsupported-kind"` is a SKIP;
/// every other Err is a FAIL (classified by the caller).
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
            Some(url) => Ok(json!({ "browser": url, "name": name })),
            None => Err("missing-url"),
        },
        "editor" => match payload.get("filePath").and_then(Value::as_str) {
            Some(fp) => Ok(json!({ "editor": fp, "name": name })),
            None => Err("missing-filePath"),
        },
        _ => Err("unsupported-kind"),
    }
}

/// Stable per-pane identity key (content-derived, NOT a positional index).
fn pane_key(tab_key: &str, pane_id: &str) -> String {
    format!("{tab_key}#{pane_id}")
}

/// One pane's marker state (`in-progress` = write-ahead, side-effect may exist,
/// delivery NOT yet confirmed; `restored` = delivery-acked). `terminal_id` is
/// recorded once the create returns, for crash reconciliation.
#[derive(Clone)]
struct PaneMark {
    state: String,
    terminal_id: Option<String>,
}
type Marker = std::collections::HashMap<String, PaneMark>;

/// Read the marker's pane map for `source_id`. A marker whose `sourceId` differs
/// is stale -> empty. (Blocking fs — call via `spawn_blocking`.)
fn read_marker(device_dir: &std::path::Path, source_id: &str) -> Marker {
    let Ok(text) = std::fs::read_to_string(device_dir.join(RESTORE_MARKER)) else {
        return Marker::new();
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return Marker::new();
    };
    if v.get("sourceId").and_then(Value::as_str) != Some(source_id) {
        return Marker::new();
    }
    let mut out = Marker::new();
    if let Some(map) = v.get("panes").and_then(Value::as_object) {
        for (k, pm) in map {
            out.insert(
                k.clone(),
                PaneMark {
                    state: pm
                        .get("state")
                        .and_then(Value::as_str)
                        .unwrap_or("in-progress")
                        .to_string(),
                    terminal_id: pm
                        .get("terminalId")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                },
            );
        }
    }
    out
}

/// Atomic (tmp + rename) marker write. Returns Err so the handler fails LOUDLY.
/// (Blocking fs — call via `spawn_blocking`.)
fn write_marker(
    device_dir: &std::path::Path,
    source_id: &str,
    panes: &Marker,
    at: i64,
) -> std::io::Result<()> {
    std::fs::create_dir_all(device_dir)?;
    let panes_json: serde_json::Map<String, Value> = panes
        .iter()
        .map(|(k, pm)| {
            (
                k.clone(),
                json!({ "state": pm.state, "terminalId": pm.terminal_id, "at": at }),
            )
        })
        .collect();
    let bytes = serde_json::to_vec_pretty(&json!({
        "sourceId": source_id, "at": at, "panes": Value::Object(panes_json)
    }))
    .unwrap_or_default();
    let tmp = device_dir.join(format!(".{RESTORE_MARKER}.tmp"));
    std::fs::write(&tmp, &bytes)?;
    std::fs::rename(&tmp, device_dir.join(RESTORE_MARKER))
}

async fn read_marker_async(device_dir: &std::path::Path, source_id: &str) -> Marker {
    let (dd, sid) = (device_dir.to_path_buf(), source_id.to_string());
    tokio::task::spawn_blocking(move || read_marker(&dd, &sid))
        .await
        .unwrap_or_default()
}
async fn write_marker_async(
    device_dir: &std::path::Path,
    source_id: &str,
    panes: Marker,
    at: i64,
) -> std::io::Result<()> {
    let (dd, sid) = (device_dir.to_path_buf(), source_id.to_string());
    match tokio::task::spawn_blocking(move || write_marker(&dd, &sid, &panes, at)).await {
        Ok(r) => r,
        Err(join) => Err(std::io::Error::other(join.to_string())),
    }
}

/// Persist the marker union when a device dir exists (`None` = nothing to
/// write). ONE home for the write-ahead sequence the handler runs three times.
async fn persist_marker(
    device_dir: Option<&std::path::Path>,
    source_id: &str,
    panes: &Marker,
    at: i64,
) -> std::io::Result<()> {
    match device_dir {
        Some(dd) => write_marker_async(dd, source_id, panes.clone(), at).await,
        None => Ok(()),
    }
}

/// Delivery ack: broadcast a `screenshot.capture` to the (single) target client
/// and await ANY reply within `timeout`. A reply proves the client received every
/// earlier in-order frame (incl. this pane's `tab.create`); a timeout means the
/// connection dropped/stalled. Uses a paneKey-derived request id so a stale reply
/// can't cross-resolve. Returns `true` iff delivery was confirmed.
async fn confirm_delivery(state: &TabsSnapshotsState, pane_key: &str) -> bool {
    let request_id = format!("restore-ack:{pane_key}");
    let rx = state.screenshots.register(request_id.clone());
    state
        .screenshots
        .send_capture(&request_id, "view", None, None);
    match tokio::time::timeout(state.restore_ack_timeout, rx).await {
        Ok(_) => true, // ANY resolve (ok OR error) == received
        Err(_) => {
            state.screenshots.cancel(&request_id);
            false
        }
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
    let dry_run = body.get("dryRun").and_then(Value::as_bool).unwrap_or(false);
    let force = body.get("force").and_then(Value::as_bool).unwrap_or(false);
    let connected = state.screenshots.capable_client_count();

    // Target gate: EXACTLY ONE capable client (reject 0 AND >1). dryRun creates
    // nothing (always allowed); force is an explicit operator override.
    if !dry_run && !force && connected != 1 {
        return (StatusCode::CONFLICT, Json(json!({
            "error": format!("restore requires exactly one connected browser (found {connected}); connect the target device only, or pass force"),
            "connectedClients": connected,
        }))).into_response();
    }

    let Some(dir) = state.snapshots_dir.clone() else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Snapshot not found" })),
        )
            .into_response();
    };
    // Snapshot selection off the runtime (fail-loud). Errors -> 500. Priority:
    // components (immutable multi-client bundle, :2621) > generationId > generation
    // > coherent union.
    let components: Vec<String> = body
        .get("components")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let generation_id_req = body
        .get("generationId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let generation_n = body
        .get("generation")
        .and_then(Value::as_u64)
        .map(|g| g as usize);
    let sel = (
        dir.clone(),
        device_id.clone(),
        components.clone(),
        generation_id_req.clone(),
        generation_n,
    );
    let read = tokio::task::spawn_blocking(move || -> std::io::Result<Option<Value>> {
        let (dir, device_id, comps, gid, gn) = sel;
        if !comps.is_empty() {
            freshell_ws::tabs_persist::read_generations_union_by_ids(&dir, &device_id, &comps)
        } else if let Some(id) = gid {
            freshell_ws::tabs_persist::read_generation_by_id(&dir, &device_id, &id)
        } else if let Some(g) = gn {
            freshell_ws::tabs_persist::read_generation(&dir, &device_id, g)
        } else {
            freshell_ws::tabs_persist::read_device_union(&dir, &device_id)
        }
    })
    .await;
    let snap = match read {
        Ok(Ok(Some(snap))) => snap,
        Ok(Ok(None)) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "Snapshot not found" })),
            )
                .into_response()
        }
        Ok(Err(err)) => return snapshots_read_error(&dir, &err),
        Err(join) => return snapshots_read_error(&dir, &join),
    };
    // STABLE content identity of the chosen snapshot -> the marker keys off this.
    let source_id = freshell_ws::tabs_persist::snapshot_content_id(&snap);
    let captured_at = snap.get("capturedAt").and_then(Value::as_i64).unwrap_or(0);

    // Serialize: hold the lock across read-marker -> create -> ack -> write-marker.
    let _guard = state.restore_lock.lock().await;

    let device_dir = freshell_ws::tabs_persist::encode_device_id(&device_id).map(|e| dir.join(e));
    // ALWAYS load the prior marker (force too, so history is preserved — :1497);
    // `force` only bypasses the already-restored SKIP below, never the load/union.
    let prior: Marker = match (&device_dir, dry_run) {
        (Some(dd), false) => read_marker_async(dd, &source_id).await,
        _ => Marker::new(),
    };
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
            let pk = pane_key(&tab_key_str, &pane_id_str);

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
            if dry_run {
                restored.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                    "request": create_body, "tabId": Value::Null }));
                continue;
            }

            let prior_mark = prior.get(&pk).cloned();
            // (1) Live-terminal reconciliation applies ALWAYS (force or not): a
            // prior create whose terminal is STILL RUNNING must NEVER be recreated
            // (that is the duplicate the crash-window and blind force would cause).
            // Re-ack; promote to restored on confirm, else report reconciled-live.
            if let Some(pm) = &prior_mark {
                if pm
                    .terminal_id
                    .as_deref()
                    .is_some_and(|t| state.terminals.is_running(t))
                {
                    // Re-ack only when a client is present (blind force has no target).
                    let acked = connected >= 1
                        && !connection_dropped
                        && confirm_delivery(&state, &pk).await;
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
                                terminal_id: pm.terminal_id.clone(),
                            },
                        );
                        restored.push(json!({ "tabKey": tab_key, "paneId": pane_id, "kind": kind,
                            "terminalId": pm.terminal_id, "reconciled": true }));
                    }
                    continue;
                }
            }
            // (2) already-restored SKIP only when !force (force re-creates a
            // restored-but-no-longer-live pane; ordinary is idempotent — :1497).
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

            // WRITE-AHEAD: record in-progress BEFORE the side-effect (:1532).
            marker.insert(
                pk.clone(),
                PaneMark {
                    state: "in-progress".into(),
                    terminal_id: None,
                },
            );
            if let Err(err) =
                persist_marker(device_dir.as_deref(), &source_id, &marker, captured_at).await
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

            let resp = freshell_freshagent::terminal_tabs::create_terminal_or_content_tab(
                state.fresh_agent.clone(),
                create_body.clone(),
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
            if let Err(err) =
                persist_marker(device_dir.as_deref(), &source_id, &marker, captured_at).await
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

            // DELIVERY ACK (skip when force has no target to ack).
            let confirmed = if connected >= 1 {
                confirm_delivery(&state, &pk).await
            } else {
                false /* force + 0 clients: blind */
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
            } else if connected >= 1 {
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
        if let Err(err) =
            persist_marker(device_dir.as_deref(), &source_id, &marker, captured_at).await
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
        "broadcastScope": "all-connected-clients",
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
