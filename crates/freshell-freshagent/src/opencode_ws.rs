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
//! **Deferred to PR-3:** bridging the serve SSE stream into `freshAgent.event` frames
//! (status snapshots + the status-guarded `freshAgent.turn.complete` chime). The turn
//! this module runs on `freshAgent.send` DOES land in the real opencode session (via
//! [`freshell_opencode::OpencodeServeManager::run_turn`]) — the pane's live-updating
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
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::Mutex as TokioMutex;

use freshell_opencode::{normalize_opencode_effort, normalize_opencode_model};
use freshell_protocol::{
    ErrorCode, ErrorMsg, FreshAgentCreate, FreshAgentCreated, FreshAgentInterrupt, FreshAgentKill,
    FreshAgentKilled, FreshAgentSend, FreshAgentSendAccepted, FreshAgentSessionMaterialized,
    ServerMessage, SessionLocator,
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
    /// concurrent `freshAgent.send` — PR-3's streaming bridge is where full turn
    /// lifecycle tracking (mirroring `adapter.ts`'s `sendQueue`) lands.
    turn_task: Option<tokio::task::JoinHandle<()>>,
}

impl FreshOpencodeState {
    /// Build the state around an existing [`FreshAgentState`] (REUSED, not duplicated),
    /// so this slice and the REST tabs slice share exactly one `opencode serve` sidecar.
    pub fn new(fresh_agent: FreshAgentState) -> Self {
        Self { fresh_agent, sessions: Arc::new(TokioMutex::new(HashMap::new())) }
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

        let session = OpencodeSession {
            placeholder_id: placeholder.clone(),
            real_session_id: None,
            cwd: msg.cwd.clone(),
            model,
            effort,
            turn_task: None,
        };
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
            session_ref: Some(SessionLocator { provider: PROVIDER.to_string(), session_id: placeholder }),
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
            self.send_error(&request_id, "SESSION_NOT_FOUND", "opencode session not found");
            return;
        };

        let mut session = session_arc.lock().await;

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

        let acked_session_id = if let Some(real_id) = session.real_session_id.clone() {
            // Already materialized: THE continuity fix — reuse it, no new session.
            real_id
        } else {
            let created = match manager.create_session(None, None, cwd.as_deref()).await {
                Ok(created) => created,
                Err(err) => {
                    self.send_error(&request_id, "OPENCODE_SESSION_CREATE_FAILED", &err.to_string());
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

            self.sessions.lock().await.insert(durable_id.clone(), session_arc.clone());

            // `freshAgent.session.materialized` (ws-handler.ts:3477-3484): placeholder ->
            // durable, emitted EXACTLY ONCE (a later send never re-enters this branch).
            self.broadcast(&ServerMessage::FreshAgentSessionMaterialized(FreshAgentSessionMaterialized {
                previous_session_id: session.placeholder_id.clone(),
                provider: PROVIDER.to_string(),
                session_id: durable_id.clone(),
                session_type: SESSION_TYPE.to_string(),
                session_ref: Some(SessionLocator { provider: PROVIDER.to_string(), session_id: durable_id.clone() }),
            }));
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
        self.broadcast(&ServerMessage::FreshAgentSendAccepted(FreshAgentSendAccepted {
            provider: PROVIDER.to_string(),
            request_id: request_id.unwrap_or_default(),
            session_id: acked_session_id,
            session_type: SESSION_TYPE.to_string(),
            cwd: route.clone(),
            submitted_turn_id: None,
        }));

        let turn_task = tokio::spawn(async move {
            // `run_turn` (freshell-opencode/serve.rs) prompts + awaits idle against the
            // REAL opencode serve session, so the reply lands in opencode's own session
            // state even though PR-3 hasn't bridged the resulting idle/turn-complete
            // signal onto the WS bus yet (see module docs).
            let _ = manager
                .run_turn(&real_id, &text, model.as_deref(), effort.as_deref(), DEFAULT_TURN_TIMEOUT, route)
                .await;
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

    // ── freshAgent.interrupt (WS) — cheap best-effort (full bridge is PR-3) ─

    /// Handle a `freshAgent.interrupt` for opencode: abort the in-flight turn task and
    /// issue a best-effort `serveManager.abort()` against the real session
    /// (`adapter.ts interrupt()` / `abortForState`). No status-snapshot broadcast yet —
    /// bridging the resulting idle status onto the WS bus is PR-3's job (see module
    /// docs); this is the cheap subset that doesn't require the streaming bridge.
    pub async fn handle_interrupt(&self, msg: FreshAgentInterrupt) {
        let session_arc = {
            let guard = self.sessions.lock().await;
            guard.get(&msg.session_id).cloned()
        };
        let Some(session_arc) = session_arc else {
            self.send_error(&None, "SESSION_NOT_FOUND", "opencode session not found");
            return;
        };

        let (real_id, route) = {
            let mut session = session_arc.lock().await;
            if let Some(task) = session.turn_task.take() {
                task.abort();
            }
            (session.real_session_id.clone(), session.cwd.clone())
        };

        if let Some(real_id) = real_id {
            let manager = self.fresh_agent.ensure_manager().await;
            let _ = manager.abort(&real_id, &route).await;
        }
    }
}

/// ISO-8601 / RFC-3339 millis-Z timestamp (matches `new Date().toISOString()`) for error
/// frames. Duplicated from `codex.rs`'s identical private helper (module-private there),
/// this crate has no shared "misc formatting" home yet — see `IMPLEMENTATION_PHILOSOPHY.md`
/// on not centralizing a one-off for a two-site duplication.
fn now_iso() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
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
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<ServeHttpResponse, String>> + Send + 'a>>
        {
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
            Ok(Endpoint { hostname: "127.0.0.1".into(), port: 1 })
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
            Ok(Box::new(TrackedProcess { killed: self.killed.clone() }))
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

    /// A started (healthy-fake-backed) manager + a flag proving whether its owned
    /// sidecar was ever killed.
    async fn started_manager() -> (OpencodeServeManager, Arc<std::sync::atomic::AtomicBool>) {
        let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let deps = ServeDeps {
            spawner: Arc::new(TrackedSpawner { killed: killed.clone() }),
            http: Arc::new(FakeHttp { next_session: AtomicUsize::new(0) }),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let config = ServeConfig { idle_poll_interval: Duration::from_millis(20), ..ServeConfig::default() };
        let mgr = OpencodeServeManager::new(deps, config);
        mgr.ensure_started().await.expect("healthy fake serve starts");
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
            guard.get(placeholder).cloned().expect("session exists after create")
        };
        let first_real_id = {
            let s = session_arc.lock().await;
            s.real_session_id.clone().expect("materialized after first send")
        };

        // Second send addressed by the PLACEHOLDER id again (the client hasn't yet
        // switched to the durable id) must reuse the SAME durable session — this is
        // the regression the AGENT-08 continuity bug produced (a fresh ses_ per send).
        st.handle_send(send_msg(placeholder, "second turn")).await;
        let second_real_id = {
            let s = session_arc.lock().await;
            s.real_session_id.clone().expect("still materialized")
        };

        assert_eq!(first_real_id, second_real_id, "second send must reuse the durable session id");
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
        assert_eq!(materialized_count, 1, "materialized must be emitted exactly once");
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
        assert!(frame["message"].as_str().unwrap().contains("SESSION_NOT_FOUND"));
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
