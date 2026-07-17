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
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::patch,
};
use serde_json::{Map, Value, json};
use tokio::sync::{Mutex as TokioMutex, oneshot};

use freshell_codex::transport::{TungsteniteTransport, reap_owned_codex_sidecars};
use freshell_codex::{
    CODEX_SIDECAR_OWNERSHIP_ENV, CodexAdapterEvent, CodexAppServerClient, CodexAppServerError,
    CodexNotification, CodexStatus, CodexSubscription, StartThreadParams, StartTurnParams,
    mint_ownership_id, normalize_codex_thread_status, normalize_freshcodex_effort,
    normalize_freshcodex_model, to_codex_reasoning_effort,
};
use freshell_protocol::{
    ErrorCode, ErrorMsg, FreshAgentAttach, FreshAgentCreate, FreshAgentCreateFailed,
    FreshAgentCreated, FreshAgentEvent, FreshAgentInterrupt, FreshAgentKill, FreshAgentKilled,
    FreshAgentSend, FreshAgentSessionMaterialized, ServerMessage, SessionLocator,
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
    /// Legacy `activeTurnByThread.get(sessionId)` mirror (adapter.ts:295,980,1009,1027): set
    /// immediately after `turn/start` resolves (`handle_send`), cleared on a successful
    /// `handle_interrupt` and whenever the notification consumer observes the turn/thread end
    /// (`reduce_notification`). Lets `freshAgent.interrupt` target the in-flight turn.
    active_turn: Arc<StdMutex<Option<String>>>,
    /// The notification-consumer task (aborted on shutdown/kill).
    consumer: tokio::task::JoinHandle<()>,
    /// Signals the exit-watcher to gracefully tear the sidecar down (a REQUESTED
    /// `freshAgent.kill`); single-shot, so `None` once sent.
    kill_tx: Option<oneshot::Sender<()>>,
    /// Owns the sidecar child. An UNREQUESTED exit self-heals (adapter.ts:935-946): the
    /// watcher broadcasts the terminal `exited` status with NO chime, flips [`Self::exited`],
    /// and does NOT remove the session (stays mapped, matching the reference's "lazy restart
    /// on next send" invariant \u2014 PR-4 implements the actual restart, see
    /// [`FreshCodexState::ensure_session_alive`]).
    watcher: tokio::task::JoinHandle<()>,
    /// PR-4: flipped `true` by the exit-watcher's self-heal (UNREQUESTED-exit) branch;
    /// consulted by [`FreshCodexState::ensure_session_alive`] on the next `freshAgent.send`/
    /// `freshAgent.attach` to decide whether a transparent respawn is needed (the
    /// `ensureRuntime` lazy-restart invariant, adapter.ts:935-946). Cleared back to `false`
    /// once a respawn succeeds.
    exited: Arc<AtomicBool>,
}

/// The result of [`FreshCodexState::ensure_session_alive`].
#[derive(Debug, PartialEq)]
enum EnsureAliveOutcome {
    /// The session's sidecar was already alive; no respawn was needed.
    AlreadyRunning,
    /// The sidecar had crashed; a fresh sidecar + thread were spawned and the session was
    /// materialized under `new_session_id`.
    Respawned { new_session_id: String },
}

/// Why [`FreshCodexState::ensure_session_alive`] could not guarantee a live session.
#[derive(Debug)]
enum EnsureAliveError {
    /// No session is tracked under the given id at all.
    NotFound,
    /// The session was known to have exited, but respawning it failed (sidecar spawn,
    /// WS connect, `initialize`, or `thread/start` all failed) -- the session is left
    /// mapped under its OLD id, still marked exited, for a future retry.
    RespawnFailed(String),
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
            if let Some(kill_tx) = session.kill_tx {
                let _ = kill_tx.send(());
            }
            // The exit-watcher performs start_kill + reap_owned_codex_sidecars on this
            // requested-kill path; wait for it so shutdown() only returns once torn down.
            let _ = session.watcher.await;
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

        // Legacy `activeTurnByThread` mirror for THIS session (adapter.ts:295) \u2014 set on
        // `handle_send`, read/cleared by `handle_interrupt`, cleared by the consumer below.
        let active_turn: Arc<StdMutex<Option<String>>> = Arc::new(StdMutex::new(None));

        // Start the notification consumer (the status-guarded completion edge lives here).
        let consumer = self.spawn_consumer(notifs, thread_id.clone(), active_turn.clone());

        // The exit-watcher owns the sidecar child: a REQUESTED kill (via `kill_tx`) tears it
        // down with no self-heal event; an UNREQUESTED exit self-heals (adapter.ts:935-946)
        // and flips `exited` so the next send/attach lazily respawns (PR-4).
        let (kill_tx, kill_rx) = oneshot::channel();
        let exited = Arc::new(AtomicBool::new(false));
        let watcher = spawn_exit_watcher(
            child,
            ownership_id.clone(),
            thread_id.clone(),
            self.broadcast_tx.clone(),
            kill_rx,
            exited.clone(),
        );

        self.sessions.lock().await.insert(
            thread_id.clone(),
            CodexSession {
                client,
                model,
                effort,
                cwd,
                sandbox,
                permission_mode,
                active_turn,
                consumer,
                kill_tx: Some(kill_tx),
                watcher,
                exited,
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
        self.broadcast(&ServerMessage::FreshAgentCreateFailed(
            FreshAgentCreateFailed {
                code: code.to_string(),
                message: message.to_string(),
                request_id: request_id.to_string(),
                retryable: None,
            },
        ));
    }

    // ── freshAgent.send (WS) ─────────────────────────────────────────────────

    /// Handle a `freshAgent.send` for codex: `turn/start` (effort VERBATIM — DEV-0003), then
    /// broadcast `freshAgent.send.accepted`. The consumer (started at create) surfaces the
    /// completion edge (`freshAgent.session.snapshot` idle + `freshAgent.turn.complete`).
    ///
    /// PR-4: first, `ensure_session_alive` transparently respawns a crashed sidecar (the
    /// `ensureRuntime` lazy-restart invariant, adapter.ts:935-946) -- the ONLY visible effect
    /// is added latency on this one send; there is no user-facing error frame for a
    /// self-healed crash.
    pub async fn handle_send(&self, msg: FreshAgentSend) {
        let request_id = msg.request_id.clone();
        let mut session_id = msg.session_id.clone();
        let cwd = msg.cwd.clone();

        match self.ensure_session_alive(&session_id).await {
            Ok(EnsureAliveOutcome::AlreadyRunning) => {}
            Ok(EnsureAliveOutcome::Respawned { new_session_id }) => {
                session_id = new_session_id;
            }
            Err(EnsureAliveError::NotFound) => {
                self.send_error(&request_id, "SESSION_NOT_FOUND", "codex session not found");
                return;
            }
            Err(EnsureAliveError::RespawnFailed(err)) => {
                self.send_error(&request_id, "CODEX_RESPAWN_FAILED", &err);
                return;
            }
        }

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
                    s.active_turn.clone(),
                )
            })
        };
        let Some((client, model, effort, turn_cwd, sandbox, permission_mode, active_turn)) =
            looked_up
        else {
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
            Ok(started) => {
                // adapter.ts:980 -- track the active turn immediately (before any
                // turn/started notification), so a fast-follow interrupt has a target.
                *active_turn.lock().expect("active_turn mutex") = Some(started.turn_id.clone());
                started.turn_id
            }
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

    // ── freshAgent.interrupt (WS) ────────────────────────────────────────────

    /// Handle a `freshAgent.interrupt` for codex: issue `turn/interrupt` for the tracked
    /// active turn (`activeTurnByThread.get(sessionId)`, adapter.ts:1009) and clear it on
    /// success (adapter.ts:1027). There is NO wire ack on success — the app-server's
    /// resulting `turn/completed{interrupted}` notification flows through the existing
    /// STATUS-GUARDED consumer (`reduce_notification` -> `CodexSubscription::on_turn_completed`),
    /// which emits the idle `freshAgent.session.snapshot` with NO `freshAgent.turn.complete`
    /// chime (an interrupt is not a positive completion). Mirrors `ws-handler.ts:3503-3516`
    /// (fire-and-forget; `INTERNAL_ERROR` on failure).
    pub async fn handle_interrupt(&self, msg: FreshAgentInterrupt) {
        let session_id = msg.session_id.clone();

        let looked_up = {
            let guard = self.sessions.lock().await;
            guard
                .get(&session_id)
                .map(|s| (s.client.clone(), s.active_turn.clone()))
        };
        let Some((client, active_turn)) = looked_up else {
            self.send_error(&None, "SESSION_NOT_FOUND", "codex session not found");
            return;
        };

        let turn_id = active_turn.lock().expect("active_turn mutex").clone();
        let Some(turn_id) = turn_id else {
            // adapter.ts:1017-1019 — no tracked active turn to target.
            self.send_error(
                &None,
                "CODEX_INTERRUPT_FAILED",
                &format!("No active Codex turn is tracked for {session_id}."),
            );
            return;
        };

        match client.interrupt_turn(&session_id, &turn_id).await {
            Ok(()) => {
                // adapter.ts:1027 — the turn is over from this call's perspective; the
                // resulting turn/completed notification also clears it (redundant, harmless).
                *active_turn.lock().expect("active_turn mutex") = None;
            }
            Err(err) => {
                self.send_error(&None, "CODEX_INTERRUPT_FAILED", &err.to_string());
            }
        }
    }

    // ── freshAgent.kill (WS) ─────────────────────────────────────────────────

    /// Handle a `freshAgent.kill` for codex: remove the session and gracefully tear down its
    /// owned sidecar (consumer abort, client close, the exit-watcher's REQUESTED-kill path —
    /// `start_kill` + reap, reusing [`reap_owned_codex_sidecars`]), then broadcast
    /// `freshAgent.killed`. Idempotent for an unknown session id (mirrors `adapter.kill`'s
    /// unconditional `return true`, adapter.ts:1211-1215) — `ws-handler.ts:3607-3626` always
    /// sends `success:true`. Never touches a process this session did not itself spawn.
    pub async fn handle_kill(&self, msg: FreshAgentKill) {
        let session_id = msg.session_id.clone();

        let removed = self.sessions.lock().await.remove(&session_id);
        if let Some(session) = removed {
            session.consumer.abort();
            session.client.close().await;
            if let Some(kill_tx) = session.kill_tx {
                let _ = kill_tx.send(());
            }
            // The exit-watcher performs start_kill + reap on this requested-kill path; wait
            // for it so the sidecar is actually gone before we broadcast success.
            let _ = session.watcher.await;
        }

        self.broadcast(&ServerMessage::FreshAgentKilled(FreshAgentKilled {
            provider: PROVIDER.to_string(),
            session_id,
            session_type: SESSION_TYPE.to_string(),
            success: true,
        }));
    }

    // ── freshAgent.attach (reload-rehydrate, PR-4) ──────────────────────────

    /// Handle a `freshAgent.attach` for codex: recover a crashed sidecar if needed
    /// ([`Self::ensure_session_alive`]), then re-emit a session snapshot so a reloaded
    /// browser rehydrates status (`fresh-agent-ws.ts:196`; legacy's `readThread`-with-turns
    /// path has no Rust-side app-server RPC equivalent yet, so this emits the cached
    /// status/active-turn state rather than a re-fetched transcript -- the transcript
    /// itself already lives in the rollout `.jsonl` history the client reads separately).
    /// An unknown session id emits the `INVALID_SESSION_ID` shape the client folds into
    /// `markSessionLost` (`fresh-agent-ws.ts:326-328`) instead of hanging.
    pub async fn handle_attach(&self, msg: FreshAgentAttach) {
        let session_id = match self.ensure_session_alive(&msg.session_id).await {
            Ok(EnsureAliveOutcome::AlreadyRunning) => msg.session_id.clone(),
            Ok(EnsureAliveOutcome::Respawned { new_session_id }) => new_session_id,
            Err(EnsureAliveError::NotFound) => {
                self.broadcast(&lost_session_frame(&msg.session_id));
                return;
            }
            Err(EnsureAliveError::RespawnFailed(err)) => {
                self.send_error(&None, "CODEX_ATTACH_RESPAWN_FAILED", &err);
                return;
            }
        };

        let running = {
            let guard = self.sessions.lock().await;
            guard
                .get(&session_id)
                .map(|s| s.active_turn.lock().expect("active_turn mutex").is_some())
                .unwrap_or(false)
        };
        let status = if running {
            CodexStatus::Running
        } else {
            CodexStatus::Idle
        };
        let event = CodexAdapterEvent::StatusSnapshot {
            session_id: session_id.clone(),
            status,
            revision: None,
        };
        if let Some(frame) = adapter_event_to_frame(&event, &session_id) {
            let _ = self.broadcast_tx.send(frame);
        }
    }

    // ── lazy restart after crash (PR-4, adapter.ts:935-946 ensureRuntime invariant) ─

    /// Ensure `session_id`'s sidecar is alive, transparently respawning it if the
    /// exit-watcher flipped [`CodexSession::exited`] (a crash/disconnect). This client has
    /// no `thread/resume` RPC, so recovery cannot continue the SAME codex thread; instead it
    /// mints a fresh thread on a fresh sidecar and MATERIALIZES the session under the new
    /// thread id -- the same placeholder\u2192durable identity-move pattern the opencode slice
    /// already uses (`FreshAgentSessionMaterialized`), just triggered by crash-recovery
    /// instead of first-turn creation. Callers (`handle_send`/`handle_attach`) must use the
    /// returned id for anything session-scoped afterward.
    async fn ensure_session_alive(
        &self,
        session_id: &str,
    ) -> Result<EnsureAliveOutcome, EnsureAliveError> {
        let (cwd, model, effort, sandbox, permission_mode) = {
            let guard = self.sessions.lock().await;
            let session = guard.get(session_id).ok_or(EnsureAliveError::NotFound)?;
            if !session.exited.load(Ordering::SeqCst) {
                return Ok(EnsureAliveOutcome::AlreadyRunning);
            }
            (
                session.cwd.clone(),
                session.model.clone(),
                session.effort.clone(),
                session.sandbox.clone(),
                session.permission_mode.clone(),
            )
        };

        let (client, notifs, ownership_id, child) = self
            .spawn_sidecar(cwd.as_deref())
            .await
            .map_err(EnsureAliveError::RespawnFailed)?;

        let started = client
            .start_thread(StartThreadParams {
                cwd: cwd.clone(),
                model: Some(model.clone()),
                sandbox: sandbox.clone(),
                approval_policy: permission_mode.clone(),
            })
            .await;
        let new_thread_id = match started {
            Ok(started) => started.thread_id,
            Err(err) => {
                client.close().await;
                let mut child = child;
                let _ = child.start_kill();
                reap_owned_codex_sidecars(&ownership_id);
                return Err(EnsureAliveError::RespawnFailed(err.to_string()));
            }
        };

        let active_turn: Arc<StdMutex<Option<String>>> = Arc::new(StdMutex::new(None));
        let exited = Arc::new(AtomicBool::new(false));
        let consumer = self.spawn_consumer(notifs, new_thread_id.clone(), active_turn.clone());
        let (kill_tx, kill_rx) = oneshot::channel();
        let watcher = spawn_exit_watcher(
            child,
            ownership_id,
            new_thread_id.clone(),
            self.broadcast_tx.clone(),
            kill_rx,
            exited.clone(),
        );

        {
            let mut guard = self.sessions.lock().await;
            guard.remove(session_id);
            guard.insert(
                new_thread_id.clone(),
                CodexSession {
                    client,
                    model,
                    effort,
                    cwd,
                    sandbox,
                    permission_mode,
                    active_turn,
                    consumer,
                    kill_tx: Some(kill_tx),
                    watcher,
                    exited,
                },
            );
        }

        self.broadcast(&ServerMessage::FreshAgentSessionMaterialized(
            FreshAgentSessionMaterialized {
                previous_session_id: session_id.to_string(),
                provider: PROVIDER.to_string(),
                session_id: new_thread_id.clone(),
                session_type: SESSION_TYPE.to_string(),
                session_ref: Some(SessionLocator {
                    provider: PROVIDER.to_string(),
                    session_id: new_thread_id.clone(),
                }),
            },
        ));

        Ok(EnsureAliveOutcome::Respawned {
            new_session_id: new_thread_id,
        })
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
        // Whitespace-split so a test fixture can point `CODEX_CMD` at an interpreter plus
        // script (e.g. `CODEX_CMD="node /path/fake-app-server.mjs"`) without needing the
        // script to carry its own execute bit; `Command::new` alone treats the whole string
        // as a single (nonexistent) executable path. The default `"codex"` is a single
        // token, so this is a no-op for the real binary.
        let mut codex_cmd_parts = codex_cmd.split_whitespace();
        let codex_program = codex_cmd_parts.next().unwrap_or("codex");
        let codex_leading_args: Vec<&str> = codex_cmd_parts.collect();

        let mut cmd = tokio::process::Command::new(codex_program);
        cmd.args(&codex_leading_args);
        cmd.args(CODEX_MANAGED_CONFIG_ARGS);
        cmd.args(["app-server", "--listen", &ws_url]);
        if let Some(cwd) = cwd {
            cmd.current_dir(cwd);
        }
        // Inherit the parent env (HOME=<isolated>, CODEX_HOME unset → <HOME>/.codex) and
        // layer the ownership tag so the /proc reaper can find exactly our sidecar.
        cmd.env(CODEX_SIDECAR_OWNERSHIP_ENV, &ownership_id);
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
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
                        return Err(format!(
                            "codex app-server exited before listening: {status}"
                        ));
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
        active_turn: Arc<StdMutex<Option<String>>>,
    ) -> tokio::task::JoinHandle<()> {
        let broadcast_tx = self.broadcast_tx.clone();
        tokio::spawn(async move {
            let mut subscription = CodexSubscription::new(thread_id.clone());
            while let Some(notification) = notifs.recv().await {
                let events = reduce_notification(&mut subscription, notification, &active_turn);
                for event in events {
                    let frame = adapter_event_to_frame(&event, &thread_id);
                    if let Some(frame) = frame {
                        let _ = broadcast_tx.send(frame);
                    }
                }
            }
        })
    }

    // ── GET /api/fresh-agent/threads/freshcodex/codex/:threadId (Batch D PR-5) ──

    /// Build a `FreshAgentSnapshotSchema`-shaped JSON snapshot for a live codex thread
    /// (`adapter.ts getSnapshot`, `adapter.ts:1082-1122` + `normalizeCodexThreadSnapshot`,
    /// `normalize.ts:748-787`). Fetches the raw thread record via `thread/read`
    /// (`includeTurns:true`), reading the "is a turn active" bit from THIS session's own
    /// `active_turn` tracker (mirrors legacy's `activeTurnByThread`/`findActiveTurnId`) rather
    /// than re-deriving it from the raw payload, since it is already the source of truth this
    /// process trusts for `handle_interrupt`.
    pub async fn get_snapshot(&self, thread_id: &str) -> Result<Value, CodexSnapshotError> {
        let (client, active_turn_present) = {
            let guard = self.sessions.lock().await;
            let session = guard.get(thread_id).ok_or(CodexSnapshotError::NotFound)?;
            let client = session.client.clone();
            let active_turn_present = session
                .active_turn
                .lock()
                .expect("active_turn mutex")
                .is_some();
            (client, active_turn_present)
        };
        let raw = client
            .read_thread(thread_id, true)
            .await
            .map_err(CodexSnapshotError::AppServer)?;
        build_codex_snapshot_json(thread_id, &raw, active_turn_present)
            .map_err(CodexSnapshotError::Protocol)
    }

    /// Test-only: register a session directly (bypassing the real sidecar spawn
    /// `handle_create` requires), so [`crate::snapshot`]'s router-level tests can exercise
    /// `get_snapshot` against a scripted [`freshell_codex::ChannelPeer`] without a real
    /// `codex app-server` process. Owns a harmless real `sleep` child so the session's
    /// exit-watcher has a real PID to watch (mirrors `codex::tests::insert_fake_session`).
    #[cfg(test)]
    pub(crate) async fn insert_session_for_test(
        &self,
        thread_id: &str,
        client: Arc<CodexAppServerClient>,
        active_turn: Option<String>,
    ) {
        let mut cmd = tokio::process::Command::new("sleep");
        cmd.arg("30");
        cmd.kill_on_drop(true);
        let child = cmd.spawn().expect("spawn sleep fixture");

        let consumer = tokio::spawn(async {});
        let (kill_tx, kill_rx) = oneshot::channel();
        let exited = Arc::new(AtomicBool::new(false));
        let watcher = spawn_exit_watcher(
            child,
            format!("codex-sidecar-test-snapshot-router-{thread_id}"),
            thread_id.to_string(),
            self.broadcast_tx.clone(),
            kill_rx,
            exited.clone(),
        );
        self.sessions.lock().await.insert(
            thread_id.to_string(),
            CodexSession {
                client,
                model: "gpt-5.3-codex-spark".to_string(),
                effort: None,
                cwd: None,
                sandbox: None,
                permission_mode: None,
                active_turn: Arc::new(StdMutex::new(active_turn)),
                consumer,
                kill_tx: Some(kill_tx),
                watcher,
                exited,
            },
        );
    }
}

/// Why [`FreshCodexState::get_snapshot`] could not produce a snapshot.
#[derive(Debug)]
pub enum CodexSnapshotError {
    /// No session is tracked under the given thread id (the REST-surface analogue of the
    /// WS `FreshAgentLostSessionError` -- there is no crash-recovery path for a cold REST
    /// GET, unlike `freshAgent.attach`, so an unknown/exited thread is reported honestly).
    NotFound,
    /// The live app-server client's `thread/read` call failed.
    AppServer(CodexAppServerError),
    /// A raw thread item's `type` was not one of `CodexThreadItemTypeSchema`'s known variants
    /// (`protocol.ts:113-129`) -- mirrors `readCodexThreadItemType`/`assertNever` both
    /// throwing `Unsupported Codex thread item type: ${value}` (`normalize.ts:141-147,123-125`),
    /// which `router.ts`'s catch-all turns into a bare 500 (`router.ts:165-166`). Every
    /// variant the real app-server currently emits IS mapped below, so this is a forward-compat
    /// guard against a future app-server item type this build doesn't know about yet, not a
    /// path exercised by ordinary transcripts.
    Protocol(String),
}

impl std::fmt::Display for CodexSnapshotError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CodexSnapshotError::NotFound => write!(f, "codex thread not found"),
            CodexSnapshotError::AppServer(err) => write!(f, "{err}"),
            CodexSnapshotError::Protocol(message) => write!(f, "{message}"),
        }
    }
}

/// `normalizeCommandStatus(status)` (`normalize.ts:105-113`).
fn codex_normalize_command_status(status: Option<&str>) -> &'static str {
    match status {
        Some("inProgress") => "running",
        Some("declined") => "declined",
        Some("failed") => "failed",
        _ => "completed",
    }
}

/// `normalizeToolStatus(status)` (`normalize.ts:115-121`).
fn codex_normalize_tool_status(status: Option<&str>) -> &'static str {
    match status {
        Some("inProgress") => "running",
        Some("failed") => "failed",
        _ => "completed",
    }
}

/// `stringArray(value)` (`normalize.ts:158-166`).
fn codex_string_array(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect(),
        Some(Value::String(s)) => vec![s.clone()],
        _ => vec![],
    }
}

/// `String(value ?? '')` (used by several `normalizeCodexItem` arms, e.g. `normalize.ts:374,376,419,421,434,446`).
fn codex_to_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

/// `readUserMessageTextParts(item)` (`normalize.ts:209-236`): a `userMessage` item's
/// `content` array becomes one text part per entry (`text`/`input_text` parts keep their
/// text; anything else becomes a `[type]` placeholder), falling back to `item.text`,
/// `item.summary`, then a single empty part.
fn codex_user_message_text_parts(item: &Value) -> Vec<(usize, String)> {
    if let Some(content) = item.get("content").and_then(Value::as_array) {
        if !content.is_empty() {
            return content
                .iter()
                .enumerate()
                .map(|(part_index, part)| {
                    let part_type = part.get("type").and_then(Value::as_str);
                    let text = if part_type == Some("text") || part_type == Some("input_text") {
                        part.get("text")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string()
                    } else {
                        format!("[{}]", part_type.unwrap_or("input"))
                    };
                    (part_index, text)
                })
                .collect();
        }
    }
    if let Some(text) = item.get("text").and_then(Value::as_str) {
        return vec![(0, text.to_string())];
    }
    if let Some(summary) = item.get("summary").and_then(Value::as_str) {
        return vec![(0, summary.to_string())];
    }
    vec![(0, String::new())]
}

/// `normalizeCodexItem` (`normalize.ts:238-473`): map ONE raw codex thread item into its
/// `FreshAgentTranscriptItemSchema`-shaped item(s). Every `CodexThreadItemTypeSchema` variant
/// (`protocol.ts:113-129`) is covered; an item `type` outside that set is `Err` (mirrors
/// `readCodexThreadItemType`'s zod-parse throw + `assertNever`'s default-case throw,
/// `normalize.ts:141-147,123-125` -- see [`CodexSnapshotError::Protocol`]).
///
/// Unlike the reference, a missing `item.id` does NOT throw (`readCodexItemId`,
/// `normalize.ts:149-156`) -- the caller ([`build_codex_turn_json`]) already falls back to a
/// synthetic `{turnId}:item-{index}` id, matching this module's existing tolerant-read
/// convention elsewhere (documented divergence, not a silent one).
fn map_codex_item(item_id: &str, item: &Value, item_type: &str) -> Result<Vec<Value>, String> {
    match item_type {
        "userMessage" => Ok(codex_user_message_text_parts(item)
            .into_iter()
            .map(|(part_index, text)| {
                json!({ "id": format!("{item_id}:part:{part_index}"), "kind": "text", "text": text })
            })
            .collect()),
        "agentMessage" | "plan" => {
            let text = item
                .get("text")
                .and_then(Value::as_str)
                .or_else(|| item.get("summary").and_then(Value::as_str))
                .unwrap_or("");
            Ok(vec![json!({ "id": item_id, "kind": "text", "text": text })])
        }
        "reasoning" => {
            let summary = codex_string_array(item.get("summary"));
            let content = codex_string_array(item.get("content"));
            let text = if !summary.is_empty() { summary.join("\n") } else { content.join("\n") };
            Ok(vec![json!({
                "id": item_id, "kind": "reasoning", "summary": summary, "content": content, "text": text,
            })])
        }
        "commandExecution" => {
            let mut value = json!({
                "id": item_id,
                "kind": "command",
                "command": item.get("command").and_then(Value::as_str).unwrap_or(""),
                "status": codex_normalize_command_status(item.get("status").and_then(Value::as_str)),
                "output": item.get("aggregatedOutput").and_then(Value::as_str),
                "exitCode": item.get("exitCode").and_then(Value::as_i64),
                "extensions": { "codex": item },
            });
            // `cwd` is optional-not-nullable in the schema -- omit the key entirely rather
            // than emit `null` (`normalize.ts:312`).
            if let Some(cwd) = item.get("cwd").and_then(Value::as_str) {
                value["cwd"] = json!(cwd);
            }
            Ok(vec![value])
        }
        "fileChange" => {
            let changes: Vec<Value> = item
                .get("changes")
                .and_then(Value::as_array)
                .map(|arr| arr.iter().filter(|change| change.is_object()).cloned().collect())
                .unwrap_or_default();
            Ok(vec![json!({
                "id": item_id,
                "kind": "file_change",
                "status": codex_normalize_command_status(item.get("status").and_then(Value::as_str)),
                "changes": changes,
                "extensions": { "codex": item },
            })])
        }
        "mcpToolCall" => Ok(vec![json!({
            "id": item_id,
            "kind": "mcp_tool",
            "server": item.get("server").and_then(Value::as_str).unwrap_or(""),
            "tool": item.get("tool").and_then(Value::as_str).unwrap_or(""),
            "status": codex_normalize_tool_status(item.get("status").and_then(Value::as_str)),
            "arguments": item.get("arguments").cloned().unwrap_or(Value::Null),
            "result": item.get("result").cloned().unwrap_or(Value::Null),
            "error": item.get("error").cloned().unwrap_or(Value::Null),
        })]),
        "dynamicToolCall" => Ok(vec![json!({
            "id": item_id,
            "kind": "dynamic_tool",
            "namespace": item.get("namespace").and_then(Value::as_str),
            "tool": item.get("tool").and_then(Value::as_str).unwrap_or(""),
            "status": codex_normalize_tool_status(item.get("status").and_then(Value::as_str)),
            "arguments": item.get("arguments").cloned().unwrap_or(Value::Null),
            "contentItems": item.get("contentItems").and_then(Value::as_array),
            "success": item.get("success").and_then(Value::as_bool),
        })]),
        "collabAgentToolCall" => {
            let receiver_thread_ids: Vec<String> = item
                .get("receiverThreadIds")
                .and_then(Value::as_array)
                .map(|arr| arr.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            let agents_states = item
                .get("agentsStates")
                .filter(|v| v.is_object())
                .cloned()
                .unwrap_or_else(|| json!({}));
            Ok(vec![json!({
                "id": item_id,
                "kind": "collab_agent",
                "tool": codex_to_string(item.get("tool")),
                "status": codex_normalize_tool_status(item.get("status").and_then(Value::as_str)),
                "senderThreadId": codex_to_string(item.get("senderThreadId")),
                "receiverThreadIds": receiver_thread_ids,
                "prompt": item.get("prompt").and_then(Value::as_str),
                "model": item.get("model").and_then(Value::as_str),
                "reasoningEffort": item.get("reasoningEffort").and_then(Value::as_str),
                "agentsStates": agents_states,
            })])
        }
        "webSearch" => Ok(vec![json!({
            "id": item_id,
            "kind": "web_search",
            "query": item.get("query").and_then(Value::as_str).unwrap_or(""),
            "action": item.get("action").cloned().unwrap_or(Value::Null),
        })]),
        "imageView" => Ok(vec![json!({
            "id": item_id,
            "kind": "image_view",
            "path": item.get("path").and_then(Value::as_str).unwrap_or(""),
        })]),
        "imageGeneration" => {
            let mut value = json!({
                "id": item_id,
                "kind": "image_generation",
                "status": codex_to_string(item.get("status")),
                "revisedPrompt": item.get("revisedPrompt").and_then(Value::as_str),
                "result": codex_to_string(item.get("result")),
            });
            // `savedPath` is optional-not-nullable -- omit rather than emit `null`
            // (`normalize.ts:422`).
            if let Some(saved_path) = item.get("savedPath").and_then(Value::as_str) {
                value["savedPath"] = json!(saved_path);
            }
            Ok(vec![value])
        }
        "enteredReviewMode" => Ok(vec![json!({
            "id": item_id, "kind": "review_mode", "event": "entered", "review": codex_to_string(item.get("review")),
        })]),
        "exitedReviewMode" => Ok(vec![json!({
            "id": item_id, "kind": "review_mode", "event": "exited", "review": codex_to_string(item.get("review")),
        })]),
        "contextCompaction" => Ok(vec![json!({ "id": item_id, "kind": "context_compaction" })]),
        "hookPrompt" => {
            let text = item.get("text").and_then(Value::as_str).unwrap_or("Hook prompt");
            Ok(vec![json!({ "id": item_id, "kind": "text", "text": text })])
        }
        other => Err(format!("Unsupported Codex thread item type: {other}")),
    }
}

/// `classifyCodexItemRole(item)` (`normalize.ts:475-501`): every `CodexThreadItemTypeSchema`
/// variant maps to exactly one display role. This is called only AFTER [`map_codex_item`] has
/// already validated `item_type` against the same variant set (returning `Err` for anything
/// else), so the catch-all arm below is unreachable in practice -- it exists only so this is a
/// total function, matching the reference's `assertNever` default case in spirit (a compile-time
/// safety net, not a runtime path).
fn classify_codex_item_role(item_type: &str) -> &'static str {
    match item_type {
        "userMessage" => "user",
        "agentMessage" | "plan" | "reasoning" => "assistant",
        "commandExecution"
        | "fileChange"
        | "mcpToolCall"
        | "dynamicToolCall"
        | "collabAgentToolCall"
        | "webSearch"
        | "imageView"
        | "imageGeneration" => "tool",
        "hookPrompt" | "enteredReviewMode" | "exitedReviewMode" | "contextCompaction" => "system",
        _ => "assistant",
    }
}

/// `readCodexTurnError(rawTurn)` (`normalize.ts:509-519`).
fn read_codex_turn_error(raw_turn: &Value) -> Option<String> {
    let error = raw_turn.get("error")?;
    if error.is_null() {
        return None;
    }
    if let Some(s) = error.as_str() {
        return Some(s.to_string());
    }
    if let Some(obj) = error.as_object() {
        if let Some(message) = obj.get("message").and_then(Value::as_str) {
            return Some(message.to_string());
        }
        if let Some(message) = obj.get("error").and_then(Value::as_str) {
            return Some(message.to_string());
        }
    }
    Some(error.to_string())
}

/// `summarizeFreshAgentItems(items)` (`normalize.ts:168-207`): the turn's `summary` string is
/// the FIRST item's kind-specific preview text (NOT a concatenation of every item) -- e.g. a
/// turn with a `reasoning` item followed by a `command` item summarizes from the reasoning
/// alone. `.slice(0,140)` is approximated with a 140-`char` (not UTF-16 code unit) cap, an
/// acceptable divergence for non-BMP text.
fn summarize_codex_items(items: &[Value]) -> String {
    fn truncate140(text: &str) -> String {
        text.chars().take(140).collect()
    }
    for item in items {
        let kind = item.get("kind").and_then(Value::as_str).unwrap_or("");
        let text = match kind {
            "text" | "thinking" => item.get("text").and_then(Value::as_str).map(truncate140),
            "reasoning" => {
                let direct = item
                    .get("text")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty());
                let text = direct.map(str::to_string).unwrap_or_else(|| {
                    let summary_joined = item
                        .get("summary")
                        .and_then(Value::as_array)
                        .map(|arr| {
                            arr.iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                        .unwrap_or_default();
                    if !summary_joined.is_empty() {
                        summary_joined
                    } else {
                        item.get("content")
                            .and_then(Value::as_array)
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(Value::as_str)
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            })
                            .unwrap_or_default()
                    }
                });
                Some(truncate140(&text))
            }
            "command" => item.get("command").and_then(Value::as_str).map(truncate140),
            "file_change" => Some("File change".to_string()),
            "mcp_tool" => {
                let server = item.get("server").and_then(Value::as_str).unwrap_or("");
                let tool = item.get("tool").and_then(Value::as_str).unwrap_or("");
                Some(truncate140(&format!("{server}:{tool}")))
            }
            "dynamic_tool" | "collab_agent" => {
                item.get("tool").and_then(Value::as_str).map(truncate140)
            }
            "web_search" => item.get("query").and_then(Value::as_str).map(truncate140),
            "image_view" => item.get("path").and_then(Value::as_str).map(truncate140),
            "image_generation" => item.get("result").and_then(Value::as_str).map(truncate140),
            "review_mode" => {
                let event = item.get("event").and_then(Value::as_str).unwrap_or("");
                Some(truncate140(&format!("{event} review mode")))
            }
            "context_compaction" => Some("Context compacted".to_string()),
            "tool_use" => item.get("name").and_then(Value::as_str).map(truncate140),
            "tool_result" => {
                let is_error = item
                    .get("isError")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                Some(if is_error {
                    "Tool error".to_string()
                } else {
                    "Tool result".to_string()
                })
            }
            _ => None,
        };
        if let Some(text) = text {
            return text;
        }
    }
    String::new()
}

/// `normalizeCodexThreadSnapshot` (`normalize.ts:748-787`): map a raw `thread/read` result
/// into the `FreshAgentSnapshotSchema` shape.
///
/// `tokenUsage` is always the zero-fallback (`normalize.ts:774-779`'s `?? {...zeros}` branch):
/// `CodexThreadReadResultSchema` (`protocol.ts:258-259`) is `{ thread: CodexThreadSchema }`, and
/// neither `CodexThreadSchema` (`protocol.ts:148-167`) nor anywhere else in the codex app-server
/// RPC surface exposes a `tokenUsage` field -- confirmed by inspection of the full protocol
/// schema, not by omission. The reference's `rawSnapshot.tokenUsage` is therefore ALWAYS
/// `undefined` on this path too; this is not a Rust-side gap, it is the reference's own honest
/// zero, faithfully reproduced.
fn build_codex_snapshot_json(
    thread_id: &str,
    raw: &Value,
    active_turn_present: bool,
) -> Result<Value, String> {
    let thread = raw.get("thread").cloned().unwrap_or_else(|| json!({}));
    let status = normalize_codex_thread_status(thread.get("status").unwrap_or(&Value::Null));
    // `isRunning` (`normalize.ts:756`): the reference also treats a `compacting` status as
    // running, which this client's [`CodexStatus`] does not model; folding in the
    // independently-tracked in-flight-turn bit keeps `send`/`interrupt`/`fork` correct even
    // though the enum itself has no `Compacting` variant.
    let is_running = status == CodexStatus::Running || active_turn_present;
    let revision = thread.get("updatedAt").and_then(Value::as_i64).unwrap_or(0);
    let summary = thread
        .get("preview")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let raw_turns = thread
        .get("turns")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    // `normalizeRawTurns` (`adapter.ts:491-502`): flatMap every raw turn's SPLIT display rows
    // into one flat list, THEN renumber `ordinal` sequentially across the WHOLE flattened list
    // (`.map((turn, index) => ({...turn, ordinal: index}))`, `adapter.ts:499-501`) -- ordinal is
    // NOT per-raw-turn, it is the display row's position in the final transcript.
    let turns: Vec<Value> = raw_turns
        .iter()
        .map(|raw_turn| build_codex_turn_json(raw_turn, 0))
        .collect::<Result<Vec<Vec<Value>>, String>>()?
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(ordinal, mut turn)| {
            turn["ordinal"] = json!(ordinal);
            turn
        })
        .collect();

    Ok(json!({
        "sessionType": SESSION_TYPE,
        "provider": PROVIDER,
        "threadId": thread_id,
        "revision": revision,
        "status": status.as_str(),
        "summary": summary,
        "capabilities": {
            "send": !is_running,
            "interrupt": is_running,
            "approvals": false,
            "questions": false,
            "fork": !is_running,
            "worktrees": false,
            "diffs": false,
            "childThreads": false,
        },
        "tokenUsage": {
            "inputTokens": 0,
            "outputTokens": 0,
            "cachedTokens": 0,
            "totalTokens": 0,
        },
        "pendingApprovals": [],
        "pendingQuestions": [],
        "worktrees": [],
        "diffs": [],
        "childThreads": [],
        "turns": turns,
        "extensions": { "codex": {} },
    }))
}

/// One raw codex turn's items, grouped into contiguous same-role rows -- the intermediate
/// shape `normalizeCodexDisplayTurns`' internal `pendingRows` builds before `buildDisplayTurn`
/// (`normalize.ts:615-632`).
struct CodexPendingRow {
    role: &'static str,
    items: Vec<Value>,
}

/// `normalizeCodexDisplayTurns` (`normalize.ts:600-684`), restricted to this committed-turns
/// REST READ path (`getSnapshot`, `adapter.ts:1082-1122`): SPLIT one raw codex `turn` record
/// (`makeThread`/real app-server shape: `{id, status, error?, items:[{type,id,...}], ...}`)
/// into MULTIPLE `FreshAgentTurnSchema`-shaped display turns, one per maximal run of
/// contiguous-same-role raw items (`classifyCodexItemRole`, `normalize.ts:475-501` --
/// ported as [`classify_codex_item_role`]). Every raw item is mapped via [`map_codex_item`]
/// (the full `normalizeCodexItem` switch, `normalize.ts:238-473`) BEFORE being folded into its
/// row, so an unrecognized item type still fails the whole turn exactly as before.
///
/// A turn-level `error` (`normalize.ts:509-519,640-641`) or a completed turn whose only items
/// are `user`-role with no `assistant` output (`normalize.ts:642-652`) each APPEND A NEW
/// synthetic row (role `assistant`, matching `createSyntheticPendingRow`'s hardcoded role,
/// `normalize.ts:521-533`) rather than an item tacked onto the last row -- this is the
/// reference's actual shape, not a simplification of it.
///
/// `turnId`/`id` semantics (documented divergence, not a silent one): the reference derives an
/// HMAC-SHA256 `turnId` per row (`createCodexDisplayId`, `normalize.ts:574-593`) keyed by a
/// per-server-instance secret (`displayIdSecret`, sourced from `configStore` in
/// `server/index.ts:322-326` -- freshell-server's config store, outside this crate's ownership
/// boundary). This port does not carry that secret and does not need to: the only consumer of
/// a Fresh-Agent `turnId`'s STABILITY is client-side checkpoint matching
/// (`fresh-agent-checkpoints.ts`), which already falls back to label+ordinal matching whenever
/// a direct `turnId`/`requestId` match fails -- and a REST-read turn's `requestId` is ALWAYS
/// absent in both ports (`stripCodexDisplayMetadata` strips it in the reference; this port
/// never adds it). There is also no `getTurnBody`/rewind-by-`turnId` RPC on this crate's
/// surface that would need to recompute and match this id later. Given that, this port keeps
/// PR-5's `turnId == raw provider turn id` for the common case (a raw turn that produces
/// exactly ONE display row, e.g. a straightforward `agentMessage`), and disambiguates a
/// SPLIT raw turn's extra rows with `"{raw_turn_id}:row-{index}"`. Both schemes are stable
/// (same raw turn shape -> same ids on repeated reads) and unique per row, which is everything
/// a `.strict()`-schema, non-cryptographic display id needs to be.
fn build_codex_turn_json(raw_turn: &Value, ordinal: usize) -> Result<Vec<Value>, String> {
    let turn_id = raw_turn
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let items_raw = raw_turn
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut rows: Vec<CodexPendingRow> = Vec::new();
    let mut has_assistant_output = false;
    let mut has_user_output = false;
    let mut all_items_are_user = true;
    for (index, item) in items_raw.iter().enumerate() {
        let item_type = item
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("undefined");
        let item_id = item
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("{turn_id}:item-{index}"));
        let mapped = map_codex_item(&item_id, item, item_type)?;
        let role = classify_codex_item_role(item_type);
        match role {
            "assistant" => has_assistant_output = true,
            "user" => has_user_output = true,
            _ => {}
        }
        if role != "user" {
            all_items_are_user = false;
        }
        match rows.last_mut() {
            Some(row) if row.role == role => row.items.extend(mapped),
            _ => rows.push(CodexPendingRow {
                role,
                items: mapped,
            }),
        }
    }

    // `readCodexTurnError`/the turn-error branch (`normalize.ts:509-519,640-641`).
    if let Some(turn_error) = read_codex_turn_error(raw_turn) {
        rows.push(CodexPendingRow {
            role: "assistant",
            items: vec![json!({
                "id": format!("{turn_id}:turn-error"),
                "kind": "text",
                "text": format!("Codex turn failed: {turn_error}"),
            })],
        });
    } else if raw_turn.get("status").and_then(Value::as_str) == Some("completed")
        && has_user_output
        && all_items_are_user
        && !has_assistant_output
    {
        // The "empty-response" synthetic row (`normalize.ts:642-652`): a completed turn that
        // recorded only user-role items and no assistant output at all.
        rows.push(CodexPendingRow {
            role: "assistant",
            items: vec![json!({
                "id": format!("{turn_id}:empty-response"),
                "kind": "text",
                "text": "Codex completed this turn without recording an assistant response.",
            })],
        });
    }

    let row_count = rows.len();
    let turns = rows
        .into_iter()
        .enumerate()
        .map(|(row_index, row)| {
            // Single-row turns keep the raw provider turn id verbatim (PR-5 precedent);
            // split turns disambiguate each extra row -- see the turnId doc comment above.
            let row_turn_id = if row_count <= 1 {
                turn_id.clone()
            } else {
                format!("{turn_id}:row-{row_index}")
            };
            json!({
                "id": row_turn_id,
                "turnId": row_turn_id,
                "ordinal": ordinal,
                "source": "durable",
                "role": row.role,
                "summary": summarize_codex_items(&row.items),
                "items": row.items,
            })
        })
        .collect();

    Ok(turns)
}

/// Watch an owned sidecar child to completion. Two ways out:
///
/// - The child exits ON ITS OWN (crash / unexpected disconnect, never requested): self-heal
///   (adapter.ts:935-946) — reap via [`reap_owned_codex_sidecars`] and broadcast the terminal
///   `exited` status with NO chime (a crash is not a positive completion). The session is
///   intentionally left mapped by the caller (this fn does not touch `sessions`) — matching
///   the reference's "leave the runtime mapped for lazy restart" invariant.
/// - A `freshAgent.kill` REQUESTS teardown via `kill_rx`: gracefully `start_kill` + reap, with
///   NO self-heal event (the caller broadcasts its own `freshAgent.killed`).
fn spawn_exit_watcher(
    mut child: tokio::process::Child,
    ownership_id: String,
    thread_id: String,
    broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    kill_rx: oneshot::Receiver<()>,
    exited: Arc<AtomicBool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        // `biased` + the REQUESTED-kill arm listed FIRST: a `freshAgent.kill` signals
        // `kill_tx` right before `start_kill()`s the child, so `child.wait()` can become
        // ready in the SAME poll as `kill_rx` (the SIGTERM lands and the child exits
        // essentially immediately). Without `biased`, `tokio::select!` picks a RANDOM
        // ready branch, so that race could take the `child.wait()` arm and broadcast a
        // spurious self-heal "exited" status for a kill that was actually requested.
        // Checking `kill_rx` first every time both are ready eliminates that race.
        tokio::select! {
            biased;
            _ = kill_rx => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                reap_owned_codex_sidecars(&ownership_id);
            }
            _ = child.wait() => {
                reap_owned_codex_sidecars(&ownership_id);
                // PR-4: flip the lazy-restart flag BEFORE broadcasting, so a client that
                // reacts to the `exited` status by immediately sending/attaching never
                // races ahead of `ensure_session_alive` observing a stale `false`.
                exited.store(true, Ordering::SeqCst);
                let event = CodexAdapterEvent::Status {
                    session_id: thread_id.clone(),
                    status: CodexStatus::Exited,
                };
                if let Some(frame) = adapter_event_to_frame(&event, &thread_id) {
                    let _ = broadcast_tx.send(frame);
                }
            }
        }
    })
}

/// Clear the shared active-turn field (the `activeTurnByThread.delete(sessionId)` mirror).
fn clear_active_turn(active_turn: &Arc<StdMutex<Option<String>>>) {
    *active_turn.lock().expect("active_turn mutex") = None;
}

/// Reduce one codex notification through the subscription into adapter events. Also mirrors
/// the legacy `activeTurnByThread` clear points onto `active_turn` (adapter.ts:901,913,1101-1103
/// — leaving running/starting, a turn completing, or the thread closing all clear it;
/// `turn/started` SETS it too, as a fallback alongside `handle_send`'s direct set).
fn reduce_notification(
    subscription: &mut CodexSubscription,
    notification: CodexNotification,
    active_turn: &Arc<StdMutex<Option<String>>>,
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
        CodexNotification::ThreadStatusChanged { thread_id, status } => {
            // adapter.ts:898-903 — unconditional clear (harmless if unset) once the thread
            // leaves running/starting, regardless of whether TurnStarted ever fired.
            if thread_id == subscription.session_id() {
                let normalized = normalize_codex_thread_status(&status);
                if normalized != CodexStatus::Running && normalized != CodexStatus::Starting {
                    clear_active_turn(active_turn);
                }
            }
            subscription
                .on_thread_status_changed(&thread_id, &status)
                .into_iter()
                .collect()
        }
        CodexNotification::TurnCompleted(event) => {
            // adapter.ts:912-913 — the turn is over regardless of status; clear unconditionally.
            if event.thread_id == subscription.session_id() {
                clear_active_turn(active_turn);
            }
            subscription.on_turn_completed(&event, now_ms())
        }
        CodexNotification::TurnStarted(event) => {
            if let Some(turn_id) = &event.turn_id {
                subscription.set_active_turn(turn_id.clone());
                if event.thread_id == subscription.session_id() {
                    *active_turn.lock().expect("active_turn mutex") = Some(turn_id.clone());
                }
            }
            Vec::new()
        }
        CodexNotification::ThreadClosed { thread_id } => {
            if thread_id == subscription.session_id() {
                clear_active_turn(active_turn);
            }
            subscription
                .on_thread_closed(&thread_id)
                .into_iter()
                .collect()
        }
        CodexNotification::FsChanged { .. } | CodexNotification::Other { .. } => Vec::new(),
    }
}

/// Map an adapter event to a `freshAgent.event` wire frame (sdk-events.ts normalization:
/// `sdk.*` → `freshAgent.*`). Returns the pre-serialized JSON, or `None` on a serialize error.
fn adapter_event_to_frame(event: &CodexAdapterEvent, thread_id: &str) -> Option<String> {
    let inner = match event {
        CodexAdapterEvent::StatusSnapshot {
            session_id,
            status,
            revision,
        } => {
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

/// The `freshAgent.error{code:'INVALID_SESSION_ID'}` shape (`sdk-events.ts:37`) the client
/// folds into `markSessionLost` (`fresh-agent-ws.ts:326-328`) instead of hanging on a stale
/// `freshAgent.attach` for a session this server has never heard of.
fn lost_session_frame(session_id: &str) -> ServerMessage {
    ServerMessage::FreshAgentEvent(FreshAgentEvent {
        event: json!({
            "type": "freshAgent.error",
            "sessionId": session_id,
            "code": "INVALID_SESSION_ID",
            "message": format!("codex session {session_id} not found"),
        }),
        provider: PROVIDER.to_string(),
        session_id: session_id.to_string(),
        session_type: SESSION_TYPE.to_string(),
    })
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
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "unauthorized" })),
        )
            .into_response();
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
                deep_merge(
                    target_map.entry(key.clone()).or_insert(Value::Null),
                    patch_value,
                );
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
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
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
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}.{millis:03}Z")
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
        assert_eq!(
            sandbox_wire_value(freshell_protocol::Sandbox::ReadOnly),
            "read-only"
        );
        assert_eq!(
            sandbox_policy_value("read-only"),
            json!({ "type": "readOnly" })
        );
        assert_eq!(
            sandbox_policy_value("workspace-write"),
            json!({ "type": "workspaceWrite" })
        );
        assert_eq!(
            sandbox_policy_value("danger-full-access"),
            json!({ "type": "dangerFullAccess" })
        );
    }

    #[test]
    fn turn_complete_event_frames_carry_the_inner_type() {
        // The status-guarded chime → freshAgent.event { event.type: freshAgent.turn.complete }.
        let frame = adapter_event_to_frame(
            &CodexAdapterEvent::TurnComplete {
                session_id: "t-1".into(),
                at: 42,
            },
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
            .map(|f| {
                serde_json::from_str::<Value>(&f).unwrap()["event"]["type"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(
            inner_types,
            vec!["freshAgent.session.snapshot", "freshAgent.turn.complete"]
        );
    }

    #[test]
    fn deep_merge_replaces_scalars_and_merges_objects() {
        let mut target = json!({ "freshAgent": { "enabled": false, "keep": 1 }, "other": true });
        deep_merge(
            &mut target,
            &json!({ "freshAgent": { "enabled": true, "defaultPlugins": [] } }),
        );
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

    // ── freshAgent.interrupt / freshAgent.kill / onExit self-heal (PR-1) ───────

    fn state_with_bus() -> (FreshCodexState, tokio::sync::broadcast::Receiver<String>) {
        let (tx, rx) = tokio::sync::broadcast::channel::<String>(64);
        let st = FreshCodexState::new(
            Arc::new("tok".to_string()),
            Arc::new(tx),
            json!({ "freshAgent": { "enabled": false } }),
        );
        (st, rx)
    }

    /// Insert a `CodexSession` directly (bypassing the real sidecar spawn `handle_create`
    /// requires) so `handle_interrupt`/`handle_kill` can be exercised against a scripted
    /// [`freshell_codex::ChannelPeer`] / a real-but-harmless child process.
    async fn insert_fake_session(
        state: &FreshCodexState,
        thread_id: &str,
        client: Arc<CodexAppServerClient>,
        active_turn: Arc<StdMutex<Option<String>>>,
        child: tokio::process::Child,
        ownership_id: &str,
    ) -> tokio::sync::broadcast::Receiver<String> {
        // no-op consumer: these tests drive the reducer/RPC surfaces directly.
        let consumer = tokio::spawn(async {});
        let (kill_tx, kill_rx) = oneshot::channel();
        let exited = Arc::new(AtomicBool::new(false));
        let watcher = spawn_exit_watcher(
            child,
            ownership_id.to_string(),
            thread_id.to_string(),
            state.broadcast_tx.clone(),
            kill_rx,
            exited.clone(),
        );
        state.sessions.lock().await.insert(
            thread_id.to_string(),
            CodexSession {
                client,
                model: "gpt-5.3-codex-spark".to_string(),
                effort: None,
                cwd: None,
                sandbox: None,
                permission_mode: None,
                active_turn,
                consumer,
                kill_tx: Some(kill_tx),
                watcher,
                exited,
            },
        );
        state.broadcast_tx.subscribe()
    }

    /// A harmless real child that stays alive until reaped (the interrupt/kill tests' fake
    /// "owned sidecar" -- no real `codex` binary needed).
    fn spawn_sleeper() -> tokio::process::Child {
        let mut cmd = tokio::process::Command::new("sleep");
        cmd.arg("30");
        cmd.kill_on_drop(true);
        cmd.spawn().expect("spawn sleep fixture")
    }

    #[tokio::test]
    async fn handle_interrupt_issues_rpc_for_tracked_turn_and_clears_it() {
        let (transport, peer) = freshell_codex::new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect(transport);
        let client = Arc::new(client);

        let (st, _rx) = state_with_bus();
        let active_turn = Arc::new(StdMutex::new(Some("turn-1".to_string())));
        insert_fake_session(
            &st,
            "thread-1",
            client,
            active_turn.clone(),
            spawn_sleeper(),
            "codex-sidecar-test-interrupt",
        )
        .await;

        let driver = {
            let st = st.clone();
            tokio::spawn(async move {
                st.handle_interrupt(FreshAgentInterrupt {
                    provider: freshell_protocol::AgentProvider::Codex,
                    session_id: "thread-1".to_string(),
                    session_type: freshell_protocol::SessionType::Freshcodex,
                    cwd: None,
                })
                .await;
            })
        };

        // `interrupt_turn` gates on the initialize handshake first (client.ts:777-778) since
        // this fresh client never initialized.
        let (init_id, init_method, _p) = peer.expect_request().await;
        assert_eq!(init_method, "initialize");
        peer.respond(
            &init_id,
            json!({ "userAgent": "x", "codexHome": "/h", "platformFamily": "u", "platformOs": "l" }),
        );
        let _ = peer.expect_notification().await;

        let (id, method, params) = peer.expect_request().await;
        assert_eq!(method, "turn/interrupt");
        assert_eq!(params["threadId"], json!("thread-1"));
        assert_eq!(params["turnId"], json!("turn-1"));
        peer.respond(&id, json!({}));

        driver.await.expect("handle_interrupt task");
        assert_eq!(
            *active_turn.lock().unwrap(),
            None,
            "active turn cleared on a successful interrupt (adapter.ts:1027)"
        );
    }

    #[tokio::test]
    async fn handle_interrupt_errors_when_no_active_turn_is_tracked() {
        let (transport, _peer) = freshell_codex::new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect(transport);
        let client = Arc::new(client);

        let (st, mut rx) = state_with_bus();
        insert_fake_session(
            &st,
            "thread-1",
            client,
            Arc::new(StdMutex::new(None)),
            spawn_sleeper(),
            "codex-sidecar-test-no-turn",
        )
        .await;

        st.handle_interrupt(FreshAgentInterrupt {
            provider: freshell_protocol::AgentProvider::Codex,
            session_id: "thread-1".to_string(),
            session_type: freshell_protocol::SessionType::Freshcodex,
            cwd: None,
        })
        .await;

        let frame: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(frame["type"], "error");
        assert!(
            frame["message"]
                .as_str()
                .unwrap()
                .contains("No active Codex turn is tracked for thread-1"),
            "{frame}"
        );
    }

    #[tokio::test]
    async fn handle_interrupt_errors_for_unknown_session() {
        let (st, mut rx) = state_with_bus();

        st.handle_interrupt(FreshAgentInterrupt {
            provider: freshell_protocol::AgentProvider::Codex,
            session_id: "does-not-exist".to_string(),
            session_type: freshell_protocol::SessionType::Freshcodex,
            cwd: None,
        })
        .await;

        let frame: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(frame["type"], "error");
    }

    #[tokio::test]
    async fn handle_kill_removes_session_kills_owned_child_and_broadcasts_killed() {
        let (transport, _peer) = freshell_codex::new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect(transport);
        let client = Arc::new(client);

        let (st, mut rx) = state_with_bus();
        let child = spawn_sleeper();
        let pid = child.id().expect("pid");
        insert_fake_session(
            &st,
            "thread-1",
            client,
            Arc::new(StdMutex::new(None)),
            child,
            "codex-sidecar-test-kill",
        )
        .await;

        st.handle_kill(FreshAgentKill {
            provider: freshell_protocol::AgentProvider::Codex,
            session_id: "thread-1".to_string(),
            session_type: freshell_protocol::SessionType::Freshcodex,
            cwd: None,
        })
        .await;

        // The owned child was actually reaped (handle_kill awaits the watcher).
        assert!(
            !std::path::Path::new(&format!("/proc/{pid}")).exists(),
            "the owned sidecar child must be killed"
        );

        let frame: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(frame["type"], "freshAgent.killed");
        assert_eq!(frame["sessionId"], "thread-1");
        assert_eq!(frame["provider"], "codex");
        assert_eq!(frame["success"], true);

        assert!(
            !st.sessions.lock().await.contains_key("thread-1"),
            "session removed"
        );
    }

    #[tokio::test]
    async fn handle_kill_of_unknown_session_still_broadcasts_success() {
        // adapter.kill() is unconditional (adapter.ts:1211-1215) -- idempotent kill of a
        // session that doesn't exist still yields `success:true`.
        let (st, mut rx) = state_with_bus();

        st.handle_kill(FreshAgentKill {
            provider: freshell_protocol::AgentProvider::Codex,
            session_id: "does-not-exist".to_string(),
            session_type: freshell_protocol::SessionType::Freshcodex,
            cwd: None,
        })
        .await;

        let frame: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(frame["type"], "freshAgent.killed");
        assert_eq!(frame["success"], true);
    }

    #[tokio::test]
    async fn onexit_self_heal_emits_exited_status_with_no_chime_and_keeps_session_mapped() {
        let (transport, _peer) = freshell_codex::new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect(transport);
        let client = Arc::new(client);

        let (st, mut rx) = state_with_bus();

        // A child that exits ON ITS OWN almost immediately -- the UNREQUESTED-exit / crash
        // path (never signaled via kill_tx).
        let mut cmd = tokio::process::Command::new("true");
        cmd.kill_on_drop(true);
        let child = cmd.spawn().expect("spawn true fixture");

        insert_fake_session(
            &st,
            "thread-1",
            client,
            Arc::new(StdMutex::new(None)),
            child,
            "codex-sidecar-test-exit",
        )
        .await;

        let frame: Value = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if let Ok(raw) = rx.recv().await {
                    return serde_json::from_str::<Value>(&raw).unwrap();
                }
            }
        })
        .await
        .expect("the watcher self-heals within the budget");

        assert_eq!(frame["type"], "freshAgent.event");
        assert_eq!(frame["provider"], "codex");
        assert_eq!(frame["sessionId"], "thread-1");
        assert_eq!(frame["event"]["type"], "freshAgent.status");
        assert_eq!(frame["event"]["status"], "exited");

        // No accompanying chime, and the session STAYS mapped (adapter.ts:937-944 invariant
        // -- PR-1 leaves the actual lazy-restart-on-next-send unimplemented; see report).
        assert!(
            rx.try_recv().is_err(),
            "no turn.complete chime alongside the exit status"
        );
        assert!(
            st.sessions.lock().await.contains_key("thread-1"),
            "the session stays mapped after an unrequested exit"
        );
    }

    // -- freshAgent.attach (PR-4) --

    #[tokio::test]
    async fn handle_attach_unknown_session_emits_lost_session_error() {
        let (st, mut rx) = state_with_bus();

        st.handle_attach(FreshAgentAttach {
            provider: freshell_protocol::AgentProvider::Codex,
            session_id: "does-not-exist".to_string(),
            session_type: freshell_protocol::SessionType::Freshcodex,
            cwd: None,
            resume_session_id: None,
            session_ref: None,
        })
        .await;

        let frame: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(frame["type"], "freshAgent.event");
        assert_eq!(frame["sessionId"], "does-not-exist");
        assert_eq!(frame["event"]["type"], "freshAgent.error");
        assert_eq!(frame["event"]["code"], "INVALID_SESSION_ID");
    }

    #[tokio::test]
    async fn handle_attach_known_session_emits_running_snapshot_when_turn_active() {
        let (transport, _peer) = freshell_codex::new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect(transport);
        let client = Arc::new(client);

        let (st, mut rx) = state_with_bus();
        insert_fake_session(
            &st,
            "thread-1",
            client,
            Arc::new(StdMutex::new(Some("turn-1".to_string()))),
            spawn_sleeper(),
            "codex-sidecar-test-attach-running",
        )
        .await;

        st.handle_attach(FreshAgentAttach {
            provider: freshell_protocol::AgentProvider::Codex,
            session_id: "thread-1".to_string(),
            session_type: freshell_protocol::SessionType::Freshcodex,
            cwd: None,
            resume_session_id: None,
            session_ref: None,
        })
        .await;

        let frame: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(frame["type"], "freshAgent.event");
        assert_eq!(frame["sessionId"], "thread-1");
        assert_eq!(frame["event"]["type"], "freshAgent.session.snapshot");
        assert_eq!(frame["event"]["status"], "running");
    }

    #[tokio::test]
    async fn handle_attach_known_session_emits_idle_snapshot_when_no_active_turn() {
        let (transport, _peer) = freshell_codex::new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect(transport);
        let client = Arc::new(client);

        let (st, mut rx) = state_with_bus();
        insert_fake_session(
            &st,
            "thread-1",
            client,
            Arc::new(StdMutex::new(None)),
            spawn_sleeper(),
            "codex-sidecar-test-attach-idle",
        )
        .await;

        st.handle_attach(FreshAgentAttach {
            provider: freshell_protocol::AgentProvider::Codex,
            session_id: "thread-1".to_string(),
            session_type: freshell_protocol::SessionType::Freshcodex,
            cwd: None,
            resume_session_id: None,
            session_ref: None,
        })
        .await;

        let frame: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(frame["event"]["type"], "freshAgent.session.snapshot");
        assert_eq!(frame["event"]["status"], "idle");
    }

    // -- lazy restart after crash (PR-4) --

    /// The absolute path to the committed Node fake codex app-server fixture
    /// (`test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`), the SAME script
    /// the JS/TS coding-cli integration suite uses to simulate a real `codex app-server`
    /// over a real WS listener. Used here (via `CODEX_CMD`) so `ensure_session_alive`'s
    /// respawn genuinely exercises [`FreshCodexState::spawn_sidecar`] -- a real subprocess
    /// spawn + real WS connect + real `initialize`/`thread/start` round-trip -- rather than
    /// the in-process [`freshell_codex::new_channel_transport`] fake the interrupt/kill
    /// tests use (which bypasses `spawn_sidecar` entirely and cannot prove a respawn).
    fn fake_codex_app_server_cmd() -> String {
        format!(
            "{}/../../test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs",
            env!("CARGO_MANIFEST_DIR")
        )
    }

    /// Serializes every test in this module that mutates the process-global `CODEX_CMD` /
    /// `FAKE_CODEX_APP_SERVER_BEHAVIOR` env vars (`std::env::set_var` is not safe to race
    /// across concurrently-running tests in the same binary).
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Point `CODEX_CMD` at the fake app-server and configure its scripted `behavior` (a
    /// `FAKE_CODEX_APP_SERVER_BEHAVIOR` JSON blob \u2014 see the fixture's `loadBehavior()`).
    fn configure_fake_codex_cmd(behavior_json: &str) {
        std::env::set_var("CODEX_CMD", format!("node {}", fake_codex_app_server_cmd()));
        std::env::set_var("FAKE_CODEX_APP_SERVER_BEHAVIOR", behavior_json);
    }

    /// Create a session whose sidecar is a REAL fake-app-server-driven codex process (not
    /// the decoupled `insert_fake_session` fixture), so a subsequent crash + respawn
    /// genuinely exercises [`FreshCodexState::spawn_sidecar`] end-to-end. Returns the thread
    /// id and drains the `freshAgent.created` frame.
    async fn create_real_fake_session(
        st: &FreshCodexState,
        rx: &mut tokio::sync::broadcast::Receiver<String>,
    ) -> String {
        st.handle_create(FreshAgentCreate {
            request_id: "req-1".to_string(),
            session_type: freshell_protocol::SessionType::Freshcodex,
            provider: Some(freshell_protocol::AgentProvider::Codex),
            cwd: None,
            legacy_restore_context: None,
            resume_session_id: None,
            session_ref: None,
            model: None,
            model_selection: None,
            permission_mode: None,
            sandbox: None,
            effort: None,
            plugins: None,
        })
        .await;

        let created: Value = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
                if frame["type"] == "freshAgent.created"
                    || frame["type"] == "freshAgent.create.failed"
                {
                    return frame;
                }
            }
        })
        .await
        .expect("the fake app-server responds within the budget");
        assert_eq!(
            created["type"], "freshAgent.created",
            "fixture create failed: {created}"
        );
        created["sessionId"].as_str().unwrap().to_string()
    }

    /// Wait for `session_id`'s exit-watcher to flip [`CodexSession::exited`] (the
    /// self-heal branch observing an unrequested crash), then drain the resulting
    /// `freshAgent.status{exited}` frame off `rx`.
    async fn wait_for_self_heal(
        st: &FreshCodexState,
        rx: &mut tokio::sync::broadcast::Receiver<String>,
        session_id: &str,
    ) {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let exited = {
                    let guard = st.sessions.lock().await;
                    guard
                        .get(session_id)
                        .map(|s| s.exited.load(Ordering::SeqCst))
                        .unwrap_or(false)
                };
                if exited {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("the sidecar self-heals to exited within the budget");

        let exited_frame: Value = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
                if frame["event"]["type"] == "freshAgent.status"
                    && frame["event"]["status"] == "exited"
                {
                    return frame;
                }
            }
        })
        .await
        .expect("the exited status frame arrives within the budget");
        assert_eq!(exited_frame["sessionId"], session_id);
    }

    #[tokio::test(flavor = "multi_thread")]
    // Intentional: `_guard` is held across every `.await` in this test BY DESIGN, so it
    // serializes against `attach_after_unrequested_crash_recovers_and_emits_a_snapshot`
    // (the other test mutating the process-global `CODEX_CMD`/`FAKE_CODEX_APP_SERVER_BEHAVIOR`
    // env vars) for the test's ENTIRE duration, not just around individual calls.
    #[allow(clippy::await_holding_lock)]
    async fn send_after_unrequested_crash_lazily_respawns_and_completes_with_no_error_frame() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (st, mut rx) = state_with_bus();

        // The FIRST spawn crashes deterministically right after `thread/start` responds
        // (the fixture's `exitProcessAfterMethodsOnce`) -- a real, observable "the child
        // process exited on its own" crash, not a simulated flag flip. A distinct
        // `threadStartThreadId` (vs the respawn's below) proves the respawned session is a
        // genuinely NEW thread, not a coincidental id collision from the fixture's shared
        // "thread-new-1" default.
        configure_fake_codex_cmd(
            r#"{"threadStartThreadId":"thread-original","exitProcessAfterMethodsOnce":["thread/start"]}"#,
        );
        let thread_id = create_real_fake_session(&st, &mut rx).await;
        wait_for_self_heal(&st, &mut rx, &thread_id).await;

        // The respawned sidecar must NOT immediately crash again, and mints a DIFFERENT
        // thread id than the original.
        configure_fake_codex_cmd(r#"{"threadStartThreadId":"thread-respawned"}"#);

        st.handle_send(FreshAgentSend {
            request_id: Some("req-2".to_string()),
            provider: freshell_protocol::AgentProvider::Codex,
            session_id: thread_id.clone(),
            session_type: freshell_protocol::SessionType::Freshcodex,
            text: "hello again".to_string(),
            images: None,
            cwd: None,
            settings: None,
        })
        .await;

        // A NEW fake-app-server child was spawned, materialized under a new thread id, and
        // the turn was accepted -- with NO user-facing error frame along the way.
        let materialized: Value = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
                assert_ne!(
                    frame["type"], "error",
                    "no user-facing error frame: {frame}"
                );
                if frame["type"] == "freshAgent.session.materialized" {
                    return frame;
                }
            }
        })
        .await
        .expect("a materialized frame arrives within the budget");

        assert_eq!(materialized["previousSessionId"], thread_id);
        let new_thread_id = materialized["sessionId"].as_str().unwrap().to_string();
        assert_ne!(new_thread_id, thread_id, "respawn mints a fresh thread id");

        let accepted: Value = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
                assert_ne!(
                    frame["type"], "error",
                    "no user-facing error frame: {frame}"
                );
                if frame["type"] == "freshAgent.send.accepted" {
                    return frame;
                }
            }
        })
        .await
        .expect("send.accepted arrives within the budget -- the turn actually ran");
        assert_eq!(accepted["sessionId"], new_thread_id);

        // The old id is gone; the new one is live.
        let guard = st.sessions.lock().await;
        assert!(!guard.contains_key(&thread_id));
        assert!(guard.contains_key(&new_thread_id));
    }

    #[tokio::test(flavor = "multi_thread")]
    // Intentional: same rationale as the sibling test above -- `_guard` must span every
    // `.await` in this test to serialize the two tests' shared env-var mutations.
    #[allow(clippy::await_holding_lock)]
    async fn attach_after_unrequested_crash_recovers_and_emits_a_snapshot() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (st, mut rx) = state_with_bus();

        configure_fake_codex_cmd(r#"{"exitProcessAfterMethodsOnce":["thread/start"]}"#);
        let thread_id = create_real_fake_session(&st, &mut rx).await;
        wait_for_self_heal(&st, &mut rx, &thread_id).await;

        configure_fake_codex_cmd("{}");
        st.handle_attach(FreshAgentAttach {
            provider: freshell_protocol::AgentProvider::Codex,
            session_id: thread_id.clone(),
            session_type: freshell_protocol::SessionType::Freshcodex,
            cwd: None,
            resume_session_id: None,
            session_ref: None,
        })
        .await;

        let outcome: Value = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
                assert_ne!(
                    frame["type"], "error",
                    "attach recovers or reports honestly, never hangs silently: {frame}"
                );
                if frame["type"] == "freshAgent.session.materialized"
                    || frame["type"] == "freshAgent.event"
                {
                    return frame;
                }
            }
        })
        .await
        .expect(
            "attach either recovers (materialized+snapshot) or reports honestly, within the budget",
        );

        // Recovery succeeded: materialized under a new id (asserted generously here since
        // frame order between the materialize broadcast and the snapshot broadcast is not
        // contractually fixed -- either arriving first proves the recovery happened).
        assert!(
            outcome["type"] == "freshAgent.session.materialized"
                || outcome["event"]["type"] == "freshAgent.session.snapshot",
            "unexpected first frame: {outcome}"
        );
    }

    // -- GET /api/fresh-agent/threads/freshcodex/codex/:threadId (Batch D PR-5) --

    #[tokio::test]
    async fn get_snapshot_of_unknown_thread_is_not_found() {
        let (st, _rx) = state_with_bus();

        let err = st
            .get_snapshot("does-not-exist")
            .await
            .expect_err("unknown thread");
        assert!(matches!(err, CodexSnapshotError::NotFound));
    }

    #[tokio::test]
    async fn get_snapshot_returns_a_schema_shaped_snapshot_with_turn_text() {
        let (transport, peer) = freshell_codex::new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect(transport);
        let client = Arc::new(client);

        let (st, _rx) = state_with_bus();
        insert_fake_session(
            &st,
            "thread-1",
            client,
            Arc::new(StdMutex::new(None)),
            spawn_sleeper(),
            "codex-sidecar-test-snapshot",
        )
        .await;

        let driver = {
            let st = st.clone();
            tokio::spawn(async move { st.get_snapshot("thread-1").await })
        };

        // `read_thread` gates on the initialize handshake first (this fresh client never
        // initialized), matching every other RPC this module drives.
        let (init_id, init_method, _p) = peer.expect_request().await;
        assert_eq!(init_method, "initialize");
        peer.respond(
            &init_id,
            json!({ "userAgent": "x", "codexHome": "/h", "platformFamily": "u", "platformOs": "l" }),
        );
        let _ = peer.expect_notification().await;

        let (id, method, params) = peer.expect_request().await;
        assert_eq!(method, "thread/read");
        assert_eq!(params["threadId"], json!("thread-1"));
        assert_eq!(params["includeTurns"], json!(true));
        peer.respond(
            &id,
            json!({
                "thread": {
                    "id": "thread-1",
                    "preview": "Fixture turn",
                    "updatedAt": 1770000007,
                    "status": { "type": "idle" },
                    "turns": [{
                        "id": "turn-1",
                        "status": "completed",
                        "items": [{
                            "type": "agentMessage",
                            "id": "turn-1:item-0",
                            "text": "hello from codex",
                        }],
                    }],
                }
            }),
        );

        let snapshot = driver.await.unwrap().expect("snapshot builds");

        // Required top-level `FreshAgentSnapshotSchema` fields (camelCase, verbatim).
        assert_eq!(snapshot["sessionType"], json!("freshcodex"));
        assert_eq!(snapshot["provider"], json!("codex"));
        assert_eq!(snapshot["threadId"], json!("thread-1"));
        assert_eq!(snapshot["revision"], json!(1770000007));
        assert_eq!(snapshot["status"], json!("idle"));
        assert_eq!(snapshot["capabilities"]["send"], json!(true));
        assert_eq!(snapshot["capabilities"]["interrupt"], json!(false));
        assert_eq!(snapshot["tokenUsage"]["inputTokens"], json!(0));
        assert_eq!(snapshot["pendingApprovals"], json!([]));
        assert_eq!(snapshot["extensions"]["codex"], json!({}));

        // The turn's transcript text survived the mapping.
        let turns = snapshot["turns"].as_array().expect("turns array");
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0]["id"], json!("turn-1"));
        assert_eq!(turns[0]["turnId"], json!("turn-1"));
        assert_eq!(turns[0]["summary"], json!("hello from codex"));
        assert_eq!(turns[0]["items"][0]["kind"], json!("text"));
        assert_eq!(turns[0]["items"][0]["text"], json!("hello from codex"));
    }

    #[tokio::test]
    async fn get_snapshot_reports_running_capabilities_when_a_turn_is_tracked_active() {
        let (transport, peer) = freshell_codex::new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect(transport);
        let client = Arc::new(client);

        let (st, _rx) = state_with_bus();
        insert_fake_session(
            &st,
            "thread-1",
            client,
            Arc::new(StdMutex::new(Some("turn-1".to_string()))),
            spawn_sleeper(),
            "codex-sidecar-test-snapshot-running",
        )
        .await;

        let driver = {
            let st = st.clone();
            tokio::spawn(async move { st.get_snapshot("thread-1").await })
        };

        let (init_id, _m, _p) = peer.expect_request().await;
        peer.respond(
            &init_id,
            json!({ "userAgent": "x", "codexHome": "/h", "platformFamily": "u", "platformOs": "l" }),
        );
        let _ = peer.expect_notification().await;

        let (id, _method, _params) = peer.expect_request().await;
        peer.respond(
            &id,
            json!({ "thread": { "id": "thread-1", "status": { "type": "active" }, "turns": [] } }),
        );

        let snapshot = driver.await.unwrap().expect("snapshot builds");
        assert_eq!(snapshot["status"], json!("running"));
        assert_eq!(snapshot["capabilities"]["send"], json!(false));
        assert_eq!(snapshot["capabilities"]["interrupt"], json!(true));
        assert_eq!(snapshot["turns"], json!([]));
    }

    // -- Batch D PR-6: rich transcript items for the codex snapshot endpoint --

    #[test]
    fn map_codex_item_command_execution_renders_command_kind_with_exact_schema_keys() {
        let item = json!({
            "type": "commandExecution",
            "id": "item-1",
            "command": "ls -la",
            "cwd": "/repo",
            "status": "inProgress",
            "aggregatedOutput": "total 0\n",
            "exitCode": null,
        });
        let mapped =
            map_codex_item("item-1", &item, "commandExecution").expect("commandExecution maps");
        assert_eq!(mapped.len(), 1);
        assert_eq!(
            mapped[0],
            json!({
                "id": "item-1",
                "kind": "command",
                "command": "ls -la",
                "cwd": "/repo",
                "status": "running",
                "output": "total 0\n",
                "exitCode": null,
                "extensions": { "codex": item },
            })
        );
    }

    #[test]
    fn map_codex_item_command_execution_omits_cwd_key_when_absent() {
        let item = json!({ "type": "commandExecution", "id": "item-1", "command": "pwd", "status": "completed" });
        let mapped = map_codex_item("item-1", &item, "commandExecution").expect("maps");
        let obj = mapped[0].as_object().expect("object");
        assert!(
            !obj.contains_key("cwd"),
            "cwd must be OMITTED (not null) when the raw item has none: {obj:?}"
        );
    }

    #[test]
    fn map_codex_item_reasoning_renders_reasoning_kind_with_exact_schema_keys() {
        let item = json!({ "type": "reasoning", "id": "item-2", "summary": ["Plan: read the file first"], "content": [] });
        let mapped = map_codex_item("item-2", &item, "reasoning").expect("reasoning maps");
        assert_eq!(
            mapped[0],
            json!({
                "id": "item-2",
                "kind": "reasoning",
                "summary": ["Plan: read the file first"],
                "content": [],
                "text": "Plan: read the file first",
            })
        );
    }

    #[test]
    fn map_codex_item_file_change_renders_file_change_kind_with_exact_schema_keys() {
        let item = json!({
            "type": "fileChange",
            "id": "item-3",
            "status": "completed",
            "changes": [{ "path": "src/main.rs", "kind": "update" }],
        });
        let mapped = map_codex_item("item-3", &item, "fileChange").expect("fileChange maps");
        assert_eq!(
            mapped[0],
            json!({
                "id": "item-3",
                "kind": "file_change",
                "status": "completed",
                "changes": [{ "path": "src/main.rs", "kind": "update" }],
                "extensions": { "codex": item },
            })
        );
    }

    #[test]
    fn map_codex_item_mcp_tool_call_renders_mcp_tool_kind_with_exact_schema_keys() {
        let item = json!({
            "type": "mcpToolCall", "id": "item-4", "server": "fs", "tool": "read_file",
            "status": "completed", "arguments": { "path": "a.txt" }, "result": "contents", "error": null,
        });
        let mapped = map_codex_item("item-4", &item, "mcpToolCall").expect("mcpToolCall maps");
        assert_eq!(
            mapped[0],
            json!({
                "id": "item-4", "kind": "mcp_tool", "server": "fs", "tool": "read_file", "status": "completed",
                "arguments": { "path": "a.txt" }, "result": "contents", "error": null,
            })
        );
    }

    #[test]
    fn map_codex_item_dynamic_tool_call_renders_dynamic_tool_kind_with_exact_schema_keys() {
        let item = json!({
            "type": "dynamicToolCall", "id": "item-5", "tool": "bash", "status": "inProgress",
            "arguments": { "command": "ls" },
        });
        let mapped =
            map_codex_item("item-5", &item, "dynamicToolCall").expect("dynamicToolCall maps");
        assert_eq!(
            mapped[0],
            json!({
                "id": "item-5", "kind": "dynamic_tool", "namespace": null, "tool": "bash", "status": "running",
                "arguments": { "command": "ls" }, "contentItems": null, "success": null,
            })
        );
    }

    #[test]
    fn map_codex_item_user_message_splits_content_parts_into_text_items() {
        let item = json!({
            "type": "userMessage", "id": "item-6",
            "content": [{ "type": "text", "text": "hello" }, { "type": "image" }],
        });
        let mapped = map_codex_item("item-6", &item, "userMessage").expect("userMessage maps");
        assert_eq!(mapped.len(), 2);
        assert_eq!(
            mapped[0],
            json!({ "id": "item-6:part:0", "kind": "text", "text": "hello" })
        );
        assert_eq!(
            mapped[1],
            json!({ "id": "item-6:part:1", "kind": "text", "text": "[image]" })
        );
    }

    #[test]
    fn map_codex_item_unrecognized_type_is_a_protocol_error_matching_reference_message() {
        let item = json!({ "type": "somethingNew", "id": "item-7" });
        let err =
            map_codex_item("item-7", &item, "somethingNew").expect_err("unrecognized type errors");
        assert_eq!(err, "Unsupported Codex thread item type: somethingNew");
    }

    #[test]
    fn build_codex_turn_json_appends_synthetic_text_item_for_turn_error() {
        // CHANGED (was: item appended into the existing turn's `items`): the reference always
        // gives a turn-level error its OWN synthetic display row with `role: 'assistant'`
        // (`createSyntheticPendingRow`, `normalize.ts:521-533`) -- it is never folded into an
        // existing row's item list. With no other items in this raw turn, that means exactly
        // ONE output turn, whose items are just the synthetic error text.
        let raw_turn = json!({
            "id": "turn-err",
            "error": { "message": "sandbox denied" },
            "items": [],
        });
        let turns = build_codex_turn_json(&raw_turn, 0).expect("turn builds");
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0]["role"], json!("assistant"));
        assert_eq!(turns[0]["items"][0]["kind"], json!("text"));
        assert_eq!(
            turns[0]["items"][0]["text"],
            json!("Codex turn failed: sandbox denied")
        );
    }

    #[test]
    fn build_codex_turn_json_propagates_unrecognized_item_type_as_error() {
        // Return type changed from a single `Value` to `Vec<Value>` (turn-splitting), but an
        // unrecognized item type must still error the WHOLE raw turn immediately, unchanged.
        let raw_turn =
            json!({ "id": "turn-bad", "items": [{ "type": "notAKnownType", "id": "x" }] });
        let err = build_codex_turn_json(&raw_turn, 0)
            .expect_err("unrecognized item type errors the whole turn");
        assert_eq!(err, "Unsupported Codex thread item type: notAKnownType");
    }

    #[test]
    fn summarize_codex_items_uses_first_items_kind_specific_text_not_a_join() {
        let items = vec![
            json!({ "id": "a", "kind": "reasoning", "summary": ["thinking hard"], "content": [], "text": "thinking hard" }),
            json!({ "id": "b", "kind": "command", "command": "ls", "status": "completed", "output": null, "exitCode": null, "extensions": {} }),
        ];
        assert_eq!(summarize_codex_items(&items), "thinking hard");
    }

    #[tokio::test]
    async fn get_snapshot_renders_tool_reasoning_and_file_change_items_end_to_end() {
        let (transport, peer) = freshell_codex::new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect(transport);
        let client = Arc::new(client);

        let (st, _rx) = state_with_bus();
        insert_fake_session(
            &st,
            "thread-rich",
            client,
            Arc::new(StdMutex::new(None)),
            spawn_sleeper(),
            "codex-sidecar-test-snapshot-rich",
        )
        .await;

        let driver = {
            let st = st.clone();
            tokio::spawn(async move { st.get_snapshot("thread-rich").await })
        };

        let (init_id, _m, _p) = peer.expect_request().await;
        peer.respond(
            &init_id,
            json!({ "userAgent": "x", "codexHome": "/h", "platformFamily": "u", "platformOs": "l" }),
        );
        let _ = peer.expect_notification().await;

        let (id, _method, _params) = peer.expect_request().await;
        peer.respond(
            &id,
            json!({
                "thread": {
                    "id": "thread-rich",
                    "status": { "type": "idle" },
                    "turns": [{
                        "id": "turn-1",
                        "status": "completed",
                        "items": [
                            { "type": "reasoning", "id": "r-1", "summary": ["Checking the file"], "content": [] },
                            { "type": "commandExecution", "id": "c-1", "command": "cat a.txt", "status": "completed", "aggregatedOutput": "hi\n", "exitCode": 0 },
                            { "type": "fileChange", "id": "f-1", "status": "completed", "changes": [{ "path": "a.txt" }] },
                        ],
                    }],
                }
            }),
        );

        // CHANGED (was: one turn with all 3 items): `reasoning` classifies as `assistant`
        // (`classifyCodexItemRole`, `normalize.ts:480-483`) while `commandExecution`/
        // `fileChange` both classify as `tool` (`normalize.ts:484-492`) -- a role change mid-turn
        // SPLITS the raw turn into two display rows (`normalizeCodexDisplayTurns`,
        // `normalize.ts:615-632`), each with its own `role`. This is the exact behavior the
        // Critical review finding required: role present on every turn, contiguous same-role
        // items grouped into their own turn.
        let snapshot = driver.await.unwrap().expect("snapshot builds");
        let turns = snapshot["turns"].as_array().expect("turns array");
        assert_eq!(turns.len(), 2);

        assert_eq!(turns[0]["role"], json!("assistant"));
        assert_eq!(turns[0]["ordinal"], json!(0));
        let assistant_items = turns[0]["items"].as_array().expect("items array");
        assert_eq!(assistant_items.len(), 1);
        assert_eq!(assistant_items[0]["kind"], json!("reasoning"));
        // Turn summary is that row's own (only) item's projection.
        assert_eq!(turns[0]["summary"], json!("Checking the file"));

        assert_eq!(turns[1]["role"], json!("tool"));
        assert_eq!(turns[1]["ordinal"], json!(1));
        let tool_items = turns[1]["items"].as_array().expect("items array");
        assert_eq!(tool_items.len(), 2);
        assert_eq!(tool_items[0]["kind"], json!("command"));
        assert_eq!(tool_items[0]["command"], json!("cat a.txt"));
        assert_eq!(tool_items[1]["kind"], json!("file_change"));
        assert_eq!(tool_items[1]["changes"], json!([{ "path": "a.txt" }]));

        // Both rows came from the SAME raw turn ("turn-1"), which splits into 2 -- so neither
        // keeps the raw id verbatim; each gets a disambiguated `"{raw_id}:row-{index}"` id.
        assert_eq!(turns[0]["id"], json!("turn-1:row-0"));
        assert_eq!(turns[0]["turnId"], json!("turn-1:row-0"));
        assert_eq!(turns[1]["id"], json!("turn-1:row-1"));
        assert_eq!(turns[1]["turnId"], json!("turn-1:row-1"));
    }

    // -- Fix task: role field + per-role turn splitting for the codex snapshot endpoint --

    #[test]
    fn build_codex_turn_json_splits_a_raw_turn_with_user_and_assistant_items_into_two_turns() {
        let raw_turn = json!({
            "id": "turn-mixed",
            "status": "completed",
            "items": [
                { "type": "userMessage", "id": "u-1", "content": [{ "type": "text", "text": "please check the file" }] },
                { "type": "agentMessage", "id": "a-1", "text": "Sure, checking now." },
            ],
        });
        let turns = build_codex_turn_json(&raw_turn, 0).expect("turn builds");

        assert_eq!(
            turns.len(),
            2,
            "one user row + one assistant row: {turns:?}"
        );

        assert_eq!(turns[0]["role"], json!("user"));
        let user_items = turns[0]["items"].as_array().expect("items array");
        assert_eq!(user_items.len(), 1);
        assert_eq!(user_items[0]["kind"], json!("text"));
        assert_eq!(user_items[0]["text"], json!("please check the file"));

        assert_eq!(turns[1]["role"], json!("assistant"));
        let assistant_items = turns[1]["items"].as_array().expect("items array");
        assert_eq!(assistant_items.len(), 1);
        assert_eq!(assistant_items[0]["kind"], json!("text"));
        assert_eq!(assistant_items[0]["text"], json!("Sure, checking now."));

        // Every emitted turn carries a `.strict()`-schema-valid `role`.
        for turn in &turns {
            assert!(
                turn.get("role").and_then(Value::as_str).is_some(),
                "every emitted turn must carry a role: {turn:?}"
            );
        }
    }

    #[test]
    fn build_codex_turn_json_keeps_a_single_role_raw_turn_as_one_turn_with_role_set() {
        let raw_turn = json!({
            "id": "turn-single",
            "items": [
                { "type": "agentMessage", "id": "a-1", "text": "hello from codex" },
            ],
        });
        let turns = build_codex_turn_json(&raw_turn, 0).expect("turn builds");

        assert_eq!(turns.len(), 1, "single role -> single turn: {turns:?}");
        assert_eq!(turns[0]["role"], json!("assistant"));
        assert_eq!(turns[0]["items"][0]["text"], json!("hello from codex"));
    }

    #[test]
    fn build_codex_turn_json_role_is_present_on_every_emitted_turn_including_tool_rows() {
        let raw_turn = json!({
            "id": "turn-tool-only",
            "items": [
                { "type": "commandExecution", "id": "c-1", "command": "pwd", "status": "completed" },
            ],
        });
        let turns = build_codex_turn_json(&raw_turn, 0).expect("turn builds");
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0]["role"], json!("tool"));
    }

    #[test]
    fn build_codex_turn_json_turn_id_semantics_single_row_keeps_raw_id_multi_row_disambiguates() {
        // Pinning the documented turnId scheme (see the doc comment on `build_codex_turn_json`):
        // the reference's HMAC-derived turnId (`createCodexDisplayId`, `normalize.ts:574-593`)
        // requires a per-server-instance secret this crate does not own (`configStore` in
        // `server/index.ts:322-326`). This port's non-cryptographic, deterministic substitute:
        // a raw turn producing exactly one display row keeps `turnId == raw turn id` (PR-5
        // precedent, unchanged for the common case); a raw turn that SPLITS into multiple rows
        // disambiguates each extra row as `"{raw_turn_id}:row-{index}"`.
        let single_row_turn = json!({
            "id": "turn-single-id",
            "items": [{ "type": "agentMessage", "id": "a-1", "text": "hi" }],
        });
        let turns = build_codex_turn_json(&single_row_turn, 0).expect("turn builds");
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0]["id"], json!("turn-single-id"));
        assert_eq!(turns[0]["turnId"], json!("turn-single-id"));

        let multi_row_turn = json!({
            "id": "turn-multi-id",
            "items": [
                { "type": "userMessage", "id": "u-1", "content": [{ "type": "text", "text": "hi" }] },
                { "type": "agentMessage", "id": "a-1", "text": "hello" },
            ],
        });
        let turns = build_codex_turn_json(&multi_row_turn, 0).expect("turn builds");
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0]["id"], json!("turn-multi-id:row-0"));
        assert_eq!(turns[0]["turnId"], json!("turn-multi-id:row-0"));
        assert_eq!(turns[1]["id"], json!("turn-multi-id:row-1"));
        assert_eq!(turns[1]["turnId"], json!("turn-multi-id:row-1"));
    }

    #[test]
    fn build_codex_turn_json_empty_response_synthetic_row_also_carries_assistant_role() {
        // A completed turn with ONLY user-role items and no assistant output gets a synthetic
        // "empty-response" row appended (`normalize.ts:642-652`) -- also role `assistant`,
        // matching `createSyntheticPendingRow`'s hardcoded role.
        let raw_turn = json!({
            "id": "turn-empty-response",
            "status": "completed",
            "items": [
                { "type": "userMessage", "id": "u-1", "content": [{ "type": "text", "text": "hi" }] },
            ],
        });
        let turns = build_codex_turn_json(&raw_turn, 0).expect("turn builds");
        assert_eq!(
            turns.len(),
            2,
            "user row + synthetic empty-response row: {turns:?}"
        );
        assert_eq!(turns[0]["role"], json!("user"));
        assert_eq!(turns[1]["role"], json!("assistant"));
        assert_eq!(
            turns[1]["items"][0]["text"],
            json!("Codex completed this turn without recording an assistant response.")
        );
    }
}
