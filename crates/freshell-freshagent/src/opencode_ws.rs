//! # freshell-freshagent :: opencode_ws — the freshopencode WS fresh-agent slice (PR-2)
//!
//! The additive Batch D PR-2 wiring that lets a browser `freshAgent.*` client drive a
//! live opencode session THROUGH the Rust server's WS surface (`freshopencode`), instead
//! of only through the REST `/api/tabs` + `/api/panes/:id/send-keys` slice ([`crate`]'s
//! root module). A faithful port of the WS-relevant subset of
//! `server/fresh-agent/adapters/opencode/adapter.ts` (`create` / `send` /
//! `materializeOrSend` / `kill` / `interrupt`) on top of the SAME
//! [`freshell_opencode::OpencodeServeManager`] the REST slice uses.
//!
//! ## Scope (PR-2 only — see the module's sibling PRs for the rest)
//!
//! | Message | Behaviour |
//! |---|---|
//! | `freshAgent.create {provider:'opencode',…}` | mint a `freshopencode-<requestId>` **placeholder** session (NO serve spawn, NO durable session yet — `adapter.ts:419-431`), broadcast `freshAgent.created` |
//! | `freshAgent.send {sessionId,text,…}` | **materialize-or-send** (`adapter.ts:324-361`): create the durable `ses_*` session ONLY the first time (THE continuity fix — see below), broadcast `freshAgent.session.materialized` exactly once, then broadcast `freshAgent.send.accepted` and run the turn |
//! | `freshAgent.kill` | remove the session (both its placeholder and durable keys), abort any in-flight turn task, broadcast `freshAgent.killed` — the SHARED `opencode serve` sidecar is NEVER touched (`adapter.ts kill()` has no `serveManager.shutdown()` call) |
//! | `freshAgent.interrupt` | best-effort: abort the in-flight turn task + issue `serveManager.abort()` against the real session (`adapter.ts interrupt()` / `abortForState`) |
//!
//! PR-3 bridges the serve SSE stream into `freshAgent.event` frames (status snapshots +
//! the status-guarded `freshAgent.turn.complete` chime). PR-4 adds `freshAgent.attach`
//! (reload-rehydrate): a known session re-emits a status snapshot and restarts its
//! serve-SSE bridge if it died; an unknown session emits the `INVALID_SESSION_ID` shape
//! the client folds into `markSessionLost` instead of hanging. **Out of scope entirely
//! for this slice:** `freshAgent.fork` / `freshAgent.compact`.
//!
//! The turn this module runs on `freshAgent.send` DOES land in the real opencode session
//! (via [`freshell_opencode::OpencodeServeManager::run_turn`]) — the pane's live-updating
//! transcript just isn't wired to the WS bus yet, so nothing streams to the browser
//! until that turn resolves and a later `freshAgent.attach`/REST read observes it.
//! **Deferred to PR-4:** `freshAgent.attach`. **Out of scope entirely for this slice:**
//! `freshAgent.fork` / `freshAgent.compact`.
//!
//! ## THE continuity fix (AGENT-08)
//!
//! The REST `send_keys` handler ([`crate::send_keys`]) unconditionally calls
//! `manager.create_session(..)` on EVERY call, even when the pane already carries a
//! `durable_id` — so a second turn on the same pane silently starts a NEW opencode
//! session instead of continuing the first (context loss). This module's `handle_send`
//! creates the durable session ONLY when `real_session_id` is still `None`
//! (`adapter.ts materializeOrSend:349` — `if (!state.realSessionId) { … }`), so a second
//! `freshAgent.send` on the same WS session id reuses the SAME `ses_*` id. The sibling
//! REST defect is fixed alongside this module (see the report); the two share the same
//! root cause and the same fix shape.
//!
//! ## One shared serve sidecar
//!
//! [`FreshOpencodeState`] holds a [`crate::FreshAgentState`] and calls its
//! `ensure_manager()` (`pub(crate)`) rather than constructing its own
//! [`freshell_opencode::OpencodeServeManager`] — there is exactly ONE `opencode serve`
//! child process per server, shared by the REST tabs slice and this WS slice.
//! `freshAgent.kill` therefore must never call `manager.shutdown()`: that would tear
//! down every OTHER session's serve sidecar too. It only removes this session's local
//! bookkeeping and aborts its own turn task (`adapter.ts kill()`, `serve-manager.ts:565`
//! / `:624` — the sidecar's lifecycle is independent of any one session's).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::Mutex as TokioMutex;

use freshell_codex::next_monotonic_turn_complete_at;
use freshell_opencode::{
    normalize_opencode_effort, normalize_opencode_model, ChangedReason, OpencodeServeManager,
    SdkProviderEvent, SessionSignal, SnapshotStatus,
};
use freshell_protocol::{
    ErrorCode, ErrorMsg, FreshAgentAttach, FreshAgentCreate, FreshAgentCreated, FreshAgentEvent,
    FreshAgentInterrupt, FreshAgentKill, FreshAgentKilled, FreshAgentSend, FreshAgentSendAccepted,
    FreshAgentSessionMaterialized, ServerMessage, SessionLocator,
};

use crate::FreshAgentState;

/// The opencode fresh-agent `sessionType` (`AGENT_SESSION_TYPES.opencode`).
const SESSION_TYPE: &str = "freshopencode";
/// The runtime provider (`AGENT_SESSION_TYPES.opencode.provider`).
const PROVIDER: &str = "opencode";
/// `DEFAULT_TURN_TIMEOUT_MS` (`adapter.ts:35`).
const DEFAULT_TURN_TIMEOUT: Duration = Duration::from_millis(600_000);

/// Shared, cheaply-cloneable freshopencode WS state (mergeable into `WsState`).
#[derive(Clone)]
pub struct FreshOpencodeState {
    /// Reused for its shared `ensure_manager()` (the ONE opencode serve sidecar) and its
    /// `broadcast()` (the SAME WS bus the REST slice pushes onto).
    fresh_agent: FreshAgentState,
    /// Keyed by BOTH the placeholder id and (once materialized) the durable `ses_*` id —
    /// mirrors `adapter.ts`'s `remember()` (`sessions.set(placeholderId, state);
    /// sessions.set(realSessionId, state)`), so a `freshAgent.send`/`kill` addressed by
    /// either id resolves to the SAME session record.
    sessions: Arc<TokioMutex<HashMap<String, Arc<TokioMutex<OpencodeSession>>>>>,
}

/// One live (or not-yet-materialized) freshopencode WS session.
struct OpencodeSession {
    placeholder_id: String,
    /// `None` until the first `freshAgent.send` materializes it (`adapter.ts:349`).
    real_session_id: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    /// The detached task running the current/most-recent turn (`manager.run_turn`), so
    /// `freshAgent.kill`/`freshAgent.interrupt` can abort it. Not serialized against a
    /// concurrent `freshAgent.send` — mirrors `adapter.ts`'s `sendQueue` only loosely
    /// (this crate does not yet serialize overlapping sends).
    turn_task: Option<tokio::task::JoinHandle<()>>,
    /// PR-3: set by `handle_interrupt` (BEFORE aborting) so a racing in-flight turn's
    /// completion gating suppresses `freshAgent.turn.complete` (`state.turnAborted`,
    /// adapter.ts:521,334-335). Reset to `false` at the top of every `handle_send`.
    turn_aborted: Arc<AtomicBool>,
    /// PR-3: flipped `true` by the serve-stream bridge when it observes a `session.error`
    /// SSE event during the in-flight turn (`state.turnErrored`, adapter.ts:278-282,334-335).
    /// Reset to `false` at the top of every `handle_send`.
    turn_errored: Arc<AtomicBool>,
    /// PR-3: the strictly-monotonic turn-complete clock's last stamped value for this
    /// session (`state.lastTurnCompleteAt`, `turn-complete-clock.ts`).
    last_turn_complete_at: Arc<StdMutex<Option<i64>>>,
    /// PR-3: the persistent serve-SSE-bridge task started ONCE at materialization
    /// (`adapter.ts bindServeStream`, called from `materializeOrSend:349`), forwarding
    /// `session.status`/`session.idle`/`message.*`/`session.error` into
    /// `freshAgent.session.snapshot` / `freshAgent.session.changed` / `freshAgent.error`
    /// for the lifetime of the session. `None` until materialized; aborted on kill.
    serve_bridge: Option<tokio::task::JoinHandle<()>>,
}

impl OpencodeSession {
    fn new(
        placeholder_id: String,
        cwd: Option<String>,
        model: Option<String>,
        effort: Option<String>,
    ) -> Self {
        Self {
            placeholder_id,
            real_session_id: None,
            cwd,
            model,
            effort,
            turn_task: None,
            turn_aborted: Arc::new(AtomicBool::new(false)),
            turn_errored: Arc::new(AtomicBool::new(false)),
            last_turn_complete_at: Arc::new(StdMutex::new(None)),
            serve_bridge: None,
        }
    }
}

impl FreshOpencodeState {
    /// Build the state around an existing [`FreshAgentState`] (REUSED, not duplicated),
    /// so this slice and the REST tabs slice share exactly one `opencode serve` sidecar.
    pub fn new(fresh_agent: FreshAgentState) -> Self {
        Self {
            fresh_agent,
            sessions: Arc::new(TokioMutex::new(HashMap::new())),
        }
    }

    fn broadcast(&self, msg: &ServerMessage) {
        self.fresh_agent.broadcast(msg);
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

    // ── freshAgent.create (WS) ──────────────────────────────────────────────

    /// Handle a `freshAgent.create` for opencode: mint a placeholder session (NO serve
    /// spawn — `adapter.ts create():419-431`) and broadcast `freshAgent.created`.
    /// `sessionId == freshopencode-<requestId>` until a `send` materializes it.
    pub async fn handle_create(&self, msg: FreshAgentCreate) {
        let request_id = msg.request_id.clone();
        let model = normalize_opencode_model(msg.model.as_deref());
        let effort = normalize_opencode_effort(model.as_deref(), msg.effort.as_deref());
        let placeholder = format!("freshopencode-{request_id}");

        let session = OpencodeSession::new(placeholder.clone(), msg.cwd.clone(), model, effort);
        self.sessions
            .lock()
            .await
            .insert(placeholder.clone(), Arc::new(TokioMutex::new(session)));

        self.broadcast(&ServerMessage::FreshAgentCreated(FreshAgentCreated {
            provider: PROVIDER.to_string(),
            request_id,
            runtime_provider: PROVIDER.to_string(),
            session_id: placeholder.clone(),
            session_type: SESSION_TYPE.to_string(),
            session_ref: Some(SessionLocator {
                provider: PROVIDER.to_string(),
                session_id: placeholder,
            }),
        }));
    }

    // ── freshAgent.send (WS) — materialize-or-send ─────────────────────────

    /// Handle a `freshAgent.send` for opencode: `materializeOrSend` (`adapter.ts:324-361`).
    /// Creates the durable `ses_*` session ONLY if this session has not materialized yet
    /// (the continuity fix), broadcasts `freshAgent.session.materialized` exactly once,
    /// then `freshAgent.send.accepted`, then runs the turn against the real opencode
    /// serve session in a detached task (PR-3 bridges its completion signal onto the bus).
    pub async fn handle_send(&self, msg: FreshAgentSend) {
        let request_id = msg.request_id.clone();
        let session_id = msg.session_id.clone();

        let session_arc = {
            let guard = self.sessions.lock().await;
            guard.get(&session_id).cloned()
        };
        let Some(session_arc) = session_arc else {
            self.send_error(
                &request_id,
                "SESSION_NOT_FOUND",
                "opencode session not found",
            );
            return;
        };

        let mut session = session_arc.lock().await;

        // materializeOrSend:334-335 -- a fresh turn starts un-aborted and un-errored;
        // `handle_interrupt` flips `turn_aborted` while we are parked on idle, and the
        // serve-stream bridge flips `turn_errored` if the turn reports an error.
        session.turn_aborted.store(false, Ordering::SeqCst);
        session.turn_errored.store(false, Ordering::SeqCst);

        // `normalizeOpencodeInput(settings)` (adapter.ts:82-83, materializeOrSend:325-328):
        // when `settings` is present, model/effort are normalized PURELY from it (the
        // reference spreads `{...settings}` — a field settings omits is NOT backfilled
        // from the session's stored value). When `settings` is absent entirely, the
        // stored model/effort/cwd are reused verbatim.
        let (model, effort, cwd) = if let Some(settings) = msg.settings.as_ref() {
            let model = normalize_opencode_model(settings.model.as_deref());
            let effort = normalize_opencode_effort(model.as_deref(), settings.effort.as_deref());
            let cwd = settings
                .cwd
                .clone()
                .or_else(|| msg.cwd.clone())
                .or_else(|| session.cwd.clone());
            (model, effort, cwd)
        } else {
            let cwd = msg.cwd.clone().or_else(|| session.cwd.clone());
            (session.model.clone(), session.effort.clone(), cwd)
        };

        let manager = self.fresh_agent.ensure_manager().await;

        // `emitStatus(state, 'running')` (adapter.ts:336) -- BEFORE any session
        // materialization, stamped with whatever id is currently known (the placeholder
        // on a session's first send, the durable id thereafter).
        let busy_session_id = session
            .real_session_id
            .clone()
            .unwrap_or_else(|| session.placeholder_id.clone());
        self.broadcast(&event_frame(
            &busy_session_id,
            snapshot_event(&busy_session_id, "running"),
        ));

        let acked_session_id = if let Some(real_id) = session.real_session_id.clone() {
            // Already materialized: THE continuity fix — reuse it, no new session.
            real_id
        } else {
            let created = match manager.create_session(None, None, cwd.as_deref()).await {
                Ok(created) => created,
                Err(err) => {
                    self.send_error(
                        &request_id,
                        "OPENCODE_SESSION_CREATE_FAILED",
                        &err.to_string(),
                    );
                    return;
                }
            };
            let durable_id = created.id;
            session.real_session_id = Some(durable_id.clone());
            if let Some(dir) = created.directory.filter(|d| !d.is_empty()) {
                session.cwd = Some(dir);
            } else if let Some(cwd) = cwd.clone() {
                session.cwd = Some(cwd);
            }

            self.sessions
                .lock()
                .await
                .insert(durable_id.clone(), session_arc.clone());

            // `freshAgent.session.materialized` (ws-handler.ts:3477-3484): placeholder ->
            // durable, emitted EXACTLY ONCE (a later send never re-enters this branch).
            self.broadcast(&ServerMessage::FreshAgentSessionMaterialized(
                FreshAgentSessionMaterialized {
                    previous_session_id: session.placeholder_id.clone(),
                    provider: PROVIDER.to_string(),
                    session_id: durable_id.clone(),
                    session_type: SESSION_TYPE.to_string(),
                    session_ref: Some(SessionLocator {
                        provider: PROVIDER.to_string(),
                        session_id: durable_id.clone(),
                    }),
                },
            ));

            // PR-3: `bindServeStream(state)` (adapter.ts:349) -- start the persistent
            // serve-SSE bridge ONCE, right after materialization. A later send never
            // re-enters this branch (mirrors `if (state.unsubscribeServe ...) return`).
            session.serve_bridge = Some(self.spawn_serve_bridge(
                manager.clone(),
                durable_id.clone(),
                session.turn_errored.clone(),
            ));
            durable_id
        };

        session.model = model.clone();
        session.effort = effort.clone();
        let real_id = acked_session_id.clone();
        let route = session.cwd.clone();
        let text = msg.text.clone();

        // `freshAgent.send.accepted` (ws-handler.ts:3487-3495) — broadcast immediately,
        // mirroring the codex slice's ack timing. The turn itself runs in a detached
        // task below so `freshAgent.kill` can target it independently of this handler's
        // own (already-detached, per terminal.rs dispatch) task.
        self.broadcast(&ServerMessage::FreshAgentSendAccepted(
            FreshAgentSendAccepted {
                provider: PROVIDER.to_string(),
                request_id: request_id.unwrap_or_default(),
                session_id: acked_session_id,
                session_type: SESSION_TYPE.to_string(),
                cwd: route.clone(),
                submitted_turn_id: None,
            },
        ));

        let fresh_agent = self.fresh_agent.clone();
        let turn_aborted = session.turn_aborted.clone();
        let turn_errored = session.turn_errored.clone();
        let last_turn_complete_at = session.last_turn_complete_at.clone();

        let turn_task = tokio::spawn(async move {
            // `run_turn` (freshell-opencode/serve.rs) prompts + awaits idle against the
            // REAL opencode serve session (adapter.ts materializeOrSend:363-368).
            let result = manager
                .run_turn(
                    &real_id,
                    &text,
                    model.as_deref(),
                    effort.as_deref(),
                    DEFAULT_TURN_TIMEOUT,
                    route,
                )
                .await;

            // `emitStatus(state, 'idle')` (adapter.ts:371/384) -- unconditional, whether
            // the turn succeeded or the promptAsync/idle-wait itself errored.
            fresh_agent.broadcast(&event_frame(&real_id, snapshot_event(&real_id, "idle")));

            // adapter.ts:377 -- a positive completion requires the idle-wait to have
            // actually succeeded AND the turn to have been neither interrupted
            // (`turn_aborted`, set by `handle_interrupt`) nor errored (`turn_errored`,
            // set by the serve-stream bridge on an observed `session.error`).
            if result.is_ok()
                && !turn_aborted.load(Ordering::SeqCst)
                && !turn_errored.load(Ordering::SeqCst)
            {
                let at = {
                    let mut guard = last_turn_complete_at
                        .lock()
                        .expect("last_turn_complete_at mutex");
                    let at = next_monotonic_turn_complete_at(*guard, now_ms());
                    *guard = Some(at);
                    at
                };
                fresh_agent.broadcast(&event_frame(&real_id, turn_complete_event(&real_id, at)));
            }
        });
        session.turn_task = Some(turn_task);
    }

    // ── freshAgent.kill (WS) ────────────────────────────────────────────────

    /// Handle a `freshAgent.kill` for opencode: remove the session's bookkeeping (both
    /// its placeholder and durable keys), abort its in-flight turn task, and broadcast
    /// `freshAgent.killed`. NEVER touches the shared `opencode serve` sidecar — that
    /// child is reused by every session and torn down only by
    /// [`crate::FreshAgentState::shutdown`] at server shutdown.
    pub async fn handle_kill(&self, msg: FreshAgentKill) {
        let session_arc = {
            let mut guard = self.sessions.lock().await;
            let found = guard.get(&msg.session_id).cloned();
            if let Some(session_arc) = &found {
                let (placeholder, real) = {
                    let s = session_arc.lock().await;
                    (s.placeholder_id.clone(), s.real_session_id.clone())
                };
                guard.remove(&placeholder);
                if let Some(real) = real {
                    guard.remove(&real);
                }
            }
            found
        };

        if let Some(session_arc) = session_arc {
            let mut s = session_arc.lock().await;
            if let Some(task) = s.turn_task.take() {
                task.abort();
            }
            // PR-3: stop the persistent serve-SSE bridge too (`unsubscribeServe?.()`,
            // adapter.ts:568) so it doesn't keep broadcasting for a dead session.
            if let Some(bridge) = s.serve_bridge.take() {
                bridge.abort();
            }
        }

        // `adapter.ts kill()` is unconditional (`return true` even for an
        // already-removed/unknown session) — idempotent, matching the codex/claude
        // `freshAgent.killed{success:true}` pattern.
        self.broadcast(&ServerMessage::FreshAgentKilled(FreshAgentKilled {
            provider: PROVIDER.to_string(),
            session_id: msg.session_id,
            session_type: SESSION_TYPE.to_string(),
            success: true,
        }));
    }

    // ── freshAgent.interrupt (WS) ────────────────────────────────────────

    /// Handle a `freshAgent.interrupt` for opencode: mark the turn aborted (BEFORE
    /// aborting, so a racing in-flight completion sees the flag — adapter.ts:521), abort
    /// the in-flight turn task, and issue a best-effort `serveManager.abort()` against
    /// the real session (`adapter.ts interrupt()` / `abortForState`). Always broadcasts
    /// the resulting idle status (`emitStatus(state,'idle')`, adapter.ts:530) — even for
    /// a not-yet-materialized session (`abortForState` no-ops when there's no
    /// `realSessionId`, but the reference still emits idle unconditionally).
    pub async fn handle_interrupt(&self, msg: FreshAgentInterrupt) {
        let session_arc = {
            let guard = self.sessions.lock().await;
            guard.get(&msg.session_id).cloned()
        };
        let Some(session_arc) = session_arc else {
            self.send_error(&None, "SESSION_NOT_FOUND", "opencode session not found");
            return;
        };

        let (real_id, route, turn_aborted) = {
            let mut session = session_arc.lock().await;
            session.turn_aborted.store(true, Ordering::SeqCst);
            if let Some(task) = session.turn_task.take() {
                task.abort();
            }
            (
                session.real_session_id.clone(),
                session.cwd.clone(),
                session.turn_aborted.clone(),
            )
        };

        let Some(real_id) = real_id else {
            // Not yet materialized: `abortForState` is a no-op, but `emitStatus('idle')`
            // still fires (adapter.ts:530), stamped with whatever id the client sent.
            self.broadcast(&event_frame(
                &msg.session_id,
                snapshot_event(&msg.session_id, "idle"),
            ));
            return;
        };

        let manager = self.fresh_agent.ensure_manager().await;
        match manager.abort(&real_id, &route).await {
            Ok(()) => {
                self.broadcast(&event_frame(&real_id, snapshot_event(&real_id, "idle")));
            }
            Err(_) => {
                // adapter.ts:525-528 -- the abort never landed, so the turn may still
                // complete normally; clear the flag so a genuine completion isn't
                // silently swallowed.
                turn_aborted.store(false, Ordering::SeqCst);
            }
        }
    }

    // ── freshAgent.attach (reload-rehydrate, PR-4) ──────────────────────────

    /// Handle a `freshAgent.attach` for opencode: emit a session snapshot carrying the
    /// current status (running/idle from turn-task liveness), and restart the serve-SSE
    /// bridge if it died (e.g. the shared `opencode serve` sidecar was restarted). An
    /// unknown session id emits the `INVALID_SESSION_ID` shape the client folds into
    /// `markSessionLost` (`fresh-agent-ws.ts:326-328`) instead of hanging.
    pub async fn handle_attach(&self, msg: FreshAgentAttach) {
        let session_arc = {
            let guard = self.sessions.lock().await;
            guard.get(&msg.session_id).cloned()
        };
        let Some(session_arc) = session_arc else {
            self.broadcast(&lost_session_frame(&msg.session_id));
            return;
        };

        let (status_session_id, running) = {
            let mut session = session_arc.lock().await;

            // Ensure the serve-SSE bridge is running (restart it if it died) -- only
            // meaningful once a durable session exists; a not-yet-materialized session has
            // never started a bridge (`bindServeStream` only fires from `materializeOrSend`).
            if let Some(real_id) = session.real_session_id.clone() {
                let bridge_dead = session
                    .serve_bridge
                    .as_ref()
                    .map(tokio::task::JoinHandle::is_finished)
                    .unwrap_or(true);
                if bridge_dead {
                    let manager = self.fresh_agent.ensure_manager().await;
                    session.serve_bridge = Some(self.spawn_serve_bridge(
                        manager,
                        real_id,
                        session.turn_errored.clone(),
                    ));
                }
            }

            let status_session_id = session
                .real_session_id
                .clone()
                .unwrap_or_else(|| session.placeholder_id.clone());
            let running = session
                .turn_task
                .as_ref()
                .map(|t| !t.is_finished())
                .unwrap_or(false);
            (status_session_id, running)
        };

        let status = if running { "running" } else { "idle" };
        self.broadcast(&event_frame(
            &status_session_id,
            snapshot_event(&status_session_id, status),
        ));
    }

    // ── PR-3: the persistent serve-SSE bridge (adapter.ts `bindServeStream`) ─

    /// Bridge the serve SSE stream for `real_id` into `freshAgent.session.snapshot` /
    /// `freshAgent.session.changed` / `freshAgent.error` frames for the lifetime of the
    /// session, and flip `turn_errored` on an observed `session.error` (`state.turnErrored`,
    /// adapter.ts bindServeStream:278-282). Started ONCE, right after materialization
    /// (`bindServeStream(state)`, adapter.ts:349); aborted by `handle_kill`.
    fn spawn_serve_bridge(
        &self,
        manager: OpencodeServeManager,
        real_id: String,
        turn_errored: Arc<AtomicBool>,
    ) -> tokio::task::JoinHandle<()> {
        let fresh_agent = self.fresh_agent.clone();
        let mut rx = manager.subscribe(&real_id);
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(SessionSignal::Event(parsed)) => {
                        let Some(mapped) = freshell_opencode::serve_event_to_sdk(&parsed, &real_id)
                        else {
                            continue;
                        };
                        let inner = match &mapped {
                            SdkProviderEvent::Snapshot { session_id, status } => {
                                let status_str = match status {
                                    SnapshotStatus::Running => "running",
                                    SnapshotStatus::Idle => "idle",
                                };
                                snapshot_event(session_id, status_str)
                            }
                            SdkProviderEvent::Changed { session_id, reason } => {
                                let reason_str = match reason {
                                    ChangedReason::OpencodeMessage => "opencode-message",
                                    ChangedReason::OpencodeStatus => "opencode-status",
                                };
                                changed_event(session_id, reason_str)
                            }
                            SdkProviderEvent::Error {
                                session_id,
                                message,
                            } => {
                                // adapter.ts:278-282 -- a turn error means the in-flight
                                // turn did not positively complete; consulted by the
                                // send task's completion gating once idle resolves.
                                turn_errored.store(true, Ordering::SeqCst);
                                error_event(session_id, message)
                            }
                        };
                        fresh_agent.broadcast(&event_frame(&real_id, inner));
                    }
                    // The sidecar was lost; `run_turn`'s own `await_idle` independently
                    // surfaces `ServeError::SidecarLost`, which already excludes the
                    // turn from a positive completion. Nothing further to bridge here.
                    Ok(SessionSignal::Lost) => {}
                    Err(RecvError::Lagged(_)) => {}
                    Err(RecvError::Closed) => break,
                }
            }
        })
    }
}

/// ISO-8601 / RFC-3339 millis-Z timestamp (matches `new Date().toISOString()`) for error
/// frames. Duplicated from `codex.rs`'s identical private helper (module-private there),
/// this crate has no shared "misc formatting" home yet — see `IMPLEMENTATION_PHILOSOPHY.md`
/// on not centralizing a one-off for a two-site duplication.
fn now_iso() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
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

/// `Date.now()` — epoch milliseconds (the turn-complete clock's `now`). Duplicated from
/// `codex.rs`'s identical private helper, same rationale as `now_iso` above.
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ── PR-3: `freshAgent.event` frame builders (sdk-events.ts + serve-events.ts shapes) ─

/// Wrap `inner` in a `freshAgent.event` envelope (mirrors codex.rs's
/// `adapter_event_to_frame` / claude.rs's `sdk_line_to_frame`).
fn event_frame(session_id: &str, inner: Value) -> ServerMessage {
    ServerMessage::FreshAgentEvent(FreshAgentEvent {
        event: inner,
        provider: PROVIDER.to_string(),
        session_id: session_id.to_string(),
        session_type: SESSION_TYPE.to_string(),
    })
}

/// `{type:'sdk.session.snapshot',...} → freshAgent.session.snapshot` (sdk-events.ts:49-50;
/// emitted both by `emitStatus` and by `bindServeStream`'s SSE mapping, adapter.ts:301-303).
fn snapshot_event(session_id: &str, status: &str) -> Value {
    json!({ "type": "freshAgent.session.snapshot", "sessionId": session_id, "status": status })
}

/// `sdk.session.changed → freshAgent.session.changed` (sdk-events.ts:51-52; the transcript
/// / non-lifecycle-status invalidation `bindServeStream` forwards, adapter.ts:296).
fn changed_event(session_id: &str, reason: &str) -> Value {
    json!({ "type": "freshAgent.session.changed", "sessionId": session_id, "reason": reason })
}

/// `sdk.error → freshAgent.error` (sdk-events.ts:75-76; `bindServeStream` forwards a
/// `session.error` SSE event as this frame IN ADDITION TO flagging `turnErrored`).
fn error_event(session_id: &str, message: &str) -> Value {
    json!({ "type": "freshAgent.error", "sessionId": session_id, "message": message })
}

/// `sdk.turn.complete → freshAgent.turn.complete` (sdk-events.ts:71-72; the status-guarded
/// positive-completion chime, adapter.ts:377-381).
fn turn_complete_event(session_id: &str, at: i64) -> Value {
    json!({ "type": "freshAgent.turn.complete", "sessionId": session_id, "at": at })
}

/// The `freshAgent.error{code:'INVALID_SESSION_ID'}` shape (`sdk-events.ts:37`) the client
/// folds into `markSessionLost` (`fresh-agent-ws.ts:326-328`) instead of hanging on a stale
/// `freshAgent.attach` for a session this server has never heard of. Duplicated from
/// `codex.rs`'s identical private helper, same rationale as `now_iso`/`now_ms` above.
fn lost_session_frame(session_id: &str) -> ServerMessage {
    event_frame(
        session_id,
        json!({
            "type": "freshAgent.error",
            "sessionId": session_id,
            "code": "INVALID_SESSION_ID",
            "message": format!("opencode session {session_id} not found"),
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use freshell_opencode::serve::{
        Endpoint, EventSink, EventSource, EventStreamHandle, OpencodeServeManager, PortAllocator,
        ProcessSpawner, ServeConfig, ServeDeps, ServeHttp, ServeHttpRequest, ServeHttpResponse,
        ServeProcess, SpawnRequest,
    };
    use freshell_protocol::{AgentProvider, SessionType};
    use serde_json::json;

    // ── fakes (no real `opencode` process, no network) ──────────────────────

    /// Fakes `/session` create (returns a fresh incrementing `ses_N` id each call) and
    /// answers everything else (health, prompt, abort, status) with a benign `{}`.
    struct FakeHttp {
        next_session: AtomicUsize,
    }
    impl ServeHttp for FakeHttp {
        fn request<'a>(
            &'a self,
            req: ServeHttpRequest,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<ServeHttpResponse, String>> + Send + 'a>,
        > {
            let is_create = req.url.contains("/session")
                && !req.url.contains("/message")
                && !req.url.contains("/abort")
                && !req.url.contains("/status")
                && matches!(req.method, freshell_opencode::serve::HttpMethod::Post);
            let body = if is_create {
                let n = self.next_session.fetch_add(1, Ordering::SeqCst) + 1;
                serde_json::to_vec(&json!({ "id": format!("ses_{n}"), "directory": null })).unwrap()
            } else {
                b"{}".to_vec()
            };
            Box::pin(async move { Ok(ServeHttpResponse::new(200, body)) })
        }
    }

    struct FakeAllocator;
    impl PortAllocator for FakeAllocator {
        fn allocate(&self) -> Result<Endpoint, String> {
            Ok(Endpoint {
                hostname: "127.0.0.1".into(),
                port: 1,
            })
        }
    }

    /// A `ServeProcess` fake that records whether it was ever killed, so tests can
    /// assert the SHARED sidecar survives a per-session `freshAgent.kill`.
    struct TrackedProcess {
        killed: Arc<std::sync::atomic::AtomicBool>,
    }
    impl ServeProcess for TrackedProcess {
        fn exited(&self) -> Option<i32> {
            None
        }
        fn take_fatal_startup_error(&self) -> Option<String> {
            None
        }
        fn kill(&self) {
            self.killed.store(true, Ordering::SeqCst);
        }
    }

    struct TrackedSpawner {
        killed: Arc<std::sync::atomic::AtomicBool>,
    }
    impl ProcessSpawner for TrackedSpawner {
        fn spawn(&self, _req: SpawnRequest) -> Result<Box<dyn ServeProcess>, String> {
            Ok(Box::new(TrackedProcess {
                killed: self.killed.clone(),
            }))
        }
    }

    struct NoopHandle;
    impl EventStreamHandle for NoopHandle {}
    struct NoopEventSource;
    impl EventSource for NoopEventSource {
        fn connect(&self, _url: String, _sink: EventSink) -> Box<dyn EventStreamHandle> {
            Box::new(NoopHandle)
        }
    }

    /// PR-3: like [`FakeHttp`], but `/session/status` reports the LAST-created session
    /// id as `busy` for the first `busy_polls` polls, then absent (idle) thereafter —
    /// driving `OpencodeServeManager::await_idle`'s status-poll fallback to a
    /// deterministic idle resolution WITHOUT depending on SSE dispatch timing (which
    /// would otherwise race the manager's own internal `subscribe()` call inside
    /// `run_turn`). This is a genuinely-idle-eventually fake, not a fast-path stub.
    struct StatusPollFakeHttp {
        next_session: AtomicUsize,
        last_created: StdMutex<Option<String>>,
        status_polls: AtomicUsize,
        busy_polls: usize,
    }
    impl StatusPollFakeHttp {
        fn new(busy_polls: usize) -> Self {
            Self {
                next_session: AtomicUsize::new(0),
                last_created: StdMutex::new(None),
                status_polls: AtomicUsize::new(0),
                busy_polls,
            }
        }
    }
    impl ServeHttp for StatusPollFakeHttp {
        fn request<'a>(
            &'a self,
            req: ServeHttpRequest,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<ServeHttpResponse, String>> + Send + 'a>,
        > {
            let is_status = req.url.contains("/session/status");
            // Precise create-match: exactly `POST /session` (optionally `?directory=...`).
            // `.contains("/session")` alone (the plain `FakeHttp`'s predicate) also matches
            // `/session/:id/prompt_async` and `/session/:id/abort` -- fine for `FakeHttp`
            // (nothing there depends on `run_turn` resolving), but fatal here: misclassifying
            // `prompt_async` as a create call would mint a SECOND `ses_N` and re-point
            // `last_created`, so the status-poll busy response would key the wrong session id
            // and `run_turn` would hang forever waiting for an idle edge that never resolves.
            let is_create = !is_status
                && matches!(req.method, freshell_opencode::serve::HttpMethod::Post)
                && (req.url.ends_with("/session") || req.url.contains("/session?"));
            let body = if is_create {
                let n = self.next_session.fetch_add(1, Ordering::SeqCst) + 1;
                let id = format!("ses_{n}");
                *self.last_created.lock().unwrap() = Some(id.clone());
                serde_json::to_vec(&json!({ "id": id, "directory": null })).unwrap()
            } else if is_status {
                let poll_n = self.status_polls.fetch_add(1, Ordering::SeqCst);
                let last = self.last_created.lock().unwrap().clone();
                if poll_n < self.busy_polls {
                    let id = last.unwrap_or_default();
                    serde_json::to_vec(&json!({ id: { "type": "busy" } })).unwrap()
                } else {
                    b"{}".to_vec()
                }
            } else {
                b"{}".to_vec()
            };
            Box::pin(async move { Ok(ServeHttpResponse::new(200, body)) })
        }
    }

    /// A started (healthy-fake-backed) manager + a flag proving whether its owned
    /// sidecar was ever killed.
    async fn started_manager() -> (OpencodeServeManager, Arc<std::sync::atomic::AtomicBool>) {
        let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let deps = ServeDeps {
            spawner: Arc::new(TrackedSpawner {
                killed: killed.clone(),
            }),
            http: Arc::new(FakeHttp {
                next_session: AtomicUsize::new(0),
            }),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let config = ServeConfig {
            idle_poll_interval: Duration::from_millis(20),
            ..ServeConfig::default()
        };
        let mgr = OpencodeServeManager::new(deps, config);
        mgr.ensure_started()
            .await
            .expect("healthy fake serve starts");
        (mgr, killed)
    }

    /// A [`FreshOpencodeState`] wired to a fresh started fake manager (via
    /// `FreshAgentState::set_manager_for_test`), plus the fake's kill flag.
    async fn state() -> (FreshOpencodeState, Arc<std::sync::atomic::AtomicBool>) {
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
        let fresh_agent = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx));
        let (manager, killed) = started_manager().await;
        fresh_agent.set_manager_for_test(manager).await;
        (FreshOpencodeState::new(fresh_agent), killed)
    }

    fn create_msg(request_id: &str) -> FreshAgentCreate {
        FreshAgentCreate {
            request_id: request_id.to_string(),
            session_type: SessionType::Freshopencode,
            cwd: None,
            effort: None,
            legacy_restore_context: None,
            model: None,
            model_selection: None,
            permission_mode: None,
            plugins: None,
            provider: Some(AgentProvider::Opencode),
            resume_session_id: None,
            sandbox: None,
            session_ref: None,
        }
    }

    fn send_msg(session_id: &str, text: &str) -> FreshAgentSend {
        FreshAgentSend {
            provider: AgentProvider::Opencode,
            session_id: session_id.to_string(),
            session_type: SessionType::Freshopencode,
            text: text.to_string(),
            cwd: None,
            images: None,
            request_id: Some(format!("req-{text}")),
            settings: None,
        }
    }

    // ── tests ────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn create_broadcasts_created_with_placeholder_session_id() {
        let (st, mut rx) = {
            let (tx, rx) = tokio::sync::broadcast::channel::<String>(64);
            let fresh_agent = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx));
            (FreshOpencodeState::new(fresh_agent), rx)
        };

        st.handle_create(create_msg("req-1")).await;

        let frame: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(frame["type"], "freshAgent.created");
        assert_eq!(frame["provider"], "opencode");
        assert_eq!(frame["sessionId"], "freshopencode-req-1");
        assert_eq!(frame["sessionType"], "freshopencode");
    }

    #[tokio::test]
    async fn second_send_reuses_the_same_durable_session_id() {
        let (st, _killed) = state().await;
        st.handle_create(create_msg("req-cont")).await;
        let placeholder = "freshopencode-req-cont";

        st.handle_send(send_msg(placeholder, "first turn")).await;
        let session_arc = {
            let guard = st.sessions.lock().await;
            guard
                .get(placeholder)
                .cloned()
                .expect("session exists after create")
        };
        let first_real_id = {
            let s = session_arc.lock().await;
            s.real_session_id
                .clone()
                .expect("materialized after first send")
        };

        // Second send addressed by the PLACEHOLDER id again (the client hasn't yet
        // switched to the durable id) must reuse the SAME durable session — this is
        // the regression the AGENT-08 continuity bug produced (a fresh ses_ per send).
        st.handle_send(send_msg(placeholder, "second turn")).await;
        let second_real_id = {
            let s = session_arc.lock().await;
            s.real_session_id.clone().expect("still materialized")
        };

        assert_eq!(
            first_real_id, second_real_id,
            "second send must reuse the durable session id"
        );
    }

    fn attach_msg(session_id: &str) -> FreshAgentAttach {
        FreshAgentAttach {
            provider: AgentProvider::Opencode,
            session_id: session_id.to_string(),
            session_type: SessionType::Freshopencode,
            cwd: None,
            resume_session_id: None,
            session_ref: None,
        }
    }

    #[tokio::test]
    async fn attach_unknown_session_emits_lost_session_error() {
        let (st, mut rx) = {
            let (tx, rx) = tokio::sync::broadcast::channel::<String>(64);
            let fresh_agent = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx));
            (FreshOpencodeState::new(fresh_agent), rx)
        };

        st.handle_attach(attach_msg("does-not-exist")).await;

        let frame: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(frame["type"], "freshAgent.event");
        assert_eq!(frame["sessionId"], "does-not-exist");
        assert_eq!(frame["event"]["type"], "freshAgent.error");
        assert_eq!(frame["event"]["code"], "INVALID_SESSION_ID");
    }

    #[tokio::test]
    async fn attach_known_materialized_session_emits_idle_snapshot() {
        // `state_with_status_poll_and_receiver(1)` (the same fixture the working
        // busy->idle->complete test above uses) resolves the turn genuinely and quickly --
        // unlike the plain `FakeHttp`-backed `started_manager()`, whose status endpoint
        // never reports idle and would hang `run_turn` until the real 600s turn timeout.
        let (st, mut rx) = state_with_status_poll_and_receiver(1).await;

        st.handle_create(create_msg("req-attach")).await;
        let placeholder = "freshopencode-req-attach";
        st.handle_send(send_msg(placeholder, "hello")).await;
        let real_id = {
            let guard = st.sessions.lock().await;
            let session_arc = guard.get(placeholder).cloned().expect("session exists");
            let s = session_arc.lock().await;
            s.real_session_id.clone().expect("materialized after send")
        };

        // Wait for the detached turn task to actually finish before attaching, so the
        // status this test asserts on isn't racing the turn's own completion.
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let done = {
                    let guard = st.sessions.lock().await;
                    let session_arc = guard.get(&real_id).cloned().expect("session exists");
                    let s = session_arc.lock().await;
                    s.turn_task
                        .as_ref()
                        .map(|t| t.is_finished())
                        .unwrap_or(true)
                };
                if done {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the turn task finishes within the budget");

        st.handle_attach(attach_msg(&real_id)).await;

        // Drain frames until the snapshot this attach call broadcasts (turn.complete /
        // status frames from the send above may already have landed on the bus first).
        let snapshot: serde_json::Value =
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                loop {
                    let raw = rx.recv().await.expect("bus stays open");
                    let frame: serde_json::Value = serde_json::from_str(&raw).unwrap();
                    if frame["event"]["type"] == "freshAgent.session.snapshot"
                        && frame["sessionId"] == real_id
                    {
                        return frame;
                    }
                }
            })
            .await
            .unwrap_or_else(|_| panic!("no snapshot frame observed for {real_id}"));
        assert_eq!(snapshot["event"]["status"], "idle");
    }

    #[tokio::test]
    async fn session_materialized_emitted_exactly_once_across_two_sends() {
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let fresh_agent = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx));
        let (manager, _killed) = started_manager().await;
        fresh_agent.set_manager_for_test(manager).await;
        let st = FreshOpencodeState::new(fresh_agent);

        st.handle_create(create_msg("req-mat")).await;
        let _ = rx.try_recv().unwrap(); // drain freshAgent.created

        let placeholder = "freshopencode-req-mat";
        st.handle_send(send_msg(placeholder, "one")).await;
        st.handle_send(send_msg(placeholder, "two")).await;

        let mut materialized_count = 0;
        let mut send_accepted_count = 0;
        while let Ok(raw) = rx.try_recv() {
            let frame: serde_json::Value = serde_json::from_str(&raw).unwrap();
            match frame["type"].as_str() {
                Some("freshAgent.session.materialized") => materialized_count += 1,
                Some("freshAgent.send.accepted") => send_accepted_count += 1,
                _ => {}
            }
        }
        assert_eq!(
            materialized_count, 1,
            "materialized must be emitted exactly once"
        );
        assert_eq!(send_accepted_count, 2, "both sends are still accepted");
    }

    #[tokio::test]
    async fn kill_removes_session_but_does_not_terminate_the_shared_serve_child() {
        let (st, killed) = state().await;
        st.handle_create(create_msg("req-kill")).await;
        let placeholder = "freshopencode-req-kill";
        st.handle_send(send_msg(placeholder, "hello")).await;

        let session_arc = {
            let guard = st.sessions.lock().await;
            guard.get(placeholder).cloned().unwrap()
        };
        let real_id = session_arc.lock().await.real_session_id.clone().unwrap();

        st.handle_kill(FreshAgentKill {
            provider: AgentProvider::Opencode,
            session_id: real_id.clone(),
            session_type: SessionType::Freshopencode,
            cwd: None,
        })
        .await;

        assert!(
            !killed.load(Ordering::SeqCst),
            "the shared opencode serve sidecar must survive a per-session kill"
        );
        let guard = st.sessions.lock().await;
        assert!(!guard.contains_key(placeholder), "placeholder key removed");
        assert!(!guard.contains_key(&real_id), "durable key removed");
    }

    #[tokio::test]
    async fn kill_of_unknown_session_still_broadcasts_success() {
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let fresh_agent = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx));
        let st = FreshOpencodeState::new(fresh_agent);

        st.handle_kill(FreshAgentKill {
            provider: AgentProvider::Opencode,
            session_id: "does-not-exist".to_string(),
            session_type: SessionType::Freshopencode,
            cwd: None,
        })
        .await;

        let frame: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(frame["type"], "freshAgent.killed");
        assert_eq!(frame["success"], true);
    }

    #[tokio::test]
    async fn send_to_unknown_session_errors() {
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let fresh_agent = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx));
        let st = FreshOpencodeState::new(fresh_agent);

        st.handle_send(send_msg("does-not-exist", "hi")).await;

        let frame: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(frame["type"], "error");
        assert!(frame["message"]
            .as_str()
            .unwrap()
            .contains("SESSION_NOT_FOUND"));
    }

    // ── PR-3: serve-stream bridge (status / turn.complete gating) ─────────

    /// Build a [`FreshOpencodeState`] on top of [`state_with_status_poll`], returning it
    /// alongside a broadcast receiver subscribed BEFORE any handler runs (so nothing —
    /// including the very first `freshAgent.created` — is missed).
    async fn state_with_status_poll_and_receiver(
        busy_polls: usize,
    ) -> (FreshOpencodeState, tokio::sync::broadcast::Receiver<String>) {
        let (tx, rx) = tokio::sync::broadcast::channel::<String>(64);
        let fresh_agent = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx));
        let deps = ServeDeps {
            spawner: Arc::new(TrackedSpawner {
                killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            }),
            http: Arc::new(StatusPollFakeHttp::new(busy_polls)),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let config = ServeConfig {
            idle_poll_interval: Duration::from_millis(15),
            ..ServeConfig::default()
        };
        let manager = OpencodeServeManager::new(deps, config);
        manager
            .ensure_started()
            .await
            .expect("healthy fake serve starts");
        fresh_agent.set_manager_for_test(manager).await;
        (FreshOpencodeState::new(fresh_agent), rx)
    }

    #[tokio::test]
    async fn clean_turn_emits_busy_then_idle_then_one_monotonic_turn_complete() {
        let (st, mut rx) = state_with_status_poll_and_receiver(1).await;

        st.handle_create(create_msg("req-clean")).await;
        let placeholder = "freshopencode-req-clean";
        st.handle_send(send_msg(placeholder, "hello")).await;

        let mut saw_busy = false;
        let mut idle_count = 0;
        let mut complete_at: Vec<i64> = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_millis(500);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            let Ok(Ok(raw)) = tokio::time::timeout(remaining, rx.recv()).await else {
                break;
            };
            let frame: serde_json::Value = serde_json::from_str(&raw).unwrap();
            if frame["type"] != "freshAgent.event" {
                continue;
            }
            match frame["event"]["type"].as_str() {
                Some("freshAgent.session.snapshot") => match frame["event"]["status"].as_str() {
                    Some("running") => saw_busy = true,
                    Some("idle") => idle_count += 1,
                    _ => {}
                },
                Some("freshAgent.turn.complete") => {
                    complete_at.push(frame["event"]["at"].as_i64().expect("numeric at"));
                    break; // the turn's terminal frame; stop draining.
                }
                _ => {}
            }
        }

        assert!(saw_busy, "expected a running/busy session.snapshot");
        assert!(
            idle_count >= 1,
            "expected at least one idle session.snapshot, got {idle_count}"
        );
        assert_eq!(complete_at.len(), 1, "expected exactly one turn.complete");
        assert!(
            complete_at[0] > 0,
            "at must be a positive monotonic timestamp"
        );
    }

    #[tokio::test]
    async fn interrupted_turn_emits_no_turn_complete() {
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let fresh_agent = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx));
        // A generous busy-poll count so the natural idle resolution would land well AFTER
        // our interrupt (proving the interrupt -- not a lucky race -- suppresses the chime).
        let deps = ServeDeps {
            spawner: Arc::new(TrackedSpawner {
                killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            }),
            http: Arc::new(StatusPollFakeHttp::new(50)),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let config = ServeConfig {
            idle_poll_interval: Duration::from_millis(15),
            ..ServeConfig::default()
        };
        let manager = OpencodeServeManager::new(deps, config);
        manager
            .ensure_started()
            .await
            .expect("healthy fake serve starts");
        fresh_agent.set_manager_for_test(manager).await;
        let st = FreshOpencodeState::new(fresh_agent);

        st.handle_create(create_msg("req-int")).await;
        let placeholder = "freshopencode-req-int";
        st.handle_send(send_msg(placeholder, "hello")).await;

        // Interrupt promptly, long before the (deliberately slow) natural idle would land.
        tokio::time::sleep(Duration::from_millis(10)).await;
        st.handle_interrupt(FreshAgentInterrupt {
            provider: AgentProvider::Opencode,
            session_id: placeholder.to_string(),
            session_type: SessionType::Freshopencode,
            cwd: None,
        })
        .await;

        // Drain everything for a budget comfortably past where the natural idle
        // (50 busy polls * 15ms) would otherwise land, asserting no turn.complete ever
        // arrives, while an idle snapshot (from handle_interrupt itself) does.
        let mut saw_idle = false;
        let mut saw_complete = false;
        let deadline = tokio::time::Instant::now() + Duration::from_millis(300);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            let Ok(Ok(raw)) = tokio::time::timeout(remaining, rx.recv()).await else {
                break;
            };
            let frame: serde_json::Value = serde_json::from_str(&raw).unwrap();
            if frame["type"] != "freshAgent.event" {
                continue;
            }
            match frame["event"]["type"].as_str() {
                Some("freshAgent.session.snapshot") if frame["event"]["status"] == "idle" => {
                    saw_idle = true;
                }
                Some("freshAgent.turn.complete") => saw_complete = true,
                _ => {}
            }
        }

        assert!(saw_idle, "handle_interrupt must broadcast an idle status");
        assert!(
            !saw_complete,
            "an interrupted turn must never emit turn.complete"
        );
    }

    #[tokio::test]
    async fn errored_turn_emits_no_turn_complete_but_forwards_the_error() {
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let fresh_agent = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx));
        let deps = ServeDeps {
            spawner: Arc::new(TrackedSpawner {
                killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            }),
            http: Arc::new(StatusPollFakeHttp::new(2)),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let config = ServeConfig {
            idle_poll_interval: Duration::from_millis(15),
            ..ServeConfig::default()
        };
        let manager = OpencodeServeManager::new(deps, config);
        manager
            .ensure_started()
            .await
            .expect("healthy fake serve starts");
        fresh_agent.set_manager_for_test(manager.clone()).await;
        let st = FreshOpencodeState::new(fresh_agent);

        st.handle_create(create_msg("req-err")).await;
        let placeholder = "freshopencode-req-err";
        st.handle_send(send_msg(placeholder, "hello")).await;

        // Dispatch a real `session.error` SSE event through the manager (the same
        // ingestion point a real serve's EventSource sink uses) well before the
        // status-poll idle (2 busy polls * 15ms ~= 30-45ms) resolves the turn.
        tokio::time::sleep(Duration::from_millis(5)).await;
        manager.dispatch_event(freshell_opencode::ParsedServeEvent {
            kind: "session.error".to_string(),
            session_id: Some("ses_1".to_string()),
            properties: {
                let mut m = serde_json::Map::new();
                m.insert("error".to_string(), json!({ "message": "boom" }));
                m
            },
            raw: serde_json::Map::new(),
        });

        let mut saw_error = false;
        let mut saw_complete = false;
        let deadline = tokio::time::Instant::now() + Duration::from_millis(400);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            let Ok(Ok(raw)) = tokio::time::timeout(remaining, rx.recv()).await else {
                break;
            };
            let frame: serde_json::Value = serde_json::from_str(&raw).unwrap();
            if frame["type"] != "freshAgent.event" {
                continue;
            }
            match frame["event"]["type"].as_str() {
                Some("freshAgent.error") => {
                    assert_eq!(frame["event"]["message"], "boom");
                    saw_error = true;
                }
                Some("freshAgent.turn.complete") => saw_complete = true,
                _ => {}
            }
        }

        assert!(
            saw_error,
            "the session.error SSE event must be forwarded as freshAgent.error"
        );
        assert!(
            !saw_complete,
            "an errored turn must never emit turn.complete"
        );
    }

    #[test]
    fn event_frame_shapes_match_legacy_wire_contract() {
        let snapshot = serde_json::from_str::<serde_json::Value>(
            &serde_json::to_string(&event_frame("s-1", snapshot_event("s-1", "running"))).unwrap(),
        )
        .unwrap();
        assert_eq!(snapshot["type"], "freshAgent.event");
        assert_eq!(snapshot["provider"], "opencode");
        assert_eq!(snapshot["sessionType"], "freshopencode");
        assert_eq!(snapshot["sessionId"], "s-1");
        assert_eq!(snapshot["event"]["type"], "freshAgent.session.snapshot");
        assert_eq!(snapshot["event"]["sessionId"], "s-1");
        assert_eq!(snapshot["event"]["status"], "running");

        let changed = serde_json::from_str::<serde_json::Value>(
            &serde_json::to_string(&event_frame(
                "s-1",
                changed_event("s-1", "opencode-message"),
            ))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(changed["event"]["type"], "freshAgent.session.changed");
        assert_eq!(changed["event"]["reason"], "opencode-message");

        let error = serde_json::from_str::<serde_json::Value>(
            &serde_json::to_string(&event_frame("s-1", error_event("s-1", "boom"))).unwrap(),
        )
        .unwrap();
        assert_eq!(error["event"]["type"], "freshAgent.error");
        assert_eq!(error["event"]["message"], "boom");

        let complete = serde_json::from_str::<serde_json::Value>(
            &serde_json::to_string(&event_frame("s-1", turn_complete_event("s-1", 42))).unwrap(),
        )
        .unwrap();
        assert_eq!(complete["event"]["type"], "freshAgent.turn.complete");
        assert_eq!(complete["event"]["at"], 42);
    }

    #[test]
    fn now_iso_is_iso8601_millis_z() {
        let ts = now_iso();
        assert!(ts.contains('T'), "{ts}");
        assert!(ts.ends_with('Z'), "{ts}");
        assert_eq!(&ts[4..5], "-");
        assert_eq!(&ts[10..11], "T");
    }
}
