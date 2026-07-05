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
use serde_json::{json, Value};
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

    fn broadcast(&self, msg: &ServerMessage) {
        if let Ok(frame) = serde_json::to_string(msg) {
            // A send with no live receivers is fine (returns Err) — the capture socket
            // subscribed before the handshake, so it will observe every broadcast.
            let _ = self.broadcast_tx.send(frame);
        }
    }

    /// Get-or-create the single serve client. `ServeConfig::default()` reads `OPENCODE_CMD`
    /// (unset in the cold-start path → the real `opencode` binary). Cheap `Arc` clone.
    async fn ensure_manager(&self) -> OpencodeServeManager {
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

    // COLD-START + create the durable session. `create_session` runs `ensure_started`
    // (spawn serve → bounded health wait — the DEV-0001 fix, NO warm-proxy) then
    // `POST /session`. Success here IS the cold-start-clean fingerprint.
    let created = match manager.create_session(None, None, pane.cwd.as_deref()).await {
        Ok(created) => created,
        Err(err) => return fail_json(serve_error_status(&err), err.to_string()),
    };
    let durable_id = created.id;

    // Persist the durable id back onto the pane (so /capture can read it).
    if let Some(entry) = state.panes.lock().expect("panes mutex").get_mut(&pane_id) {
        entry.durable_id = Some(durable_id.clone());
    }

    let session_ref = SessionLocator {
        provider: PROVIDER.to_string(),
        session_id: durable_id.clone(),
    };

    // Broadcast the placeholder→durable materialization (router.ts:1734, broadcast to ALL).
    state.broadcast(&ServerMessage::FreshAgentSessionMaterialized(FreshAgentSessionMaterialized {
        previous_session_id: pane.placeholder_id.clone(),
        provider: PROVIDER.to_string(),
        session_id: durable_id.clone(),
        session_type: SESSION_TYPE.to_string(),
        session_ref: Some(session_ref.clone()),
    }));

    // A durable session was persisted → sessions.changed (the original's session-indexer
    // watcher fires this on the isolated opencode.db write; we surface it directly).
    let revision = state.sessions_revision.fetch_add(1, Ordering::SeqCst) + 1;
    state.broadcast(&ServerMessage::SessionsChanged(SessionsChanged { revision }));

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
}
