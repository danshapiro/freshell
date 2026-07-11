//! # freshell-freshagent :: codex — the freshcodex WS fresh-agent slice
//!
//! The additive Phase 3.8b wiring that lets the equivalence oracle drive a live
//! codex/GPT T2 turn THROUGH the Rust server exactly as it drives the original, and
//! prove `original≡rust` at T2. A faithful port of the codex path of `server/ws-handler.ts`
//! (`freshAgent.create` / `freshAgent.send`) + `server/fresh-agent/adapters/codex/adapter.ts`
//! (thread/turn drive, the STATUS-GUARDED completion edge) on top of the
//! [`freshell_codex`] app-server client CORE (`real-transport`).
//!
//! ## Drive path (WS, not REST)
//!
//! Unlike the opencode slice (POST /api/tabs + send-keys, REST), codex is app-server-driven
//! (JSON-RPC 2.0 over WS). The oracle drives over the WS `freshAgent.*` surface:
//!
//! | Client→server | Behaviour |
//! |---|---|
//! | `freshAgent.create {sessionType:'freshcodex',…}` | spawn the real `codex app-server` sidecar, `initialize`→`thread/start` → a STABLE UUID threadId (NO placeholder→durable materialization — codex `sessionId==durable`), broadcast `freshAgent.created`, start the notification consumer |
//! | `freshAgent.send {sessionId,text}` | `turn/start` (effort forwarded VERBATIM — DEV-0003), broadcast `freshAgent.send.accepted`; the consumer surfaces completion |
//!
//! The consumer maps codex app-server notifications through the STATUS-GUARDED
//! [`freshell_codex::CodexSubscription`] reducer into `freshAgent.event` envelopes:
//! `turn/completed` → an idle `freshAgent.session.snapshot` (always) THEN a positive
//! `freshAgent.turn.complete` chime ONLY when `params.turn.status ?? params.status ===
//! 'completed'`. That discrete, status-guarded edge is the T2
//! `provider.emits-completion-signal` invariant. The rollout `.jsonl` the app-server persists
//! under the isolated `<CODEX_HOME>/sessions/…` corroborates it.
//!
//! ## Wire types (must match `port/oracle/baselines/t2/codex-gptmini.json`)
//!
//! `freshAgent.created` + `freshAgent.send.accepted` (direct-style, requestId-correlated) and
//! `freshAgent.event` wrapping `freshAgent.session.snapshot` / `freshAgent.turn.complete`
//! (inner event types) — pushed as pre-serialized frames onto the shared broadcast bus the
//! `freshell-ws` connections fan out (incl. the oracle's capture socket).
//!
//! ## Safety
//!
//! Every spawned `codex app-server` inherits the server's isolated HOME (so it authenticates
//! from and writes ALL rollout/session data under `<isolatedHOME>/.codex`, never the user's
//! real store) and carries an `FRESHELL_CODEX_SIDECAR_ID` ownership tag. [`FreshCodexState::shutdown`]
//! SIGTERM/SIGKILLs each child and runs the `/proc` ownership sweep; the harness sentinel sweep
//! is the backstop — no orphans.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::patch,
    Json, Router,
};
use serde_json::{json, Map, Value};
use tokio::sync::Mutex as TokioMutex;

use freshell_codex::transport::{reap_owned_codex_sidecars, TungsteniteTransport};
use freshell_codex::{
    mint_ownership_id, normalize_freshcodex_effort, normalize_freshcodex_model,
    to_codex_reasoning_effort, CodexAdapterEvent, CodexAppServerClient, CodexNotification,
    CodexSubscription, StartThreadParams, StartTurnParams, CODEX_SIDECAR_OWNERSHIP_ENV,
};
use freshell_protocol::{
    ErrorCode, ErrorMsg, FreshAgentCreate, FreshAgentCreated, FreshAgentCreateFailed,
    FreshAgentEvent, FreshAgentSend, ServerMessage, SessionLocator,
};

/// The codex fresh-agent `sessionType` (`AGENT_SESSION_TYPES.codex`).
const SESSION_TYPE: &str = "freshcodex";
/// The runtime provider (`AGENT_SESSION_TYPES.codex.provider`).
const PROVIDER: &str = "codex";
/// The managed-config args every codex app-server launch carries
/// (`CODEX_MANAGED_REMOTE_CONFIG_ARGS`, `codex-managed-config.ts`).
const CODEX_MANAGED_CONFIG_ARGS: &[&str] = &["-c", "features.apps=false"];
/// Cold-boot budget for the sidecar's WS listener + `initialize` handshake.
const SIDECAR_START_BUDGET: Duration = Duration::from_secs(45);

/// Shared, cheaply-cloneable freshcodex WS state (mergeable into the server app + WsState).
#[derive(Clone)]
pub struct FreshCodexState {
    /// The shared WS broadcast bus (pre-serialized frames), fanned out by every
    /// `freshell-ws` connection. `freshAgent.created` / `freshAgent.send.accepted` /
    /// `freshAgent.event` are pushed here so the oracle's capture socket records them.
    broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    /// threadId → live codex session (client + settings + owned sidecar).
    sessions: Arc<TokioMutex<HashMap<String, CodexSession>>>,
    /// The `settings.freshAgent.enabled` gate the WS `freshAgent.create` requires
    /// (default off; flipped true by `PATCH /api/settings`, as a real freshcodex user does).
    fresh_agent_enabled: Arc<AtomicBool>,
    /// The current server settings tree (JSON) returned by `PATCH /api/settings`.
    settings: Arc<TokioMutex<Value>>,
    /// The required auth token (constant-time compared on `PATCH /api/settings`).
    auth_token: Arc<String>,
}

/// One live freshcodex session: the app-server client, its owned sidecar, and the
/// normalized create-time settings a later `send` re-uses.
struct CodexSession {
    client: Arc<CodexAppServerClient>,
    /// Normalized model (`normalizeFreshcodexModel`), reused verbatim on `send`.
    model: String,
    /// Normalized menu effort (`normalizeFreshAgentEffort`); wire-mapped on `send`.
    effort: Option<String>,
    cwd: Option<String>,
    /// Raw create sandbox (e.g. `read-only`) → the turn's `sandboxPolicy`.
    sandbox: Option<String>,
    /// Raw create permissionMode (e.g. `never`) → the turn's `approvalPolicy`.
    permission_mode: Option<String>,
    /// The `/proc` reaper tag for this session's detached app-server sidecar.
    ownership_id: String,
    /// The owned sidecar child (SIGKILL on shutdown; kill_on_drop backstop).
    child: tokio::process::Child,
    /// The notification-consumer task (aborted on shutdown).
    consumer: tokio::task::JoinHandle<()>,
}

impl FreshCodexState {
    /// Build the state around the shared broadcast bus + the current settings tree.
    pub fn new(
        auth_token: Arc<String>,
        broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
        settings: Value,
    ) -> Self {
        // Seed the runtime gate from the settings tree (usually false at boot).
        let enabled = settings
            .pointer("/freshAgent/enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Self {
            broadcast_tx,
            sessions: Arc::new(TokioMutex::new(HashMap::new())),
            fresh_agent_enabled: Arc::new(AtomicBool::new(enabled)),
            settings: Arc::new(TokioMutex::new(settings)),
            auth_token,
        }
    }

    /// The `PATCH /api/settings` sub-router (the fresh-clients enable toggle).
    pub fn settings_router(&self) -> Router {
        Router::new()
            .route("/api/settings", patch(patch_settings))
            .with_state(self.clone())
    }

    /// Whether fresh clients are enabled (`settings.freshAgent.enabled`).
    pub fn is_enabled(&self) -> bool {
        self.fresh_agent_enabled.load(Ordering::SeqCst)
    }

    /// Set the `settings.freshAgent.enabled` gate directly. Called by the
    /// consolidated `/api/settings` router (`freshell-server::settings_store`)
    /// after every successful merge, so the codex create-gate reflects the ONE
    /// live settings source of truth instead of this slice's own (now-unused
    /// for HTTP purposes) internal settings copy.
    pub fn set_enabled(&self, enabled: bool) {
        self.fresh_agent_enabled.store(enabled, Ordering::SeqCst);
    }

    /// Reap every owned codex app-server sidecar (SIGKILL child + `/proc` ownership sweep)
    /// and abort the consumer tasks. Called on server shutdown so no sidecar leaks.
    pub async fn shutdown(&self) {
        let drained: Vec<CodexSession> = {
            let mut guard = self.sessions.lock().await;
            guard.drain().map(|(_, s)| s).collect()
        };
        for session in drained {
            session.consumer.abort();
            session.client.close().await;
            let mut child = session.child;
            let _ = child.start_kill();
            reap_owned_codex_sidecars(&session.ownership_id);
        }
    }

    fn broadcast(&self, msg: &ServerMessage) {
        if let Ok(frame) = serde_json::to_string(msg) {
            let _ = self.broadcast_tx.send(frame);
        }
    }

    // ── freshAgent.create (WS) ───────────────────────────────────────────────

    /// Handle a `freshAgent.create` for codex: spawn the app-server sidecar, start a thread,
    /// register the session + its notification consumer, and broadcast `freshAgent.created`
    /// (or `freshAgent.create.failed`). Long-running (cold sidecar spawn), so the WS loop
    /// dispatches this as a detached task and keeps fanning out the bus meanwhile.
    pub async fn handle_create(&self, msg: FreshAgentCreate) {
        let request_id = msg.request_id.clone();
        let cwd = msg.cwd.clone();
        let model = normalize_freshcodex_model(msg.model.as_deref());
        let effort = normalize_freshcodex_effort(Some(&model), msg.effort.as_deref());
        let sandbox = msg.sandbox.map(sandbox_wire_value);
        let permission_mode = msg.permission_mode.clone();

        // Validate the effort maps to the codex wire vocabulary (adapter create calls
        // toCodexReasoningEffort purely to reject unsupported efforts before spawning).
        if let Err(err) = to_codex_reasoning_effort(effort.as_deref()) {
            self.fail_create(&request_id, "FRESH_AGENT_CREATE_FAILED", &err.to_string());
            return;
        }

        // Spawn + initialize the app-server sidecar.
        let (client, notifs, ownership_id, child) = match self.spawn_sidecar(cwd.as_deref()).await {
            Ok(parts) => parts,
            Err(err) => {
                self.fail_create(&request_id, "CODEX_APP_SERVER_START_FAILED", &err);
                return;
            }
        };

        // thread/start → the STABLE codex thread id (a UUID). No placeholder→durable step.
        let started = client
            .start_thread(StartThreadParams {
                cwd: cwd.clone(),
                model: Some(model.clone()),
                sandbox: sandbox.clone(),
                approval_policy: permission_mode.clone(),
            })
            .await;
        let thread_id = match started {
            Ok(started) => started.thread_id,
            Err(err) => {
                client.close().await;
                let mut child = child;
                let _ = child.start_kill();
                reap_owned_codex_sidecars(&ownership_id);
                self.fail_create(&request_id, "CODEX_THREAD_START_FAILED", &err.to_string());
                return;
            }
        };

        // Start the notification consumer (the status-guarded completion edge lives here).
        let consumer = self.spawn_consumer(notifs, thread_id.clone());

        self.sessions.lock().await.insert(
            thread_id.clone(),
            CodexSession {
                client,
                model,
                effort,
                cwd,
                sandbox,
                permission_mode,
                ownership_id,
                child,
                consumer,
            },
        );

        // Broadcast freshAgent.created (ws-handler.ts:3378). sessionId == durable (UUID).
        self.broadcast(&ServerMessage::FreshAgentCreated(FreshAgentCreated {
            provider: PROVIDER.to_string(),
            request_id,
            runtime_provider: PROVIDER.to_string(),
            session_id: thread_id.clone(),
            session_type: SESSION_TYPE.to_string(),
            session_ref: Some(SessionLocator {
                provider: PROVIDER.to_string(),
                session_id: thread_id,
            }),
        }));
    }

    fn fail_create(&self, request_id: &str, code: &str, message: &str) {
        self.broadcast(&ServerMessage::FreshAgentCreateFailed(FreshAgentCreateFailed {
            code: code.to_string(),
            message: message.to_string(),
            request_id: request_id.to_string(),
            retryable: None,
        }));
    }

    // ── freshAgent.send (WS) ─────────────────────────────────────────────────

    /// Handle a `freshAgent.send` for codex: `turn/start` (effort VERBATIM — DEV-0003), then
    /// broadcast `freshAgent.send.accepted`. The consumer (started at create) surfaces the
    /// completion edge (`freshAgent.session.snapshot` idle + `freshAgent.turn.complete`).
    pub async fn handle_send(&self, msg: FreshAgentSend) {
        let request_id = msg.request_id.clone();
        let session_id = msg.session_id.clone();
        let cwd = msg.cwd.clone();

        // Look up the session; extract the client + settings under the lock (Child isn't Clone).
        let looked_up = {
            let guard = self.sessions.lock().await;
            guard.get(&session_id).map(|s| {
                (
                    s.client.clone(),
                    s.model.clone(),
                    s.effort.clone(),
                    s.cwd.clone().or_else(|| cwd.clone()),
                    s.sandbox.clone(),
                    s.permission_mode.clone(),
                )
            })
        };
        let Some((client, model, effort, turn_cwd, sandbox, permission_mode)) = looked_up else {
            self.send_error(&request_id, "SESSION_NOT_FOUND", "codex session not found");
            return;
        };

        // Re-normalize model/effort on send (adapter.ts:961-963) — idempotent for stored values.
        let model = normalize_freshcodex_model(Some(&model));
        let effort = normalize_freshcodex_effort(Some(&model), effort.as_deref());
        let wire_effort = match to_codex_reasoning_effort(effort.as_deref()) {
            Ok(value) => value,
            Err(err) => {
                self.send_error(&request_id, "INVALID_EFFORT", &err.to_string());
                return;
            }
        };

        let params = StartTurnParams {
            thread_id: session_id.clone(),
            // toCodexUserInput(text): [{ type:'text', text, text_elements:[] }] (adapter.ts:164).
            input: vec![json!({ "type": "text", "text": msg.text, "text_elements": [] })],
            cwd: turn_cwd.clone(),
            model: Some(model),
            // DEV-0003: none/minimal/low/medium/high forwarded VERBATIM; max/xhigh → xhigh.
            effort: wire_effort,
            sandbox_policy: sandbox.as_deref().map(sandbox_policy_value),
            approval_policy: permission_mode.as_deref().map(|p| json!(p)),
        };

        let submitted_turn_id = match client.start_turn(params).await {
            Ok(started) => started.turn_id,
            Err(err) => {
                self.send_error(&request_id, "CODEX_TURN_START_FAILED", &err.to_string());
                return;
            }
        };

        // Broadcast freshAgent.send.accepted (ws-handler.ts:3487). turnAccepted edge.
        self.broadcast(&ServerMessage::FreshAgentSendAccepted(
            freshell_protocol::FreshAgentSendAccepted {
                provider: PROVIDER.to_string(),
                request_id: request_id.unwrap_or_default(),
                session_id,
                session_type: SESSION_TYPE.to_string(),
                cwd: turn_cwd,
                submitted_turn_id: Some(submitted_turn_id),
            },
        ));
    }

    fn send_error(&self, request_id: &Option<String>, code: &str, message: &str) {
        self.broadcast(&ServerMessage::Error(ErrorMsg {
            code: ErrorCode::InternalError,
            message: format!("{code}: {message}"),
            timestamp: now_iso(),
            actual_session_ref: None,
            expected_session_ref: None,
            request_id: request_id.clone(),
            terminal_exit_code: None,
            terminal_id: None,
        }));
    }

    // ── codex app-server sidecar spawn ───────────────────────────────────────

    /// Spawn `codex -c features.apps=false app-server --listen ws://127.0.0.1:<port>`
    /// (`runtime.ts:1246-1261`), ownership-tagged, inheriting the server's isolated HOME (so
    /// codex authenticates from + writes under `<isolatedHOME>/.codex`). Connect the WS with
    /// retry, then `initialize`. Returns the client, its notification stream, the ownership
    /// tag, and the owned child.
    #[allow(clippy::type_complexity)]
    async fn spawn_sidecar(
        &self,
        cwd: Option<&str>,
    ) -> Result<
        (
            Arc<CodexAppServerClient>,
            tokio::sync::mpsc::UnboundedReceiver<CodexNotification>,
            String,
            tokio::process::Child,
        ),
        String,
    > {
        use std::process::Stdio;

        let port = allocate_loopback_port()?;
        let ws_url = format!("ws://127.0.0.1:{port}");
        let ownership_id = mint_ownership_id();
        let codex_cmd = std::env::var("CODEX_CMD").unwrap_or_else(|_| "codex".to_string());

        let mut cmd = tokio::process::Command::new(&codex_cmd);
        cmd.args(CODEX_MANAGED_CONFIG_ARGS);
        cmd.args(["app-server", "--listen", &ws_url]);
        if let Some(cwd) = cwd {
            cmd.current_dir(cwd);
        }
        // Inherit the parent env (HOME=<isolated>, CODEX_HOME unset → <HOME>/.codex) and
        // layer the ownership tag so the /proc reaper can find exactly our sidecar.
        cmd.env(CODEX_SIDECAR_OWNERSHIP_ENV, &ownership_id);
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        cmd.kill_on_drop(true);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("codex app-server spawn failed ({codex_cmd}): {e}"))?;
        // Drain child stdio so verbose app-server/MCP logs can never fill the pipe and stall it.
        if let Some(out) = child.stdout.take() {
            drain_reader(out);
        }
        if let Some(err) = child.stderr.take() {
            drain_reader(err);
        }

        let deadline = Instant::now() + SIDECAR_START_BUDGET;

        // Connect the WS as soon as the listener is up (the app-server binds it after startup).
        let transport = loop {
            match TungsteniteTransport::connect(&ws_url).await {
                Ok(transport) => break Arc::new(transport),
                Err(err) => {
                    if let Ok(Some(status)) = child.try_wait() {
                        return Err(format!("codex app-server exited before listening: {status}"));
                    }
                    if Instant::now() >= deadline {
                        let _ = child.start_kill();
                        reap_owned_codex_sidecars(&ownership_id);
                        return Err(format!("codex app-server WS never came up: {err}"));
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        };

        let (client, notifs) = CodexAppServerClient::connect(transport);
        let client = Arc::new(client);

        // initialize → initialized. Single-flight caches ONLY on success, so a transient
        // failure (socket up before the server can answer) is safely retried until the deadline.
        loop {
            match client.initialize().await {
                Ok(_) => break,
                Err(err) => {
                    if Instant::now() >= deadline {
                        client.close().await;
                        let _ = child.start_kill();
                        reap_owned_codex_sidecars(&ownership_id);
                        return Err(format!("codex app-server initialize failed: {err}"));
                    }
                    tokio::time::sleep(Duration::from_millis(150)).await;
                }
            }
        }

        Ok((client, notifs, ownership_id, child))
    }

    // ── notification consumer (the status-guarded completion edge) ───────────

    /// Consume the app-server notification stream through the STATUS-GUARDED
    /// [`CodexSubscription`] reducer and broadcast the resulting `freshAgent.event` envelopes.
    /// `turn/completed` yields an idle `freshAgent.session.snapshot` (always) then the positive
    /// `freshAgent.turn.complete` chime ONLY on a `completed` status.
    fn spawn_consumer(
        &self,
        mut notifs: tokio::sync::mpsc::UnboundedReceiver<CodexNotification>,
        thread_id: String,
    ) -> tokio::task::JoinHandle<()> {
        let broadcast_tx = self.broadcast_tx.clone();
        tokio::spawn(async move {
            let mut subscription = CodexSubscription::new(thread_id.clone());
            while let Some(notification) = notifs.recv().await {
                let events = reduce_notification(&mut subscription, notification);
                for event in events {
                    let frame = adapter_event_to_frame(&event, &thread_id);
                    if let Some(frame) = frame {
                        let _ = broadcast_tx.send(frame);
                    }
                }
            }
        })
    }
}

/// Reduce one codex notification through the subscription into adapter events.
fn reduce_notification(
    subscription: &mut CodexSubscription,
    notification: CodexNotification,
) -> Vec<CodexAdapterEvent> {
    match notification {
        CodexNotification::ThreadStarted { thread } => {
            let thread_id = thread.get("id").and_then(Value::as_str);
            let Some(thread_id) = thread_id else {
                return Vec::new();
            };
            let status = thread.get("status").cloned().unwrap_or(Value::Null);
            let updated_at = thread.get("updatedAt").and_then(Value::as_f64);
            subscription
                .on_thread_started(thread_id, &status, updated_at)
                .into_iter()
                .collect()
        }
        CodexNotification::ThreadStatusChanged { thread_id, status } => subscription
            .on_thread_status_changed(&thread_id, &status)
            .into_iter()
            .collect(),
        CodexNotification::TurnCompleted(event) => {
            subscription.on_turn_completed(&event, now_ms())
        }
        CodexNotification::TurnStarted(event) => {
            if let Some(turn_id) = &event.turn_id {
                subscription.set_active_turn(turn_id.clone());
            }
            Vec::new()
        }
        CodexNotification::ThreadClosed { thread_id } => {
            subscription.on_thread_closed(&thread_id).into_iter().collect()
        }
        CodexNotification::FsChanged { .. } | CodexNotification::Other { .. } => Vec::new(),
    }
}

/// Map an adapter event to a `freshAgent.event` wire frame (sdk-events.ts normalization:
/// `sdk.*` → `freshAgent.*`). Returns the pre-serialized JSON, or `None` on a serialize error.
fn adapter_event_to_frame(event: &CodexAdapterEvent, thread_id: &str) -> Option<String> {
    let inner = match event {
        CodexAdapterEvent::StatusSnapshot { session_id, status, revision } => {
            let mut map = Map::new();
            map.insert("type".into(), json!("freshAgent.session.snapshot"));
            map.insert("sessionId".into(), json!(session_id));
            map.insert("latestTurnId".into(), Value::Null);
            map.insert("status".into(), json!(status.as_str()));
            map.insert("timelineSessionId".into(), json!(session_id));
            if let Some(revision) = revision {
                map.insert("revision".into(), json!(revision));
            }
            Value::Object(map)
        }
        CodexAdapterEvent::TurnComplete { session_id, at } => json!({
            "type": "freshAgent.turn.complete",
            "sessionId": session_id,
            "at": at,
        }),
        CodexAdapterEvent::Status { session_id, status } => json!({
            "type": "freshAgent.status",
            "sessionId": session_id,
            "status": status.as_str(),
        }),
    };
    let msg = ServerMessage::FreshAgentEvent(FreshAgentEvent {
        event: inner,
        provider: PROVIDER.to_string(),
        session_id: thread_id.to_string(),
        session_type: SESSION_TYPE.to_string(),
    });
    serde_json::to_string(&msg).ok()
}

// ── PATCH /api/settings (fresh-clients enable toggle) ────────────────────────

/// `PATCH /api/settings` — deep-merge the patch into the stored settings, reflect
/// `freshAgent.enabled` into the runtime gate, and return the merged settings (matching
/// `configStore.updateSettings` + the `settings.updated`-shaped response `enableFreshClients`
/// reads). The oracle uses this to enable fresh clients before `freshAgent.create`.
async fn patch_settings(
    State(state): State<FreshCodexState>,
    headers: HeaderMap,
    Json(patch_body): Json<Value>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "unauthorized" }))).into_response();
    }
    let merged = {
        let mut guard = state.settings.lock().await;
        deep_merge(&mut guard, &patch_body);
        guard.clone()
    };
    let enabled = merged
        .pointer("/freshAgent/enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    state.fresh_agent_enabled.store(enabled, Ordering::SeqCst);

    // Fan the merged settings out to every connected WS client (`settings-router.ts:141`
    // `wsHandler.broadcast({ type:'settings.updated', settings: updated })`), so a second
    // client reflects a server-backed settings change live — the multi-client settings
    // fan-out. Only the distilled turn/session invariants are graded by T2, so this extra
    // frame on the shared bus is inert there; a fresh boot / handshake is unaffected
    // (broadcasts only reach already-connected sockets, never the handshake window).
    if let Ok(frame) =
        serde_json::to_string(&json!({ "type": "settings.updated", "settings": merged }))
    {
        let _ = state.broadcast_tx.send(frame);
    }

    (StatusCode::OK, Json(merged)).into_response()
}

/// Recursive object deep-merge (arrays + scalars replace; objects merge key-wise) — the
/// `mergeServerSettings` semantics the settings patch relies on.
fn deep_merge(target: &mut Value, patch: &Value) {
    match (target, patch) {
        (Value::Object(target_map), Value::Object(patch_map)) => {
            for (key, patch_value) in patch_map {
                deep_merge(target_map.entry(key.clone()).or_insert(Value::Null), patch_value);
            }
        }
        (target_slot, patch_value) => {
            *target_slot = patch_value.clone();
        }
    }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/// `x-auth-token` constant-time compare (auth.ts#httpAuthMiddleware).
fn authorized(headers: &HeaderMap, token: &str) -> bool {
    headers
        .get("x-auth-token")
        .and_then(|v| v.to_str().ok())
        .map(|provided| constant_time_eq(provided.as_bytes(), token.as_bytes()))
        .unwrap_or(false)
}

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

/// The `Sandbox` enum → the raw wire string thread/start carries (`read-only` etc.).
fn sandbox_wire_value(sandbox: freshell_protocol::Sandbox) -> String {
    match sandbox {
        freshell_protocol::Sandbox::ReadOnly => "read-only",
        freshell_protocol::Sandbox::WorkspaceWrite => "workspace-write",
        freshell_protocol::Sandbox::DangerFullAccess => "danger-full-access",
    }
    .to_string()
}

/// `toCodexSandboxPolicy(sandbox)` (adapter.ts:136-149): the turn/start `sandboxPolicy` object.
fn sandbox_policy_value(sandbox: &str) -> Value {
    match sandbox {
        "read-only" => json!({ "type": "readOnly" }),
        "workspace-write" => json!({ "type": "workspaceWrite" }),
        "danger-full-access" => json!({ "type": "dangerFullAccess" }),
        other => json!({ "type": other }),
    }
}

/// Allocate an ephemeral loopback port (bind→read→release; the tiny race window matches
/// the reference's `allocateLocalhostPort`).
fn allocate_loopback_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    Ok(listener.local_addr().map_err(|e| e.to_string())?.port())
}

/// Drain an async child pipe to /dev/null so it never back-pressures the app-server.
fn drain_reader<R: tokio::io::AsyncRead + Unpin + Send + 'static>(mut reader: R) {
    tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
    });
}

/// `Date.now()` — epoch milliseconds (the turn-complete clock's `now`).
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// ISO-8601 / RFC-3339 millis-Z timestamp (matches `new Date().toISOString()`) for error frames.
fn now_iso() -> String {
    // Reuse the same shape freshell-ws uses; a tiny local formatter avoids a chrono dep here.
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    // days since epoch → civil date (Howard Hinnant's algorithm).
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (hour, min, sec) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}.{millis:03}Z"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_codex::{CodexStatus, CodexTurnEvent};

    fn state() -> FreshCodexState {
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
        FreshCodexState::new(
            Arc::new("tok".to_string()),
            Arc::new(tx),
            json!({ "freshAgent": { "enabled": false } }),
        )
    }

    #[test]
    fn gate_seeds_from_settings_and_defaults_off() {
        assert!(!state().is_enabled());
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(4);
        let on = FreshCodexState::new(
            Arc::new("t".into()),
            Arc::new(tx),
            json!({ "freshAgent": { "enabled": true } }),
        );
        assert!(on.is_enabled());
    }

    #[test]
    fn sandbox_and_approval_wire_shapes_match_reference() {
        assert_eq!(sandbox_wire_value(freshell_protocol::Sandbox::ReadOnly), "read-only");
        assert_eq!(sandbox_policy_value("read-only"), json!({ "type": "readOnly" }));
        assert_eq!(sandbox_policy_value("workspace-write"), json!({ "type": "workspaceWrite" }));
        assert_eq!(sandbox_policy_value("danger-full-access"), json!({ "type": "dangerFullAccess" }));
    }

    #[test]
    fn turn_complete_event_frames_carry_the_inner_type() {
        // The status-guarded chime → freshAgent.event { event.type: freshAgent.turn.complete }.
        let frame = adapter_event_to_frame(
            &CodexAdapterEvent::TurnComplete { session_id: "t-1".into(), at: 42 },
            "t-1",
        )
        .unwrap();
        let wire: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(wire["type"], "freshAgent.event");
        assert_eq!(wire["provider"], "codex");
        assert_eq!(wire["sessionType"], "freshcodex");
        assert_eq!(wire["sessionId"], "t-1");
        assert_eq!(wire["event"]["type"], "freshAgent.turn.complete");
        assert_eq!(wire["event"]["at"], 42);
    }

    #[test]
    fn idle_snapshot_frames_carry_the_snapshot_inner_type() {
        let frame = adapter_event_to_frame(
            &CodexAdapterEvent::StatusSnapshot {
                session_id: "t-1".into(),
                status: CodexStatus::Idle,
                revision: None,
            },
            "t-1",
        )
        .unwrap();
        let wire: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(wire["type"], "freshAgent.event");
        assert_eq!(wire["event"]["type"], "freshAgent.session.snapshot");
        assert_eq!(wire["event"]["status"], "idle");
    }

    #[test]
    fn completed_turn_yields_snapshot_then_chime_frames() {
        // End-to-end reducer → wire: an idle snapshot precedes the positive chime.
        let mut sub = CodexSubscription::new("t-1");
        let events = sub.on_turn_completed(
            &CodexTurnEvent {
                thread_id: "t-1".into(),
                turn_id: Some("turn-1".into()),
                params: json!({ "threadId": "t-1", "status": "completed" })
                    .as_object()
                    .cloned()
                    .unwrap(),
            },
            1000,
        );
        let inner_types: Vec<String> = events
            .iter()
            .filter_map(|e| adapter_event_to_frame(e, "t-1"))
            .map(|f| serde_json::from_str::<Value>(&f).unwrap()["event"]["type"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(inner_types, vec!["freshAgent.session.snapshot", "freshAgent.turn.complete"]);
    }

    #[test]
    fn deep_merge_replaces_scalars_and_merges_objects() {
        let mut target = json!({ "freshAgent": { "enabled": false, "keep": 1 }, "other": true });
        deep_merge(&mut target, &json!({ "freshAgent": { "enabled": true, "defaultPlugins": [] } }));
        assert_eq!(target["freshAgent"]["enabled"], true);
        assert_eq!(target["freshAgent"]["keep"], 1);
        assert_eq!(target["freshAgent"]["defaultPlugins"], json!([]));
        assert_eq!(target["other"], true);
    }

    #[test]
    fn now_iso_is_iso8601_millis_z() {
        let ts = now_iso();
        assert!(ts.contains('T'), "{ts}");
        assert!(ts.ends_with('Z'), "{ts}");
        assert_eq!(&ts[4..5], "-");
        assert_eq!(&ts[10..11], "T");
    }

    #[tokio::test]
    async fn shutdown_is_safe_with_no_sessions() {
        state().shutdown().await;
    }

    #[tokio::test]
    async fn patch_settings_requires_auth_and_flips_the_gate() {
        // Unauthorized → 401, gate unchanged.
        let st = state();
        let resp = patch_settings(
            State(st.clone()),
            HeaderMap::new(),
            Json(json!({ "freshAgent": { "enabled": true } })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert!(!st.is_enabled());

        // Authorized → 200, gate on, response echoes freshAgent.enabled = true.
        let mut headers = HeaderMap::new();
        headers.insert("x-auth-token", "tok".parse().unwrap());
        let resp = patch_settings(
            State(st.clone()),
            headers,
            Json(json!({ "freshAgent": { "enabled": true, "defaultPlugins": [] } })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(st.is_enabled());
    }
}
