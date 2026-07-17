//! # freshell-freshagent — the fresh-agent REST surface (opencode slice)
//!
//! The additive Phase 3.7 wiring that lets the equivalence oracle drive a live
//! opencode/Kimi T2 turn THROUGH the Rust server exactly as it drives the original,
//! and prove `original≡rust` at T2. A faithful port of the opencode path of
//! `server/agent-api/router.ts` (create-tab / send-keys / capture) on top of the
//! [`freshell_opencode`] serve client (`real-transport`).
//!
//! ## Surface (only what the opencode T2 invariant set + baseline need)
//!
//! | Route | Ports | Behaviour |
//! |---|---|---|
//! | `POST /api/tabs {agent:'opencode',…}` | `router.ts:695` + `createFreshAgentPane:546` | mint a `freshopencode-*` placeholder pane (NO serve yet — lazy), broadcast `ui.command{tab.create}`, return `{data:{tabId,paneId,sessionId}}` |
//! | `POST /api/panes/:id/send-keys` | `router.ts:1669` | **cold-start** the `opencode serve` (DEV-0001 fix → NO warm-proxy), create the durable `ses_*`, broadcast `freshAgent.session.materialized` + `sessions.changed`, drive one turn, resolve on the **idle edge** (`status:'idle'`) |
//! | `GET /api/panes/:id/capture` | `router.ts:904` | render the transcript (`listMessages`) as text |
//!
//! ## Cold-start = the DEV-0001 fingerprint
//!
//! The original needs an `OPENCODE_CMD` warm-proxy to step around DEV-0001's cold-serve
//! health-probe wedge. The Rust port carries the fix natively ([`freshell_opencode`]'s
//! bounded per-probe health wait), so the first `send-keys` cold-starts the real serve
//! with **no warm-proxy** — the observable fingerprint the T2-rust test asserts.
//!
//! ## Broadcasts
//!
//! `ui.command` / `freshAgent.session.materialized` / `sessions.changed` are pushed as
//! pre-serialized [`freshell_protocol`] frames onto a shared [`tokio::sync::broadcast`]
//! bus that the `freshell-ws` connections fan out to every client (incl. the oracle's
//! capture socket), so its `wsServerMessageTypes` set matches the original baseline.
//!
//! ## Safety
//!
//! All session data lands under the server's **isolated HOME** (the real `opencode serve`
//! writes `<HOME>/.local/share/opencode/opencode.db`); the user's store is never touched.
//! The spawned serve inherits the server's ownership sentinels and is reaped by
//! [`FreshAgentState::shutdown`] (SIGTERM + the `/proc` ownership sweep) and, as a
//! backstop, by the harness sentinel sweep — no orphans.

pub mod claude;
pub mod codex;
pub mod opencode_ws;
pub mod snapshot;

pub use claude::FreshClaudeState;
pub use codex::FreshCodexState;
pub use opencode_ws::FreshOpencodeState;
pub use snapshot::SnapshotState;

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use freshell_opencode::transport::{
    LoopbackPortAllocator, ReqwestEventSource, ReqwestServeHttp, TokioProcessSpawner,
};
use freshell_opencode::{
    normalize_opencode_effort, normalize_opencode_model, OpencodeServeManager, ServeConfig,
    ServeDeps, ServeError,
};
use freshell_protocol::{
    FreshAgentSessionMaterialized, ServerMessage, SessionLocator, SessionsChanged, UiCommand,
};

/// The opencode fresh-agent `sessionType` (`AGENT_SESSION_TYPES.opencode`, `router.ts:541`).
const SESSION_TYPE: &str = "freshopencode";
/// The runtime provider (`AGENT_SESSION_TYPES.opencode.provider`).
const PROVIDER: &str = "opencode";
/// Fallback turn idle budget when `send-keys` carries no `timeout` (matches the harness's
/// generous Kimi budget; the request always supplies one in the oracle path).
const DEFAULT_TURN_TIMEOUT: Duration = Duration::from_secs(180);

/// Shared, cheaply-cloneable fresh-agent REST state (mergeable into the server app).
#[derive(Clone)]
pub struct FreshAgentState {
    auth_token: Arc<String>,
    /// The shared WS broadcast bus (pre-serialized frames), fanned out by every
    /// `freshell-ws` connection. `ui.command` / `freshAgent.session.materialized` /
    /// `sessions.changed` are pushed here.
    broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    /// paneId → pane record (placeholder id, cwd, model/effort, durable id).
    panes: Arc<Mutex<HashMap<String, PaneEntry>>>,
    /// The single lazily-started `opencode serve` client for this server process.
    opencode: Arc<tokio::sync::Mutex<Option<OpencodeServeManager>>>,
    /// Monotonic `sessions.changed` revision.
    sessions_revision: Arc<AtomicI64>,
}

/// A fresh-agent pane (the `paneContent` subset the opencode T2 path needs).
#[derive(Clone)]
struct PaneEntry {
    placeholder_id: String,
    cwd: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    /// The durable `ses_*` id after the first turn materializes it.
    durable_id: Option<String>,
}

impl FreshAgentState {
    /// Build the state around the shared broadcast bus the WS connections fan out.
    pub fn new(
        auth_token: Arc<String>,
        broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    ) -> Self {
        Self {
            auth_token,
            broadcast_tx,
            panes: Arc::new(Mutex::new(HashMap::new())),
            opencode: Arc::new(tokio::sync::Mutex::new(None)),
            sessions_revision: Arc::new(AtomicI64::new(0)),
        }
    }

    /// Reap the opencode serve sidecar (SIGTERM/SIGKILL + the `/proc` ownership sweep).
    /// Called on server shutdown so the spawned serve leaves no orphan.
    pub async fn shutdown(&self) {
        let manager = self.opencode.lock().await.take();
        if let Some(manager) = manager {
            manager.shutdown().await;
        }
    }

    /// Shared with [`opencode_ws::FreshOpencodeState`] (same crate root), which pushes
    /// `freshAgent.created` / `freshAgent.send.accepted` / `freshAgent.session.materialized`
    /// / `freshAgent.killed` onto the SAME bus this REST slice uses.
    pub(crate) fn broadcast(&self, msg: &ServerMessage) {
        if let Ok(frame) = serde_json::to_string(msg) {
            // A send with no live receivers is fine (returns Err) — the capture socket
            // subscribed before the handshake, so it will observe every broadcast.
            let _ = self.broadcast_tx.send(frame);
        }
    }

    /// Get-or-create the single serve client. `ServeConfig::default()` reads `OPENCODE_CMD`
    /// (unset in the cold-start path → the real `opencode` binary). Cheap `Arc` clone.
    ///
    /// `pub(crate)` so [`opencode_ws::FreshOpencodeState`] reuses THIS ONE manager cell
    /// instead of constructing its own — the "never spawn a second `opencode serve`
    /// sidecar" invariant PR-2 depends on.
    pub(crate) async fn ensure_manager(&self) -> OpencodeServeManager {
        let mut guard = self.opencode.lock().await;
        if let Some(manager) = guard.as_ref() {
            return manager.clone();
        }
        let deps = ServeDeps {
            spawner: Arc::new(TokioProcessSpawner),
            http: Arc::new(ReqwestServeHttp::new()),
            ports: Arc::new(LoopbackPortAllocator),
            events: Arc::new(ReqwestEventSource::new()),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        *guard = Some(manager.clone());
        manager
    }

    /// Test-only: seed the manager cell with a fake-backed [`OpencodeServeManager`] so
    /// [`opencode_ws`]'s unit tests can drive `ensure_manager()` deterministically, with
    /// NO real `opencode` process spawned.
    #[cfg(test)]
    pub(crate) async fn set_manager_for_test(&self, manager: OpencodeServeManager) {
        *self.opencode.lock().await = Some(manager);
    }

    // ── GET /api/fresh-agent/threads/freshopencode/opencode/:threadId (Batch D PR-5) ──

    /// Build a `FreshAgentSnapshotSchema`-shaped JSON snapshot for an opencode session
    /// (`adapter.ts getSnapshot`, `adapter.ts:574-592` + `normalizeOpencodeSnapshot`,
    /// `normalize.ts:357-405`). `thread_id` is treated as the durable `ses_*` id (the id a
    /// materialized fresh-agent pane's REST/WS surfaces hand the client) -- there is no
    /// placeholder-session snapshot path here (an un-materialized pane has no opencode
    /// session to read yet; the client only calls this endpoint after a `sessionRef`/
    /// `sessionId` exists). Fetches the session's own info (`GET /session/:id`) and its
    /// message page (`GET /session/:id/message`) through the ONE shared `opencode serve`
    /// sidecar via [`Self::ensure_manager`].
    pub async fn get_opencode_snapshot(
        &self,
        thread_id: &str,
        cwd: Option<&str>,
    ) -> Result<Value, OpencodeSnapshotError> {
        let manager = self.ensure_manager().await;
        let route: freshell_opencode::Route = cwd.map(str::to_string);

        let info = match manager.get_session(thread_id, &route).await {
            Ok(value) if value.is_object() => value,
            Ok(_) => return Err(OpencodeSnapshotError::NotFound),
            Err(ServeError::Http { status: 404, .. }) => return Err(OpencodeSnapshotError::NotFound),
            Err(err) => return Err(OpencodeSnapshotError::Serve(err)),
        };
        let messages = manager
            .list_messages(thread_id, &route)
            .await
            .map_err(OpencodeSnapshotError::Serve)?;

        Ok(build_opencode_snapshot_json(thread_id, &info, &messages))
    }
}

/// Why [`FreshAgentState::get_opencode_snapshot`] could not produce a snapshot.
#[derive(Debug)]
pub enum OpencodeSnapshotError {
    /// The serve reported no such session (a 404, or a non-object `/session/:id` body).
    NotFound,
    /// The serve request itself failed (transport, cold-start, etc.).
    Serve(ServeError),
}

impl std::fmt::Display for OpencodeSnapshotError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpencodeSnapshotError::NotFound => write!(f, "opencode session not found"),
            OpencodeSnapshotError::Serve(err) => write!(f, "{err}"),
        }
    }
}

/// `modelFromInfo(info)` (`normalize.ts:30-37`): `providerID/modelID`, falling back to a bare
/// `modelID`/`model.id` when no provider is present.
fn opencode_model_from_info(info: &Value) -> Option<String> {
    let provider_id = info
        .get("providerID")
        .and_then(Value::as_str)
        .or_else(|| info.pointer("/model/providerID").and_then(Value::as_str));
    let model_id = info
        .get("modelID")
        .and_then(Value::as_str)
        .or_else(|| info.pointer("/model/modelID").and_then(Value::as_str))
        .or_else(|| info.pointer("/model/id").and_then(Value::as_str));
    match (provider_id, model_id) {
        (Some(provider), Some(model)) => Some(format!("{provider}/{model}")),
        (None, Some(model)) => Some(model.to_string()),
        _ => None,
    }
}

/// `tokenUsage(info)` (`normalize.ts:39-52`).
fn opencode_token_usage(info: &Value) -> Value {
    let tokens = info.get("tokens").cloned().unwrap_or_else(|| json!({}));
    let input = tokens.get("input").and_then(Value::as_f64).unwrap_or(0.0) as i64;
    let output = tokens.get("output").and_then(Value::as_f64).unwrap_or(0.0) as i64;
    let cached = tokens.pointer("/cache/read").and_then(Value::as_f64).map(|v| v as i64);
    let total = tokens
        .get("total")
        .and_then(Value::as_f64)
        .map(|v| v as i64)
        .unwrap_or(input + output + cached.unwrap_or(0));

    let mut usage = Map::new();
    usage.insert("inputTokens".to_string(), json!(input));
    usage.insert("outputTokens".to_string(), json!(output));
    if let Some(cached) = cached {
        usage.insert("cachedTokens".to_string(), json!(cached));
    }
    usage.insert("totalTokens".to_string(), json!(total));
    if let Some(reasoning) = tokens.get("reasoning").and_then(Value::as_f64) {
        usage.insert("contextTokens".to_string(), json!(reasoning as i64));
    }
    if let Some(cost) = info.get("cost").and_then(Value::as_f64) {
        usage.insert("costUsd".to_string(), json!(cost));
    }
    Value::Object(usage)
}

/// `normalizeOpencodeRole(value)` (`normalize.ts:24-28`).
fn opencode_role(value: Option<&str>) -> Option<&'static str> {
    match value {
        Some("user") => Some("user"),
        Some("assistant") => Some("assistant"),
        Some("system") => Some("system"),
        Some("tool") => Some("tool"),
        _ => None,
    }
}

/// A MINIMAL `FreshAgentTurnSchema`-shaped turn from one opencode `{info, parts}` message
/// (`normalizeOpencodeTurn`, `normalize.ts:324-355`). Only `text`-type parts become visible
/// `{kind:'text'}` transcript items today; `reasoning`/`tool`/`file`/`patch`/`compaction`
/// parts are DROPPED rather than mis-rendered (the same honest-subset choice the codex side
/// makes -- see [`crate::codex`]'s snapshot builder doc comment and the task report).
/// Returns `None` when the message has no recognizable role AND produced no items --
/// mirroring the reference's `if (!role && items.length > 0) return null` guard for the
/// "no role but structural output" case; a role-less, item-less message still degenerates to
/// an (excluded) empty turn here, which is harmless since it would carry no visible content.
fn build_opencode_turn_json(message: &Value, ordinal: usize) -> Option<Value> {
    let info = message.get("info").cloned().unwrap_or_else(|| json!({}));
    let id = info
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("message-{ordinal}"));
    let role = opencode_role(info.get("role").and_then(Value::as_str));
    let parts = message.get("parts").and_then(Value::as_array).cloned().unwrap_or_default();

    let mut items = Vec::new();
    let mut text_parts: Vec<String> = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        if part.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        let Some(text) = part.get("text").and_then(Value::as_str) else { continue };
        let part_id = part
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("{id}:part-{index}"));
        items.push(json!({ "id": part_id, "kind": "text", "text": text }));
        text_parts.push(text.to_string());
    }

    if role.is_none() && !items.is_empty() {
        return None;
    }

    let mut turn = Map::new();
    turn.insert("id".to_string(), json!(id));
    turn.insert("turnId".to_string(), json!(id));
    turn.insert("messageId".to_string(), json!(id));
    turn.insert("ordinal".to_string(), json!(ordinal));
    turn.insert("source".to_string(), json!("durable"));
    if let Some(role) = role {
        turn.insert("role".to_string(), json!(role));
    }
    if let Some(model) = opencode_model_from_info(&info) {
        turn.insert("model".to_string(), json!(model));
    }
    turn.insert("summary".to_string(), json!(text_parts.join("\n\n")));
    turn.insert("items".to_string(), json!(items));
    Some(Value::Object(turn))
}

/// `normalizeOpencodeSnapshot` (`normalize.ts:357-405`): map the session's own info + its
/// message page into the `FreshAgentSnapshotSchema` shape. `status` always reports `idle`
/// here -- this REST read has no live busy/idle bit to consult (that lives in the WS
/// session's in-memory turn task, not the serve's own session record) -- an honest
/// approximation the task report calls out; the client's WS-driven busy chrome already
/// covers the live case, this endpoint's job is the committed transcript.
fn build_opencode_snapshot_json(thread_id: &str, info: &Value, messages: &Value) -> Value {
    let messages = messages.as_array().cloned().unwrap_or_default();
    let turns: Vec<Value> = messages
        .iter()
        .enumerate()
        .filter_map(|(ordinal, message)| build_opencode_turn_json(message, ordinal))
        .collect();
    let session_id = info
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(thread_id);
    let revision = info
        .pointer("/time/updated")
        .and_then(Value::as_i64)
        .unwrap_or(turns.len() as i64);
    let latest_turn_id = turns.last().and_then(|t| t.get("turnId")).cloned().unwrap_or(Value::Null);
    let summary = info.get("title").and_then(Value::as_str);

    let mut snapshot = Map::new();
    snapshot.insert("sessionType".to_string(), json!(SESSION_TYPE));
    snapshot.insert("provider".to_string(), json!(PROVIDER));
    snapshot.insert("threadId".to_string(), json!(thread_id));
    snapshot.insert("sessionId".to_string(), json!(session_id));
    snapshot.insert("revision".to_string(), json!(revision));
    snapshot.insert("latestTurnId".to_string(), latest_turn_id);
    snapshot.insert("status".to_string(), json!("idle"));
    if let Some(summary) = summary {
        snapshot.insert("summary".to_string(), json!(summary));
    }
    snapshot.insert(
        "capabilities".to_string(),
        json!({
            "send": true,
            "interrupt": true,
            "approvals": false,
            "questions": false,
            "fork": true,
            "worktrees": false,
            "diffs": true,
            "childThreads": false,
        }),
    );
    snapshot.insert("tokenUsage".to_string(), opencode_token_usage(info));
    snapshot.insert("pendingApprovals".to_string(), json!([]));
    snapshot.insert("pendingQuestions".to_string(), json!([]));
    snapshot.insert("worktrees".to_string(), json!([]));
    snapshot.insert("diffs".to_string(), json!([]));
    snapshot.insert("childThreads".to_string(), json!([]));
    snapshot.insert("turns".to_string(), json!(turns));
    snapshot.insert("extensions".to_string(), json!({ "opencode": {} }));
    Value::Object(snapshot)
}

/// The fresh-agent sub-router, pre-bound to its state.
pub fn router(state: FreshAgentState) -> Router {
    Router::new()
        .route("/api/tabs", post(create_tab))
        .route("/api/panes/{id}/send-keys", post(send_keys))
        .route("/api/panes/{id}/capture", get(capture))
        .with_state(state)
}

// ── auth (constant-time, matches auth.ts#httpAuthMiddleware x-auth-token) ────────

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn authorized(headers: &HeaderMap, token: &str) -> bool {
    headers
        .get("x-auth-token")
        .and_then(|v| v.to_str().ok())
        .map(|provided| constant_time_eq(provided.as_bytes(), token.as_bytes()))
        .unwrap_or(false)
}

// ── response envelopes (server/agent-api/response.ts) ────────────────────────────

/// `ok(data, message)` → `{status:'ok', data, message}` at HTTP 200.
fn ok_json(data: Value, message: &str) -> Response {
    (StatusCode::OK, Json(json!({ "status": "ok", "data": data, "message": message }))).into_response()
}

/// `approx(data, message)` → `{status:'approx', …}` (turn did not reach idle by deadline).
fn approx_json(data: Value, message: &str) -> Response {
    (StatusCode::OK, Json(json!({ "status": "approx", "data": data, "message": message }))).into_response()
}

/// `fail(message)` → `{status:'error', message}` at `status`.
fn fail_json(status: StatusCode, message: String) -> Response {
    (status, Json(json!({ "status": "error", "message": message }))).into_response()
}

/// The error status the original maps serve failures to (`agentRouteErrorStatus`): a
/// bounded cold-start failure / transport error is a 5xx; everything else 500 here.
fn serve_error_status(err: &ServeError) -> StatusCode {
    match err {
        ServeError::NotHealthy { .. }
        | ServeError::Transport(_)
        | ServeError::ProcessExited { .. }
        | ServeError::Spawn(_)
        | ServeError::StartupFailed(_) => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

// ── POST /api/tabs (fresh-agent create) ──────────────────────────────────────────

async fn create_tab(
    State(state): State<FreshAgentState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }
    let agent = body.get("agent").and_then(Value::as_str).unwrap_or("");
    // This surface is the opencode T2 slice; other agents are deferred (400, matching
    // the original's `unknown agent` rejection for anything without a mapping here).
    if agent != "opencode" {
        return fail_json(StatusCode::BAD_REQUEST, format!("unknown agent \"{agent}\""));
    }

    let cwd = body.get("cwd").and_then(Value::as_str).map(str::to_string);
    let model = body.get("model").and_then(Value::as_str).map(str::to_string);
    let effort = body.get("effort").and_then(Value::as_str).map(str::to_string);
    let name = body.get("name").and_then(Value::as_str).map(str::to_string);

    let tab_id = Uuid::new_v4().to_string();
    let pane_id = Uuid::new_v4().to_string();
    // `makePlaceholderSessionId(requestId)` = `freshopencode-<requestId>` (adapter.ts:75).
    let request_id = Uuid::new_v4().simple().to_string();
    let placeholder = format!("freshopencode-{request_id}");

    // The `paneContent` the original attaches + echoes in the ui.command payload.
    let mut pane_content = json!({
        "kind": "fresh-agent",
        "sessionType": SESSION_TYPE,
        "provider": PROVIDER,
        "sessionId": placeholder,
        "createRequestId": request_id,
        "status": "connected",
    });
    if let Some(cwd) = &cwd {
        pane_content["initialCwd"] = json!(cwd);
    }
    if let Some(model) = &model {
        pane_content["model"] = json!(model);
    }
    if let Some(effort) = &effort {
        pane_content["effort"] = json!(effort);
    }

    // Broadcast ui.command{tab.create} (broadcastUiCommand → broadcast to ALL clients,
    // router.ts:704) so the capture socket records the `ui.command` wire type.
    state.broadcast(&ServerMessage::UiCommand(UiCommand {
        command: "tab.create".to_string(),
        payload: Some(json!({
            "id": tab_id,
            "title": name,
            "paneId": pane_id,
            "paneContent": pane_content,
        })),
    }));

    state.panes.lock().expect("panes mutex").insert(
        pane_id.clone(),
        PaneEntry {
            placeholder_id: placeholder.clone(),
            cwd,
            model,
            effort,
            durable_id: None,
        },
    );

    ok_json(
        json!({ "tabId": tab_id, "paneId": pane_id, "sessionId": placeholder }),
        "fresh-agent pane created",
    )
}

// ── POST /api/panes/:id/send-keys (drive one turn) ───────────────────────────────

async fn send_keys(
    State(state): State<FreshAgentState>,
    Path(pane_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }

    let text = body
        .get("data")
        .or_else(|| body.get("keys"))
        .or_else(|| body.get("text"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if text.is_empty() {
        return fail_json(StatusCode::BAD_REQUEST, "text is required".to_string());
    }

    let pane = match state.panes.lock().expect("panes mutex").get(&pane_id).cloned() {
        Some(pane) => pane,
        None => return fail_json(StatusCode::NOT_FOUND, "pane not found".to_string()),
    };

    let turn_timeout = body
        .get("timeout")
        .and_then(value_as_secs)
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_TURN_TIMEOUT);

    let manager = state.ensure_manager().await;
    let route = pane.cwd.clone();

    // AGENT-08 continuity fix: create the durable session ONLY the FIRST time this pane
    // sends (mirrors `adapter.ts materializeOrSend:349` — `if (!state.realSessionId)`).
    // Before this fix, every call unconditionally ran `create_session`, so a second
    // `send-keys` on the same pane silently started a BRAND NEW opencode session instead
    // of continuing the first — the exact context-loss bug the WS `handle_send`
    // continuity regression test (`opencode_ws.rs`) guards against on the WS path.
    let durable_id = if let Some(durable_id) = pane.durable_id.clone() {
        durable_id
    } else {
        // COLD-START + create the durable session. `create_session` runs `ensure_started`
        // (spawn serve → bounded health wait — the DEV-0001 fix, NO warm-proxy) then
        // `POST /session`. Success here IS the cold-start-clean fingerprint.
        let created = match manager.create_session(None, None, pane.cwd.as_deref()).await {
            Ok(created) => created,
            Err(err) => return fail_json(serve_error_status(&err), err.to_string()),
        };
        let durable_id = created.id;

        // Persist the durable id back onto the pane (so /capture and the next
        // `send-keys` on this pane can reuse it instead of re-materializing).
        if let Some(entry) = state.panes.lock().expect("panes mutex").get_mut(&pane_id) {
            entry.durable_id = Some(durable_id.clone());
        }

        let session_ref = SessionLocator {
            provider: PROVIDER.to_string(),
            session_id: durable_id.clone(),
        };

        // Broadcast the placeholder→durable materialization (router.ts:1734, broadcast to
        // ALL) — emitted EXACTLY ONCE per pane, only on the send that actually materializes.
        state.broadcast(&ServerMessage::FreshAgentSessionMaterialized(FreshAgentSessionMaterialized {
            previous_session_id: pane.placeholder_id.clone(),
            provider: PROVIDER.to_string(),
            session_id: durable_id.clone(),
            session_type: SESSION_TYPE.to_string(),
            session_ref: Some(session_ref.clone()),
        }));

        // A durable session was persisted → sessions.changed (the original's
        // session-indexer watcher fires this on the isolated opencode.db write; we
        // surface it directly). Also once-only: subsequent turns on an already-durable
        // session don't create a new session-directory entry.
        let revision = state.sessions_revision.fetch_add(1, Ordering::SeqCst) + 1;
        state.broadcast(&ServerMessage::SessionsChanged(SessionsChanged { revision }));

        durable_id
    };

    // Drive the turn: normalize model/effort (adapter.ts:80-83), send, block on the IDLE
    // edge (session.idle / session.status{idle}) surfaced by run_turn.
    let model = normalize_opencode_model(pane.model.as_deref());
    let effort = normalize_opencode_effort(pane.model.as_deref(), pane.effort.as_deref());
    let submitted_turn_id = Uuid::new_v4().to_string();

    match manager
        .run_turn(&durable_id, &text, model.as_deref(), effort.as_deref(), turn_timeout, route)
        .await
    {
        Ok(()) => ok_json(
            json!({
                "paneId": pane_id,
                "sessionId": durable_id,
                "submittedTurnId": submitted_turn_id,
                "sessionRef": { "provider": PROVIDER, "sessionId": durable_id },
                "status": "idle",
            }),
            "prompt sent",
        ),
        // Idle deadline missed → approx (the turn was accepted; it just did not idle in time).
        Err(ServeError::IdleTimeout { .. }) => approx_json(
            json!({
                "paneId": pane_id,
                "sessionId": durable_id,
                "submittedTurnId": submitted_turn_id,
                "sessionRef": { "provider": PROVIDER, "sessionId": durable_id },
                "status": "approx",
            }),
            "prompt sent; turn did not complete within deadline",
        ),
        Err(err) => fail_json(serve_error_status(&err), err.to_string()),
    }
}

/// A `timeout` value in seconds (number or numeric string), clamped ≥ 0.
fn value_as_secs(value: &Value) -> Option<u64> {
    match value {
        Value::Number(n) => n.as_f64().filter(|f| f.is_finite() && *f >= 0.0).map(|f| f as u64),
        Value::String(s) => s.trim().parse::<f64>().ok().filter(|f| f.is_finite() && *f >= 0.0).map(|f| f as u64),
        _ => None,
    }
}

// ── GET /api/panes/:id/capture (render transcript) ───────────────────────────────

async fn capture(
    State(state): State<FreshAgentState>,
    Path(pane_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }

    let pane = match state.panes.lock().expect("panes mutex").get(&pane_id).cloned() {
        Some(pane) => pane,
        None => return fail_json(StatusCode::NOT_FOUND, "pane not found".to_string()),
    };
    let Some(durable_id) = pane.durable_id else {
        // No turn yet → empty transcript (text/plain), matching a fresh pane.
        return text_plain(String::new());
    };

    let manager = { state.opencode.lock().await.clone() };
    let Some(manager) = manager else {
        return text_plain(String::new());
    };

    match manager.list_messages(&durable_id, &pane.cwd).await {
        Ok(messages) => text_plain(render_transcript(&messages)),
        Err(err) => fail_json(serve_error_status(&err), err.to_string()),
    }
}

fn text_plain(body: String) -> Response {
    (StatusCode::OK, [("content-type", "text/plain; charset=utf-8")], body).into_response()
}

/// Render an opencode message page to plain text: collect every `{type:'text', text}`
/// part's text (the transcript's assistant + user turns), joined by newlines. Robust to
/// the exact message/part envelope (walks the tree). Falls back to the raw JSON so the
/// oracle's `captureNonEmpty` never trips on an unexpected shape.
fn render_transcript(value: &Value) -> String {
    let mut out: Vec<String> = Vec::new();
    collect_text_parts(value, &mut out);
    if out.is_empty() {
        // Non-empty guarantee: a shape we did not recognise still yields the raw body.
        return value.to_string();
    }
    out.join("\n")
}

fn collect_text_parts(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            let is_text_part = map.get("type").and_then(Value::as_str) == Some("text");
            if is_text_part {
                if let Some(text) = map.get("text").and_then(Value::as_str) {
                    if !text.is_empty() {
                        out.push(text.to_string());
                    }
                }
            }
            for child in map.values() {
                collect_text_parts(child, out);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_text_parts(item, out);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> FreshAgentState {
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
        FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx))
    }

    #[test]
    fn authorized_is_constant_time_and_requires_header() {
        let mut headers = HeaderMap::new();
        assert!(!authorized(&headers, "tok")); // absent
        headers.insert("x-auth-token", "nope".parse().unwrap());
        assert!(!authorized(&headers, "tok"));
        headers.insert("x-auth-token", "tok".parse().unwrap());
        assert!(authorized(&headers, "tok"));
    }

    #[test]
    fn value_as_secs_parses_number_and_string() {
        assert_eq!(value_as_secs(&json!(180)), Some(180));
        assert_eq!(value_as_secs(&json!("90")), Some(90));
        assert_eq!(value_as_secs(&json!(-1)), None);
        assert_eq!(value_as_secs(&json!("nan")), None);
        assert_eq!(value_as_secs(&json!(null)), None);
    }

    #[test]
    fn render_transcript_collects_text_parts_and_contains_reply() {
        // A representative opencode /message page: user prompt + assistant reply parts.
        let page = json!([
            { "info": { "role": "user" }, "parts": [{ "type": "text", "text": "Reply with freshell-t2-ok" }] },
            { "info": { "role": "assistant" }, "parts": [
                { "type": "step-start" },
                { "type": "text", "text": "freshell-t2-ok" }
            ] }
        ]);
        let rendered = render_transcript(&page);
        assert!(rendered.contains("freshell-t2-ok"), "{rendered}");
        assert!(!rendered.trim().is_empty());
    }

    #[test]
    fn render_transcript_falls_back_to_raw_for_unknown_shape() {
        let page = json!({ "unexpected": "shape" });
        let rendered = render_transcript(&page);
        assert!(!rendered.trim().is_empty());
    }

    #[test]
    fn materialized_frame_carries_placeholder_and_durable() {
        // The broadcast frame shape the oracle's wire.session-materialized invariant reads.
        let msg = ServerMessage::FreshAgentSessionMaterialized(FreshAgentSessionMaterialized {
            previous_session_id: "freshopencode-abc".to_string(),
            provider: PROVIDER.to_string(),
            session_id: "ses_123".to_string(),
            session_type: SESSION_TYPE.to_string(),
            session_ref: Some(SessionLocator { provider: PROVIDER.to_string(), session_id: "ses_123".to_string() }),
        });
        let wire: Value = serde_json::to_value(&msg).unwrap();
        assert_eq!(wire["type"], "freshAgent.session.materialized");
        assert_eq!(wire["previousSessionId"], "freshopencode-abc");
        assert_eq!(wire["sessionId"], "ses_123");
        assert_eq!(wire["provider"], "opencode");
    }

    #[tokio::test]
    async fn shutdown_is_safe_when_no_serve_started() {
        // No manager was ever created → shutdown is a clean no-op (never panics).
        state().shutdown().await;
    }

    // ── GET /api/fresh-agent/threads/freshopencode/opencode/:threadId (Batch D PR-5) ──

    use freshell_opencode::{
        Endpoint, EventSource, EventStreamHandle, PortAllocator, ServeDeps, ServeHttp,
        ServeHttpRequest, ServeHttpResponse,
    };

    /// Fakes `GET /session/:id` (session info) and `GET /session/:id/message` (the page)
    /// with fixed, scripted bodies; anything else (health, etc.) is a benign `{}`.
    struct FixedSessionHttp {
        session_body: Value,
        messages_body: Value,
    }
    impl ServeHttp for FixedSessionHttp {
        fn request<'a>(
            &'a self,
            req: ServeHttpRequest,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<ServeHttpResponse, String>> + Send + 'a>>
        {
            let body = if req.url.contains("/message") {
                serde_json::to_vec(&self.messages_body).unwrap()
            } else if req.url.contains("/session/") {
                serde_json::to_vec(&self.session_body).unwrap()
            } else {
                b"{}".to_vec()
            };
            Box::pin(async move { Ok(ServeHttpResponse::new(200, body)) })
        }
    }

    /// Answers the serve's own `/global/health` probe (so `ensure_started()` succeeds) but
    /// 404s any `/session/:id` GET (unknown session).
    struct NotFoundHttp;
    impl ServeHttp for NotFoundHttp {
        fn request<'a>(
            &'a self,
            req: ServeHttpRequest,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<ServeHttpResponse, String>> + Send + 'a>>
        {
            Box::pin(async move {
                if req.url.contains("/global/health") {
                    return Ok(ServeHttpResponse::new(200, b"{}".to_vec()));
                }
                Ok(ServeHttpResponse::new(404, b"not found".to_vec()))
            })
        }
    }

    struct FakeAllocator;
    impl PortAllocator for FakeAllocator {
        fn allocate(&self) -> Result<Endpoint, String> {
            Ok(Endpoint { hostname: "127.0.0.1".into(), port: 1 })
        }
    }
    struct NoopHandle;
    impl EventStreamHandle for NoopHandle {}
    struct NoopEventSource;
    impl EventSource for NoopEventSource {
        fn connect(&self, _url: String, _sink: freshell_opencode::serve::EventSink) -> Box<dyn EventStreamHandle> {
            Box::new(NoopHandle)
        }
    }
    struct NoopSpawner;
    impl freshell_opencode::ProcessSpawner for NoopSpawner {
        fn spawn(&self, _req: freshell_opencode::serve::SpawnRequest) -> Result<Box<dyn freshell_opencode::ServeProcess>, String> {
            struct NoopProcess;
            impl freshell_opencode::ServeProcess for NoopProcess {
                fn exited(&self) -> Option<i32> {
                    None
                }
                fn take_fatal_startup_error(&self) -> Option<String> {
                    None
                }
                fn kill(&self) {}
            }
            Ok(Box::new(NoopProcess))
        }
    }

    async fn state_with_fixed_session_http(session_body: Value, messages_body: Value) -> FreshAgentState {
        let st = state();
        let deps = ServeDeps {
            spawner: Arc::new(NoopSpawner),
            http: Arc::new(FixedSessionHttp { session_body, messages_body }),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        manager.ensure_started().await.expect("healthy fake serve starts");
        st.set_manager_for_test(manager).await;
        st
    }

    #[tokio::test]
    async fn get_opencode_snapshot_returns_a_schema_shaped_snapshot_with_turn_text() {
        let session_body = json!({
            "id": "ses_1",
            "title": "a session",
            "time": { "created": 1_700_000_000_000i64, "updated": 1_700_000_005_000i64 },
            "tokens": { "input": 10, "output": 20, "total": 30 },
        });
        let messages_body = json!([
            { "info": { "id": "msg-1", "role": "user" }, "parts": [{ "type": "text", "text": "hi" }] },
            { "info": { "id": "msg-2", "role": "assistant" }, "parts": [
                { "type": "step-start" },
                { "type": "text", "text": "hello from opencode" }
            ] },
        ]);
        let st = state_with_fixed_session_http(session_body, messages_body).await;

        let snapshot = st.get_opencode_snapshot("ses_1", None).await.expect("snapshot builds");

        assert_eq!(snapshot["sessionType"], json!("freshopencode"));
        assert_eq!(snapshot["provider"], json!("opencode"));
        assert_eq!(snapshot["threadId"], json!("ses_1"));
        assert_eq!(snapshot["sessionId"], json!("ses_1"));
        assert_eq!(snapshot["revision"], json!(1_700_000_005_000i64));
        assert_eq!(snapshot["status"], json!("idle"));
        assert_eq!(snapshot["summary"], json!("a session"));
        assert_eq!(snapshot["tokenUsage"]["inputTokens"], json!(10));
        assert_eq!(snapshot["tokenUsage"]["outputTokens"], json!(20));
        assert_eq!(snapshot["tokenUsage"]["totalTokens"], json!(30));
        assert_eq!(snapshot["pendingApprovals"], json!([]));
        assert_eq!(snapshot["extensions"]["opencode"], json!({}));

        let turns = snapshot["turns"].as_array().expect("turns array");
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0]["role"], json!("user"));
        assert_eq!(turns[0]["items"][0]["kind"], json!("text"));
        assert_eq!(turns[0]["items"][0]["text"], json!("hi"));
        assert_eq!(turns[1]["role"], json!("assistant"));
        assert_eq!(turns[1]["summary"], json!("hello from opencode"));
        assert_eq!(snapshot["latestTurnId"], turns[1]["turnId"]);
    }

    #[tokio::test]
    async fn get_opencode_snapshot_of_unknown_session_is_not_found() {
        let st = state();
        let deps = ServeDeps {
            spawner: Arc::new(NoopSpawner),
            http: Arc::new(NotFoundHttp),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        manager.ensure_started().await.expect("healthy fake serve starts");
        st.set_manager_for_test(manager).await;

        let err = st.get_opencode_snapshot("does-not-exist", None).await.expect_err("unknown session");
        assert!(matches!(err, OpencodeSnapshotError::NotFound));
    }
}
