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
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::patch,
    Json, Router,
};
use serde_json::{json, Map, Value};
use tokio::sync::{oneshot, Mutex as TokioMutex};

use freshell_codex::launch_lifecycle::{
    allocate_loopback_port, drain_child_io, SIDECAR_START_BUDGET,
};
use freshell_codex::launch_plan::codex_sidecar_spawn_spec;
use freshell_codex::transport::{reap_owned_codex_sidecars, TungsteniteTransport};
use freshell_codex::{
    mint_ownership_id, normalize_codex_thread_status, normalize_freshcodex_effort,
    normalize_freshcodex_model, to_codex_reasoning_effort, CodexAdapterEvent, CodexAppServerClient,
    CodexAppServerError, CodexNotification, CodexStatus, CodexSubscription, StartThreadParams,
    StartTurnParams, ThreadForkParams, CODEX_SIDECAR_OWNERSHIP_ENV,
};
use freshell_protocol::{
    ErrorCode, ErrorMsg, FreshAgentAttach, FreshAgentCompact, FreshAgentCreate,
    FreshAgentCreateFailed, FreshAgentCreated, FreshAgentEvent, FreshAgentFork, FreshAgentForked,
    FreshAgentInterrupt, FreshAgentKill, FreshAgentKilled, FreshAgentSend,
    FreshAgentSessionMaterialized, ServerMessage, SessionLocator,
};
use freshell_terminal::FrameSink;

use crate::summary::{
    truncate_summary, SUMMARY_KIND_AUTHORED, SUMMARY_KIND_ECHO, TOOL_ERROR_LABEL, TOOL_RESULT_LABEL,
};
use crate::{FreshAgentCreateDedup, FreshAgentCreateOutcome, SharedPaneIdentitySink};

/// The codex fresh-agent `sessionType` (`AGENT_SESSION_TYPES.codex`).
const SESSION_TYPE: &str = "freshcodex";
/// The runtime provider (`AGENT_SESSION_TYPES.codex.provider`).
const PROVIDER: &str = "codex";
/// Default TTL for the [`FreshCodexState::dead_threads`] negative cache (CODEX-FIRST
/// triage Finding 2). Long enough to absorb a burst of retries from a client with no
/// backoff (the empirically-observed storm), short enough that a thread this process was
/// wrong about -- or that genuinely becomes resumable again -- is not stuck unresumable for
/// long.
const DEAD_THREAD_CACHE_TTL: Duration = Duration::from_secs(30);
/// Hard cap on [`FreshCodexState::dead_threads`] entries (review item 2). Bounds
/// worst-case memory for a long-lived server process that, over its lifetime, resumes
/// many distinct thread ids that turn out dead and are never queried again -- without
/// this, such entries would accumulate for the life of the process (the map's own doc
/// comment previously described this as "a small, bounded amount of long-lived
/// bookkeeping" without anything actually enforcing a bound). Enforced on insert in
/// [`FreshCodexState::mark_thread_dead`].
const DEAD_THREADS_CAP: usize = 256;

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
    /// Per-thread-id single-flight guard for [`Self::ensure_session_resumable`]: a
    /// `freshAgent.attach` (reload-rehydrate) and a `GET .../threads/...` snapshot read
    /// (`Self::snapshot_runtime_for`) can race for the SAME historical thread id (e.g. a
    /// browser reload that both re-attaches its pane's WS session AND refetches its
    /// snapshot). Without this, both would spawn their own `codex app-server` sidecar and
    /// `thread/resume` the same thread concurrently -- two owned sidecars for one logical
    /// session, one of which becomes an orphaned, un-tracked leak. Keyed by thread id;
    /// entries are never removed (a small, bounded amount of long-lived bookkeeping, no
    /// worse than `sessions` itself never shrinking for thread ids this process has ever
    /// touched).
    resuming: Arc<TokioMutex<HashMap<String, Arc<TokioMutex<()>>>>>,
    /// FIX (CODEX-FIRST triage Finding 2, sidecar spawn storm): a negative cache of thread
    /// ids this process has recently confirmed genuinely gone (`is_codex_thread_not_found`
    /// on a `thread/resume` attempt), mapped to the `Instant` the entry expires. Consulted
    /// BEFORE spawning a sidecar in every resume attempt ([`Self::ensure_session_resumable`],
    /// [`Self::ensure_session_alive`], and [`Self::handle_create_resume`]) -- without it, a
    /// client retrying `freshAgent.attach`/`freshAgent.create{resumeSessionId}` against a
    /// permanently-dead thread with no backoff spawns (and immediately kills) a real `codex
    /// app-server` subprocess on every single attempt (empirically measured: ~3 spawn/kill
    /// cycles per second, no damping). Bounded: entries expire after [`Self::dead_thread_ttl`]
    /// and are removed lazily on read, or explicitly on any later successful resume/create
    /// for that id -- so a thread this process was wrong about (or that became resumable
    /// again) is never stuck permanently unresumable.
    dead_threads: Arc<TokioMutex<HashMap<String, Instant>>>,
    /// TTL for [`Self::dead_threads`] entries. A plain field (not shared state) so tests can
    /// shrink it directly (private-field access from the `tests` submodule, same convention
    /// [`CodexSession`]'s test constructors already rely on) without needing a fake clock.
    dead_thread_ttl: Duration,
    /// `freshAgent.create` requestId dedup (parity gap fix -- see the module doc on
    /// [`crate::FreshAgentCreateDedup`]): single-flight + replay cache so a client
    /// resending the SAME `requestId` on every reconnect while a pane is
    /// `status==creating` reattaches to the ONE session it already created instead of
    /// spawning a fresh `codex app-server` sidecar per resend. Cleared for a session's
    /// entries only on an explicit `freshAgent.kill` ([`Self::handle_kill`]); an
    /// unrequested sidecar exit does NOT evict (mirrors legacy, see the type doc).
    create_dedup: Arc<FreshAgentCreateDedup<CodexCreateRecord>>,
    /// P1.13 identity-event sink (the pane-ledger bridge,
    /// [`crate::identity_sink`]). Clone-shared + set-once: the state is cloned
    /// into consumer tasks, so the `OnceLock` sits behind an `Arc`. Wired
    /// post-construction by `freshell-server` (precedent:
    /// `TerminalRegistry::set_activity_observer`).
    identity_sink: Arc<std::sync::OnceLock<SharedPaneIdentitySink>>,
    /// The per-sessionRef create/resume lease (D8 for fresh agents, Task 12) —
    /// ALWAYS ON at this runtime seam (never capability-gated). `main.rs` replaces the
    /// default with the ONE server-wide shared map via [`Self::set_session_leases`].
    leases: Arc<crate::session_lease::FreshAgentSessionLeases>,
    /// Task 13b: cross-kind liveness -- true when a live terminal PTY owns
    /// `(provider, session_id)`. Wired by `main.rs`; defaults to always-false.
    terminal_liveness: crate::TerminalLivenessProbe,
    /// Per-parent-session fork single-flight (delta-review rounds 2+3, D2-F2): the
    /// client leaves the Fork action enabled while a fork is in flight, so a rapid
    /// duplicate click would otherwise mint TWO children for one parent — once the
    /// first reply re-keys the pane and kills the parent, the second reply can no
    /// longer correlate, leaving its child (a registered sidecar + durable thread
    /// here) UNOWNED. [`Self::handle_fork`] acquires AFTER `ensure_session_alive`,
    /// under the RESOLVED parent id — on the mint-new respawn route the materialized
    /// broadcast re-keys the pane mid-flight, so the duplicate click arrives
    /// addressed to the NEW id (that route holds the clicked id too, atomically —
    /// round-3). The RAII guard releases on every terminal leg (success, refusal,
    /// and the post-archive containment alike).
    fork_in_flight: crate::InFlightRegistry,
}

/// The cached result of a completed codex `freshAgent.create`, keyed by `requestId` in
/// [`FreshCodexState::create_dedup`]. Only `session_id` is needed: every other field of
/// the `freshAgent.created` replay frame ([`FreshCodexState::handle_create`]'s replay
/// branch) is either a codex-wide constant (`PROVIDER`/`SESSION_TYPE`) or derived from
/// `session_id` itself (`sessionRef`).
#[derive(Clone)]
struct CodexCreateRecord {
    session_id: String,
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
    /// The sidecar had crashed; recovery respawned a fresh sidecar and `thread/resume`d
    /// the ORIGINAL thread id (matching `adapter.ts`'s `ensureRuntime`, `adapter.ts:762-799`
    /// -- this client's crash recovery has a real resume RPC now; see
    /// [`FreshCodexState::ensure_session_alive`]'s doc comment). The session's durable
    /// identity is unchanged -- no `freshAgent.session.materialized` broadcast -- but the
    /// sidecar/turn state is new to this connection, so callers treat it like fresh state
    /// (e.g. `handle_attach` still emits a snapshot).
    Recovered,
    /// The sidecar had crashed AND the app-server no longer has the thread (a genuine
    /// `threadNotFound` on resume, e.g. the on-disk rollout was deleted) -- recovery fell
    /// back to minting a brand-new thread on a fresh sidecar, and the session was
    /// materialized under `new_session_id`. Conversation memory for the old thread is
    /// lost; see [`FreshCodexState::ensure_session_alive`]'s doc comment for the client
    /// notification story.
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
    /// Task 13 (D8): another create/attach holds this sessionRef's lease -- the caller
    /// answers `freshAgent.error { code: "SESSION_RESERVED" }` (retryable, never lost).
    Reserved,
}

/// A codex thread this process now has a live, registered runtime for -- either it was
/// already tracked, or [`FreshCodexState::ensure_session_resumable`] just spawned a
/// sidecar and `thread/resume`d it.
struct ResumedCodexSession {
    client: Arc<CodexAppServerClient>,
    active_turn: Arc<StdMutex<Option<String>>>,
}

/// Why [`FreshCodexState::ensure_session_resumable`] could not produce a live session for
/// a requested thread id.
#[derive(Debug)]
enum ResumeSessionError {
    /// The app-server itself said this thread genuinely doesn't exist (`thread/resume`
    /// failed with a "not found"-shaped error) -- a real `FRESH_AGENT_LOST_SESSION`,
    /// distinct from an infra hiccup.
    NotFound,
    /// Spawn/WS-connect/`initialize`/`thread/resume` failed for a reason OTHER than "this
    /// thread doesn't exist" (sidecar unreachable, RPC timeout, transport error, ...) --
    /// safe to retry; the thread may still be resumable.
    Transient(String),
    /// Task 13 (D8): another create/attach holds this sessionRef's lease -- the caller
    /// answers `freshAgent.error { code: "SESSION_RESERVED" }` (retryable, never lost).
    Reserved,
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
            resuming: Arc::new(TokioMutex::new(HashMap::new())),
            dead_threads: Arc::new(TokioMutex::new(HashMap::new())),
            dead_thread_ttl: DEAD_THREAD_CACHE_TTL,
            create_dedup: Arc::new(FreshAgentCreateDedup::new()),
            identity_sink: Arc::new(std::sync::OnceLock::new()),
            leases: Arc::new(crate::session_lease::FreshAgentSessionLeases::new()),
            terminal_liveness: Arc::new(|_, _| false),
            fork_in_flight: crate::InFlightRegistry::new(),
        }
    }

    /// Wire the cross-kind terminal-liveness probe (Task 13b; called by `main.rs`
    /// before this state is cloned into the router).
    pub fn set_terminal_liveness(&mut self, probe: crate::TerminalLivenessProbe) {
        self.terminal_liveness = probe;
    }

    /// Replace the default lease map with the ONE server-wide shared map (Task 12;
    /// called by `main.rs` before this state is cloned into the router). Keys are
    /// provider-namespaced, so a default per-runtime map is semantically identical —
    /// the shared map exists for observability and Task 13b's cross-kind wiring.
    pub fn set_session_leases(
        &mut self,
        leases: Arc<crate::session_lease::FreshAgentSessionLeases>,
    ) {
        self.leases = leases;
    }

    /// Wire the P1.13 identity-event sink (set-once; later calls are no-ops).
    pub fn set_identity_sink(&self, sink: SharedPaneIdentitySink) {
        let _ = self.identity_sink.set(sink);
    }

    /// The wired identity sink, if any.
    fn identity_sink(&self) -> Option<SharedPaneIdentitySink> {
        self.identity_sink.get().cloned()
    }

    /// P1.13: write one fresh-agent binding row (FULL settings snapshot) through the
    /// identity sink. AWAITED at every identity site (the wave-A durable-before-answer
    /// policy) BEFORE that site's reply/broadcast goes out; a failed write is surfaced
    /// user-visibly ([`Self::emit_fresh_agent_error`], never warn-and-drop) and then the
    /// identity event proceeds -- a write failure never blocks it.
    #[allow(clippy::too_many_arguments)]
    async fn record_codex_binding(
        &self,
        session_id: &str,
        create_request_id: Option<&str>,
        model: &str,
        sandbox: Option<&str>,
        permission_mode: Option<&str>,
        effort: Option<&str>,
        cwd: Option<&str>,
        supersedes: Option<&str>,
    ) {
        let Some(sink) = self.identity_sink() else {
            return;
        };
        let settings = crate::identity_sink::FreshAgentSettings {
            model: if model.is_empty() {
                None
            } else {
                Some(model.into())
            },
            sandbox: sandbox.map(Into::into),
            permission_mode: permission_mode.map(Into::into),
            effort: effort.map(Into::into),
            cwd: cwd.map(Into::into),
        };
        // No-laundering guard (V7/A10): never persist an all-blank snapshot --
        // it would mask a genuine record miss forever. Real creates always carry
        // at least cwd; a supersession write always goes through (G3 linkage).
        if settings == crate::identity_sink::FreshAgentSettings::default() && supersedes.is_none() {
            return;
        }
        if let Err(e) = sink
            .record_binding(crate::identity_sink::FreshAgentBindingUpsert {
                provider: "codex".into(),
                session_id: session_id.into(),
                mode: "freshcodex".into(),
                create_request_id: create_request_id.map(Into::into),
                resolves_pending: None,
                supersedes: supersedes.map(Into::into),
                settings,
            })
            .await
        {
            tracing::warn!(error = %e, session = %session_id, "freshagent.codex.ledger_write_failed");
            self.emit_fresh_agent_error(
                session_id,
                "LEDGER_WRITE_FAILED",
                "Failed to persist this session's resume record - settings may not survive a server restart.",
            );
        }
    }

    /// Broadcast a `freshAgent.error` alarm/degradation frame (Tasks 5/6 consume this
    /// too). Wire shape (V1/A2, verified against `fresh-agent-ws.ts:182-193`):
    /// `{ "type": "freshAgent.event", "sessionId", "sessionType", "provider",
    /// "event": { "type": "freshAgent.error", "code", "message" } }` -- built on the
    /// SAME [`ServerMessage::FreshAgentEvent`] envelope [`lost_session_frame`] uses (the
    /// existing `freshAgent.error` forwarding path), so it is byte-compatible with the
    /// frozen client's banner path: top-level `sessionType`/`provider` are REQUIRED
    /// (locator resolution) and `message` is user-facing (the banner shows the message,
    /// never the code).
    fn emit_fresh_agent_error(&self, session_id: &str, code: &str, message: &str) {
        self.broadcast(&ServerMessage::FreshAgentEvent(FreshAgentEvent {
            event: json!({
                "type": "freshAgent.error",
                "sessionId": session_id,
                "code": code,
                "message": message,
            }),
            provider: PROVIDER.to_string(),
            session_id: session_id.to_string(),
            session_type: SESSION_TYPE.to_string(),
        }));
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

        // Dedup by requestId (parity gap fix -- see [`crate::FreshAgentCreateDedup`]'s
        // doc and [`Self::create_dedup`]'s field doc). Held for the WHOLE creation
        // attempt below (including the `handle_create_resume` sub-call), so concurrent
        // duplicate `create`s for the same requestId serialize instead of each spawning
        // their own sidecar.
        let _dedup_guard = match self.create_dedup.acquire_or_replay(&request_id).await {
            FreshAgentCreateOutcome::Replay(cached) => {
                self.broadcast(&ServerMessage::FreshAgentCreated(FreshAgentCreated {
                    provider: PROVIDER.to_string(),
                    request_id,
                    runtime_provider: PROVIDER.to_string(),
                    session_id: cached.session_id.clone(),
                    session_type: SESSION_TYPE.to_string(),
                    session_ref: Some(SessionLocator {
                        provider: PROVIDER.to_string(),
                        session_id: cached.session_id,
                    }),
                }));
                return;
            }
            FreshAgentCreateOutcome::Proceed(guard) => guard,
        };

        // The resume thread id: the legacy `resumeSessionId` first, else the
        // provider-matched `sessionRef` (Node parity: `runtime-manager.ts:106-108`
        // promotes the sessionRef into the adapter's resume input the same way) --
        // the canonical carrier must work standalone so the client can drop the
        // legacy duplicate.
        let requested_resume_session_id = msg
            .resume_session_id
            .clone()
            .filter(|s| !s.is_empty())
            .or_else(|| {
                msg.session_ref
                    .as_ref()
                    .filter(|r| r.provider == PROVIDER)
                    .map(|r| r.session_id.clone())
                    .filter(|s| !s.is_empty())
            });

        // P1.13 (Task 5, R1): for a resume-create the client's explicit params win and
        // the ledger record fills the gaps -- merged BEFORE normalization, so a missing
        // model recovers the recorded one instead of being rewritten to the default.
        let rec = match requested_resume_session_id.as_deref() {
            Some(resume_id) => self
                .identity_sink()
                .and_then(|s| s.load_settings("codex", resume_id))
                .unwrap_or_default(),
            None => crate::identity_sink::FreshAgentSettings::default(),
        };
        let cwd = msg.cwd.clone().or(rec.cwd);
        let raw_model = msg.model.clone().or(rec.model);
        let model = normalize_freshcodex_model(raw_model.as_deref());
        let raw_effort = msg.effort.clone().or(rec.effort);
        let effort = normalize_freshcodex_effort(Some(&model), raw_effort.as_deref());
        let sandbox = msg.sandbox.map(sandbox_wire_value).or(rec.sandbox);
        let permission_mode = msg.permission_mode.clone().or(rec.permission_mode);

        // Validate the effort maps to the codex wire vocabulary (adapter create calls
        // toCodexReasoningEffort purely to reject unsupported efforts before spawning).
        if let Err(err) = to_codex_reasoning_effort(effort.as_deref()) {
            self.fail_create(&request_id, "FRESH_AGENT_CREATE_FAILED", &err.to_string());
            return;
        }

        // FIX (CODEX-FIRST triage Finding 1): a `freshAgent.create` carrying
        // `resumeSessionId` must RESUME the existing thread -- mirroring the reference's
        // resume-first create path (`FreshAgentRuntimeManager.create`, `runtime-manager.ts:
        // 103-112`'s `usedResume` branch, which dispatches to the codex adapter's `resume()`,
        // `adapter.ts:843-869`, instead of `create()`) -- rather than unconditionally
        // minting a brand-new thread. Before this fix, `msg.resume_session_id` was never
        // read here at all: the client's lost-session recovery (which resends `create` with
        // `resumeSessionId` set, `FreshAgentView.tsx`'s `triggerRecovery`) silently produced
        // an EMPTY new conversation under a brand-new id -- connected, no error, just quiet
        // data loss.
        if let Some(resume_session_id) = requested_resume_session_id.clone() {
            // Task 13b (cross-kind liveness): a live terminal PTY owning
            // `(codex, thread)` is the one writer on that rollout -- refuse the resume
            // with the retryable loser answer; NO lease claim, NO spawn.
            if (self.terminal_liveness)(PROVIDER, &resume_session_id) {
                tracing::warn!(target: "freshell_freshagent::codex",
                    session_id = %resume_session_id, request_id = %request_id,
                    "fresh_agent_create_refused: a live terminal PTY owns this session (Task 13b cross-kind live-guard)");
                self.fail_create_session_reserved(&request_id);
                return;
            }
            // Task 12 (D8 for fresh agents): claim the per-sessionRef lease BEFORE any
            // spawn -- exactly one in-flight resume (and one live rollout writer) per
            // thread. ALWAYS ON (never capability-gated).
            // Fast-path ADOPT (V1): the thread is already live -- answer created
            // naming it, spawn nothing (base checked only the dead-thread negative
            // cache here, never the live sessions map).
            if self.has_live_session(&resume_session_id).await {
                self.adopt_live_create(&request_id, &resume_session_id)
                    .await;
                return;
            }
            let mut lease_guard: Option<crate::FreshSessionLeaseGuard> = None;
            for round in 0..2u8 {
                match self.leases.claim(
                    PROVIDER,
                    &resume_session_id,
                    &request_id,
                    crate::session_lease::now_epoch_ms(),
                ) {
                    crate::session_lease::FreshSessionClaim::Acquired => {
                        lease_guard = Some(crate::FreshSessionLeaseGuard::armed(
                            Arc::clone(&self.leases),
                            PROVIDER,
                            &resume_session_id,
                            &request_id,
                        ));
                        break;
                    }
                    crate::session_lease::FreshSessionClaim::BoundLive { .. } => {
                        // Under-lock ADOPT (the V5 TOCTOU window).
                        self.adopt_live_create(&request_id, &resume_session_id)
                            .await;
                        return;
                    }
                    crate::session_lease::FreshSessionClaim::Held { .. } => {
                        self.fail_create_session_reserved(&request_id);
                        return;
                    }
                    crate::session_lease::FreshSessionClaim::ExpiredNeedsKill {
                        pid,
                        ownership_id,
                    } => {
                        if round == 0
                            && crate::session_lease::kill_and_confirm_tree_dead(
                                pid,
                                CODEX_SIDECAR_OWNERSHIP_ENV,
                                &ownership_id,
                            )
                            .await
                        {
                            self.leases
                                .force_release_after_confirmed_kill(PROVIDER, &resume_session_id);
                            continue;
                        }
                        tracing::error!(target: "invariant", pid, session_id = %resume_session_id,
                            "fresh_agent_lease_expired_kill_unconfirmed: holding closed");
                        self.fail_create_session_reserved(&request_id);
                        return;
                    }
                }
            }
            self.handle_create_resume(
                request_id,
                resume_session_id,
                cwd,
                model,
                effort,
                sandbox,
                permission_mode,
                lease_guard,
            )
            .await;
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

        self.finish_create(
            request_id,
            thread_id,
            client,
            notifs,
            ownership_id,
            child,
            model,
            effort,
            cwd,
            sandbox,
            permission_mode,
            None,
        )
        .await;
    }

    /// The resume branch of `handle_create` (FINDING 1 -- CODEX-FIRST triage): spawn a
    /// sidecar and `thread/resume` the CALLER-SUPPLIED id (never minting a new one),
    /// registering the session under that SAME id on success. Mirrors the reference's
    /// `resume()` (`adapter.ts:843-869`): one resume attempt with the settings this create
    /// carried, no retry-without-settings (that fallback is exclusive to crash recovery,
    /// `ensure_session_alive` -- an unrelated feature this create path does not have in the
    /// reference either).
    ///
    /// On a genuine `threadNotFound` (`is_codex_thread_not_found`), mirrors the reference's
    /// fallback exactly: `FreshAgentRuntimeManager.create` (`runtime-manager.ts:103-112`)
    /// propagates ANY `resume()` failure unwrapped -- there is no mint-new fallback inside
    /// `create`, that behavior is exclusive to crash recovery -- and `ws-handler.ts:3388-3405`'s
    /// generic catch turns it into a `freshAgent.create.failed`. The thrown JS error's
    /// `.code` is the app-server's numeric JSON-RPC code (`CodexAppServerRpcError`,
    /// `client.ts:68-78`), never a string, so `ws-handler.ts:3395-3397`'s
    /// `typeof error.code === 'string'` guard never matches it -- the code is ALWAYS the
    /// generic `FRESH_AGENT_CREATE_FAILED` fallback, never a distinguishing not-found code.
    /// So: an error to the client, never a silently-minted fresh thread, and never a
    /// `lost_session_frame` (that shape is exclusive to `freshAgent.attach`). This is also
    /// the case `is_known_dead_thread` (Finding 2) short-circuits: a thread already
    /// confirmed gone within its TTL window fails the SAME way, without spawning a sidecar
    /// to re-prove it.
    #[allow(clippy::too_many_arguments)]
    async fn handle_create_resume(
        &self,
        request_id: String,
        resume_session_id: String,
        cwd: Option<String>,
        model: String,
        effort: Option<String>,
        sandbox: Option<String>,
        permission_mode: Option<String>,
        mut lease_guard: Option<crate::FreshSessionLeaseGuard>,
    ) {
        if self.is_known_dead_thread(&resume_session_id).await {
            if let Some(mut g) = lease_guard.take() {
                g.fail();
            }
            self.fail_create(
                &request_id,
                "FRESH_AGENT_CREATE_FAILED",
                &format!("codex thread {resume_session_id} not found"),
            );
            return;
        }

        let (client, notifs, ownership_id, child) = match self.spawn_sidecar(cwd.as_deref()).await {
            Ok(parts) => parts,
            Err(err) => {
                if let Some(mut g) = lease_guard.take() {
                    g.fail();
                }
                self.fail_create(&request_id, "CODEX_APP_SERVER_START_FAILED", &err);
                return;
            }
        };
        // Task 12: arm the TTL tree-kill path now that the child + its tag exist.
        if let Some(g) = lease_guard.as_mut() {
            if let Some(pid) = child.id() {
                g.set_kill_handle(pid, &ownership_id);
            }
        }

        let resume_result = client
            .resume_thread(
                &resume_session_id,
                StartThreadParams {
                    cwd: cwd.clone(),
                    model: Some(model.clone()),
                    sandbox: sandbox.clone(),
                    approval_policy: permission_mode.clone(),
                },
            )
            .await;
        let started = match resume_result {
            Ok(started) => started,
            Err(err) => {
                client.close().await;
                let mut child = child;
                let _ = child.start_kill();
                reap_owned_codex_sidecars(&ownership_id);
                // Own tree torn down above -- releasing the lease is safe.
                if let Some(mut g) = lease_guard.take() {
                    g.fail();
                }
                if is_codex_thread_not_found(&err) {
                    self.mark_thread_dead(&resume_session_id).await;
                }
                self.fail_create(&request_id, "FRESH_AGENT_CREATE_FAILED", &err.to_string());
                return;
            }
        };
        // TERM-25: never silently proceed against the wrong thread. `thread/resume`
        // answering with a different id than requested means the sidecar is sitting on a
        // thread the user did NOT ask for -- adopting it (or renaming it) would bind the
        // pane to an unrelated conversation. Reject loudly instead.
        if started.thread_id != resume_session_id {
            client.close().await;
            let mut child = child;
            let _ = child.start_kill();
            reap_owned_codex_sidecars(&ownership_id);
            if let Some(mut g) = lease_guard.take() {
                g.fail();
            }
            tracing::error!(
                requested = %resume_session_id,
                returned = %started.thread_id,
                "freshagent.codex.wrong_thread_resume_rejected"
            );
            self.fail_create(
                &request_id,
                "FRESH_AGENT_CREATE_FAILED",
                &format!(
                    "codex thread/resume returned wrong thread id {} (requested {}); \
                     refusing to adopt the wrong thread",
                    started.thread_id, resume_session_id
                ),
            );
            return;
        }
        let thread_id = resume_session_id;
        self.clear_dead_thread(&thread_id).await;

        self.finish_create(
            request_id,
            thread_id,
            client,
            notifs,
            ownership_id,
            child,
            model,
            effort,
            cwd,
            sandbox,
            permission_mode,
            lease_guard,
        )
        .await;
    }

    /// Shared tail of `handle_create` and `handle_create_resume`: register the session
    /// (notification consumer, exit-watcher, `sessions` map insert) and broadcast
    /// `freshAgent.created` (ws-handler.ts:3378). `thread_id` is either a freshly-minted
    /// `thread/start` id or a caller-supplied `thread/resume` id preserved verbatim -- this
    /// tail treats them identically, since from here on both are just "a live codex thread
    /// this process now owns runtime state for."
    #[allow(clippy::too_many_arguments)]
    async fn finish_create(
        &self,
        request_id: String,
        thread_id: String,
        client: Arc<CodexAppServerClient>,
        notifs: tokio::sync::mpsc::UnboundedReceiver<CodexNotification>,
        ownership_id: String,
        child: tokio::process::Child,
        model: String,
        effort: Option<String>,
        cwd: Option<String>,
        sandbox: Option<String>,
        permission_mode: Option<String>,
        mut lease_guard: Option<crate::FreshSessionLeaseGuard>,
    ) {
        // Task 12 EVICTION GUARD: on base this tail REPLACED a live incumbent under the
        // same threadId -- orphaning the winner's sidecar and stealing its binding
        // (strictly worse than a duplicate). If a LIVE entry already occupies the
        // threadId, do NOT insert: tear down our own sidecar and answer the create as
        // an ADOPT of the incumbent. (An `exited` incumbent is legitimately replaced --
        // that is the PR-4 lazy-respawn path.)
        let incumbent_live = self
            .sessions
            .lock()
            .await
            .get(&thread_id)
            .is_some_and(|s| !s.exited.load(Ordering::SeqCst));
        if incumbent_live {
            client.close().await;
            let mut child = child;
            let _ = child.start_kill();
            let _ = child.wait().await;
            reap_owned_codex_sidecars(&ownership_id);
            // Own tree confirmed torn down -- releasing the lease is safe.
            if let Some(mut g) = lease_guard.take() {
                g.fail();
            }
            self.adopt_live_create(&request_id, &thread_id).await;
            return;
        }

        // Legacy `activeTurnByThread` mirror for THIS session (adapter.ts:295) -- set on
        // `handle_send`, read/cleared by `handle_interrupt`, cleared by the consumer below.
        let active_turn: Arc<StdMutex<Option<String>>> = Arc::new(StdMutex::new(None));

        // ORDERING FIX (wireshape-oracle flake, ~1-in-3): the app-server can already have
        // pushed a `ThreadStarted` notification onto `notifs` (the fake app-server
        // broadcasts it synchronously right after the `thread/start` RPC response,
        // `fake-app-server.mjs:506-511`) BEFORE this task reaches the
        // `broadcast(FreshAgentCreated)` below. Spawning the consumer gates its FIRST
        // `notifs.recv()` on `created_tx` firing -- which happens only after `created` is
        // broadcast -- so the consumer can never race the created broadcast, matching
        // legacy's structural guarantee (its per-session lifecycle listener is attached
        // only AFTER `freshAgent.created` is sent, `ws-handler.ts:3378` then `:3387`, so it
        // cannot possibly observe an event that fired before it existed). The unbounded
        // `notifs` channel buffers whatever arrives in the meantime -- nothing is lost,
        // only its delivery to the consumer is deferred.
        let (created_tx, created_rx) = oneshot::channel();
        let consumer = self.spawn_consumer_after(
            notifs,
            thread_id.clone(),
            active_turn.clone(),
            Some(created_rx),
        );

        // The exit-watcher owns the sidecar child: a REQUESTED kill (via `kill_tx`) tears it
        // down with no self-heal event; an UNREQUESTED exit self-heals (adapter.ts:935-946)
        // and flips `exited` so the next send/attach lazily respawns (PR-4).
        let (kill_tx, kill_rx) = oneshot::channel();
        let exited = Arc::new(AtomicBool::new(false));
        let watcher = spawn_exit_watcher(
            child,
            ownership_id,
            thread_id.clone(),
            self.broadcast_tx.clone(),
            kill_rx,
            exited.clone(),
            Arc::clone(&self.leases),
        );

        self.sessions.lock().await.insert(
            thread_id.clone(),
            CodexSession {
                client,
                model: model.clone(),
                effort: effort.clone(),
                cwd: cwd.clone(),
                sandbox: sandbox.clone(),
                permission_mode: permission_mode.clone(),
                active_turn,
                consumer,
                kill_tx: Some(kill_tx),
                watcher,
                exited,
            },
        );

        // Task 12: bind the durable thread id to this live session + release the lease
        // in ONE lock scope. A revoked lease means we must NOT keep the session -- tear
        // down our own tree and answer failed.
        if let Some(mut g) = lease_guard.take() {
            if !g.complete(&thread_id) {
                if let Some(session) = self.sessions.lock().await.remove(&thread_id) {
                    session.consumer.abort();
                    session.client.close().await;
                    if let Some(kill_tx) = session.kill_tx {
                        let _ = kill_tx.send(());
                    }
                    let _ = session.watcher.await;
                }
                g.fail(); // own tree torn down -- reopen the key
                self.fail_create(
                    &request_id,
                    "FRESH_AGENT_CREATE_FAILED",
                    "session lease revoked during create; torn down",
                );
                return;
            }
        }

        // P1.13 identity event (Task 4): the ledger binding row for this create,
        // AWAITED before the `freshAgent.created` reply below goes out
        // (durable-before-answer). Covers both the healthy create and the
        // `handle_create_resume` (R1) path -- both funnel through this shared tail.
        self.record_codex_binding(
            &thread_id,
            Some(&request_id),
            &model,
            sandbox.as_deref(),
            permission_mode.as_deref(),
            effort.as_deref(),
            cwd.as_deref(),
            None,
        )
        .await;

        // DIAG-01: fresh-agent session lifecycle -- provider/session_id/cwd,
        // never the turn text/prompt content.
        tracing::info!(
            provider = PROVIDER,
            session_id = %thread_id,
            cwd = %cwd.as_deref().unwrap_or(""),
            "freshagent.session.created"
        );

        // Cache the completed create for requestId dedup BEFORE responding (mirrors
        // legacy's `this.createdFreshAgentByRequestId.set(...)` preceding its
        // `this.send(...)`, `ws-handler.ts:3425` before `3433`) -- a duplicate
        // `freshAgent.create` for this requestId that arrives right after this point
        // must see the cache populated, never a window where it could race past this
        // guard's release and spawn a second sidecar.
        self.create_dedup
            .record_success(
                &request_id,
                CodexCreateRecord {
                    session_id: thread_id.clone(),
                },
            )
            .await;

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

        // ORDERING FIX: release the consumer's gate now that `created` has been
        // broadcast (see the `created_tx`/`created_rx` doc above) -- any `ThreadStarted`
        // notification already buffered on `notifs` is only delivered to the consumer
        // (and thus only broadcast) from this point on.
        let _ = created_tx.send(());
    }

    /// REVIEW FIX (item 3): legacy's `freshAgent.create.failed` sends `retryable: true` on
    /// EVERY path this port's `fail_create` corresponds to -- the disabled-gate rejection
    /// (`ws-handler.ts:3334`) and the generic create-failure catch-all
    /// (`ws-handler.ts:3403`) both hardcode `retryable: true`. Legacy's ONE
    /// `retryable: false` path (`ws-handler.ts:3299`, no `freshAgentRuntimeManager`
    /// configured at all) has no Rust analogue: this state IS the manager, so that
    /// "manager absent" case never occurs here. The client reads this field to decide
    /// whether to show a retry action (`src/lib/fresh-agent-ws.ts`, `FreshAgentView.tsx`),
    /// so this was a real, user-visible gap: every Rust `fail_create` call previously sent
    /// no `retryable` field at all (serde omits `None`), silently hiding the retry button
    /// legacy always offers.
    fn fail_create(&self, request_id: &str, code: &str, message: &str) {
        self.broadcast(&ServerMessage::FreshAgentCreateFailed(
            FreshAgentCreateFailed {
                code: code.to_string(),
                message: message.to_string(),
                request_id: request_id.to_string(),
                retryable: Some(true),
            },
        ));
    }

    /// The D8 loser answer (Task 12): reuses the existing create-failed frame with the
    /// fixed reservation code — NO new protocol fields.
    fn fail_create_session_reserved(&self, request_id: &str) {
        self.fail_create(
            request_id,
            "SESSION_RESERVED",
            "Another resume for this session is in flight",
        );
    }

    /// The HAS-LIVE→ADOPT arm (Task 12, V1): answer a loser's create-with-resume with a
    /// `freshAgent.created` naming the live durable threadId under the loser's own
    /// `requestId` — no spawn, no rollout clobber.
    async fn adopt_live_create(&self, request_id: &str, thread_id: &str) {
        self.create_dedup
            .record_success(
                request_id,
                CodexCreateRecord {
                    session_id: thread_id.to_string(),
                },
            )
            .await;
        self.broadcast(&ServerMessage::FreshAgentCreated(FreshAgentCreated {
            provider: PROVIDER.to_string(),
            request_id: request_id.to_string(),
            runtime_provider: PROVIDER.to_string(),
            session_id: thread_id.to_string(),
            session_type: SESSION_TYPE.to_string(),
            session_ref: Some(SessionLocator {
                provider: PROVIDER.to_string(),
                session_id: thread_id.to_string(),
            }),
        }));
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
            // FIX-2: a resume-recovered session keeps its ORIGINAL id -- nothing for
            // `handle_send` to update, same as the already-running case.
            Ok(EnsureAliveOutcome::Recovered) => {}
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
            Err(EnsureAliveError::Reserved) => {
                // Task 13 (D8): another create/attach holds this sessionRef -- the
                // retryable non-lost error channel; the client re-drive converges.
                self.emit_fresh_agent_error(
                    &session_id,
                    "SESSION_RESERVED",
                    "Another resume for this session is in flight",
                );
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

        // DIAG-01: the turn was accepted by the sidecar -- session_id + turn
        // id only, never the submitted text/prompt.
        tracing::info!(
            provider = PROVIDER,
            session_id = %session_id,
            turn = %submitted_turn_id,
            "freshagent.send.accepted"
        );

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
            retry_after_ms: None,
            terminal_exit_code: None,
            terminal_id: None,
            live_terminal_id: None,
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

    // ── freshAgent.compact (WS, AGENT-04) ────────────────────────────────────

    /// Handle a `freshAgent.compact` for codex: issue the app-server's REAL compact RPC
    /// (`thread/compact/start`, 0.147.0) — NEVER a `/compact` user-turn fallback
    /// (fresh-eyes round-2 F5). The schema's params are `{threadId}` ONLY, so the
    /// client's `instructions` are DELIBERATELY DROPPED (upstream limitation).
    /// Awaiting the `Record<string, never>` response is merely the acceptance edge: the
    /// compact turn's busy→idle lifecycle and its status-gated `freshAgent.turn.complete`
    /// chime ride THIS session's existing notification consumer
    /// ([`reduce_notification`]), matching the PROBED 0.147.0 flow
    /// (`thread/status/changed{active}` → `turn/started` → items/token-usage →
    /// `thread/status/changed{idle}` → `turn/completed{turn.status:'completed'}`; NO
    /// `thread/compacted` notification exists in the success flow, so no new
    /// `CodexStatus` is needed). Concurrency gate: a BEST-EFFORT refusal while a turn
    /// is tracked active (`active_turn` set) — a concurrent send or a rapid second
    /// Compact click can slip past it, in which case the app-server's rejection is
    /// the backstop (surfaced as `CODEX_COMPACT_FAILED`). Every failure path is LOUD
    /// via the nested `freshAgent.error` banner envelope (a request-less top-level
    /// `error` frame never reaches the frozen client's pane surface).
    ///
    /// Whole-branch-review M-2: [`Self::ensure_session_alive`] runs FIRST — the
    /// [`Self::handle_send`] precedent, and legacy's `ensureRuntime(sessionId, settings)`
    /// before compact (`adapter.ts:1030`) — so a crash-stale sidecar (kept mapped by the
    /// self-heal design BY DESIGN) transparently respawns instead of the click dying
    /// loudly against a dead connection; genuinely unrespawnable sessions keep their LOUD
    /// `CODEX_RESPAWN_FAILED`/`SESSION_RESERVED` legs. Review M-1: an untracked session
    /// answers the nested lost-session `INVALID_SESSION_ID` envelope (codex fork's own
    /// unknown-parent shape, legacy `requireOrRecoverSession` →
    /// `FreshAgentLostSessionError` parity) so the pane engages `markSessionLost`
    /// recovery rather than showing a dead-end banner.
    pub async fn handle_compact(&self, msg: FreshAgentCompact) {
        let mut session_id = msg.session_id.clone();

        match self.ensure_session_alive(&session_id).await {
            Ok(EnsureAliveOutcome::AlreadyRunning) => {}
            // A resume-recovered session keeps its ORIGINAL id — nothing to re-key,
            // same as the already-running case.
            Ok(EnsureAliveOutcome::Recovered) => {}
            Ok(EnsureAliveOutcome::Respawned { new_session_id }) => {
                // Recovery minted a NEW thread (the old rollout was genuinely gone; the
                // client was told via the materialized broadcast) — compact the
                // respawned session.
                session_id = new_session_id;
            }
            Err(EnsureAliveError::NotFound) => {
                // Review M-1: the lost-session shape (codex fork's own unknown-parent
                // leg, legacy `requireOrRecoverSession` → `FreshAgentLostSessionError`
                // parity) — `INVALID_SESSION_ID` engages the client's `markSessionLost`
                // recovery. Broadcast: compact frames carry no requestId, so a top-level
                // `error` frame would never reach any pane.
                self.broadcast(&lost_session_frame(&session_id));
                return;
            }
            Err(EnsureAliveError::RespawnFailed(err)) => {
                self.emit_fresh_agent_error(&session_id, "CODEX_RESPAWN_FAILED", &err);
                return;
            }
            Err(EnsureAliveError::Reserved) => {
                // Task 13 (D8) discipline, mirrored from handle_send: another
                // create/attach holds this sessionRef — retryable, never lost.
                self.emit_fresh_agent_error(
                    &session_id,
                    "SESSION_RESERVED",
                    "Another resume for this session is in flight",
                );
                return;
            }
        }

        let looked_up = {
            let guard = self.sessions.lock().await;
            guard
                .get(&session_id)
                .map(|s| (s.client.clone(), s.active_turn.clone()))
        };
        let Some((client, active_turn)) = looked_up else {
            // TOCTOU: a kill can land between ensure-alive and this lookup — the loud
            // lost-session leg, never silence.
            self.broadcast(&lost_session_frame(&session_id));
            return;
        };

        if active_turn.lock().expect("active_turn mutex").is_some() {
            self.emit_fresh_agent_error(
                &session_id,
                "CODEX_COMPACT_FAILED",
                &format!(
                    "Codex session {session_id} has an active turn; compact it after the turn completes."
                ),
            );
            return;
        }

        if let Err(err) = client.compact_thread(&session_id).await {
            self.emit_fresh_agent_error(&session_id, "CODEX_COMPACT_FAILED", &err.to_string());
        }
    }

    // ── freshAgent.fork (WS, AGENT-07) ───────────────────────────────────────

    /// Handle a `freshAgent.fork` for codex: `thread/fork` on the PARENT's app-server,
    /// then move the child onto its OWN sidecar via the VALIDATED (LB-01, real 0.147.0
    /// probe) while-alive handoff — **archive on parent → spawn the child sidecar →
    /// unarchive on child → resume on child**. A direct cross-process `thread/resume`
    /// while the parent owns the child is rejected outright (`-32600 "thread … already
    /// has an active writer"`; thread-writer locks under CODEX_HOME), and a post-`fork`
    /// `result.thread.turns` keeps full history because 0.147.0 removed `excludeTurns`
    /// from the schema (it is NEVER sent here).
    ///
    /// Deliberate divergence from legacy: Node pins the child to the PARENT's
    /// app-server connection (`adapter.ts:1070` `rememberRuntimeThread`); this port
    /// registers the child on its own sidecar, preserving the one-thread-per-sidecar
    /// invariant (the pane kills the parent immediately after `forked`; a resumed child
    /// on a killed parent's connection would die with it — here the child owns its
    /// sidecar, and post-owner-exit resume was probed to work, SIGKILL stale locks
    /// included).
    ///
    /// Deliberate override narrowing vs. legacy: `input` overrides ONLY `cwd`/`model`
    /// — the legacy adapter also honored `input.sandbox`/`input.permissionMode`
    /// (`adapter.ts:1062-1067`); those are NOT honored here (the client's fork frame
    /// never sends them — it carries only `input.atTurnId`).
    ///
    /// Whole-branch-review M-2: [`Self::ensure_session_alive`] runs FIRST — legacy's
    /// `ensureRuntime(sessionId, settings)` before fork (`adapter.ts:1056`), the
    /// [`Self::handle_send`]/[`Self::handle_compact`] precedent — so a crash-stale parent
    /// (kept mapped by the self-heal design BY DESIGN) transparently respawns and the
    /// fork proceeds against the RESUMED thread, rather than failing the click loudly
    /// against a dead connection. Loud legs remain for genuinely unrespawnable
    /// (`RespawnFailed`) or leased (`Reserved`) parents. Adaptation for the
    /// `Respawned` outcome: the old rollout was genuinely gone, so the fork proceeds
    /// against the newly-minted thread id (the old id no longer names anything) — and every
    /// post-resolution reply/error below keys to the RESOLVED id (`parent_id`, == the
    /// clicked id on AlreadyRunning/Recovered): the mint-new respawn broadcasts
    /// `freshAgent.session.materialized{OLD→NEW}` DURING ensure-alive, so the frozen client
    /// has ALREADY re-keyed the pane's `sessionId` to the new id and deleted the old
    /// session record before any fork frame can arrive (whole-branch fix review F-1). A
    /// reply keyed to the clicked old id would be DROPPED by the pane's ANDed
    /// requestId+parentSessionId fork correlation (`FreshAgentView.tsx`), and a nested
    /// error keyed old would ENSURE-create a phantom deleted-id record whose `lastError`
    /// no pane reads. Only the pre-resolution legs below (`NotFound`/`RespawnFailed`/
    /// `Reserved`) address `msg.session_id` — no materialized broadcast has occurred there.
    /// The lease-`BoundLive` Respawned corner (a contender bound the durable id to a
    /// DIFFERENT live key before this call claimed it) follows the same resolved-id keying —
    /// uniform with [`Self::handle_send`]/[`Self::handle_compact`]: replies address the live
    /// session the fork actually ran against.
    ///
    /// Delta-review round 3: the resolved-id keying principle extends to the D2-F2
    /// fork in-flight guard itself. The guard acquires AFTER ensure-alive, under the
    /// RESOLVED parent id (plus the clicked id alongside it on the mint-new route) —
    /// keyed only to the clicked id it never collides with the duplicate click the
    /// re-keyed pane emits under the NEW id while this fork is parked mid-RPC, and
    /// both forks would mint children whose replies race the pane's createRequestId
    /// re-key + parent-kill (the loser leaves its child sidecar + durable thread
    /// unowned).
    ///
    /// Fork is a request/response op answered ON THE REQUESTING CONNECTION
    /// (`reply_sink`, the opencode fork arm's shape): every failure path — including
    /// the REVIEWED post-archive containment (fresh-eyes F6) — replies a nested
    /// `freshAgent.error`, so a Fork click never dies silently. After the child is
    /// archived on the parent, ANY later failure additionally BEST-EFFORT
    /// `thread/unarchive`s the child on the PARENT client (its own error is ignored —
    /// the parent may be mid-kill), restoring the child's original visibility.
    pub async fn handle_fork(&self, msg: FreshAgentFork, reply_sink: FrameSink) {
        let parent_id = match self.ensure_session_alive(&msg.session_id).await {
            Ok(EnsureAliveOutcome::AlreadyRunning) | Ok(EnsureAliveOutcome::Recovered) => {
                // A resume-recovered parent keeps its ORIGINAL id.
                msg.session_id.clone()
            }
            Ok(EnsureAliveOutcome::Respawned { new_session_id }) => new_session_id,
            Err(EnsureAliveError::NotFound) => {
                // Legacy throws FreshAgentLostSessionError on an unknown parent; the port
                // answers the same lost-session shape on the requesting connection so the
                // client's recovery path engages.
                reply_sink(lost_session_frame(&msg.session_id));
                return;
            }
            Err(EnsureAliveError::RespawnFailed(err)) => {
                reply_sink(fork_error_frame(&msg.session_id, &err));
                return;
            }
            Err(EnsureAliveError::Reserved) => {
                // Task 13 (D8) discipline: retryable, never lost — answered on the
                // requesting sink like every other fork failure.
                reply_sink(fork_error_frame_with_code(
                    &msg.session_id,
                    "SESSION_RESERVED",
                    "Another resume for this session is in flight",
                ));
                return;
            }
        };

        // D2-F2 single-flight, keyed to the RESOLVED parent id (delta-review round
        // 3): a rapid duplicate Fork click for the same parent must never mint a
        // second child — the first reply's re-key + parent-kill leaves the second
        // reply uncorrelatable and its child/sidecar/thread unowned. Acquisition
        // happens AFTER ensure-alive because the respawn the fork may trigger
        // MINT-NEWS the parent's id: the materialized broadcast re-keys the pane
        // mid-flight, so the duplicate click arrives addressed to the NEW id — a
        // guard holding only the clicked id (the round-2 shape) never collides with
        // it. The mint-new route additionally holds the CLICKED id for the fork's
        // duration: `try_acquire_pair` is atomic under the registry lock, so neither
        // key-space admits a racing Fork while this one is parked. The refusal
        // answers on the requesting sink keyed to the RESOLVED id (the F-1
        // post-resolution keying principle, identical to every failure leg below);
        // the RAII guard releases on EVERY terminal path (success, refusal legs,
        // and the post-archive containment alike), so a refreshed click can retry
        // once this fork settles.
        let _fork_guard = if parent_id == msg.session_id {
            let Some(guard) = self.fork_in_flight.try_acquire(&parent_id) else {
                reply_sink(fork_error_frame(
                    &parent_id,
                    &format!("fork already in progress for {parent_id}"),
                ));
                return;
            };
            guard
        } else {
            let Some(guard) = self
                .fork_in_flight
                .try_acquire_pair(&parent_id, &msg.session_id)
            else {
                reply_sink(fork_error_frame(
                    &parent_id,
                    &format!("fork already in progress for {parent_id}"),
                ));
                return;
            };
            guard
        };

        let looked_up = {
            let guard = self.sessions.lock().await;
            guard.get(&parent_id).map(|s| {
                (
                    s.client.clone(),
                    s.model.clone(),
                    s.effort.clone(),
                    s.cwd.clone(),
                    s.sandbox.clone(),
                    s.permission_mode.clone(),
                )
            })
        };
        let Some((
            parent_client,
            parent_model,
            parent_effort,
            parent_cwd,
            parent_sandbox,
            parent_permission_mode,
        )) = looked_up
        else {
            // TOCTOU: a kill can land between ensure-alive and this lookup — the loud
            // lost-session leg, never silence. Keyed to the RESOLVED parent id (F-1):
            // post-resolve, the client no longer tracks the clicked id on the mint-new
            // route.
            reply_sink(lost_session_frame(&parent_id));
            return;
        };

        // Effective fork params: the parent's stored settings (model/effort/cwd/
        // sandbox/permission_mode), with `input` overriding ONLY cwd/model (the legacy
        // adapter spread, narrowed per the Task-6 plan). `lastTurnId` comes from
        // `input.atTurnId` with the synthetic `:row-<digits>` split suffix stripped
        // (the snapshot's split turn ids vs. codex's raw provider turn ids — round-3
        // F6, `build_codex_turn_json`).
        let input = msg.input.as_ref();
        let input_str = |key: &str| {
            input
                .and_then(|v| v.get(key))
                .and_then(Value::as_str)
                .map(str::to_string)
        };
        let eff_cwd = input_str("cwd").or(parent_cwd);
        let eff_model = input_str("model").unwrap_or(parent_model);
        let last_turn_id = input_str("atTurnId").map(|id| strip_codex_row_suffix(&id).to_string());

        let fork_result = match parent_client
            .fork_thread(ThreadForkParams {
                // The RESOLVED parent id (post ensure-alive): identical to the clicked
                // id for already-running/resume-recovered parents, the newly-minted
                // thread id for the memory-lost respawn fallback.
                thread_id: parent_id.clone(),
                last_turn_id,
                model: Some(eff_model.clone()),
                cwd: eff_cwd.clone(),
                approval_policy: parent_permission_mode.clone(),
                sandbox: parent_sandbox.clone(),
            })
            .await
        {
            Ok(result) => result,
            Err(err) => {
                // e.g. the PROBED empty-parent rejection (`-32600 "no rollout found
                // for thread id"`). No state changes on this path. Keyed to the
                // RESOLVED parent id (F-1).
                reply_sink(fork_error_frame(&parent_id, &err.to_string()));
                return;
            }
        };
        let child_id = fork_result
            .get("thread")
            .and_then(|t| t.get("id"))
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .map(str::to_string);
        let Some(child_id) = child_id else {
            // A pathological 200 without a usable thread.id — never register or
            // repoint the pane at a garbage child (the opencode malformed-id guard's
            // sibling).
            reply_sink(fork_error_frame(
                &parent_id,
                &format!(
                    "codex thread/fork of session {} returned a malformed response: missing thread \"id\".",
                    parent_id
                ),
            ));
            return;
        };

        // Release the child's writer lock on the parent so the child sidecar can own
        // it. An archive failure leaves the child attached to the PARENT connection
        // (still usable there; no handoff was attempted), so nothing more happens.
        if let Err(err) = parent_client.archive_thread(&child_id).await {
            reply_sink(fork_error_frame(&parent_id, &err.to_string()));
            return;
        }

        // ── post-archive (failure containment applies to every step below) ──
        let child_parts = match self.spawn_sidecar(eff_cwd.as_deref()).await {
            Ok(parts) => parts,
            Err(err) => {
                self.fail_fork_after_archive(
                    &parent_client,
                    &child_id,
                    &parent_id,
                    &reply_sink,
                    &err,
                )
                .await;
                return;
            }
        };
        let (child_client, child_notifs, child_ownership_id, mut child_proc) = child_parts;

        if let Err(err) = child_client.unarchive_thread(&child_id).await {
            shut_down_fork_child(&child_client, &mut child_proc, &child_ownership_id).await;
            self.fail_fork_after_archive(
                &parent_client,
                &child_id,
                &parent_id,
                &reply_sink,
                &err.to_string(),
            )
            .await;
            return;
        }

        let resumed = child_client
            .resume_thread(
                &child_id,
                StartThreadParams {
                    cwd: eff_cwd.clone(),
                    model: Some(eff_model.clone()),
                    sandbox: parent_sandbox.clone(),
                    approval_policy: parent_permission_mode.clone(),
                },
            )
            .await;
        let resumed = match resumed {
            Ok(resumed) => resumed,
            Err(err) => {
                shut_down_fork_child(&child_client, &mut child_proc, &child_ownership_id).await;
                self.fail_fork_after_archive(
                    &parent_client,
                    &child_id,
                    &parent_id,
                    &reply_sink,
                    &err.to_string(),
                )
                .await;
                return;
            }
        };
        // TERM-25's wrong-thread guard, on the child's own connection.
        if resumed.thread_id != child_id {
            let message = format!(
                "codex thread/resume returned wrong thread id {} (expected {child_id}); \
                 refusing to adopt the wrong thread",
                resumed.thread_id
            );
            shut_down_fork_child(&child_client, &mut child_proc, &child_ownership_id).await;
            self.fail_fork_after_archive(
                &parent_client,
                &child_id,
                &parent_id,
                &reply_sink,
                &message,
            )
            .await;
            return;
        }

        // Register the child on its OWN sidecar (the shared registration tail, the
        // ensure_session_resumable shape), inheriting the parent's settings.
        self.register_live_session(
            &child_id,
            child_client,
            child_notifs,
            child_ownership_id,
            child_proc,
            eff_model.clone(),
            parent_effort.clone(),
            eff_cwd.clone(),
            parent_sandbox.clone(),
            parent_permission_mode.clone(),
        )
        .await;

        // P1.13: the child's binding row, AWAITED before the forked reply
        // (durable-before-answer). Fork is not a create: no create_request_id.
        self.record_codex_binding(
            &child_id,
            None,
            &eff_model,
            parent_sandbox.as_deref(),
            parent_permission_mode.as_deref(),
            parent_effort.as_deref(),
            eff_cwd.as_deref(),
            None,
        )
        .await;

        // DIAG-01: lifecycle metadata only.
        tracing::info!(
            provider = PROVIDER,
            session_id = %child_id,
            parent_session_id = %parent_id,
            "freshagent.session.forked"
        );

        // Keyed to the RESOLVED parent id (F-1): the pane re-keyed to it on the
        // mint-new materialized broadcast, so its ANDed requestId+parentSessionId
        // correlation only matches THIS id.
        reply_sink(ServerMessage::FreshAgentForked(FreshAgentForked {
            request_id: msg.request_id.clone(),
            parent_session_id: parent_id.clone(),
            session_id: child_id.clone(),
            session_type: SESSION_TYPE.to_string(),
            provider: PROVIDER.to_string(),
            runtime_provider: PROVIDER.to_string(),
            session_ref: Some(SessionLocator {
                provider: PROVIDER.to_string(),
                session_id: child_id,
            }),
        }));
    }

    /// REVIEWED post-archive failure containment (fresh-eyes F6): after the child was
    /// archived on the parent, ANY later failure (child-sidecar spawn, child
    /// unarchive/resume) (a) replies the nested `freshAgent.error` on the requesting
    /// sink with the failing step's text AND (b) BEST-EFFORT `thread/unarchive`s the
    /// child on the PARENT client, restoring the child's original visibility. The
    /// unarchive's own error is IGNORED — the parent may be mid-kill — and the child
    /// stays recoverable via post-owner-exit resume.
    async fn fail_fork_after_archive(
        &self,
        parent_client: &CodexAppServerClient,
        child_id: &str,
        session_id: &str,
        reply_sink: &FrameSink,
        message: &str,
    ) {
        reply_sink(fork_error_frame(session_id, message));
        let _ = parent_client.unarchive_thread(child_id).await;
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
        // Task 12: an explicitly-killed session must reopen its durable id (the watcher
        // also clears it; idempotent -- this covers watcher-less test sessions too).
        self.leases.clear_binding(PROVIDER, &session_id);

        // Explicit kill evicts this session's requestId dedup cache entries (mirrors
        // `clearFreshAgentCreateCachesForSession`, `ws-handler.ts:1044-1050`, called from
        // `ws-handler.ts:3673`) -- an EXPLICIT kill means a later duplicate `create` for
        // the same requestId must genuinely mint a fresh session, not replay the one just
        // killed. An UNREQUESTED sidecar exit does NOT reach this path (see
        // [`crate::FreshAgentCreateDedup`]'s doc).
        self.create_dedup
            .clear_for_session(|record| record.session_id == session_id)
            .await;

        self.broadcast(&ServerMessage::FreshAgentKilled(FreshAgentKilled {
            provider: PROVIDER.to_string(),
            session_id,
            session_type: SESSION_TYPE.to_string(),
            success: true,
        }));
    }

    // ── freshAgent.attach (reload-rehydrate, PR-4) ──────────────────────────

    /// Reconcile liveness probe (campaign §4.3, Task 13): is this thread id
    /// tracked in the sessions map with a sidecar that has NOT exited? The
    /// exited check matters — a crashed sidecar stays mapped for lazy respawn
    /// ([`Self::ensure_session_alive`]), but it is not attach-ably live.
    pub async fn has_live_session(&self, session_id: &str) -> bool {
        let guard = self.sessions.lock().await;
        guard
            .get(session_id)
            .is_some_and(|s| !s.exited.load(Ordering::SeqCst))
    }

    /// Handle a `freshAgent.attach` for codex (reload-rehydrate). Decision table:
    ///
    /// | State | Action |
    /// |---|---|
    /// | tracked, sidecar alive | no-op -- NO frame (wire-shape parity, see below) |
    /// | tracked, sidecar exited | crash-recovery respawn ([`Self::ensure_session_alive`]) |
    /// | NOT tracked, thread resumes | register it (THE FIX) + emit an idle snapshot |
    /// | NOT tracked, thread genuinely missing | `lost_session_frame` (`INVALID_SESSION_ID`) |
    /// | NOT tracked, transient resume failure | `CODEX_ATTACH_RESUME_FAILED` error |
    ///
    /// Attach always preserves the CALLER's id for the not-tracked branch -- only the
    /// crash-recovery respawn path mints a new thread id (an existing, unrelated
    /// invariant). Before this fix, ANY id outside the live in-memory map -- including a
    /// perfectly healthy historical session from a page reload or a fresh-agent pane that
    /// outlived a server restart -- unconditionally hit `INVALID_SESSION_ID`, which the
    /// client folds into `markSessionLost` and abandons the durable session entirely
    /// (`fresh-agent-ws.ts:326-328`). Mirroring [`Self::snapshot_runtime_for`]'s
    /// ensure-runtime-on-demand behavior here is what makes restore actually restore.
    ///
    /// WIRE-SHAPE PARITY (fresh-agent differential capture,
    /// `test/unit/port/oracle/freshagent-wireshape-differential.test.ts`): the tracked +
    /// sidecar-alive branch used to UNCONDITIONALLY re-emit a `freshAgent.session.snapshot`
    /// on every attach, even when nothing changed. The reference's `attach()`
    /// (`server/fresh-agent/adapters/codex/adapter.ts:871-874`) is a pure no-op for this
    /// case -- it only remembers thread settings and returns the locator; it never pushes an
    /// event. Its `subscribe()` (`adapter.ts:875-946`) likewise never proactively pushes a
    /// CURRENT snapshot on (re-)subscription -- it only reacts to FUTURE thread-lifecycle /
    /// turn-completed notifications. The differential capture proved this: driving the
    /// identical `create -> send -> attach` sequence against both servers produced
    /// byte-identical frames through the turn-complete chime, then the Rust port alone
    /// emitted one EXTRA `freshAgent.event{event.type:'freshAgent.session.snapshot'}` frame
    /// after `attach` that the original never sends. Removed to match: the respawn (crash
    /// recovery) and not-tracked-resume branches below are UNCHANGED and still emit their
    /// snapshot, because those represent genuinely new state the client has never observed
    /// (a new thread id, or a session this connection is only now discovering) -- not an
    /// unconditional repeat of already-known state.
    pub async fn handle_attach(&self, msg: FreshAgentAttach) {
        let tracked = self.sessions.lock().await.contains_key(&msg.session_id);

        let (session_id, active_turn_present, should_emit_snapshot) = if tracked {
            let (resolved_id, should_emit_snapshot) =
                match self.ensure_session_alive(&msg.session_id).await {
                    Ok(EnsureAliveOutcome::AlreadyRunning) => (msg.session_id.clone(), false),
                    // FIX-2: a resume-recovered session keeps its ORIGINAL id, but the
                    // sidecar/turn state is new to this connection (memory MAY have moved,
                    // an in-flight turn is gone, etc) -- unlike the plain-tracked-and-alive
                    // no-op case above, this genuinely-new state DOES warrant a fresh
                    // snapshot, same as the not-tracked-resume and mint-new-respawn
                    // branches below.
                    Ok(EnsureAliveOutcome::Recovered) => (msg.session_id.clone(), true),
                    Ok(EnsureAliveOutcome::Respawned { new_session_id }) => (new_session_id, true),
                    Err(EnsureAliveError::NotFound) => {
                        // Raced away between the `tracked` check and here (e.g. a concurrent
                        // kill) -- fall back to the same "not tracked" handling a plain miss
                        // would get.
                        self.broadcast(&lost_session_frame(&msg.session_id));
                        return;
                    }
                    Err(EnsureAliveError::RespawnFailed(err)) => {
                        self.send_error(&None, "CODEX_ATTACH_RESPAWN_FAILED", &err);
                        return;
                    }
                    Err(EnsureAliveError::Reserved) => {
                        // Task 13 (D8): loser answer -- retryable, never lost.
                        self.emit_fresh_agent_error(
                            &msg.session_id,
                            "SESSION_RESERVED",
                            "Another resume for this session is in flight",
                        );
                        return;
                    }
                };
            let active_turn_present = {
                let guard = self.sessions.lock().await;
                guard
                    .get(&resolved_id)
                    .map(|s| s.active_turn.lock().expect("active_turn mutex").is_some())
                    .unwrap_or(false)
            };
            (resolved_id, active_turn_present, should_emit_snapshot)
        } else {
            match self
                .ensure_session_resumable(&msg.session_id, msg.cwd.as_deref())
                .await
            {
                Ok(resumed) => {
                    let active_turn_present = resumed
                        .active_turn
                        .lock()
                        .expect("active_turn mutex")
                        .is_some();
                    (msg.session_id.clone(), active_turn_present, true)
                }
                Err(ResumeSessionError::NotFound) => {
                    self.broadcast(&lost_session_frame(&msg.session_id));
                    return;
                }
                Err(ResumeSessionError::Transient(err)) => {
                    self.send_error(&None, "CODEX_ATTACH_RESUME_FAILED", &err);
                    return;
                }
                Err(ResumeSessionError::Reserved) => {
                    // Task 13 (D8): loser answer -- retryable, never lost.
                    self.emit_fresh_agent_error(
                        &msg.session_id,
                        "SESSION_RESERVED",
                        "Another resume for this session is in flight",
                    );
                    return;
                }
            }
        };

        if !should_emit_snapshot {
            return;
        }

        let status = if active_turn_present {
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
    /// exit-watcher flipped [`CodexSession::exited`] (a crash/disconnect).
    ///
    /// FIX-2 (codex-first triage): this client DOES have a `thread/resume` RPC
    /// ([`CodexAppServerClient::resume_thread`], added for [`Self::ensure_session_resumable`]'s
    /// historical-thread path) -- the doc comment that used to live here claiming otherwise
    /// was stale. Recovery is resume-first now, matching the reference's `ensureRuntime`
    /// (`adapter.ts:762-802`, via `toCodexResumeInput`, `adapter.ts:151-162`): respawn a fresh
    /// sidecar, then `thread/resume` the ORIGINAL `session_id` (passing this session's stored
    /// `cwd`/`model`/`sandbox`/`permissionMode`, mirroring `toCodexResumeInput`'s "forward
    /// what we have"), and re-register the recovered runtime under the SAME id -- no
    /// `freshAgent.session.materialized` broadcast, because the durable identity never
    /// changed and conversation memory survives (this is the actual crash-recovery bug fix:
    /// the OLD mint-new path silently discarded the model's memory of the conversation).
    ///
    /// If the app-server rejects the resume WITH those settings for any reason other than a
    /// genuine "thread not found" (a stale/invalid model or sandbox value, say), one retry is
    /// made with NO settings at all -- `handle_send`'s own "re-normalize on send" already
    /// re-applies the real settings on the next turn, so a resume succeeding with defaults is
    /// strictly better than failing over a value we can't currently validate.
    ///
    /// Only a genuine `threadNotFound` on resume ([`is_codex_thread_not_found`]) falls back to
    /// the ORIGINAL mint-new-thread behavior ([`Self::respawn_as_new_thread_after_crash`]):
    /// there is truly no thread left to resume, so a fresh one is minted and materialized
    /// under a new id, same as before -- conversation memory for the old thread is genuinely
    /// lost in that (rare) case.
    ///
    /// Single-flighted per session id via [`Self::resuming`] (the SAME per-thread-id lock map
    /// [`Self::ensure_session_resumable`] uses): a `freshAgent.send` and a `freshAgent.attach`
    /// racing on the SAME crashed session must respawn exactly once, not twice. Callers
    /// (`handle_send`/`handle_attach`) only need the returned id for anything session-scoped
    /// afterward when the outcome is [`EnsureAliveOutcome::Respawned`] -- for
    /// [`EnsureAliveOutcome::Recovered`], `session_id` is unchanged.
    async fn ensure_session_alive(
        &self,
        session_id: &str,
    ) -> Result<EnsureAliveOutcome, EnsureAliveError> {
        let (cwd, session_model, session_effort, session_sandbox, session_permission_mode) = {
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

        // P1.13 (Task 5, R2): a blank stored model means this registration came from a
        // settings-less resume (a record miss at R3 time) -- fall back to the ledger
        // record so crash recovery doesn't silently respawn onto defaults.
        let (model, sandbox, permission_mode, effort) = if session_model.is_empty() {
            let rec = self
                .identity_sink()
                .and_then(|s| s.load_settings("codex", session_id))
                .unwrap_or_default();
            (
                rec.model.unwrap_or_default(),
                rec.sandbox,
                rec.permission_mode,
                rec.effort,
            )
        } else {
            (
                session_model,
                session_sandbox,
                session_permission_mode,
                session_effort,
            )
        };

        // Single-flight: acquire (and possibly create) this session id's per-thread lock,
        // shared with `ensure_session_resumable`'s map so a concurrent historical-thread
        // resume and a crash recovery for the SAME id can't race either.
        let per_thread_lock = {
            let mut guard = self.resuming.lock().await;
            guard
                .entry(session_id.to_string())
                .or_insert_with(|| Arc::new(TokioMutex::new(())))
                .clone()
        };
        let _permit = per_thread_lock.lock().await;

        // Double-checked: a concurrent caller (e.g. a racing `freshAgent.send` and
        // `freshAgent.attach` for the same session) may have already completed recovery
        // while this call waited for the per-thread lock above.
        {
            let guard = self.sessions.lock().await;
            match guard.get(session_id) {
                Some(session) if !session.exited.load(Ordering::SeqCst) => {
                    return Ok(EnsureAliveOutcome::AlreadyRunning);
                }
                Some(_) => {}
                None => return Err(EnsureAliveError::NotFound),
            }
        }

        // Task 13b (cross-kind liveness): a live terminal PTY owning `(codex, thread)`
        // is the one writer on that rollout -- refuse the respawn (retryable).
        if (self.terminal_liveness)(PROVIDER, session_id) {
            tracing::warn!(target: "freshell_freshagent::codex", session_id = %session_id,
                "fresh_agent_respawn_refused: a live terminal PTY owns this session (Task 13b cross-kind live-guard)");
            return Err(EnsureAliveError::Reserved);
        }
        // Task 13 (D8): the exited->respawn arm SPAWNS -- claim the per-sessionRef
        // lease first (the per-thread lock above covers in-process races; the lease
        // serializes against CREATE-path holders for the same durable id).
        let alive_request_id = format!("attach-alive-{}", uuid::Uuid::new_v4());
        let mut lease_guard: Option<crate::FreshSessionLeaseGuard> = None;
        for round in 0..2u8 {
            match self.leases.claim(
                PROVIDER,
                session_id,
                &alive_request_id,
                crate::session_lease::now_epoch_ms(),
            ) {
                crate::session_lease::FreshSessionClaim::Acquired => {
                    lease_guard = Some(crate::FreshSessionLeaseGuard::armed(
                        Arc::clone(&self.leases),
                        PROVIDER,
                        session_id,
                        &alive_request_id,
                    ));
                    break;
                }
                crate::session_lease::FreshSessionClaim::BoundLive { live_session_key } => {
                    // The winner bound while we contended: adopt its live session.
                    let live = self.sessions.lock().await.get(&live_session_key).is_some();
                    if live {
                        if live_session_key == session_id {
                            return Ok(EnsureAliveOutcome::Recovered);
                        }
                        return Ok(EnsureAliveOutcome::Respawned {
                            new_session_id: live_session_key,
                        });
                    }
                    return Err(EnsureAliveError::Reserved);
                }
                crate::session_lease::FreshSessionClaim::Held { .. } => {
                    return Err(EnsureAliveError::Reserved);
                }
                crate::session_lease::FreshSessionClaim::ExpiredNeedsKill { pid, ownership_id } => {
                    if round == 0
                        && crate::session_lease::kill_and_confirm_tree_dead(
                            pid,
                            CODEX_SIDECAR_OWNERSHIP_ENV,
                            &ownership_id,
                        )
                        .await
                    {
                        self.leases
                            .force_release_after_confirmed_kill(PROVIDER, session_id);
                        continue;
                    }
                    tracing::error!(target: "invariant", pid, session_id = %session_id,
                        "fresh_agent_lease_expired_kill_unconfirmed: holding closed");
                    return Err(EnsureAliveError::Reserved);
                }
            }
        }

        // FIX (CODEX-FIRST triage Finding 2): this exact thread id was already confirmed
        // genuinely gone within its negative-cache TTL window -- skip the doomed resume
        // attempt (and the sidecar it would burn to re-prove it) and go straight to the
        // mint-new-thread fallback, which needs a fresh sidecar of its own regardless.
        if self.is_known_dead_thread(session_id).await {
            return self
                .respawn_as_new_thread_after_crash(
                    session_id,
                    cwd,
                    model,
                    effort,
                    sandbox,
                    permission_mode,
                    lease_guard,
                )
                .await;
        }

        let (client, notifs, ownership_id, child) = match self.spawn_sidecar(cwd.as_deref()).await {
            Ok(parts) => parts,
            Err(err) => {
                if let Some(mut g) = lease_guard.take() {
                    g.fail();
                }
                return Err(EnsureAliveError::RespawnFailed(err));
            }
        };
        // Arm the lease's TTL tree-kill path now that the child + its tag exist.
        if let Some(g) = lease_guard.as_mut() {
            if let Some(pid) = child.id() {
                g.set_kill_handle(pid, &ownership_id);
            }
        }

        // `toCodexResumeInput` (adapter.ts:151-162): forward only settings this process
        // actually has recorded for the thread. An empty `model` means `handle_send` never
        // ran for this session (mirrors `ensure_session_resumable`'s "unknown until a
        // freshAgent.send supplies one" convention, and `CodexSession::model`'s doc comment)
        // -- omit it (`None`) rather than resuming with an empty string.
        let resume_model = (!model.is_empty()).then(|| model.clone());
        let first_attempt = client
            .resume_thread(
                session_id,
                StartThreadParams {
                    cwd: cwd.clone(),
                    model: resume_model,
                    sandbox: sandbox.clone(),
                    approval_policy: permission_mode.clone(),
                },
            )
            .await;

        let resume_result = match first_attempt {
            Ok(started) => Ok(started),
            Err(err) if is_codex_thread_not_found(&err) => Err(err),
            // Not a "thread not found" -- retry once with no settings at all in case the
            // app-server rejected one of them; `handle_send` re-applies the real settings
            // on the next turn regardless.
            Err(_) => {
                client
                    .resume_thread(
                        session_id,
                        StartThreadParams {
                            cwd: cwd.clone(),
                            model: None,
                            sandbox: None,
                            approval_policy: None,
                        },
                    )
                    .await
            }
        };

        let started = match resume_result {
            Ok(started) => started,
            Err(err) if is_codex_thread_not_found(&err) => {
                // Genuine "thread not found": this sidecar/socket already burned its resume
                // attempt(s) against a thread the app-server has truly forgotten -- close it
                // and fall back to the ORIGINAL mint-new-thread recovery on a fresh sidecar.
                client.close().await;
                let mut dead_child = child;
                let _ = dead_child.start_kill();
                reap_owned_codex_sidecars(&ownership_id);
                // FIX (CODEX-FIRST triage Finding 2): remember this id as genuinely gone so
                // a later attach/create against it fails fast instead of repeating this same
                // spawn-resume-fail cycle.
                self.mark_thread_dead(session_id).await;
                return self
                    .respawn_as_new_thread_after_crash(
                        session_id,
                        cwd,
                        model,
                        effort,
                        sandbox,
                        permission_mode,
                        lease_guard,
                    )
                    .await;
            }
            Err(err) => {
                client.close().await;
                let mut child = child;
                let _ = child.start_kill();
                reap_owned_codex_sidecars(&ownership_id);
                // Own tree torn down above -- releasing the lease is safe.
                if let Some(mut g) = lease_guard.take() {
                    g.fail();
                }
                return Err(EnsureAliveError::RespawnFailed(err.to_string()));
            }
        };
        // TERM-25: never silently proceed against the wrong thread. Re-registering the
        // ORIGINAL id against a sidecar that `thread/resume` actually put on a DIFFERENT
        // thread would route every subsequent send to an unrelated conversation. Reject
        // loudly instead; the caller surfaces it as a respawn failure.
        if started.thread_id != session_id {
            client.close().await;
            let mut child = child;
            let _ = child.start_kill();
            reap_owned_codex_sidecars(&ownership_id);
            tracing::error!(
                requested = %session_id,
                returned = %started.thread_id,
                "freshagent.codex.wrong_thread_resume_rejected"
            );
            if let Some(mut g) = lease_guard.take() {
                g.fail();
            }
            return Err(EnsureAliveError::RespawnFailed(format!(
                "codex thread/resume returned wrong thread id {} (requested {session_id}); \
                 refusing to adopt the wrong thread",
                started.thread_id
            )));
        }

        let active_turn: Arc<StdMutex<Option<String>>> = Arc::new(StdMutex::new(None));
        let exited = Arc::new(AtomicBool::new(false));
        let consumer = self.spawn_consumer(notifs, session_id.to_string(), active_turn.clone());
        let (kill_tx, kill_rx) = oneshot::channel();
        let watcher = spawn_exit_watcher(
            child,
            ownership_id,
            session_id.to_string(),
            self.broadcast_tx.clone(),
            kill_rx,
            exited.clone(),
            Arc::clone(&self.leases),
        );

        // `HashMap::insert` on an existing key overwrites in place, dropping the old (dead
        // sidecar's) entry -- same convention `respawn_as_new_thread_after_crash` and
        // `ensure_session_resumable` both already rely on; its `consumer`/`watcher`
        // `JoinHandle`s are not aborted, they simply run to completion on their own (the old
        // notification stream is closed, and the old watcher already fired the self-heal
        // broadcast that got us here).
        {
            let mut guard = self.sessions.lock().await;
            guard.insert(
                session_id.to_string(),
                CodexSession {
                    client,
                    model: model.clone(),
                    effort: effort.clone(),
                    cwd: cwd.clone(),
                    sandbox: sandbox.clone(),
                    permission_mode: permission_mode.clone(),
                    active_turn,
                    consumer,
                    kill_tx: Some(kill_tx),
                    watcher,
                    exited,
                },
            );
        }

        // P1.13 identity event (Task 4, R2): refresh write under the SAME id --
        // snapshots the LIVE in-session values (which originate from a real
        // create/user change); the helper's no-laundering guard skips it if they
        // are all blank. AWAITED before this fn returns (durable-before-answer).
        self.record_codex_binding(
            session_id,
            None,
            &model,
            sandbox.as_deref(),
            permission_mode.as_deref(),
            effort.as_deref(),
            cwd.as_deref(),
            None,
        )
        .await;

        // FIX (CODEX-FIRST triage Finding 2): the app-server just proved this id alive again
        // -- clear any stale "recently gone" marking so it doesn't linger.
        self.clear_dead_thread(session_id).await;

        // Task 13: bind the durable id to the recovered live session + release the
        // lease (registration above precedes the bind -- no no-lease/no-binding window).
        if let Some(mut g) = lease_guard.take() {
            if !g.complete(session_id) {
                // Revoked mid-recovery: we are still the only writer (contenders were
                // held closed) -- keep the recovered session, reopen the key; the
                // has-live fast paths adopt it from here.
                g.fail();
            }
        }

        // DIAG-01: crash recovery took the resume-first path -- the durable
        // session_id is unchanged, conversation memory survives.
        tracing::info!(provider = PROVIDER, session_id = %session_id, "freshagent.crash_recovery.resumed_same_thread");

        Ok(EnsureAliveOutcome::Recovered)
    }

    /// The ORIGINAL crash-recovery fallback (kept verbatim in behavior, just extracted so
    /// [`Self::ensure_session_alive`]'s resume-first path can fall back to it): mint a fresh
    /// thread on a fresh sidecar and MATERIALIZE the session under the new thread id -- the
    /// same placeholder\u2192durable identity-move pattern the opencode slice already uses
    /// (`FreshAgentSessionMaterialized`). Reached only when [`is_codex_thread_not_found`]
    /// proves the app-server has genuinely forgotten `old_session_id`'s thread; conversation
    /// memory for it is lost. Callers must use the returned `new_session_id` for anything
    /// session-scoped afterward.
    #[allow(clippy::too_many_arguments)]
    #[allow(clippy::too_many_arguments)]
    async fn respawn_as_new_thread_after_crash(
        &self,
        old_session_id: &str,
        cwd: Option<String>,
        model: String,
        effort: Option<String>,
        sandbox: Option<String>,
        permission_mode: Option<String>,
        mut lease_guard: Option<crate::FreshSessionLeaseGuard>,
    ) -> Result<EnsureAliveOutcome, EnsureAliveError> {
        let (client, notifs, ownership_id, child) = match self.spawn_sidecar(cwd.as_deref()).await {
            Ok(parts) => parts,
            Err(err) => {
                if let Some(mut g) = lease_guard.take() {
                    g.fail();
                }
                return Err(EnsureAliveError::RespawnFailed(err));
            }
        };
        // Task 13: arm the lease's TTL tree-kill path now that the child + tag exist.
        if let Some(g) = lease_guard.as_mut() {
            if let Some(pid) = child.id() {
                g.set_kill_handle(pid, &ownership_id);
            }
        }

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
                // Own tree torn down above -- releasing the lease is safe.
                if let Some(mut g) = lease_guard.take() {
                    g.fail();
                }
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
            Arc::clone(&self.leases),
        );

        {
            let mut guard = self.sessions.lock().await;
            guard.remove(old_session_id);
            guard.insert(
                new_thread_id.clone(),
                CodexSession {
                    client,
                    model: model.clone(),
                    effort: effort.clone(),
                    cwd: cwd.clone(),
                    sandbox: sandbox.clone(),
                    permission_mode: permission_mode.clone(),
                    active_turn,
                    consumer,
                    kill_tx: Some(kill_tx),
                    watcher,
                    exited,
                },
            );
        }

        // Task 13: bind the OLD durable id to the NEW live key (the identity moved) --
        // contenders holding the old id adopt the new session via BoundLive.
        if let Some(mut g) = lease_guard.take() {
            if !g.complete(&new_thread_id) {
                // Revoked mid-respawn: keep the live session (we are the only writer);
                // reopen the key -- has-live fast paths adopt from here.
                g.fail();
            }
        }

        // P1.13 identity event (Task 4): NEW ledger row under the new thread id with
        // `supersedes: Some(old_thread_id)` -- the G3 supersession linkage (V8/A14):
        // the ledger retires the old row and links it to the new one. This is the
        // ONLY site that ever knows both ids; the edge is unrecoverable if not
        // written here. AWAITED before the materialized broadcast below goes out.
        self.record_codex_binding(
            &new_thread_id,
            None,
            &model,
            sandbox.as_deref(),
            permission_mode.as_deref(),
            effort.as_deref(),
            cwd.as_deref(),
            Some(old_session_id),
        )
        .await;

        // DIAG-01: crash recovery had to mint a fresh thread -- the durable
        // identity MOVED (old_session_id -> new_thread_id); conversation
        // memory for the old thread is lost. `warn`, unlike the resume-first
        // path, because this is the degraded fallback. Carries the canonical
        // `session_id` (= the NEW, now-current thread) alongside the
        // recovery-forensics old/new pair, so generic session-lifecycle
        // parses see one uniform identity field on every lifecycle event.
        tracing::warn!(
            provider = PROVIDER,
            session_id = %new_thread_id,
            old_session_id = %old_session_id,
            new_session_id = %new_thread_id,
            "freshagent.crash_recovery.minted_new"
        );

        self.broadcast(&ServerMessage::FreshAgentSessionMaterialized(
            FreshAgentSessionMaterialized {
                previous_session_id: old_session_id.to_string(),
                provider: PROVIDER.to_string(),
                session_id: new_thread_id.clone(),
                session_type: SESSION_TYPE.to_string(),
                session_ref: Some(SessionLocator {
                    provider: PROVIDER.to_string(),
                    session_id: new_thread_id.clone(),
                }),
            },
        ));

        // P1.13 §2.6b (Task 6): memory loss must be user-visible, not server-log-only.
        // Emitted AFTER the materialized broadcast above -- the frozen client re-keys
        // its session state on `materialized` (`fresh-agent-ws.ts:143-160`); emitting
        // first would target a session id the client no longer tracks. The non-`RESTORE_`
        // error branch also clears streaming and forces `running -> idle` -- safe here,
        // the turn is already dead.
        self.emit_fresh_agent_error(
            &new_thread_id,
            "THREAD_MEMORY_LOST",
            "Codex crashed and this pane was restarted as a new thread. The agent no longer has memory of the earlier conversation in this pane.",
        );

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
        // The canonical argv + env: `-c features.apps=false app-server --listen <ws_url>`
        // plus the ownership tag the /proc reaper keys on (S5.d.1 unification).
        let spec = codex_sidecar_spawn_spec(&ws_url, &ownership_id);
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
        cmd.args(&spec.args);
        if let Some(cwd) = cwd {
            cmd.current_dir(cwd);
        }
        // Inherit the parent env (HOME=<isolated>, CODEX_HOME unset → <HOME>/.codex) and
        // layer the spec's env (the ownership tag, so the /proc reaper can find exactly
        // our sidecar).
        for (key, value) in &spec.env {
            cmd.env(key, value);
        }
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd.kill_on_drop(true);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("codex app-server spawn failed ({codex_cmd}): {e}"))?;
        // Drain child stdio so verbose app-server/MCP logs can never fill the pipe and stall it.
        drain_child_io(&mut child);

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

        tracing::info!(
            provider = PROVIDER,
            pid = child.id().unwrap_or(0),
            "freshagent.sidecar.spawned"
        );
        Ok((client, notifs, ownership_id, child))
    }

    // ── notification consumer (the status-guarded completion edge) ───────────

    /// Consume the app-server notification stream through the STATUS-GUARDED
    /// [`CodexSubscription`] reducer and broadcast the resulting `freshAgent.event` envelopes.
    /// `turn/completed` yields an idle `freshAgent.session.snapshot` (always) then the positive
    /// `freshAgent.turn.complete` chime ONLY on a `completed` status.
    fn spawn_consumer(
        &self,
        notifs: tokio::sync::mpsc::UnboundedReceiver<CodexNotification>,
        thread_id: String,
        active_turn: Arc<StdMutex<Option<String>>>,
    ) -> tokio::task::JoinHandle<()> {
        self.spawn_consumer_after(notifs, thread_id, active_turn, None)
    }

    /// Like [`Self::spawn_consumer`], but if `gate` is given, the consumer's first
    /// `notifs.recv()` waits for it to fire before consuming anything -- see
    /// [`Self::finish_create`]'s ordering-fix doc for why this exists. The unbounded
    /// `notifs` channel buffers whatever arrives while gated; nothing is lost, only its
    /// delivery to the consumer (and thus any resulting broadcast) is deferred. A
    /// dropped/never-fired `gate` behaves identically to `None` (a dropped oneshot
    /// sender resolves its receiver immediately with `Err`, which this ignores) --
    /// callers must still fire it on every path, but a bug that forgets to can never
    /// wedge the consumer forever.
    fn spawn_consumer_after(
        &self,
        mut notifs: tokio::sync::mpsc::UnboundedReceiver<CodexNotification>,
        thread_id: String,
        active_turn: Arc<StdMutex<Option<String>>>,
        gate: Option<oneshot::Receiver<()>>,
    ) -> tokio::task::JoinHandle<()> {
        let broadcast_tx = self.broadcast_tx.clone();
        tokio::spawn(async move {
            if let Some(gate) = gate {
                let _ = gate.await;
            }
            let mut subscription = CodexSubscription::new(thread_id.clone());
            while let Some(notification) = notifs.recv().await {
                let events = reduce_notification(&mut subscription, notification, &active_turn);
                for event in events {
                    // DIAG-01: the positive turn-complete chime only -- session_id
                    // alone, never the turn's text/response content.
                    if let CodexAdapterEvent::TurnComplete { session_id, .. } = &event {
                        tracing::info!(provider = PROVIDER, session_id = %session_id, "freshagent.turn.complete");
                    }
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
    pub async fn get_snapshot(
        &self,
        thread_id: &str,
        cwd: Option<&str>,
    ) -> Result<Value, CodexSnapshotError> {
        let (client, active_turn_present) = self.snapshot_runtime_for(thread_id, cwd).await?;
        // `isCodexIncludeTurnsUnavailable` fallback (`adapter.ts:1088-1095,1157-1159`): a
        // thread with no committed turns yet (freshly created, or resumed before its first
        // user message) can make the REAL codex app-server reject `includeTurns:true`. THIS
        // is the root cause of the "open a brand-new freshcodex pane -> 500" rehearsal bug --
        // this port previously had no fallback at all, so ANY such rejection became an
        // unconditional 500. Retry once with `includeTurns:false`, matching the reference
        // exactly (still a valid, if turn-less, snapshot).
        let raw = match client.read_thread(thread_id, true).await {
            Ok(raw) => raw,
            Err(err) if is_codex_include_turns_unavailable(&err) => client
                .read_thread(thread_id, false)
                .await
                .map_err(CodexSnapshotError::AppServer)?,
            Err(err) => return Err(CodexSnapshotError::AppServer(err)),
        };
        build_codex_snapshot_json(thread_id, &raw, active_turn_present)
            .map_err(CodexSnapshotError::Protocol)
    }

    /// Resolve the live client + active-turn bit for `thread_id`, via
    /// [`Self::ensure_session_resumable`] (called unconditionally, mirroring the
    /// reference's `ensureRuntime`, `adapter.ts:762-799,1083-1086`, regardless of whether
    /// the thread was ever created by THIS process). This is what lets a HISTORICAL
    /// session (opened from the sidebar, never created/attached in this server's
    /// lifetime) serve a snapshot at all, instead of an unconditional 404.
    async fn snapshot_runtime_for(
        &self,
        thread_id: &str,
        cwd: Option<&str>,
    ) -> Result<(Arc<CodexAppServerClient>, bool), CodexSnapshotError> {
        match self.ensure_session_resumable(thread_id, cwd).await {
            Ok(resumed) => {
                let active_turn_present = resumed
                    .active_turn
                    .lock()
                    .expect("active_turn mutex")
                    .is_some();
                Ok((resumed.client, active_turn_present))
            }
            Err(ResumeSessionError::NotFound) => Err(CodexSnapshotError::NotFound),
            Err(ResumeSessionError::Transient(message)) => {
                Err(CodexSnapshotError::Protocol(message))
            }
            // Task 13 (D8): a reserved sessionRef is transient at the REST layer.
            Err(ResumeSessionError::Reserved) => Err(CodexSnapshotError::Protocol(
                "SESSION_RESERVED: another resume for this session is in flight".to_string(),
            )),
        }
    }

    // -- dead-thread negative cache (CODEX-FIRST triage Finding 2) --

    /// Fast, side-effect-mostly-free check: is `thread_id` currently within its negative-cache
    /// TTL window (a thread this process recently confirmed genuinely gone)? Lazily evicts an
    /// expired entry it happens to observe on read, so the map only ever holds entries that
    /// still matter (bounded memory without a separate sweep task).
    async fn is_known_dead_thread(&self, thread_id: &str) -> bool {
        let mut guard = self.dead_threads.lock().await;
        match guard.get(thread_id) {
            Some(expires_at) if Instant::now() < *expires_at => true,
            Some(_) => {
                guard.remove(thread_id);
                false
            }
            None => false,
        }
    }

    /// Record that `thread_id` was just confirmed genuinely gone (`is_codex_thread_not_found`
    /// on a real `thread/resume` attempt), so the next attempt within [`Self::dead_thread_ttl`]
    /// fails fast instead of spawning a sidecar only to re-prove what this process already
    /// knows.
    async fn mark_thread_dead(&self, thread_id: &str) {
        let expires_at = Instant::now() + self.dead_thread_ttl;
        let mut guard = self.dead_threads.lock().await;

        // Enforce the cap (review item 2) only when inserting a genuinely NEW id -- an
        // update to an already-tracked id never grows the map.
        if guard.len() >= DEAD_THREADS_CAP && !guard.contains_key(thread_id) {
            let now = Instant::now();
            // Evict every already-expired entry first -- a free win, no reason to keep
            // entries this cache would already report as not-dead.
            guard.retain(|_, expires| *expires > now);
            // Still at capacity? Evict the single soonest-to-expire entry: the closest
            // proxy to "oldest" this map's data supports without extra bookkeeping, since
            // every entry's expiry is its own insertion time plus the same TTL.
            if guard.len() >= DEAD_THREADS_CAP {
                if let Some(oldest_id) = guard
                    .iter()
                    .min_by_key(|(_, expires)| **expires)
                    .map(|(id, _)| id.clone())
                {
                    guard.remove(&oldest_id);
                }
            }
        }

        guard.insert(thread_id.to_string(), expires_at);
    }

    /// Clear a negative-cache entry after a successful resume/create for `thread_id` -- the
    /// app-server just proved it alive again, so no stale "recently gone" marking may linger
    /// for this id.
    async fn clear_dead_thread(&self, thread_id: &str) {
        self.dead_threads.lock().await.remove(thread_id);
    }

    /// Resolve the live client + active-turn bit for `thread_id`. If this process already
    /// tracks the session (created or previously resumed here), reuse it. Otherwise spawn a
    /// sidecar and `thread/resume` the requested id (SAME id, unlike crash-recovery's
    /// `ensure_session_alive`, which mints a new one), then register it so subsequent
    /// reads/sends/attaches reuse the same runtime.
    ///
    /// Single-flighted per thread id via [`Self::resuming`]: a `freshAgent.attach` and a
    /// snapshot `GET` can race for the SAME historical thread, and without serialization
    /// both would spawn their own sidecar and `thread/resume` concurrently -- two owned
    /// sidecars for one logical session. The double-checked-lock pattern below (check
    /// `sessions`, acquire the per-thread lock, re-check `sessions`) ensures at most one
    /// resume RPC (and one spawned sidecar) is ever in flight per thread id at a time.
    ///
    /// FIX (CODEX-FIRST triage Finding 2): also checked (before AND after acquiring the
    /// per-thread lock) against [`Self::dead_threads`] -- a thread already confirmed gone
    /// within its TTL window fails fast with the SAME [`ResumeSessionError::NotFound`] a
    /// fresh not-found produces, without spawning a sidecar to re-prove it. This is what
    /// bounds the spawn storm from a client retrying `freshAgent.attach` with no backoff.
    async fn ensure_session_resumable(
        &self,
        thread_id: &str,
        cwd: Option<&str>,
    ) -> Result<ResumedCodexSession, ResumeSessionError> {
        if let Some(resumed) = self.live_resumed_session(thread_id).await {
            return Ok(resumed);
        }
        if self.is_known_dead_thread(thread_id).await {
            return Err(ResumeSessionError::NotFound);
        }

        let per_thread_lock = {
            let mut guard = self.resuming.lock().await;
            guard
                .entry(thread_id.to_string())
                .or_insert_with(|| Arc::new(TokioMutex::new(())))
                .clone()
        };
        let _permit = per_thread_lock.lock().await;

        // Re-check: a concurrent caller may have finished resuming this exact thread id
        // while we were waiting for the per-thread lock above.
        if let Some(resumed) = self.live_resumed_session(thread_id).await {
            return Ok(resumed);
        }
        // FIX (review item 1): also re-check the dead-thread cache here, not just before
        // acquiring the lock above. Without this, a concurrent waiter that contended the
        // lock while the FIRST caller's resume attempt was still in flight would, on
        // waking, see no live session (correctly -- the thread is dead) and fall through
        // to repeat the ENTIRE spawn/resume/fail cycle itself, even though the first
        // caller already proved the thread gone and marked it dead before releasing the
        // lock. This is what makes this function's doc comment's "before AND after
        // acquiring the per-thread lock" claim actually true.
        if self.is_known_dead_thread(thread_id).await {
            return Err(ResumeSessionError::NotFound);
        }

        // Task 13b (cross-kind liveness): a live terminal PTY owning `(codex, thread)`
        // is the one writer on that rollout -- refuse the resume (retryable).
        if (self.terminal_liveness)(PROVIDER, thread_id) {
            tracing::warn!(target: "freshell_freshagent::codex", session_id = %thread_id,
                "fresh_agent_attach_resume_refused: a live terminal PTY owns this session (Task 13b cross-kind live-guard)");
            return Err(ResumeSessionError::Reserved);
        }
        // Task 13 (D8): this arm SPAWNS -- claim the per-sessionRef lease first. The
        // per-thread lock above covers in-process attach-vs-attach; the lease
        // serializes against CREATE-path holders for the same durable id.
        let resume_request_id = format!("attach-resume-{}", uuid::Uuid::new_v4());
        let mut lease_guard: Option<crate::FreshSessionLeaseGuard> = None;
        for round in 0..2u8 {
            match self.leases.claim(
                PROVIDER,
                thread_id,
                &resume_request_id,
                crate::session_lease::now_epoch_ms(),
            ) {
                crate::session_lease::FreshSessionClaim::Acquired => {
                    lease_guard = Some(crate::FreshSessionLeaseGuard::armed(
                        Arc::clone(&self.leases),
                        PROVIDER,
                        thread_id,
                        &resume_request_id,
                    ));
                    break;
                }
                crate::session_lease::FreshSessionClaim::BoundLive { .. } => {
                    // The winner completed while we contended -- adopt its live session.
                    if let Some(resumed) = self.live_resumed_session(thread_id).await {
                        return Ok(resumed);
                    }
                    return Err(ResumeSessionError::Reserved);
                }
                crate::session_lease::FreshSessionClaim::Held { .. } => {
                    return Err(ResumeSessionError::Reserved);
                }
                crate::session_lease::FreshSessionClaim::ExpiredNeedsKill { pid, ownership_id } => {
                    if round == 0
                        && crate::session_lease::kill_and_confirm_tree_dead(
                            pid,
                            CODEX_SIDECAR_OWNERSHIP_ENV,
                            &ownership_id,
                        )
                        .await
                    {
                        self.leases
                            .force_release_after_confirmed_kill(PROVIDER, thread_id);
                        continue;
                    }
                    tracing::error!(target: "invariant", pid, session_id = %thread_id,
                        "fresh_agent_lease_expired_kill_unconfirmed: holding closed");
                    return Err(ResumeSessionError::Reserved);
                }
            }
        }

        let (client, notifs, ownership_id, child) = match self.spawn_sidecar(cwd).await {
            Ok(parts) => parts,
            Err(err) => {
                if let Some(mut g) = lease_guard.take() {
                    g.fail();
                }
                return Err(ResumeSessionError::Transient(err));
            }
        };
        // Arm the lease's TTL tree-kill path now that the child + its tag exist.
        if let Some(g) = lease_guard.as_mut() {
            if let Some(pid) = child.id() {
                g.set_kill_handle(pid, &ownership_id);
            }
        }

        // P1.13 (Task 5, R3): recover this thread's recorded settings snapshot BEFORE
        // issuing `thread/resume`, gated per V7/A10.
        let sink = self.identity_sink();
        let recovered = sink
            .as_ref()
            .and_then(|s| s.load_settings("codex", thread_id));
        // A record miss with NO prior recording (pre-ship / historical / sidebar-opened
        // -- the populations this resume path exists to serve, see `snapshot_runtime_for`)
        // is ROUTINE: resume silently with defaults exactly as before. NO alarm, NO
        // defaults write (V7).
        if recovered.is_none()
            && sink
                .as_ref()
                .is_some_and(|s| s.was_recorded("codex", thread_id))
        {
            // The ledger PROVES prior fresh-agent recording, yet nothing is
            // recoverable -- the genuine "never-happens" anomaly. Alarm.
            tracing::warn!(session = %thread_id, "freshagent.codex.settings_record_unrecoverable");
            self.emit_fresh_agent_error(
                thread_id,
                "SETTINGS_RESET",
                "Session settings could not be recovered after restart - the agent is \
                 running with default model and permissions. Reconfirm your settings.",
            );
        }
        let rec = recovered.clone().unwrap_or_default();

        let resume_result = client
            .resume_thread(
                thread_id,
                StartThreadParams {
                    cwd: cwd.map(str::to_string),
                    model: rec.model.clone(),
                    sandbox: rec.sandbox.clone(),
                    approval_policy: rec.permission_mode.clone(),
                },
            )
            .await;
        let started = match resume_result {
            Ok(started) => started,
            Err(err) => {
                client.close().await;
                let mut child = child;
                let _ = child.start_kill();
                reap_owned_codex_sidecars(&ownership_id);
                // Own tree torn down above -- releasing the lease is safe.
                if let Some(mut g) = lease_guard.take() {
                    g.fail();
                }
                if is_codex_thread_not_found(&err) {
                    // FIX (CODEX-FIRST triage Finding 2): remember this id as genuinely gone
                    // so a later attach/snapshot-read against it fails fast instead of
                    // repeating this same spawn-resume-fail cycle.
                    self.mark_thread_dead(thread_id).await;
                    return Err(ResumeSessionError::NotFound);
                }
                return Err(ResumeSessionError::Transient(err.to_string()));
            }
        };

        // TERM-25: never silently proceed against the wrong thread. Registering the
        // requested id against a sidecar that `thread/resume` actually put on a DIFFERENT
        // thread would bind the pane to an unrelated conversation. Reject loudly as a
        // transient failure (NOT NotFound -- the requested thread may be perfectly fine;
        // the app-server misbehaved), so the client keeps the durable identity.
        if started.thread_id != thread_id {
            client.close().await;
            let mut child = child;
            let _ = child.start_kill();
            reap_owned_codex_sidecars(&ownership_id);
            tracing::error!(
                requested = %thread_id,
                returned = %started.thread_id,
                "freshagent.codex.wrong_thread_resume_rejected"
            );
            if let Some(mut g) = lease_guard.take() {
                g.fail();
            }
            return Err(ResumeSessionError::Transient(format!(
                "codex thread/resume returned wrong thread id {} (requested {thread_id}); \
                 refusing to adopt the wrong thread",
                started.thread_id
            )));
        }

        // FIX (CODEX-FIRST triage Finding 2): the app-server just proved this id alive --
        // clear any stale "recently gone" marking so it doesn't linger.
        self.clear_dead_thread(thread_id).await;

        // Registration tail (shared with `handle_fork`). P1.13 (Task 5, R3): the ledger
        // record's settings snapshot -- blank only when no record was recoverable
        // (never-recorded historical sessions resume on defaults, exactly as before
        // this fix). (Lease completion happens right after the insert -- see below.)
        let active_turn = self
            .register_live_session(
                thread_id,
                client.clone(),
                notifs,
                ownership_id,
                child,
                rec.model.clone().unwrap_or_default(),
                rec.effort.clone(),
                cwd.map(str::to_string).or_else(|| rec.cwd.clone()),
                rec.sandbox.clone(),
                rec.permission_mode.clone(),
            )
            .await;

        // Task 13: bind the durable thread id to this live session + release the lease.
        if let Some(mut g) = lease_guard.take() {
            if !g.complete(thread_id) {
                // Revoked mid-resume (expired holder): tear our own session down and
                // reopen the key -- never keep a session a contender may replace.
                if let Some(session) = self.sessions.lock().await.remove(thread_id) {
                    session.consumer.abort();
                    session.client.close().await;
                    if let Some(kill_tx) = session.kill_tx {
                        let _ = kill_tx.send(());
                    }
                    let _ = session.watcher.await;
                }
                g.fail();
                return Err(ResumeSessionError::Transient(
                    "session lease revoked during attach-resume; torn down".to_string(),
                ));
            }
        }

        // P1.13 identity event (Task 5, R3): refresh write re-persisting the RECOVERED
        // live values, `supersedes: None` -- GATED on an actual recovery. On a miss it
        // must NOT run: writing would launder blank defaults into the ledger and
        // permanently mask the miss (V7 §2's laundering finding). AWAITED before this
        // fn returns (durable-before-answer).
        if recovered.is_some() {
            self.record_codex_binding(
                thread_id,
                None,
                rec.model.as_deref().unwrap_or(""),
                rec.sandbox.as_deref(),
                rec.permission_mode.as_deref(),
                rec.effort.as_deref(),
                cwd.or(rec.cwd.as_deref()),
                None,
            )
            .await;
        }

        Ok(ResumedCodexSession {
            client,
            active_turn,
        })
    }

    /// The shared "register a freshly-resumed/forked session on its new sidecar" tail of
    /// [`Self::ensure_session_resumable`] and [`Self::handle_fork`]: notification
    /// consumer + exit-watcher + insert, built from the caller-resolved settings
    /// snapshot. Returns the new session's `active_turn` handle. Callers own everything
    /// AROUND this insert (watcher ownership of the child, lease completion in
    /// [`Self::ensure_session_resumable`], the binding row in [`Self::handle_fork`]).
    #[allow(clippy::too_many_arguments)]
    async fn register_live_session(
        &self,
        thread_id: &str,
        client: Arc<CodexAppServerClient>,
        notifs: tokio::sync::mpsc::UnboundedReceiver<CodexNotification>,
        ownership_id: String,
        child: tokio::process::Child,
        model: String,
        effort: Option<String>,
        cwd: Option<String>,
        sandbox: Option<String>,
        permission_mode: Option<String>,
    ) -> Arc<StdMutex<Option<String>>> {
        let active_turn: Arc<StdMutex<Option<String>>> = Arc::new(StdMutex::new(None));
        let exited = Arc::new(AtomicBool::new(false));
        let consumer = self.spawn_consumer(notifs, thread_id.to_string(), active_turn.clone());
        let (kill_tx, kill_rx) = oneshot::channel();
        let watcher = spawn_exit_watcher(
            child,
            ownership_id,
            thread_id.to_string(),
            self.broadcast_tx.clone(),
            kill_rx,
            exited.clone(),
            Arc::clone(&self.leases),
        );
        self.sessions.lock().await.insert(
            thread_id.to_string(),
            CodexSession {
                client,
                model,
                effort,
                cwd,
                sandbox,
                permission_mode,
                active_turn: active_turn.clone(),
                consumer,
                kill_tx: Some(kill_tx),
                watcher,
                exited,
            },
        );
        active_turn
    }

    /// Fast-path lookup: is `thread_id` already tracked (created, or previously resumed by
    /// this process)? Shared by both checks in [`Self::ensure_session_resumable`]'s
    /// double-checked-lock.
    async fn live_resumed_session(&self, thread_id: &str) -> Option<ResumedCodexSession> {
        let guard = self.sessions.lock().await;
        guard.get(thread_id).map(|session| ResumedCodexSession {
            client: session.client.clone(),
            active_turn: session.active_turn.clone(),
        })
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
            Arc::clone(&self.leases),
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
    /// A non-item-type protocol failure while building the snapshot (currently: sidecar spawn
    /// failure from [`FreshCodexState::snapshot_runtime_for`]). NOTE: an unrecognized raw thread
    /// item `type` (e.g. the real codex CLI's `subAgentActivity`, unknown to both the frozen
    /// legacy protocol and current `origin/main`) no longer produces this variant -- see the
    /// DELIBERATE DEVIATION doc on [`map_codex_item`]. The reference's `readCodexThreadItemType`/
    /// `assertNever` throw `Unsupported Codex thread item type: ${value}`
    /// (`normalize.ts:141-147,123-125`), which `router.ts`'s catch-all turns into a bare 500 for
    /// the whole thread (`router.ts:165-166`); this port instead skips the single unrecognized
    /// item and keeps rendering everything else.
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

/// `isCodexIncludeTurnsUnavailable` (`adapter.ts:1157-1160`): the real codex app-server
/// rejects `thread/read{includeTurns:true}` for a thread with no committed turns yet
/// (freshly created, or resumed before its first user message) with one of these two
/// message substrings.
fn is_codex_include_turns_unavailable(err: &CodexAppServerError) -> bool {
    let message = err.to_string();
    message.contains("includeTurns is unavailable before first user message")
        || message.contains("not materialized yet")
}

/// The reference has no dedicated "is this genuinely a missing thread" check for
/// `thread/resume` failures -- `ensureRuntime` (`adapter.ts:762-799`) propagates ANY resume
/// error unwrapped, which `sendFreshAgentError`'s generic fallback turns into a plain 500
/// (`router.ts:165-166`). This port goes one step further and surfaces a proper 404 when the
/// app-server's own error text says so, so a garbage/expired thread id (as opposed to a
/// real spawn/RPC failure) doesn't masquerade as a server error.
fn is_codex_thread_not_found(err: &CodexAppServerError) -> bool {
    let message = err.to_string().to_lowercase();
    message.contains("not found")
        || message.contains("no such thread")
        || message.contains("unknown thread")
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
/// (`protocol.ts:113-129`) is covered.
///
/// DELIBERATE DEVIATION from legacy for an unrecognized `type`: the reference's
/// `readCodexThreadItemType`/`assertNever` both throw `Unsupported Codex thread item type:
/// ${value}` (`normalize.ts:141-147,123-125`), which `router.ts`'s catch-all turns into a bare
/// 500 for the ENTIRE thread (`router.ts:165-166`) -- legacy would 500 here too, so this is not
/// a port regression, but it is a real bug either way. The real codex CLI (observed: 0.144.5)
/// emits `subAgentActivity`, an item type absent from BOTH the frozen legacy protocol
/// (`protocol.ts:113-129`, 16 variants) and current `origin/main`. Hard-failing an entire
/// historical thread over one item type neither codebase has caught up to yet makes the
/// snapshot endpoint unusable for real transcripts -- proven against real staging data (a
/// genuinely readable thread 500'd solely because of one `subAgentActivity` item). So an
/// unrecognized item type returns `Ok(vec![])` (the item is silently omitted; every other item
/// in the thread still renders) instead of `Err`. This mirrors the opencode side's existing
/// precedent: an unrecognized opencode part also degrades to `[]`, not a hard error (see
/// `opencode_item_from_part`).
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
        // DELIBERATE DEVIATION: unrecognized item type -> skip, don't error the whole thread.
        // See the doc comment above for the full rationale (real codex 0.144.5's
        // `subAgentActivity`, unknown to both frozen legacy and current `origin/main`).
        _ => Ok(vec![]),
    }
}

/// `classifyCodexItemRole(item)` (`normalize.ts:475-501`): every `CodexThreadItemTypeSchema`
/// variant maps to exactly one display role. The caller ([`build_codex_turn_json`]) classifies
/// EVERY raw item, INCLUDING ones [`map_codex_item`] mapped to an empty item list
/// (unrecognized types) -- the catch-all arm IS reachable there and decides whether that item
/// pushes a zero-item display row -- so the catch-all is a runtime path, not just a
/// compile-time safety net (it still matches the reference's `assertNever` default in spirit).
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
/// alone. Truncation is the shared 140-char policy (`crate::summary`).
///
/// Provenance: the summary is AUTHORED only when it comes from a `reasoning`
/// item's provider-written `summary` array (codex is the one provider that
/// ships provider-written summary prose). Everything else — including a
/// reasoning item reduced to its raw `content` text — is a mechanical
/// projection and tags ECHO. The value SELECTION ORDER is the shipped one
/// (direct `text` → provider `summary` → `content`), deliberately NOT
/// reordered: `map_codex_item` (:3315-3322) constructs a reasoning item's
/// `text` as the joined provider summary exactly when one exists, so authored
/// is reachable with no visible-text change (planning decision 6).
fn summarize_codex_items(items: &[Value]) -> (String, &'static str) {
    for item in items {
        let kind = item.get("kind").and_then(Value::as_str).unwrap_or("");
        let text = match kind {
            "text" | "thinking" => item
                .get("text")
                .and_then(Value::as_str)
                .map(truncate_summary),
            "reasoning" => {
                // Shipped order: direct `text` first, then the provider
                // `summary` array, then raw `content`.
                let provider_summary = item
                    .get("summary")
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .filter(|joined| !joined.is_empty());
                let direct = item
                    .get("text")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty());
                let text = direct.map(str::to_string).unwrap_or_else(|| {
                    provider_summary.clone().unwrap_or_else(|| {
                        item.get("content")
                            .and_then(Value::as_array)
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(Value::as_str)
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            })
                            .unwrap_or_default()
                    })
                });
                // Authored iff the RETURNED string is the provider summary
                // join. For `map_codex_item`-built items that holds exactly
                // when a provider summary exists; a synthetic item whose
                // direct text diverges stays echo (the value came from text).
                let summary_kind = match &provider_summary {
                    Some(joined) if *joined == text => SUMMARY_KIND_AUTHORED,
                    _ => SUMMARY_KIND_ECHO,
                };
                return (truncate_summary(&text), summary_kind);
            }
            "command" => item
                .get("command")
                .and_then(Value::as_str)
                .map(truncate_summary),
            "file_change" => Some("File change".to_string()),
            "mcp_tool" => {
                let server = item.get("server").and_then(Value::as_str).unwrap_or("");
                let tool = item.get("tool").and_then(Value::as_str).unwrap_or("");
                Some(truncate_summary(&format!("{server}:{tool}")))
            }
            "dynamic_tool" | "collab_agent" => item
                .get("tool")
                .and_then(Value::as_str)
                .map(truncate_summary),
            "web_search" => item
                .get("query")
                .and_then(Value::as_str)
                .map(truncate_summary),
            "image_view" => item
                .get("path")
                .and_then(Value::as_str)
                .map(truncate_summary),
            "image_generation" => item
                .get("result")
                .and_then(Value::as_str)
                .map(truncate_summary),
            "review_mode" => {
                let event = item.get("event").and_then(Value::as_str).unwrap_or("");
                Some(truncate_summary(&format!("{event} review mode")))
            }
            "context_compaction" => Some("Context compacted".to_string()),
            "tool_use" => item
                .get("name")
                .and_then(Value::as_str)
                .map(truncate_summary),
            "tool_result" => {
                let is_error = item
                    .get("isError")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                Some(if is_error {
                    TOOL_ERROR_LABEL.to_string()
                } else {
                    TOOL_RESULT_LABEL.to_string()
                })
            }
            _ => None,
        };
        if let Some(text) = text {
            return (text, SUMMARY_KIND_ECHO);
        }
    }
    (String::new(), SUMMARY_KIND_ECHO)
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
    _active_turn_present: bool,
) -> Result<Value, String> {
    let thread = raw.get("thread").cloned().unwrap_or_else(|| json!({}));
    let status = normalize_codex_thread_status(thread.get("status").unwrap_or(&Value::Null));
    // `isRunning` (`normalize.ts:756`): PURELY the freshly-read thread status --
    // `status === 'running' || status === 'compacting'` -- and NOTHING else. The reference
    // has no independently-tracked in-flight-turn fallback here.
    //
    // FIX-1 (codex-first triage, `test/e2e-browser/specs/restore-matrix.spec.ts`'s
    // `test.fail` annotation): this used to also OR in `active_turn_present` (this
    // process's own `active_turn` bookkeeping, kept for `freshAgent.interrupt` targeting)
    // as a workaround for [`CodexStatus`] having no `Compacting` variant. That was a
    // correctness regression: `active_turn_present` is server-local, in-memory state that
    // can lag the app-server's actual thread status for reasons having nothing to do with
    // whether a turn is genuinely still running (a missed/reordered notification, a
    // resumed session inheriting stale bookkeeping, etc). Any such lag permanently wedged
    // `capabilities.send: false` even after the app-server itself reported `idle` --
    // exactly the observed regression: the FreshCodex composer never re-enabled after the
    // first live turn completed. `active_turn_present` is intentionally UNUSED here now
    // (retained as a parameter -- see doc comment on the caller,
    // [`FreshCodexState::get_snapshot`] -- for callers that still need the value for other
    // purposes); a snapshot is sendable whenever the freshly-read status says so, full
    // stop, matching the legacy adapter exactly.
    let is_running = status == CodexStatus::Running;
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
/// (the full `normalizeCodexItem` switch, `normalize.ts:238-473`) before being folded into its
/// row. DELIBERATE DEVIATION: an unrecognized item type no longer fails the turn -- per
/// [`map_codex_item`]'s doc comment, it maps to an empty item list. The loop does NOT skip it:
/// its role is still classified (the catch-all arm of [`classify_codex_item_role`] yields
/// `assistant`) and folded into `has_assistant_output`/`has_user_output`/`all_items_are_user`,
/// and when that role differs from the previous row's a new row is pushed whose `items` is the
/// empty list -- a ZERO-ITEM display row with a BLANK summary (`summarize_codex_items(&[])`
/// returns `""`). When the role matches the previous row, `row.items.extend(mapped)` extends by
/// nothing and no empty row appears. Every other item in the turn still renders normally.
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
            let (summary, summary_kind) = summarize_codex_items(&row.items);
            json!({
                "id": row_turn_id,
                "turnId": row_turn_id,
                "ordinal": ordinal,
                "source": "durable",
                "role": row.role,
                "summary": summary,
                "summaryKind": summary_kind,
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
    leases: Arc<crate::session_lease::FreshAgentSessionLeases>,
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
                // Task 12: the bound session is gone -- reopen its durable id.
                leases.clear_binding(PROVIDER, &thread_id);
                tracing::info!(provider = PROVIDER, session_id = %thread_id, "freshagent.sidecar.reaped");
            }
            _ = child.wait() => {
                reap_owned_codex_sidecars(&ownership_id);
                // Task 12: a crashed sidecar is no longer a live writer -- reopen the
                // durable id (the entry stays mapped for PR-4 lazy respawn, which
                // re-claims through the attach/send seams).
                leases.clear_binding(PROVIDER, &thread_id);
                tracing::info!(provider = PROVIDER, session_id = %thread_id, "freshagent.sidecar.reaped");
                // DIAG-01: an UNREQUESTED exit -- the crash/disconnect self-heal
                // edge (`kill_rx` firing instead would mean a requested kill,
                // handled in the sibling arm above with no event here).
                tracing::warn!(provider = PROVIDER, session_id = %thread_id, "freshagent.session.crash_detected");
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

/// The nested `freshAgent.event{freshAgent.error{code:'INTERNAL_ERROR'}}` envelope every
/// codex fork failure rides on (approval-respond run, Task 6): delivered on the REQUESTING
/// connection's sink (never silence for a user action — the Fork click's pane banner gets
/// the message text), keyed to the PARENT session id the fork ran against — the RESOLVED
/// post-ensure-alive id (whole-branch fix review F-1: on the mint-new respawn route the
/// client has already re-keyed the pane off the clicked id).
fn fork_error_frame(session_id: &str, message: &str) -> ServerMessage {
    fork_error_frame_with_code(session_id, "INTERNAL_ERROR", message)
}

/// [`fork_error_frame`] carrying a non-default code (whole-branch review M-2: the
/// ensure-alive `Reserved` leg is retryable and never lost — `SESSION_RESERVED` mirrors
/// [`FreshCodexState::handle_send`]'s answer).
fn fork_error_frame_with_code(session_id: &str, code: &str, message: &str) -> ServerMessage {
    ServerMessage::FreshAgentEvent(FreshAgentEvent {
        event: json!({
            "type": "freshAgent.error",
            "sessionId": session_id,
            "code": code,
            "message": message,
        }),
        provider: PROVIDER.to_string(),
        session_id: session_id.to_string(),
        session_type: SESSION_TYPE.to_string(),
    })
}

/// Tear down a fork-child sidecar whose registration never completed (close the client,
/// kill the child, sweep by ownership id) — the same teardown `ensure_session_resumable`
/// runs on its resume failure paths.
async fn shut_down_fork_child(
    client: &CodexAppServerClient,
    child: &mut tokio::process::Child,
    ownership_id: &str,
) {
    client.close().await;
    let _ = child.start_kill();
    let _ = child.wait().await;
    reap_owned_codex_sidecars(ownership_id);
}

/// Codex fork's `lastTurnId` normalization (fresh-eyes round-3 F6): the REST snapshot
/// renders synthetic SPLIT turn ids of the form `{raw_turn_id}:row-{index}`
/// (`build_codex_turn_json`), but `thread/fork` expects the RAW provider turn id —
/// strip exactly ONE trailing `:row-<digits>` suffix; a non-split id passes VERBATIM.
fn strip_codex_row_suffix(turn_id: &str) -> &str {
    let Some(idx) = turn_id.rfind(':') else {
        return turn_id;
    };
    let (head, tail) = turn_id.split_at(idx);
    let Some(digits) = tail[1..].strip_prefix("row-") else {
        return turn_id;
    };
    if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
        head
    } else {
        turn_id
    }
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
pub(crate) mod tests {
    use super::*;
    use crate::summary::{SUMMARY_KIND_AUTHORED, SUMMARY_KIND_ECHO};
    use freshell_codex::{CodexStatus, CodexTurnEvent};

    // ── DIAG-01 lifecycle tracing events (capturing test facility) ────────
    mod tracing_capture {
        use std::collections::BTreeMap;
        use std::sync::{Arc, Mutex, OnceLock};
        use tracing::field::{Field, Visit};
        use tracing::{Event, Subscriber};
        use tracing_subscriber::layer::{Context, SubscriberExt};
        use tracing_subscriber::Layer;

        #[derive(Debug, Clone, Default)]
        pub struct CapturedEvent {
            pub message: String,
            pub fields: BTreeMap<String, String>,
        }

        #[derive(Default)]
        struct FieldVisitor {
            message: String,
            fields: BTreeMap<String, String>,
        }

        impl Visit for FieldVisitor {
            fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
                let rendered = format!("{value:?}");
                if field.name() == "message" {
                    self.message = rendered;
                } else {
                    self.fields.insert(field.name().to_string(), rendered);
                }
            }
            fn record_str(&mut self, field: &Field, value: &str) {
                if field.name() == "message" {
                    self.message = value.to_string();
                } else {
                    self.fields
                        .insert(field.name().to_string(), value.to_string());
                }
            }
            fn record_i64(&mut self, field: &Field, value: i64) {
                self.fields
                    .insert(field.name().to_string(), value.to_string());
            }
            fn record_u64(&mut self, field: &Field, value: u64) {
                self.fields
                    .insert(field.name().to_string(), value.to_string());
            }
            fn record_bool(&mut self, field: &Field, value: bool) {
                self.fields
                    .insert(field.name().to_string(), value.to_string());
            }
        }

        struct CaptureLayer {
            events: Arc<Mutex<Vec<CapturedEvent>>>,
        }

        impl<S: Subscriber> Layer<S> for CaptureLayer {
            fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
                let mut visitor = FieldVisitor::default();
                event.record(&mut visitor);
                self.events
                    .lock()
                    .expect("capture lock")
                    .push(CapturedEvent {
                        message: visitor.message,
                        fields: visitor.fields,
                    });
            }
        }

        /// Thread-local capturing subscriber. Callers MUST use a CURRENT-THREAD
        /// `#[tokio::test]` (not `flavor = "multi_thread"`) so every task this
        /// crate's async fns spawn is polled on the SAME OS thread and observed.
        ///
        /// NOTE: unused by any test today (superseded by [`capture_by_session`] below
        /// for exactly the reason its own doc comment warns about -- DIAG-01's crash
        /// detection fires from a task tokio may poll on a different OS thread under
        /// parallel `cargo test`). Kept as a smaller building block (`CaptureLayer`,
        /// `FieldVisitor`) other single-threaded-only tests could still reach for.
        #[allow(dead_code)]
        pub fn capture() -> (
            Arc<Mutex<Vec<CapturedEvent>>>,
            tracing::subscriber::DefaultGuard,
        ) {
            let events = Arc::new(Mutex::new(Vec::new()));
            let layer = CaptureLayer {
                events: Arc::clone(&events),
            };
            let subscriber = tracing_subscriber::registry().with(layer);
            let guard = tracing::subscriber::set_default(subscriber);
            (events, guard)
        }

        /// Global (process-wide) capturing layer.
        ///
        /// `capture()` above is thread-local (`tracing::subscriber::set_default`): it only
        /// observes events emitted ON THE THREAD that installed it. DIAG-01's crash/self-heal
        /// event (`freshagent.session.crash_detected`) fires from `spawn_exit_watcher`'s
        /// spawned tokio task. Under a plain `#[tokio::test]` (current-thread flavor) that
        /// task is normally polled on the same OS thread as the test body -- but empirically
        /// (see the flaky-test investigation this fixes) it is NOT reliably so under
        /// `cargo test`'s default PARALLEL execution, where many other tests' OS threads,
        /// tokio runtimes and process reaping are churning concurrently; the exact scheduling
        /// that keeps everything thread-local under `--test-threads=1` is not a guarantee this
        /// test can depend on. A `set_global_default` subscriber -- installed exactly ONCE for
        /// the whole test binary via `OnceLock::get_or_init` (first caller wins, and
        /// `get_or_init` itself is the synchronization: only one caller ever runs the init
        /// closure even if several tests reach it concurrently) -- observes every event from
        /// every thread in the process, regardless of which one emits it, which is what makes
        /// capture deterministic here.
        ///
        /// Every event (from every concurrently-running test, in this binary) lands in one
        /// shared, append-only `Vec`. Reads filter that vec down to what a given test cares
        /// about, two ways (see `GlobalCapture` below):
        ///   - by `session_id` field (exact match) for events that carry one -- airtight
        ///     regardless of what else is running concurrently, since DIAG-01's fixture pins
        ///     a session id literal unique in this codebase.
        ///   - by arrival order (`since` an index snapshot) for the one DIAG-01 event that
        ///     carries no `session_id` (`freshagent.sidecar.spawned`, which only has `pid`) --
        ///     narrower than "ever in the process" though not perfectly attributable absent a
        ///     session-tagged field the production event doesn't carry.
        struct GlobalCaptureLayer {
            events: Arc<Mutex<Vec<CapturedEvent>>>,
        }

        impl<S: Subscriber> Layer<S> for GlobalCaptureLayer {
            fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
                let mut visitor = FieldVisitor::default();
                event.record(&mut visitor);
                self.events
                    .lock()
                    .expect("capture lock")
                    .push(CapturedEvent {
                        message: visitor.message,
                        fields: visitor.fields,
                    });
            }
        }

        static GLOBAL_EVENTS: OnceLock<Arc<Mutex<Vec<CapturedEvent>>>> = OnceLock::new();

        /// Scope a capture to `session_id`. Installs the global subscriber on the first call
        /// across the whole test binary (harmless, cheap no-op on every subsequent call --
        /// `get_or_init` never re-runs the closure) and returns a handle that reads back
        /// events for that session id, plus everything captured from this point forward.
        pub fn capture_by_session(session_id: &str) -> GlobalCapture {
            let events = GLOBAL_EVENTS
                .get_or_init(|| {
                    let events = Arc::new(Mutex::new(Vec::new()));
                    let layer = GlobalCaptureLayer {
                        events: Arc::clone(&events),
                    };
                    let subscriber = tracing_subscriber::registry().with(layer);
                    // This crate's test suite installs no other global default (verified: no
                    // `set_global_default`/`tracing_subscriber::fmt().init()` elsewhere in this
                    // binary), so this is guaranteed to be the first and only installer --
                    // `.expect()` turns any future regression (a second global-default
                    // installer added elsewhere) into an immediate, diagnosable panic instead
                    // of a silently-empty capture.
                    tracing::subscriber::set_global_default(subscriber)
                        .expect("DIAG-01 test binary installs exactly one global subscriber");
                    events
                })
                .clone();
            let start_index = events.lock().expect("capture lock").len();
            GlobalCapture {
                events,
                session_id: session_id.to_string(),
                start_index,
            }
        }

        pub struct GlobalCapture {
            events: Arc<Mutex<Vec<CapturedEvent>>>,
            session_id: String,
            start_index: usize,
        }

        impl GlobalCapture {
            /// Every event (from any point in the process's lifetime) tagged with this
            /// handle's `session_id`. Exact-match filtering makes this safe under concurrency:
            /// no other test in this codebase uses the same session id literal.
            pub fn events(&self) -> Vec<CapturedEvent> {
                self.events
                    .lock()
                    .expect("capture lock")
                    .iter()
                    .filter(|e| {
                        e.fields.get("session_id").map(String::as_str)
                            == Some(self.session_id.as_str())
                    })
                    .cloned()
                    .collect()
            }

            /// Events with NO `session_id` field, captured since this handle was created.
            /// For events the production code doesn't tag (e.g. `freshagent.sidecar.spawned`).
            pub fn untagged_events_since_start(&self) -> Vec<CapturedEvent> {
                self.events
                    .lock()
                    .expect("capture lock")
                    .iter()
                    .skip(self.start_index)
                    .filter(|e| !e.fields.contains_key("session_id"))
                    .cloned()
                    .collect()
            }
        }
    }

    /// **DIAG-01**: `handle_create` must emit `freshagent.session.created`
    /// (fields: `provider`, `session_id`, `cwd`), and an UNREQUESTED sidecar
    /// crash must emit `freshagent.session.crash_detected` (field:
    /// `session_id`) -- exercised through the SAME real fake-app-server
    /// "scripted peer" fixture (`test/fixtures/coding-cli/codex-app-server/
    /// fake-app-server.mjs`) the crash-recovery tests above use, so this
    /// proves the events fire on a genuine subprocess lifecycle, not a mock.
    #[tokio::test]
    // Intentional: `_guard` is held across every `.await` in this test BY DESIGN
    // (same convention as the crash-recovery tests above), serializing against
    // every other test in this module that mutates the process-global
    // `CODEX_CMD`/`FAKE_CODEX_APP_SERVER_BEHAVIOR` env vars.
    async fn diag01_freshagent_events_fire_on_create_and_crash_detection() {
        let _guard = ENV_LOCK.lock().await;
        // The fixture below pins the durable thread id to this exact literal, so it's known
        // up front -- see `capture_by_session`'s doc comment for why this must be a
        // process-wide (not thread-local) capture: `freshagent.session.crash_detected` fires
        // from `spawn_exit_watcher`'s spawned task, which parallel `cargo test` does not
        // guarantee lands on this test's own OS thread.
        let capture = tracing_capture::capture_by_session("thread-diag01");

        configure_fake_codex_cmd(
            r#"{"threadStartThreadId":"thread-diag01","exitProcessAfterMethodsOnce":["thread/start"]}"#,
        );
        let (st, mut rx) = state_with_bus();
        let thread_id = create_real_fake_session(&st, &mut rx).await;
        wait_for_self_heal(&st, &mut rx, &thread_id).await;

        std::env::remove_var("CODEX_CMD");
        std::env::remove_var("FAKE_CODEX_APP_SERVER_BEHAVIOR");

        let captured = capture.events();

        let created = captured
            .iter()
            .find(|e| e.message == "freshagent.session.created")
            .expect("expected a freshagent.session.created tracing event");
        assert_eq!(
            created.fields.get("provider").map(String::as_str),
            Some("codex")
        );
        assert_eq!(
            created.fields.get("session_id").map(String::as_str),
            Some(thread_id.as_str())
        );
        assert!(created.fields.contains_key("cwd"));

        let crash = captured
            .iter()
            .find(|e| e.message == "freshagent.session.crash_detected")
            .expect("expected a freshagent.session.crash_detected tracing event");
        assert_eq!(
            crash.fields.get("session_id").map(String::as_str),
            Some(thread_id.as_str())
        );
        // DIAG-01 schema completeness (review round 4): the crash lifecycle
        // event must carry the same provider/session identity the schema
        // documents for every fresh-agent session lifecycle event.
        assert_eq!(
            crash.fields.get("provider").map(String::as_str),
            Some("codex"),
            "crash_detected must carry provider per the canonical schema"
        );

        let spawned = capture
            .untagged_events_since_start()
            .iter()
            .filter(|e| e.message == "freshagent.sidecar.spawned")
            .count();
        assert!(
            spawned >= 1,
            "expected at least one freshagent.sidecar.spawned event"
        );
        // DIAG-01: every spawned event carries provider + the spawned pid.
        for e in capture
            .untagged_events_since_start()
            .iter()
            .filter(|e| e.message == "freshagent.sidecar.spawned")
        {
            assert_eq!(
                e.fields.get("provider").map(String::as_str),
                Some("codex"),
                "sidecar.spawned must carry provider"
            );
            assert!(
                e.fields
                    .get("pid")
                    .and_then(|p| p.parse::<u64>().ok())
                    .unwrap_or(0)
                    > 0,
                "sidecar.spawned must carry the spawned process pid"
            );
        }
    }

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
            Arc::clone(&state.leases),
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

    /// Like [`insert_fake_session`], but wires the REAL notification-consumer
    /// ([`FreshCodexState::spawn_consumer`]) instead of a no-op, so a scripted
    /// `turn/completed` notification pushed via the paired
    /// [`freshell_codex::ChannelPeer`] actually flows through [`reduce_notification`]
    /// and clears `active_turn` -- exercising the exact production path `get_snapshot`
    /// (REST) relies on for `capabilities.send`.
    async fn insert_fake_session_with_real_consumer(
        state: &FreshCodexState,
        thread_id: &str,
        client: Arc<CodexAppServerClient>,
        active_turn: Arc<StdMutex<Option<String>>>,
        notifs: tokio::sync::mpsc::UnboundedReceiver<CodexNotification>,
        child: tokio::process::Child,
        ownership_id: &str,
    ) -> tokio::sync::broadcast::Receiver<String> {
        let consumer = state.spawn_consumer(notifs, thread_id.to_string(), active_turn.clone());
        let (kill_tx, kill_rx) = oneshot::channel();
        let exited = Arc::new(AtomicBool::new(false));
        let watcher = spawn_exit_watcher(
            child,
            ownership_id.to_string(),
            thread_id.to_string(),
            state.broadcast_tx.clone(),
            kill_rx,
            exited.clone(),
            Arc::clone(&state.leases),
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

    /// FIX-1 (codex-first triage): after a turn genuinely completes through the REAL
    /// notification-consumer path (not a hand-set mutex), a subsequent `get_snapshot`
    /// must report `capabilities.send: true` -- matching the legacy adapter
    /// (`normalizeCodexThreadSnapshot`, `normalize.ts:756,765`), which computes
    /// `send`/`interrupt`/`fork` PURELY from the freshly-read thread status, never
    /// from an independently-tracked in-flight-turn bit. Reproduces the E2E-observed
    /// regression documented in `test/e2e-browser/specs/restore-matrix.spec.ts`'s
    /// `test.fail` comment: the FreshCodex composer stays permanently disabled after
    /// the first live turn completes.
    #[tokio::test]
    async fn get_snapshot_reports_sendable_after_a_turn_completes_via_the_real_notification_stream()
    {
        let (transport, peer) = freshell_codex::new_channel_transport();
        let (client, notifs) = CodexAppServerClient::connect(transport);
        let client = Arc::new(client);

        let (st, mut rx) = state_with_bus();
        let active_turn = Arc::new(StdMutex::new(Some("turn-1".to_string())));
        insert_fake_session_with_real_consumer(
            &st,
            "thread-1",
            client,
            active_turn.clone(),
            notifs,
            spawn_sleeper(),
            "codex-sidecar-test-turn-complete-capabilities",
        )
        .await;

        // The real app-server pushes `turn/completed` for the tracked thread -- exactly
        // what `handle_send`'s consumer (`spawn_consumer` -> `reduce_notification`)
        // observes in production.
        peer.emit_notification(
            "turn/completed",
            json!({ "threadId": "thread-1", "turnId": "turn-1", "status": "completed" }),
        );

        // Deterministic sync: the consumer clears `active_turn` BEFORE it broadcasts the
        // resulting frames, so waiting for the idle snapshot frame here proves the clear
        // has already happened by the time `get_snapshot` is called below.
        let frame = rx.recv().await.expect("idle snapshot frame");
        let wire: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(wire["event"]["type"], "freshAgent.session.snapshot");

        assert!(
            active_turn.lock().expect("active_turn mutex").is_none(),
            "active_turn must be cleared by the real notification consumer"
        );

        let driver = {
            let st = st.clone();
            tokio::spawn(async move { st.get_snapshot("thread-1", None).await })
        };

        let (init_id, init_method, _p) = peer.expect_request().await;
        assert_eq!(init_method, "initialize");
        peer.respond(
            &init_id,
            json!({ "userAgent": "x", "codexHome": "/h", "platformFamily": "u", "platformOs": "l" }),
        );
        let _ = peer.expect_notification().await;

        let (id, method, _params) = peer.expect_request().await;
        assert_eq!(method, "thread/read");
        peer.respond(
            &id,
            json!({
                "thread": {
                    "id": "thread-1",
                    "status": { "type": "idle" },
                    "turns": [],
                }
            }),
        );

        let snapshot = driver.await.unwrap().expect("snapshot builds");
        assert_eq!(snapshot["status"], json!("idle"));
        assert_eq!(
            snapshot["capabilities"]["send"],
            json!(true),
            "composer must be sendable once the real notification stream has cleared the active turn"
        );
        assert_eq!(snapshot["capabilities"]["interrupt"], json!(false));
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

    // ── freshAgent.compact (AGENT-04, approval-respond Task 4) ─────────────

    fn compact_msg(session_id: &str) -> FreshAgentCompact {
        FreshAgentCompact {
            provider: freshell_protocol::AgentProvider::Codex,
            session_id: session_id.to_string(),
            session_type: freshell_protocol::SessionType::Freshcodex,
            cwd: None,
            instructions: None,
        }
    }

    /// Insert a live, IDLE fake codex session whose notification consumer is the REAL
    /// one ([`FreshCodexState::spawn_consumer`]), returning the scripted server end of
    /// the channel plus a fresh bus receiver.
    async fn insert_idle_compact_session(
        st: &FreshCodexState,
        thread_id: &str,
    ) -> (
        freshell_codex::ChannelPeer,
        tokio::sync::broadcast::Receiver<String>,
    ) {
        let (transport, peer) = freshell_codex::new_channel_transport();
        let (client, notifs) = CodexAppServerClient::connect(transport);
        let rx = insert_fake_session_with_real_consumer(
            st,
            thread_id,
            Arc::new(client),
            Arc::new(StdMutex::new(None)),
            notifs,
            spawn_sleeper(),
            &format!("codex-sidecar-test-compact-{thread_id}"),
        )
        .await;
        (peer, rx)
    }

    /// Complete the initialize handshake a first RPC triggers (client.ts:777-778).
    async fn answer_initialize(peer: &freshell_codex::ChannelPeer) {
        let (init_id, init_method, _p) = peer.expect_request().await;
        assert_eq!(init_method, "initialize");
        peer.respond(
            &init_id,
            json!({ "userAgent": "x", "codexHome": "/h", "platformFamily": "u", "platformOs": "l" }),
        );
        let _ = peer.expect_notification().await; // initialized
    }

    /// Drive the PROBED real-0.147.0 post-compact notification sequence (plan Task 4,
    /// fresh-eyes round-3 F4 closure): `thread/status/changed{active}` → `turn/started`
    /// → `item/started` → `thread/tokenUsage/updated` → `item/completed` →
    /// `thread/status/changed{idle}` → `turn/completed{turn.status}`. NO
    /// `thread/compacted` notification exists in the success flow.
    fn emit_compact_notification_sequence(
        peer: &freshell_codex::ChannelPeer,
        thread_id: &str,
        turn_status: &str,
    ) {
        peer.emit_notification(
            "thread/status/changed",
            json!({ "threadId": thread_id, "status": { "type": "active" } }),
        );
        peer.emit_notification(
            "turn/started",
            json!({ "threadId": thread_id, "turn": { "id": "turn-compact-1" } }),
        );
        peer.emit_notification(
            "item/started",
            json!({ "threadId": thread_id, "turnId": "turn-compact-1", "item": { "id": "item-1", "type": "reasoning" } }),
        );
        peer.emit_notification(
            "thread/tokenUsage/updated",
            json!({ "threadId": thread_id, "turnId": "turn-compact-1", "tokenUsage": {} }),
        );
        peer.emit_notification(
            "item/completed",
            json!({ "threadId": thread_id, "turnId": "turn-compact-1", "item": { "id": "item-1", "type": "reasoning" } }),
        );
        peer.emit_notification(
            "thread/status/changed",
            json!({ "threadId": thread_id, "status": { "type": "idle" } }),
        );
        peer.emit_notification(
            "turn/completed",
            json!({ "threadId": thread_id, "turn": { "id": "turn-compact-1", "status": turn_status } }),
        );
    }

    #[tokio::test]
    async fn handle_compact_issues_thread_compact_start_and_the_probed_notification_flow_completes()
    {
        let (st, _rx_boot) = state_with_bus();
        let (peer, mut rx) = insert_idle_compact_session(&st, "thread-c1").await;

        // The pane's Compact click: instructions ARE on the wire frame, but codex
        // 0.147.0's `thread/compact/start` schema has NO instructions field -- they are
        // deliberately DROPPED (never sent as `/compact` turn text either).
        let driver = {
            let st = st.clone();
            tokio::spawn(async move {
                let mut msg = compact_msg("thread-c1");
                msg.instructions = Some("focus the diff".to_string());
                st.handle_compact(msg).await;
            })
        };

        answer_initialize(&peer).await;
        let (id, method, params) = peer.expect_request().await;
        assert_eq!(method, "thread/compact/start");
        let obj = params.as_object().expect("params object");
        assert_eq!(
            obj.len(),
            1,
            "thread/compact/start params are `{{threadId}}` ONLY: {params}"
        );
        assert_eq!(params["threadId"], json!("thread-c1"));
        assert!(
            params.get("instructions").is_none(),
            "instructions NEVER cross the wire for codex compact: {params}"
        );
        peer.respond(&id, json!({}));
        driver.await.expect("compact task");

        // NO turn/start anywhere in this drive: compact never degenerates to turn text.
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), peer.expect_request())
                .await
                .is_err(),
            "compact must issue NO further RPC (in particular, no `turn/start`)"
        );

        // The fake app-server then drives the probed notification sequence, and the
        // session must go BUSY then IDLE with ONE server-authoritative chime (existing
        // consumer machinery absorbs the compact flow; no thread/compacted is needed).
        emit_compact_notification_sequence(&peer, "thread-c1", "completed");

        let mut snapshots: Vec<String> = Vec::new();
        let mut completes = 0usize;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            assert!(
                !remaining.is_zero(),
                "no turn.complete within the budget (snapshots seen: {snapshots:?})"
            );
            let Ok(Ok(raw)) = tokio::time::timeout(remaining, rx.recv()).await else {
                break;
            };
            let frame: Value = serde_json::from_str(&raw).unwrap();
            if frame["type"] != "freshAgent.event" || frame["sessionId"] != "thread-c1" {
                continue;
            }
            match frame["event"]["type"].as_str() {
                Some("freshAgent.session.snapshot") => {
                    snapshots.push(frame["event"]["status"].as_str().unwrap_or("?").to_string());
                }
                Some("freshAgent.turn.complete") => {
                    completes += 1;
                    break;
                }
                _ => {}
            }
        }
        assert_eq!(
            completes, 1,
            "exactly one completion chime, got {completes}"
        );
        assert!(
            snapshots.iter().any(|s| s == "running"),
            "compact must mark the session BUSY first, got {snapshots:?}"
        );
        assert!(
            snapshots.iter().any(|s| s == "idle"),
            "compact must return the session to idle, got {snapshots:?}"
        );
    }

    #[tokio::test]
    async fn handle_compact_failed_or_interrupted_turn_produces_no_completion_chime() {
        for status in ["failed", "interrupted"] {
            let (st, _rx_boot) = state_with_bus();
            let (peer, mut rx) = insert_idle_compact_session(&st, "thread-cx").await;

            let driver = {
                let st = st.clone();
                tokio::spawn(async move {
                    st.handle_compact(compact_msg("thread-cx")).await;
                })
            };
            answer_initialize(&peer).await;
            let (id, method, _params) = peer.expect_request().await;
            assert_eq!(method, "thread/compact/start");
            peer.respond(&id, json!({}));
            driver.await.expect("compact task");

            // Same probed sequence, but the compact turn ends WITHOUT status:completed.
            emit_compact_notification_sequence(&peer, "thread-cx", status);

            let mut saw_idle = false;
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(500);
            loop {
                let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                if remaining.is_zero() {
                    break;
                }
                let Ok(Ok(raw)) = tokio::time::timeout(remaining, rx.recv()).await else {
                    break;
                };
                let frame: Value = serde_json::from_str(&raw).unwrap();
                if frame["sessionId"] != "thread-cx" {
                    continue;
                }
                match frame["event"]["type"].as_str() {
                    Some("freshAgent.session.snapshot") if frame["event"]["status"] == "idle" => {
                        saw_idle = true;
                    }
                    Some("freshAgent.turn.complete") => {
                        panic!("a `{status}` compact turn must never chime")
                    }
                    _ => {}
                }
            }
            assert!(
                saw_idle,
                "the idle snapshot still flows for a `{status}` compact turn"
            );
        }
    }

    #[tokio::test]
    async fn handle_compact_refuses_while_a_turn_is_active_without_issuing_any_rpc() {
        let (st, mut rx) = state_with_bus();
        let (transport, peer) = freshell_codex::new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect(transport);
        insert_fake_session(
            &st,
            "thread-busy",
            Arc::new(client),
            Arc::new(StdMutex::new(Some("turn-9".to_string()))),
            spawn_sleeper(),
            "codex-sidecar-test-compact-busy",
        )
        .await;

        st.handle_compact(compact_msg("thread-busy")).await;

        // The refusal is LOUD and pane-visible: the nested freshAgent.error
        // banner envelope, never a request-less top-level `error` frame.
        let frame: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(frame["type"], "freshAgent.event");
        assert_eq!(frame["provider"], "codex");
        assert_eq!(frame["sessionType"], "freshcodex");
        assert_eq!(frame["sessionId"], "thread-busy");
        assert_eq!(frame["event"]["type"], "freshAgent.error");
        assert_eq!(frame["event"]["code"], "CODEX_COMPACT_FAILED");
        assert!(
            frame["event"]["message"]
                .as_str()
                .unwrap()
                .contains("active turn"),
            "{frame}"
        );

        // The gate fires BEFORE any RPC -- nothing (not even the initialize gating)
        // ever reaches the app-server: no app-server EINVAL is let through.
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), peer.next_frame())
                .await
                .is_err(),
            "a busy session must produce NO compact RPC"
        );
    }

    #[tokio::test]
    async fn handle_compact_rpc_error_surfaces_the_error_path_and_no_fake_completion() {
        let (st, _rx_boot) = state_with_bus();
        let (peer, mut rx) = insert_idle_compact_session(&st, "thread-ce").await;

        let driver = {
            let st = st.clone();
            tokio::spawn(async move {
                st.handle_compact(compact_msg("thread-ce")).await;
            })
        };
        answer_initialize(&peer).await;
        let (id, method, _params) = peer.expect_request().await;
        assert_eq!(method, "thread/compact/start");
        peer.respond_error(&id, -32600, "compact rejected");
        driver.await.expect("compact task");

        // The app-server's rejection surfaces LOUD via the nested banner envelope.
        let frame: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(frame["type"], "freshAgent.event");
        assert_eq!(frame["provider"], "codex");
        assert_eq!(frame["sessionType"], "freshcodex");
        assert_eq!(frame["sessionId"], "thread-ce");
        assert_eq!(frame["event"]["type"], "freshAgent.error");
        assert_eq!(frame["event"]["code"], "CODEX_COMPACT_FAILED");
        assert!(
            frame["event"]["message"]
                .as_str()
                .unwrap()
                .contains("compact rejected"),
            "the app-server's rejection text crosses the wire: {frame}"
        );

        // No compact flow was accepted server-side, so NOTHING else may be broadcast
        // (in particular no fabricated idle snapshot or turn.complete).
        assert!(
            rx.try_recv().is_err(),
            "an RPC failure must not fabricate a completion"
        );
    }

    #[tokio::test]
    async fn handle_compact_unknown_session_surfaces_a_loud_nested_error() {
        let (st, mut rx) = state_with_bus();

        st.handle_compact(compact_msg("does-not-exist")).await;

        // Whole-branch-review M-1: the unknown-session leg is the lost-session shape —
        // the SAME `INVALID_SESSION_ID` envelope codex fork answers for an unknown
        // parent (`lost_session_frame`) — so the pane engages its `markSessionLost`
        // recovery instead of showing a dead-end banner (legacy
        // `requireOrRecoverSession` → `FreshAgentLostSessionError` parity). Session-keyed
        // so the client's banner path routes it to the pane that clicked Compact; a
        // request-less top-level `error` frame is invisible.
        let frame: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(frame["type"], "freshAgent.event");
        assert_eq!(frame["provider"], "codex");
        assert_eq!(frame["sessionType"], "freshcodex");
        assert_eq!(frame["sessionId"], "does-not-exist");
        assert_eq!(frame["event"]["type"], "freshAgent.error");
        assert_eq!(frame["event"]["code"], "INVALID_SESSION_ID");
        assert!(
            frame["event"]["message"]
                .as_str()
                .unwrap()
                .contains("codex session does-not-exist not found"),
            "{frame}"
        );
    }

    // ── freshAgent.fork (AGENT-07, approval-respond Task 6) ────────────────

    fn fork_msg(session_id: &str, request_id: &str, input: Option<Value>) -> FreshAgentFork {
        FreshAgentFork {
            provider: freshell_protocol::AgentProvider::Codex,
            session_id: session_id.to_string(),
            session_type: freshell_protocol::SessionType::Freshcodex,
            input,
            request_id: Some(request_id.to_string()),
            cwd: None,
        }
    }

    /// A `FrameSink` that records every delivered frame — the requesting connection's
    /// sink the fork handler answers on (`conn_sink` in terminal.rs).
    fn capturing_sink() -> (
        freshell_terminal::FrameSink,
        Arc<StdMutex<Vec<ServerMessage>>>,
    ) {
        let captured = Arc::new(StdMutex::new(Vec::new()));
        let sink: freshell_terminal::FrameSink = {
            let captured = captured.clone();
            Arc::new(move |msg| captured.lock().expect("captured mutex").push(msg))
        };
        (sink, captured)
    }

    fn captured_frames(captured: &Arc<StdMutex<Vec<ServerMessage>>>) -> Vec<Value> {
        captured
            .lock()
            .expect("captured mutex")
            .iter()
            .map(|m| serde_json::to_value(m).expect("frame serializes"))
            .collect()
    }

    fn assert_single_fork_error_frame(
        frames: &[Value],
        session_id: &str,
        code: &str,
        message_fragment: &str,
    ) {
        assert_eq!(frames.len(), 1, "exactly one sink frame: {frames:?}");
        let frame = &frames[0];
        assert_eq!(frame["type"], "freshAgent.event", "{frame}");
        assert_eq!(frame["provider"], "codex", "{frame}");
        assert_eq!(frame["sessionType"], "freshcodex", "{frame}");
        assert_eq!(frame["sessionId"], session_id, "{frame}");
        assert_eq!(frame["event"]["type"], "freshAgent.error", "{frame}");
        assert_eq!(frame["event"]["code"], code, "{frame}");
        assert!(
            frame["event"]["message"]
                .as_str()
                .unwrap_or_default()
                .contains(message_fragment),
            "sink error must carry the failing step's text ({message_fragment}): {frame}"
        );
    }

    #[tokio::test]
    async fn handle_fork_unknown_parent_replies_the_lost_session_shape_on_the_sink() {
        let (st, _rx_boot) = state_with_bus();
        let (sink, captured) = capturing_sink();

        st.handle_fork(fork_msg("does-not-exist", "fork-req-x", None), sink)
            .await;

        // Legacy throws FreshAgentLostSessionError on an unknown parent; the port
        // answers the same lost-session code ON THE REQUESTING CONNECTION so the
        // client's recovery path engages (never silence, never the refusal table).
        assert_single_fork_error_frame(
            &captured_frames(&captured),
            "does-not-exist",
            "INVALID_SESSION_ID",
            "codex session does-not-exist not found",
        );
        assert!(
            st.sessions.lock().await.is_empty(),
            "no fork machinery ran for an unknown parent"
        );
    }

    #[tokio::test]
    async fn handle_fork_rpc_error_replies_on_the_sink_without_archiving_or_spawning() {
        let (st, _rx_boot) = state_with_bus();
        let (transport, peer) = freshell_codex::new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect(transport);
        insert_fake_session(
            &st,
            "parent-fork-err",
            Arc::new(client),
            Arc::new(StdMutex::new(None)),
            spawn_sleeper(),
            "codex-sidecar-test-fork-err",
        )
        .await;

        let (sink, captured) = capturing_sink();
        let driver = {
            let st = st.clone();
            tokio::spawn(async move {
                st.handle_fork(fork_msg("parent-fork-err", "fork-req-e", None), sink)
                    .await;
            })
        };

        answer_initialize(&peer).await;
        let (id, method, params) = peer.expect_request().await;
        assert_eq!(method, "thread/fork");
        assert_eq!(params["threadId"], json!("parent-fork-err"));
        // The PROBED empty-parent rejection (0.147.0 real binary).
        peer.respond_error(&id, -32600, "no rollout found for thread id");
        driver.await.expect("fork task");

        assert_single_fork_error_frame(
            &captured_frames(&captured),
            "parent-fork-err",
            "INTERNAL_ERROR",
            "no rollout found for thread id",
        );

        // A failed fork changes NO state: no archive RPC follows, no child registers.
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), peer.next_frame())
                .await
                .is_err(),
            "a failed thread/fork must produce NO archive call"
        );
        assert!(
            st.sessions.lock().await.len() == 1,
            "only the parent remains registered"
        );
    }

    /// D2-F2 (delta-review round 2): the client leaves the Fork action enabled while a
    /// fork is in flight (and reuses the pane's `createRequestId`), so rapid duplicate
    /// clicks would otherwise mint TWO children for one parent — once the first reply
    /// re-keys the pane and kills the parent, the second reply can no longer correlate,
    /// leaving its child (and, for codex, a registered sidecar + durable thread)
    /// UNOWNED. The duplicate must be refused ON THE REQUESTING SINK with the nested
    /// `freshAgent.error{INTERNAL_ERROR}` shape and take NO other action (no
    /// thread/fork RPC, no state change); the guard releases on EVERY terminal leg
    /// (failure included), so a refreshed click can retry.
    #[tokio::test]
    async fn handle_fork_duplicate_in_flight_is_refused_and_releases_on_failure() {
        let (st, _rx_boot) = state_with_bus();
        let (transport, peer) = freshell_codex::new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect(transport);
        insert_fake_session(
            &st,
            "parent-fork-dup",
            Arc::new(client),
            Arc::new(StdMutex::new(None)),
            spawn_sleeper(),
            "codex-sidecar-test-fork-dup",
        )
        .await;

        // Fork #1 parks mid-RPC — the duplicate click's deterministic in-flight window.
        let (sink1, captured1) = capturing_sink();
        let driver1 = {
            let st = st.clone();
            tokio::spawn(async move {
                st.handle_fork(fork_msg("parent-fork-dup", "fork-req-d1", None), sink1)
                    .await;
            })
        };
        answer_initialize(&peer).await;
        let (id1, method, _params) = peer.expect_request().await;
        assert_eq!(method, "thread/fork");

        // Fork #2 — the duplicate — is refused INLINE (never waits upstream) and
        // takes NO other action.
        let (sink2, captured2) = capturing_sink();
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            st.handle_fork(fork_msg("parent-fork-dup", "fork-req-d2", None), sink2),
        )
        .await
        .expect("the duplicate fork is refused inline, never upstream-blocking");
        assert_single_fork_error_frame(
            &captured_frames(&captured2),
            "parent-fork-dup",
            "INTERNAL_ERROR",
            "already in progress",
        );

        // Fail fork #1: its reply rides the fork-RPC failure leg and the guard must
        // release even on a failure terminal path.
        peer.respond_error(&id1, -32000, "fork kaput");
        driver1.await.expect("fork #1 task");
        assert_single_fork_error_frame(
            &captured_frames(&captured1),
            "parent-fork-dup",
            "INTERNAL_ERROR",
            "fork kaput",
        );

        // A refreshed click reaches the wire again (no stranded guard) — fail it too
        // so the test leaves no parked task.
        let (sink3, captured3) = capturing_sink();
        let driver3 = {
            let st = st.clone();
            tokio::spawn(async move {
                st.handle_fork(fork_msg("parent-fork-dup", "fork-req-d3", None), sink3)
                    .await;
            })
        };
        let (id3, method, _params) = peer.expect_request().await;
        assert_eq!(
            method, "thread/fork",
            "the retried fork reached the wire — the guard released on failure"
        );
        peer.respond_error(&id3, -32000, "kaput too");
        driver3.await.expect("fork #3 task");
        assert_single_fork_error_frame(
            &captured_frames(&captured3),
            "parent-fork-dup",
            "INTERNAL_ERROR",
            "kaput too",
        );

        // Exactly two thread/fork RPCs total crossed the wire (#1 and #3 — the
        // refused duplicate produced none) and no child ever registered.
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), peer.next_frame())
                .await
                .is_err(),
            "no further RPCs (the duplicate never touched the wire)"
        );
        assert!(
            st.sessions.lock().await.len() == 1,
            "no child registered across the refused/failed forks"
        );
    }

    #[tokio::test]
    async fn handle_fork_archive_failure_replies_on_the_sink_and_never_spawns() {
        let (st, _rx_boot) = state_with_bus();
        let (transport, peer) = freshell_codex::new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect(transport);
        insert_fake_session(
            &st,
            "parent-arch-err",
            Arc::new(client),
            Arc::new(StdMutex::new(None)),
            spawn_sleeper(),
            "codex-sidecar-test-fork-arch-err",
        )
        .await;

        let (sink, captured) = capturing_sink();
        let driver = {
            let st = st.clone();
            tokio::spawn(async move {
                st.handle_fork(fork_msg("parent-arch-err", "fork-req-a", None), sink)
                    .await;
            })
        };

        answer_initialize(&peer).await;
        let (id, method, _params) = peer.expect_request().await;
        assert_eq!(method, "thread/fork");
        peer.respond(&id, json!({ "thread": { "id": "child-arch-err" } }));
        let (id, method, params) = peer.expect_request().await;
        assert_eq!(method, "thread/archive");
        assert_eq!(params["threadId"], json!("child-arch-err"));
        peer.respond_error(&id, -32000, "archive denied");
        driver.await.expect("fork task");

        assert_single_fork_error_frame(
            &captured_frames(&captured),
            "parent-arch-err",
            "INTERNAL_ERROR",
            "archive denied",
        );

        // The child stays attached to the PARENT connection (an archive failure is
        // pre-handoff, so there is nothing to restore): nothing further crosses the
        // wire and no child registers.
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), peer.next_frame())
                .await
                .is_err(),
            "a failed thread/archive must produce NO unarchive/spawn"
        );
        assert!(st.sessions.lock().await.len() == 1, "no child registered");
    }

    #[tokio::test]
    async fn handle_fork_malformed_fork_result_replies_and_never_archives() {
        let (st, _rx_boot) = state_with_bus();
        let (transport, peer) = freshell_codex::new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect(transport);
        insert_fake_session(
            &st,
            "parent-malformed",
            Arc::new(client),
            Arc::new(StdMutex::new(None)),
            spawn_sleeper(),
            "codex-sidecar-test-fork-malformed",
        )
        .await;

        let (sink, captured) = capturing_sink();
        let driver = {
            let st = st.clone();
            tokio::spawn(async move {
                st.handle_fork(fork_msg("parent-malformed", "fork-req-m", None), sink)
                    .await;
            })
        };

        answer_initialize(&peer).await;
        let (id, method, _params) = peer.expect_request().await;
        assert_eq!(method, "thread/fork");
        // A pathological 200 without a usable thread.id must NEVER be registered or
        // repointed at (same guard class as the opencode malformed-child-id pin).
        peer.respond(&id, json!({}));
        driver.await.expect("fork task");

        assert_single_fork_error_frame(
            &captured_frames(&captured),
            "parent-malformed",
            "INTERNAL_ERROR",
            "malformed",
        );
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), peer.next_frame())
                .await
                .is_err(),
            "a malformed fork result must produce NO archive call"
        );
        assert!(st.sessions.lock().await.len() == 1, "no child registered");
    }

    #[tokio::test]
    async fn handle_fork_builds_params_from_parent_settings_input_overrides_and_strips_row_suffix()
    {
        // Case A+B share a parent with EVERY setting stored; case C is bare defaults.
        for (case, overrides, expected) in [
            (
                "A",
                Some(
                    json!({ "cwd": "/override/cwd", "model": "override-model", "atTurnId": "turn-42:row-2" }),
                ),
                ("/override/cwd", "override-model", Some("turn-42")),
            ),
            (
                "B",
                Some(json!({ "atTurnId": "turn-9:row-0" })),
                ("/stored/cwd", "stored-model", Some("turn-9")),
            ),
        ] {
            let (st, _rx_boot) = state_with_bus();
            let (transport, peer) = freshell_codex::new_channel_transport();
            let (client, _notifs) = CodexAppServerClient::connect(transport);
            insert_fake_session(
                &st,
                "parent-params",
                Arc::new(client),
                Arc::new(StdMutex::new(None)),
                spawn_sleeper(),
                "codex-sidecar-test-fork-params",
            )
            .await;
            {
                let mut guard = st.sessions.lock().await;
                let s = guard.get_mut("parent-params").expect("parent session");
                s.model = "stored-model".to_string();
                s.cwd = Some("/stored/cwd".to_string());
                s.sandbox = Some("workspace-write".to_string());
                s.permission_mode = Some("on-request".to_string());
                s.effort = Some("high".to_string());
            }

            let (sink, captured) = capturing_sink();
            let driver = {
                let st = st.clone();
                tokio::spawn(async move {
                    st.handle_fork(fork_msg("parent-params", "fork-req-p", overrides), sink)
                        .await;
                })
            };

            answer_initialize(&peer).await;
            let (id, method, params) = peer.expect_request().await;
            assert_eq!(method, "thread/fork", "case {case}");
            let (exp_cwd, exp_model, exp_last_turn) = expected;
            assert_eq!(params["threadId"], json!("parent-params"), "case {case}");
            assert_eq!(params["cwd"], json!(exp_cwd), "case {case} cwd");
            assert_eq!(params["model"], json!(exp_model), "case {case} model");
            assert_eq!(
                params["sandbox"],
                json!("workspace-write"),
                "case {case}: parent sandbox flows verbatim"
            );
            assert_eq!(
                params["approvalPolicy"],
                json!("on-request"),
                "case {case}: parent permissionMode flows verbatim"
            );
            match exp_last_turn {
                Some(raw) => assert_eq!(
                    params["lastTurnId"],
                    json!(raw),
                    "case {case}: atTurnId normalizes to the raw provider turn id"
                ),
                None => assert!(
                    params.get("lastTurnId").is_none(),
                    "case {case}: no atTurnId → no lastTurnId"
                ),
            }
            assert!(
                params.get("excludeTurns").is_none(),
                "case {case}: excludeTurns is removed from 0.147.0, never sent"
            );
            let obj = params.as_object().expect("params object");
            assert_eq!(obj.len(), 6, "case {case} exact key set: {params}");
            // Stop the flow AFTER the params probe: a fork RPC error ends it cleanly.
            peer.respond_error(&id, -32000, "stop after param probe");
            driver.await.expect("fork task");
            assert_single_fork_error_frame(
                &captured_frames(&captured),
                "parent-params",
                "INTERNAL_ERROR",
                "stop after param probe",
            );
        }

        // Case C: bare stored defaults + no input → only {threadId, model} cross the wire.
        let (st, _rx_boot) = state_with_bus();
        let (transport, peer) = freshell_codex::new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect(transport);
        insert_fake_session(
            &st,
            "parent-bare",
            Arc::new(client),
            Arc::new(StdMutex::new(None)),
            spawn_sleeper(),
            "codex-sidecar-test-fork-bare",
        )
        .await;

        let (sink, captured) = capturing_sink();
        let driver = {
            let st = st.clone();
            tokio::spawn(async move {
                st.handle_fork(fork_msg("parent-bare", "fork-req-c", None), sink)
                    .await;
            })
        };

        answer_initialize(&peer).await;
        let (id, method, params) = peer.expect_request().await;
        assert_eq!(method, "thread/fork");
        let obj = params.as_object().expect("params object");
        assert_eq!(
            obj.len(),
            2,
            "defaults + no input → {{threadId, model}} ONLY: {params}"
        );
        assert_eq!(params["threadId"], json!("parent-bare"));
        assert_eq!(params["model"], json!("gpt-5.3-codex-spark"));
        peer.respond_error(&id, -32000, "stop after param probe");
        driver.await.expect("fork task");
        assert_single_fork_error_frame(
            &captured_frames(&captured),
            "parent-bare",
            "INTERNAL_ERROR",
            "stop after param probe",
        );
    }

    #[test]
    fn codex_fork_last_turn_id_strips_exactly_one_trailing_row_suffix() {
        // The snapshot surface renders synthetic split turn ids `{raw}:row-{index}`
        // (`build_codex_turn_json`, round-3 F6); codex expects the RAW provider turn id.
        assert_eq!(strip_codex_row_suffix("turn-1:row-2"), "turn-1");
        assert_eq!(strip_codex_row_suffix("turn-9:row-0"), "turn-9");
        // A non-split id passes VERBATIM — including lookalikes.
        assert_eq!(strip_codex_row_suffix("turn-9"), "turn-9");
        assert_eq!(strip_codex_row_suffix("turn-1:row-"), "turn-1:row-");
        assert_eq!(strip_codex_row_suffix("turn-1:row-x"), "turn-1:row-x");
        assert_eq!(strip_codex_row_suffix("raw:row-12"), "raw");
    }

    #[tokio::test]
    async fn handle_fork_child_spawn_failure_replies_and_best_effort_unarchives_the_child() {
        let _guard = ENV_LOCK.lock().await;
        std::env::set_var(
            "CODEX_CMD",
            "definitely-missing-codex-binary-freshell-fork-test",
        );

        let (st, _rx_boot) = state_with_bus();
        let (transport, peer) = freshell_codex::new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect(transport);
        insert_fake_session(
            &st,
            "parent-spawn-fail",
            Arc::new(client),
            Arc::new(StdMutex::new(None)),
            spawn_sleeper(),
            "codex-sidecar-test-fork-spawn-fail",
        )
        .await;

        let (sink, captured) = capturing_sink();
        let driver = {
            let st = st.clone();
            tokio::spawn(async move {
                st.handle_fork(fork_msg("parent-spawn-fail", "fork-req-s", None), sink)
                    .await;
            })
        };

        answer_initialize(&peer).await;
        let (id, method, _params) = peer.expect_request().await;
        assert_eq!(method, "thread/fork");
        peer.respond(&id, json!({ "thread": { "id": "child-spawn-fail" } }));
        let (id, method, params) = peer.expect_request().await;
        assert_eq!(method, "thread/archive");
        assert_eq!(params["threadId"], json!("child-spawn-fail"));
        peer.respond(&id, json!({}));

        // Post-archive containment (fresh-eyes F6): the spawn failure replies on the
        // sink AND best-effort unarchives the child on the PARENT client, restoring the
        // child's original visibility (post-owner-exit resume stays possible).
        let (id, method, params) = peer.expect_request().await;
        assert_eq!(method, "thread/unarchive");
        assert_eq!(params["threadId"], json!("child-spawn-fail"));
        peer.respond(&id, json!({}));
        driver.await.expect("fork task");
        std::env::remove_var("CODEX_CMD");
        std::env::remove_var("FAKE_CODEX_APP_SERVER_BEHAVIOR");

        assert_single_fork_error_frame(
            &captured_frames(&captured),
            "parent-spawn-fail",
            "INTERNAL_ERROR",
            "spawn failed",
        );
        assert!(st.sessions.lock().await.len() == 1, "no child registered");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn handle_fork_child_unarchive_failure_replies_and_best_effort_unarchives_the_child() {
        let _guard = ENV_LOCK.lock().await;
        configure_fake_codex_cmd(
            &json!({
                "overrides": {
                    "thread/unarchive": { "error": { "code": -32000, "message": "unarchive kaput" } }
                }
            })
            .to_string(),
        );

        let (st, _rx_boot) = state_with_bus();
        let (transport, peer) = freshell_codex::new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect(transport);
        insert_fake_session(
            &st,
            "parent-ua-fail",
            Arc::new(client),
            Arc::new(StdMutex::new(None)),
            spawn_sleeper(),
            "codex-sidecar-test-fork-ua-fail",
        )
        .await;

        let (sink, captured) = capturing_sink();
        let driver = {
            let st = st.clone();
            tokio::spawn(async move {
                st.handle_fork(fork_msg("parent-ua-fail", "fork-req-u", None), sink)
                    .await;
            })
        };

        answer_initialize(&peer).await;
        let (id, method, _params) = peer.expect_request().await;
        assert_eq!(method, "thread/fork");
        peer.respond(&id, json!({ "thread": { "id": "child-ua-fail" } }));
        let (id, method, params) = peer.expect_request().await;
        assert_eq!(method, "thread/archive");
        assert_eq!(params["threadId"], json!("child-ua-fail"));
        peer.respond(&id, json!({}));

        // The child sidecar (a REAL scripted fake) spawns and its thread/unarchive
        // fails — containment: sink error with the step text + the parent's
        // best-effort unarchive of the child.
        let (id, method, params) =
            tokio::time::timeout(std::time::Duration::from_secs(30), peer.expect_request())
                .await
                .expect("the best-effort parent unarchive arrives");
        assert_eq!(method, "thread/unarchive");
        assert_eq!(params["threadId"], json!("child-ua-fail"));
        peer.respond(&id, json!({}));
        driver.await.expect("fork task");

        assert_single_fork_error_frame(
            &captured_frames(&captured),
            "parent-ua-fail",
            "INTERNAL_ERROR",
            "unarchive kaput",
        );
        assert!(st.sessions.lock().await.len() == 1, "no child registered");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn handle_fork_child_resume_failure_replies_and_best_effort_unarchives_the_child() {
        let _guard = ENV_LOCK.lock().await;
        configure_fake_codex_cmd(
            &json!({
                "overrides": {
                    "thread/resume": { "error": { "code": -32600, "message": "resume kaput" } }
                }
            })
            .to_string(),
        );

        let (st, _rx_boot) = state_with_bus();
        let (transport, peer) = freshell_codex::new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect(transport);
        insert_fake_session(
            &st,
            "parent-resume-fail",
            Arc::new(client),
            Arc::new(StdMutex::new(None)),
            spawn_sleeper(),
            "codex-sidecar-test-fork-resume-fail",
        )
        .await;

        let (sink, captured) = capturing_sink();
        let driver = {
            let st = st.clone();
            tokio::spawn(async move {
                st.handle_fork(fork_msg("parent-resume-fail", "fork-req-r", None), sink)
                    .await;
            })
        };

        answer_initialize(&peer).await;
        let (id, method, _params) = peer.expect_request().await;
        assert_eq!(method, "thread/fork");
        peer.respond(&id, json!({ "thread": { "id": "child-resume-fail" } }));
        let (id, method, params) = peer.expect_request().await;
        assert_eq!(method, "thread/archive");
        assert_eq!(params["threadId"], json!("child-resume-fail"));
        peer.respond(&id, json!({}));

        // Child sidecar spawns, unarchive succeeds, thread/resume fails → containment.
        let (id, method, params) =
            tokio::time::timeout(std::time::Duration::from_secs(30), peer.expect_request())
                .await
                .expect("the best-effort parent unarchive arrives");
        assert_eq!(method, "thread/unarchive");
        assert_eq!(params["threadId"], json!("child-resume-fail"));
        peer.respond(&id, json!({}));
        driver.await.expect("fork task");

        assert_single_fork_error_frame(
            &captured_frames(&captured),
            "parent-resume-fail",
            "INTERNAL_ERROR",
            "resume kaput",
        );
        assert!(st.sessions.lock().await.len() == 1, "no child registered");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn handle_fork_threads_fork_archive_then_child_unarchive_resume_across_two_sidecars_and_replies_forked(
    ) {
        let _guard = ENV_LOCK.lock().await;
        let log_path = std::env::temp_dir().join(format!(
            "freshell-fork-oplog-{}-{}.jsonl",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::remove_file(&log_path);
        configure_fake_codex_cmd(
            &json!({
                "overrides": {
                    "thread/fork": { "result": { "thread": { "id": "child-thread-1" } } }
                },
                "appendThreadOperationLogPath": log_path.to_string_lossy(),
            })
            .to_string(),
        );
        let (st, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        let parent_id = create_real_fake_session(&st, &mut rx).await;

        let (sink, captured) = capturing_sink();
        st.handle_fork(fork_msg(&parent_id, "fork-req-1", None), sink)
            .await;

        // The exact `freshAgent.forked` reply — every field, request_id echoed (the
        // client matches on requestId + parentSessionId to repoint the pane).
        let frames = captured_frames(&captured);
        assert_eq!(frames.len(), 1, "exactly one sink frame: {frames:?}");
        let forked = &frames[0];
        assert_eq!(forked["type"], "freshAgent.forked", "{forked}");
        assert_eq!(forked["requestId"], json!("fork-req-1"), "{forked}");
        assert_eq!(forked["parentSessionId"], json!(parent_id), "{forked}");
        assert_eq!(forked["sessionId"], json!("child-thread-1"), "{forked}");
        assert_eq!(forked["sessionType"], json!("freshcodex"), "{forked}");
        assert_eq!(forked["provider"], json!("codex"), "{forked}");
        assert_eq!(forked["runtimeProvider"], json!("codex"), "{forked}");
        assert_eq!(
            forked["sessionRef"],
            json!({ "provider": "codex", "sessionId": "child-thread-1" }),
            "{forked}"
        );

        // The child is registered on its OWN sidecar (one-thread-per-sidecar
        // invariant), inheriting the parent's stored settings verbatim.
        let (child_settings, parent_settings) = {
            let guard = st.sessions.lock().await;
            let child = guard
                .get("child-thread-1")
                .expect("the child session is registered");
            let parent = guard.get(&parent_id).expect("the parent session stays");
            (
                (
                    child.model.clone(),
                    child.effort.clone(),
                    child.cwd.clone(),
                    child.sandbox.clone(),
                    child.permission_mode.clone(),
                ),
                (
                    parent.model.clone(),
                    parent.effort.clone(),
                    parent.cwd.clone(),
                    parent.sandbox.clone(),
                    parent.permission_mode.clone(),
                ),
            )
        };
        assert_eq!(
            child_settings, parent_settings,
            "the child inherits the parent's stored settings verbatim"
        );

        // P1.13: a binding row durable-before-answer for the child.
        {
            let bindings = fake.bindings.lock().expect("bindings mutex");
            let row = bindings
                .iter()
                .find(|b| b.session_id == "child-thread-1")
                .expect("a binding row for the child");
            assert_eq!(row.provider, "codex");
            assert_eq!(row.mode, "freshcodex");
            assert_eq!(row.create_request_id, None, "fork is not a create");
        }

        // RPC call order, per connection (the op log tags every thread/* call with
        // its process's listenUrl): parent = thread/start → thread/fork →
        // thread/archive; child (spawn #2) = thread/unarchive → thread/resume.
        //
        // Read with a bounded poll: the fake appends each op line AFTER sending the
        // RPC result (adjacent statements in the same event-loop tick), so under
        // parallel-suite load the fake child process can be descheduled between the
        // two while the resumed `handle_fork` races ahead to this read (observed once
        // as a missing trailing `thread/resume` line in a 480-test parallel run — a
        // test-read race, never a handler-ordering defect). Poll until both
        // connection sequences settle to the exact expected value, then run the
        // original assertions for their diagnostic output.
        let read_sequences = || -> Option<(String, Vec<Vec<String>>)> {
            let log_text = std::fs::read_to_string(&log_path).expect("the op log exists");
            let mut by_url: HashMap<String, Vec<String>> = HashMap::new();
            for line in log_text.lines() {
                let entry: Value = serde_json::from_str(line).expect("op log line parses");
                by_url
                    .entry(entry["listenUrl"].as_str().expect("listenUrl").to_string())
                    .or_default()
                    .push(entry["method"].as_str().expect("method").to_string());
            }
            if by_url.len() != 2 {
                return None;
            }
            let mut sequences: Vec<Vec<String>> = by_url.into_values().collect();
            sequences.sort();
            Some((log_text, sequences))
        };
        let settled = |s: &[Vec<String>]| {
            s.len() == 2
                && s[0] == ["thread/start", "thread/fork", "thread/archive"]
                && s[1] == ["thread/unarchive", "thread/resume"]
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let (log_text, sequences) = loop {
            if let Some((text, sequences)) = read_sequences() {
                if settled(&sequences) {
                    break (text, sequences);
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "the op log never settled to exactly two sidecar connections (parent \
                 + one child spawn) with the expected RPC order: {}",
                read_sequences()
                    .map(|(text, _)| text)
                    .unwrap_or_else(|| "<unreadable>".to_string())
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        };
        assert_eq!(
            sequences[0],
            vec!["thread/start", "thread/fork", "thread/archive"],
            "the parent connection's RPC order: {log_text}"
        );
        assert_eq!(
            sequences[1],
            vec!["thread/unarchive", "thread/resume"],
            "the child sidecar's RPC order (the archive→unarchive→resume handoff): {log_text}"
        );

        let _ = std::fs::remove_file(&log_path);
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

    fn attach_msg(session_id: &str) -> FreshAgentAttach {
        FreshAgentAttach {
            provider: freshell_protocol::AgentProvider::Codex,
            session_id: session_id.to_string(),
            session_type: freshell_protocol::SessionType::Freshcodex,
            cwd: None,
            resume_session_id: None,
            session_ref: None,
        }
    }

    /// THE FIX (defect 2): a thread id outside the live in-memory map -- e.g. a page
    /// reload re-attaching a fresh-agent pane's WS session after a server restart --
    /// must NOT be declared lost. It must be resumed on demand (same mechanism as
    /// `snapshot_runtime_for`), registered, and rehydrated with a real idle snapshot.
    #[tokio::test]
    async fn handle_attach_unknown_session_resumes_via_fake_app_server_and_registers_idle_snapshot()
    {
        let _guard = ENV_LOCK.lock().await;
        configure_fake_codex_cmd("{}");
        let (st, mut rx) = state_with_bus();

        st.handle_attach(attach_msg("historical-thread-attach"))
            .await;

        let frame: Value = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let raw = rx.recv().await.expect("bus stays open");
                let frame: Value = serde_json::from_str(&raw).unwrap();
                if frame["type"] == "freshAgent.event" {
                    return frame;
                }
            }
        })
        .await
        .expect("attach resumes and emits a session frame within the budget");

        assert_eq!(frame["sessionId"], "historical-thread-attach");
        assert_eq!(frame["event"]["type"], "freshAgent.session.snapshot");
        assert_eq!(frame["event"]["status"], "idle");
        assert_ne!(
            frame["event"]["code"], "INVALID_SESSION_ID",
            "a resumable historical thread must never be declared lost"
        );

        assert!(
            st.sessions
                .lock()
                .await
                .contains_key("historical-thread-attach"),
            "the resumed thread must be registered for reuse by a later send/attach"
        );
    }

    /// Decision-table row: NOT tracked + the app-server says the thread genuinely doesn't
    /// exist -> `lost_session_frame` (`INVALID_SESSION_ID`) is still the right outcome --
    /// the fix must not turn every unknown id into a false "it's fine" resume.
    #[tokio::test]
    async fn handle_attach_unknown_session_with_genuinely_missing_thread_emits_lost_session_error()
    {
        let _guard = ENV_LOCK.lock().await;
        configure_fake_codex_cmd(
            &json!({
                "overrides": {
                    "thread/resume": {
                        "error": { "code": -32001, "message": "Thread not found" }
                    }
                }
            })
            .to_string(),
        );
        let (st, mut rx) = state_with_bus();

        st.handle_attach(attach_msg("truly-does-not-exist")).await;

        let frame: Value = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let raw = rx.recv().await.expect("bus stays open");
                let frame: Value = serde_json::from_str(&raw).unwrap();
                if frame["type"] == "freshAgent.event" {
                    return frame;
                }
            }
        })
        .await
        .expect("attach resolves within the budget");

        assert_eq!(frame["sessionId"], "truly-does-not-exist");
        assert_eq!(frame["event"]["type"], "freshAgent.error");
        assert_eq!(frame["event"]["code"], "INVALID_SESSION_ID");
    }

    /// Decision-table row: NOT tracked + a transient resume failure (sidecar unreachable,
    /// not a "this thread doesn't exist" answer) -> a `CODEX_ATTACH_RESUME_FAILED` error,
    /// NEVER `INVALID_SESSION_ID` -- a transient infra hiccup must not cause the client to
    /// abandon an otherwise-healthy durable session via `markSessionLost`.
    #[tokio::test]
    async fn handle_attach_unknown_session_with_transient_resume_failure_emits_resume_failed_error()
    {
        let _guard = ENV_LOCK.lock().await;
        std::env::set_var(
            "CODEX_CMD",
            "/definitely/not/a/real/codex/binary-xyz-does-not-exist",
        );
        std::env::remove_var("FAKE_CODEX_APP_SERVER_BEHAVIOR");
        let (st, mut rx) = state_with_bus();

        st.handle_attach(attach_msg("historical-thread-transient"))
            .await;
        std::env::remove_var("CODEX_CMD");

        let frame: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(frame["type"], "error");
        assert!(
            frame["message"]
                .as_str()
                .unwrap()
                .starts_with("CODEX_ATTACH_RESUME_FAILED:"),
            "{frame}"
        );
    }

    /// The single-flight guard (`FreshCodexState::resuming`): two concurrent
    /// `freshAgent.attach` calls for the SAME unknown thread id (the exact race the
    /// investigation identified between an attach and a racing snapshot read) must
    /// serialize onto ONE `thread/resume` RPC / one spawned sidecar, not two.
    #[tokio::test]
    async fn handle_attach_single_flights_concurrent_resumes_for_the_same_unknown_thread() {
        let _guard = ENV_LOCK.lock().await;
        let log_path = std::env::temp_dir().join(format!(
            "codex-resume-single-flight-{}-{}.jsonl",
            std::process::id(),
            now_ms()
        ));
        let _ = std::fs::remove_file(&log_path);
        configure_fake_codex_cmd(
            &json!({
                "delayMethodsMs": { "thread/resume": 300 },
                "appendThreadOperationLogPath": log_path.to_str().unwrap(),
            })
            .to_string(),
        );
        let (st, mut rx) = state_with_bus();

        let st1 = st.clone();
        let st2 = st.clone();
        tokio::join!(
            st1.handle_attach(attach_msg("racey-thread")),
            st2.handle_attach(attach_msg("racey-thread")),
        );

        let mut idle_snapshots = 0;
        while let Ok(raw) = rx.try_recv() {
            let frame: Value = serde_json::from_str(&raw).unwrap();
            assert_ne!(
                frame["event"]["code"], "INVALID_SESSION_ID",
                "neither concurrent attach should be told the thread is lost"
            );
            if frame["event"]["type"] == "freshAgent.session.snapshot" {
                idle_snapshots += 1;
            }
        }
        assert_eq!(
            idle_snapshots, 2,
            "both concurrent attaches observe a real session snapshot"
        );

        // The fake app-server's log write (`fs.appendFileSync`, a side effect in a
        // SEPARATE OS process) is not synchronized with this client observing the RPC
        // response that unblocks `handle_attach` -- the two happen over independent
        // kernel channels (the TCP response vs. the disk write), so reading the log
        // exactly once immediately after `join!` returns can observe it before the
        // write lands. Poll briefly for content instead of asserting on a single read.
        let log = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let content = std::fs::read_to_string(&log_path).unwrap_or_default();
                if !content.is_empty() {
                    return content;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap_or_default();
        let resume_count = log
            .lines()
            .filter(|l| l.contains("\"thread/resume\""))
            .count();
        assert_eq!(
            resume_count, 1,
            "expected exactly one thread/resume RPC to reach the fake app-server, log: {log}"
        );
        assert_eq!(
            st.sessions.lock().await.len(),
            1,
            "only one session is registered for the racing thread id"
        );

        std::fs::remove_file(&log_path).ok();
    }

    /// WIRE-SHAPE PARITY: attaching to a tracked, still-alive session (no crash, no
    /// respawn) must be a pure no-op on the wire -- NO frame at all -- matching the
    /// reference's `attach()` (`adapter.ts:871-874`), which only remembers thread settings
    /// and never pushes an event. This replaces the two former tests
    /// (`handle_attach_known_session_emits_{running,idle}_snapshot_when_*`), which asserted
    /// the OLD, over-eager behavior the fresh-agent wire-shape differential capture
    /// (`test/unit/port/oracle/freshagent-wireshape-differential.test.ts`) proved diverges
    /// from the original: the differential showed an identical `create -> send ->
    /// turn-complete` sequence on both servers, then the Rust port ALONE emitted one extra
    /// `freshAgent.event{event.type:'freshAgent.session.snapshot'}` frame after `attach`.
    #[tokio::test]
    async fn handle_attach_known_alive_session_emits_no_frame_regardless_of_turn_state() {
        for active_turn in [Some("turn-1".to_string()), None] {
            let (transport, _peer) = freshell_codex::new_channel_transport();
            let (client, _notifs) = CodexAppServerClient::connect(transport);
            let client = Arc::new(client);

            let (st, mut rx) = state_with_bus();
            insert_fake_session(
                &st,
                "thread-1",
                client,
                Arc::new(StdMutex::new(active_turn)),
                spawn_sleeper(),
                "codex-sidecar-test-attach-no-frame",
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

            assert!(
                rx.try_recv().is_err(),
                "attach to a tracked, alive session must broadcast nothing (byte-parity with \
                 the reference's no-op attach()), regardless of whether a turn is active"
            );
        }
    }

    /// Task 5 (R3): a restart/reload resume of a thread the ledger holds a full settings
    /// record for must reapply model/sandbox/permission/effort -- on the registered
    /// session AND on the `thread/resume` RPC itself (the wire is the contract).
    #[tokio::test(flavor = "multi_thread")]
    async fn resume_after_restart_reapplies_settings_from_ledger() {
        let _guard = ENV_LOCK.lock().await;
        let op_log = tempfile::NamedTempFile::new().unwrap();
        configure_fake_codex_cmd(
            &json!({ "appendThreadOperationLogPath": op_log.path().to_str().unwrap() }).to_string(),
        );
        let (state, _bus) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        fake.seed(
            "codex",
            "thread-9",
            crate::identity_sink::FreshAgentSettings {
                model: Some("gpt-5.3-codex-spark".into()),
                sandbox: Some("workspace-write".into()),
                permission_mode: Some("on-request".into()),
                effort: Some("high".into()),
                cwd: Some("/w".into()),
            },
        );
        state.set_identity_sink(fake.clone());

        // Simulate the restart path exactly as the existing R3 tests above do
        // (`handle_attach_unknown_session_*`): attach to "thread-9", which is NOT in
        // the in-memory map.
        state.handle_attach(attach_msg("thread-9")).await;

        // (1) The registered session carries the recovered settings:
        let sessions = state.sessions.lock().await;
        let s = sessions.get("thread-9").expect("session registered");
        assert_eq!(s.model, "gpt-5.3-codex-spark");
        assert_eq!(s.sandbox.as_deref(), Some("workspace-write"));
        assert_eq!(s.permission_mode.as_deref(), Some("on-request"));
        assert_eq!(s.effort.as_deref(), Some("high"));
        drop(sessions);

        // The fake app-server's log write lands from a SEPARATE OS process (see the
        // single-flight test above) -- poll briefly for it before the one real read.
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !std::fs::read_to_string(op_log.path())
                .unwrap_or_default()
                .contains("\"thread/resume\"")
            {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("thread/resume reaches the fake app-server's op log");

        // (2) The thread/resume RPC itself carried them (the wire is the contract):
        let log = std::fs::read_to_string(op_log.path()).unwrap();
        let resume_line = log
            .lines()
            .find(|l| l.contains("\"thread/resume\""))
            .expect("thread/resume logged");
        let entry: serde_json::Value = serde_json::from_str(resume_line).unwrap();
        assert_eq!(entry["params"]["model"], "gpt-5.3-codex-spark");
        assert_eq!(entry["params"]["sandbox"], "workspace-write");
    }

    /// V7/A10: record misses are ROUTINE (pre-ship sessions, sidebar-opened historical
    /// threads -- R3 exists FOR them, see `snapshot_runtime_for`'s doc). They must
    /// resume silently with defaults exactly as today, and must NOT launder a defaults
    /// row into the ledger. Permanent regression guard for V7's no-spam rule.
    #[tokio::test(flavor = "multi_thread")]
    async fn resume_of_a_never_recorded_session_is_silent_and_writes_no_defaults_row() {
        let _guard = ENV_LOCK.lock().await;
        configure_fake_codex_cmd("{}");
        let (state, mut bus_rx) = state_with_bus();
        // Deliberately empty: no record, no snapshot.
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        state.set_identity_sink(fake.clone());

        // Same R3 entry point as above for an untracked "thread-x".
        state.handle_attach(attach_msg("thread-x")).await;

        // Bounded drain: NO SETTINGS_RESET frame may appear.
        while let Ok(frame) =
            tokio::time::timeout(std::time::Duration::from_secs(1), bus_rx.recv()).await
        {
            let Ok(text) = frame else { break };
            assert!(
                !text.contains("SETTINGS_RESET"),
                "never-recorded resume must stay silent"
            );
        }
        // No defaults laundering (V7 §2): no binding row was written for thread-x.
        assert!(
            !fake
                .bindings
                .lock()
                .unwrap()
                .iter()
                .any(|b| b.session_id == "thread-x"),
            "a load_settings miss must not write a defaults row"
        );
    }

    /// The genuine anomaly: the ledger PROVES prior fresh-agent recording, yet no
    /// snapshot is recoverable -- the only case that alarms (V7/A10).
    #[tokio::test(flavor = "multi_thread")]
    async fn resume_with_a_prior_record_but_unrecoverable_settings_alarms_settings_reset() {
        let _guard = ENV_LOCK.lock().await;
        configure_fake_codex_cmd("{}");
        let (state, mut bus_rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        fake.seed_recorded_only("codex", "thread-y"); // was_recorded=true, load_settings=None
        state.set_identity_sink(fake);

        // Same R3 entry point, attaching untracked "thread-y".
        state.handle_attach(attach_msg("thread-y")).await;

        let mut found = false;
        while let Ok(frame) =
            tokio::time::timeout(std::time::Duration::from_secs(2), bus_rx.recv()).await
        {
            let Ok(text) = frame else { break };
            if text.contains("SETTINGS_RESET") {
                // A2 qualification (V1): the frame must carry top-level
                // sessionType/provider and a user-facing message.
                assert!(text.contains("freshcodex") && text.contains("codex"));
                assert!(text.contains("Reconfirm your settings"));
                found = true;
                break;
            }
        }
        assert!(
            found,
            "recorded-but-unrecoverable resume must broadcast SETTINGS_RESET"
        );
    }

    /// REVIEW FIX (Minor, item 3): `fail_create`'s `freshAgent.create.failed` frame must
    /// carry `retryable: true`, matching legacy's hardcoded `retryable: true` on every
    /// create-failed path this port's `fail_create` corresponds to (`ws-handler.ts:3334`
    /// the disabled-gate rejection, `ws-handler.ts:3403` the generic create-failure
    /// catch-all). The client reads this field to decide whether to offer a retry action
    /// (`src/lib/fresh-agent-ws.ts:141`, `FreshAgentView.tsx:1889`'s retry button), so an
    /// omitted field (what `retryable: None` serializes to -- serde's
    /// `skip_serializing_if`) silently hid that action from every Rust-server user.
    /// Exercised via the same "sidecar unreachable" path
    /// `handle_attach_unknown_session_with_transient_resume_failure_emits_resume_failed_error`
    /// uses above, but through `handle_create` (`CODEX_APP_SERVER_START_FAILED`) --
    /// deterministic and fast, no fake app-server needed.
    #[tokio::test]
    async fn fail_create_frame_carries_retryable_true() {
        let _guard = ENV_LOCK.lock().await;
        std::env::set_var(
            "CODEX_CMD",
            "/definitely/not/a/real/codex/binary-xyz-does-not-exist",
        );
        std::env::remove_var("FAKE_CODEX_APP_SERVER_BEHAVIOR");
        let (st, mut rx) = state_with_bus();

        st.handle_create(FreshAgentCreate {
            request_id: "req-retryable-1".to_string(),
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
        std::env::remove_var("CODEX_CMD");

        let frame: Value = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
                if frame["type"] == "freshAgent.create.failed" {
                    return frame;
                }
            }
        })
        .await
        .expect("the unreachable-sidecar create failure resolves within the budget");

        assert_eq!(
            frame["code"], "CODEX_APP_SERVER_START_FAILED",
            "sanity: this must be the sidecar-spawn-failure path, not some other \
             create.failed cause: {frame}"
        );
        assert_eq!(
            frame["retryable"], true,
            "freshAgent.create.failed must carry retryable:true, matching legacy's \
             hardcoded retryable:true on every create-failed path this port's fail_create \
             corresponds to: {frame}"
        );
    }

    // -- freshAgent.create requestId dedup (reconnect-spam parity gap fix) --

    /// Helper: a minimal `FreshAgentCreate` for the dedup tests, varying only
    /// `request_id`.
    fn create_msg(request_id: &str) -> FreshAgentCreate {
        FreshAgentCreate {
            request_id: request_id.to_string(),
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
        }
    }

    /// Count `freshagent.sidecar.spawned` events recorded since `capture` started.
    fn spawn_count(capture: &tracing_capture::GlobalCapture) -> usize {
        capture
            .untagged_events_since_start()
            .into_iter()
            .filter(|e| e.message == "freshagent.sidecar.spawned")
            .count()
    }

    /// Drain `rx` until the `freshAgent.created` (or `.create.failed`) frame for
    /// `request_id` arrives.
    async fn await_created(
        rx: &mut tokio::sync::broadcast::Receiver<String>,
        request_id: &str,
    ) -> Value {
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
                if (frame["type"] == "freshAgent.created"
                    || frame["type"] == "freshAgent.create.failed")
                    && frame["requestId"] == request_id
                {
                    return frame;
                }
            }
        })
        .await
        .unwrap_or_else(|_| {
            panic!("freshAgent.created for {request_id} resolves within the budget")
        })
    }

    /// THE regression this task fixes: the frozen client resends `freshAgent.create`
    /// with the SAME `requestId` on every reconnect while a pane is `status==creating`
    /// (no client-side in-flight guard, `FreshAgentView.tsx`). Without server-side dedup
    /// (legacy's `withFreshAgentCreateLock` + `createdFreshAgentByRequestId`,
    /// `ws-handler.ts:568-569,1027-1050,3359-3425`), a flappy connection mints one
    /// `codex app-server` sidecar/session PER resend. Two SEQUENTIAL `create`s sharing a
    /// `requestId` must produce exactly ONE session and ONE sidecar spawn -- the second
    /// response must carry the SAME `sessionId` as the first (a replay), not a new one.
    #[tokio::test]
    async fn handle_create_duplicate_request_id_reuses_the_session_and_spawns_once() {
        let _guard = ENV_LOCK.lock().await;
        configure_fake_codex_cmd("{}");
        let (st, mut rx) = state_with_bus();
        let capture = tracing_capture::capture_by_session("dedup-sequential-marker-unused");

        st.handle_create(create_msg("req-dedup-seq")).await;
        let first = await_created(&mut rx, "req-dedup-seq").await;
        assert_eq!(
            first["type"], "freshAgent.created",
            "sanity: first create must succeed: {first}"
        );
        let first_session_id = first["sessionId"].as_str().unwrap().to_string();

        st.handle_create(create_msg("req-dedup-seq")).await;
        let second = await_created(&mut rx, "req-dedup-seq").await;

        assert_eq!(
            second["type"], "freshAgent.created",
            "the replay response must be a normal freshAgent.created frame: {second}"
        );
        assert_eq!(
            second["sessionId"], first_session_id,
            "a duplicate requestId must replay the SAME session, not mint a new one: {second}"
        );
        assert_eq!(
            spawn_count(&capture),
            1,
            "two sequential creates sharing a requestId must spawn the codex app-server \
             sidecar exactly once (the reconnect-spam duplicate-session parity gap)"
        );
    }

    /// The concurrent variant of the sequential test above: two GENUINELY CONCURRENT
    /// `create`s sharing a `requestId` (e.g. two reconnect-races landing back to back)
    /// must still spawn at most one sidecar and both resolve to the SAME session --
    /// single-flight serialization, not just cache-hit-after-the-fact.
    #[tokio::test]
    async fn handle_create_concurrent_duplicate_request_id_spawns_at_most_once() {
        let _guard = ENV_LOCK.lock().await;
        configure_fake_codex_cmd("{}");
        let (st, mut rx) = state_with_bus();
        let capture = tracing_capture::capture_by_session("dedup-concurrent-marker-unused");

        let st1 = st.clone();
        let st2 = st.clone();
        tokio::join!(
            st1.handle_create(create_msg("req-dedup-race")),
            st2.handle_create(create_msg("req-dedup-race")),
        );

        let first = await_created(&mut rx, "req-dedup-race").await;
        let second = await_created(&mut rx, "req-dedup-race").await;
        let first_id = first["sessionId"].as_str().unwrap();
        let second_id = second["sessionId"].as_str().unwrap();

        assert_eq!(
            first_id, second_id,
            "both racing creates for the same requestId must resolve to the SAME session: \
             {first} / {second}"
        );
        assert_eq!(
            spawn_count(&capture),
            1,
            "two CONCURRENT creates racing on the same requestId must spawn the codex \
             app-server sidecar exactly once"
        );
    }

    /// Control: DISTINCT requestIds must never dedup against each other -- each is a
    /// genuinely separate create, so this must still spawn once per request and produce
    /// two distinct sessions.
    #[tokio::test]
    async fn handle_create_distinct_request_ids_create_distinct_sessions() {
        let _guard = ENV_LOCK.lock().await;
        let (st, mut rx) = state_with_bus();
        let capture = tracing_capture::capture_by_session("dedup-distinct-marker-unused");

        // The fake fixture's `thread/start` returns a FIXED default id
        // (`'thread-new-1'`, `fake-app-server.mjs:191`) absent an override -- configure a
        // distinct `threadStartThreadId` per call so this test proves "distinct
        // requestIds -> distinct sessions" on its own merits, not on an accident of the
        // fixture's default.
        configure_fake_codex_cmd(r#"{"threadStartThreadId":"thread-dedup-a"}"#);
        st.handle_create(create_msg("req-dedup-a")).await;
        let a = await_created(&mut rx, "req-dedup-a").await;

        configure_fake_codex_cmd(r#"{"threadStartThreadId":"thread-dedup-b"}"#);
        st.handle_create(create_msg("req-dedup-b")).await;
        let b = await_created(&mut rx, "req-dedup-b").await;

        assert_ne!(
            a["sessionId"], b["sessionId"],
            "distinct requestIds must never replay each other's session: {a} / {b}"
        );
        assert_eq!(
            spawn_count(&capture),
            2,
            "two distinct requestIds must spawn the sidecar once each (dedup must not \
             over-suppress unrelated creates)"
        );
    }

    /// Edge case (task-specified): a REPLAY after the cached session has ALREADY EXITED
    /// on its own (not via `freshAgent.kill`) must re-serve the SAME dead session id, not
    /// spawn a new one. Legacy has no hook from an unrequested sidecar exit to
    /// `clearFreshAgentCreateCachesForSession` -- that eviction runs ONLY from the
    /// `freshAgent.kill` handler (`ws-handler.ts:3673`) -- so a duplicate `create` after a
    /// natural crash replays the dead session's id byte-for-byte, matching legacy exactly
    /// rather than "helpfully" minting a fresh one.
    #[tokio::test]
    async fn handle_create_replay_after_unrequested_exit_reuses_the_dead_session_no_new_spawn() {
        let _guard = ENV_LOCK.lock().await;
        configure_fake_codex_cmd(r#"{"exitProcessAfterMethodsOnce":["thread/start"]}"#);
        let (st, mut rx) = state_with_bus();
        let capture = tracing_capture::capture_by_session("dedup-post-exit-marker-unused");

        st.handle_create(create_msg("req-dedup-exit")).await;
        let created = await_created(&mut rx, "req-dedup-exit").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        wait_for_self_heal(&st, &mut rx, &session_id).await;
        assert_eq!(
            spawn_count(&capture),
            1,
            "sanity: exactly one spawn before the replay attempt"
        );

        // Reset so a genuinely NEW spawn (if the bug regresses) would succeed cleanly --
        // isolating the assertion below to "did dedup replay?" rather than "did the fake
        // app-server fail?".
        configure_fake_codex_cmd("{}");

        st.handle_create(create_msg("req-dedup-exit")).await;
        let replay = await_created(&mut rx, "req-dedup-exit").await;

        assert_eq!(
            replay["sessionId"], session_id,
            "a replay after an UNREQUESTED exit must re-serve the SAME (dead) session id: \
             {replay}"
        );
        assert_eq!(
            spawn_count(&capture),
            1,
            "a replay after an unrequested exit must NOT spawn a new sidecar (legacy has \
             no unrequested-exit cache-eviction hook)"
        );
    }

    /// Cache invalidation (task-specified): an EXPLICIT `freshAgent.kill` DOES evict the
    /// requestId dedup cache (`clearFreshAgentCreateCachesForSession`,
    /// `ws-handler.ts:1044-1050`, called from `ws-handler.ts:3673`) -- unlike the
    /// unrequested-exit case above, a duplicate `create` for the SAME requestId after an
    /// explicit kill must genuinely mint a fresh session (a new spawn), not replay the
    /// killed one.
    #[tokio::test]
    async fn handle_create_duplicate_after_explicit_kill_creates_a_fresh_session() {
        let _guard = ENV_LOCK.lock().await;
        let (st, mut rx) = state_with_bus();
        let capture = tracing_capture::capture_by_session("dedup-post-kill-marker-unused");

        configure_fake_codex_cmd(r#"{"threadStartThreadId":"thread-dedup-kill-1"}"#);
        st.handle_create(create_msg("req-dedup-kill")).await;
        let created = await_created(&mut rx, "req-dedup-kill").await;
        let killed_session_id = created["sessionId"].as_str().unwrap().to_string();

        st.handle_kill(FreshAgentKill {
            provider: freshell_protocol::AgentProvider::Codex,
            session_id: killed_session_id.clone(),
            session_type: freshell_protocol::SessionType::Freshcodex,
            cwd: None,
        })
        .await;

        // Distinct thread id (`fake-app-server.mjs:191` returns a FIXED default
        // absent an override) so a genuine re-create is provably distinguishable from
        // an accidental fixture coincidence, not just from a cache replay.
        configure_fake_codex_cmd(r#"{"threadStartThreadId":"thread-dedup-kill-2"}"#);
        st.handle_create(create_msg("req-dedup-kill")).await;
        let recreated = await_created(&mut rx, "req-dedup-kill").await;

        assert_ne!(
            recreated["sessionId"], killed_session_id,
            "a duplicate create after an EXPLICIT kill must mint a fresh session, not \
             replay the killed one: {recreated}"
        );
        assert_eq!(
            spawn_count(&capture),
            2,
            "the kill must evict the dedup cache, so the duplicate create genuinely \
             re-spawns"
        );
    }

    // -- freshAgent.created-vs-session.snapshot wire-shape ordering (oracle flake fix) --

    /// THE wireshape-oracle ordering flake this task fixes
    /// (`test/unit/port/oracle/freshagent-wireshape-differential.test.ts`, ~1-in-3):
    /// `finish_create` used to spawn the notification consumer BEFORE broadcasting
    /// `freshAgent.created` -- a genuine race between the consumer task processing an
    /// already-arrived `ThreadStarted` notification (the fake app-server broadcasts it
    /// synchronously right after the `thread/start` RPC response,
    /// `fake-app-server.mjs:506-511`, so it can already be buffered on the notification
    /// channel by the time the consumer starts) and the main task's own
    /// `broadcast(FreshAgentCreated)` a few lines later. Legacy structurally cannot
    /// exhibit this: the per-session lifecycle listener that would translate
    /// `thread_started` into a status snapshot is attached (`ensureFreshAgentSubscription`
    /// -> `adapter.ts subscribe()`) strictly AFTER `freshAgent.created` is sent
    /// (`ws-handler.ts:3378` then `:3387`), so it cannot observe an event that fired
    /// before it existed. Run many independent creates and assert `created` always
    /// precedes any `freshAgent.event` for that session -- this reproduced the race
    /// roughly 1-in-3 before the fix and must be 0-in-N after it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn handle_create_always_broadcasts_created_before_any_session_event() {
        let _guard = ENV_LOCK.lock().await;
        let (st, mut rx) = state_with_bus();

        for i in 0..30 {
            let request_id = format!("req-order-{i}");
            configure_fake_codex_cmd(&format!(r#"{{"threadStartThreadId":"thread-order-{i}"}}"#));
            st.handle_create(create_msg(&request_id)).await;

            // Settle window: give the (possibly-racing) consumer task a chance to run
            // and broadcast its first status-snapshot event, if it's going to.
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;

            let mut created_seen = false;
            let mut violation: Option<Value> = None;
            let mut session_id: Option<String> = None;
            while let Ok(frame) = rx.try_recv() {
                let wire: Value = serde_json::from_str(&frame).unwrap();
                if wire["type"] == "freshAgent.created" && wire["requestId"] == request_id {
                    created_seen = true;
                    session_id = wire["sessionId"].as_str().map(|s| s.to_string());
                } else if !created_seen && wire["type"] == "freshAgent.event" {
                    violation = Some(wire);
                }
            }
            assert!(
                created_seen,
                "iteration {i}: freshAgent.created must have been broadcast for {request_id}"
            );
            assert!(
                violation.is_none(),
                "iteration {i}: a freshAgent.event arrived BEFORE freshAgent.created: \
                 {violation:?}"
            );

            if let Some(session_id) = session_id {
                st.handle_kill(FreshAgentKill {
                    provider: freshell_protocol::AgentProvider::Codex,
                    session_id,
                    session_type: freshell_protocol::SessionType::Freshcodex,
                    cwd: None,
                })
                .await;
                // Drain the killed frame (+ any trailing notification) so the next
                // iteration starts from an empty buffer.
                while rx.try_recv().is_ok() {}
            }
        }
    }

    // -- freshAgent.create resume (CODEX-FIRST triage Finding 1) --

    /// FINDING 1 (CODEX-FIRST triage): `freshAgent.create` carrying a provider-matched
    /// `sessionRef` must RESUME the existing thread (mirroring the reference's
    /// resume-first create path, `runtime-manager.ts:103-112` -> `adapter.ts:843-869`),
    /// never mint a brand-new one. The fake app-server's `thread/start` is configured to
    /// return an OBVIOUSLY WRONG id (`thread-should-never-be-minted`) so a passing
    /// assertion on the requested resume id proves `thread/resume` was used, not
    /// `thread/start`.
    #[tokio::test]
    async fn handle_create_with_session_ref_resumes_the_same_thread() {
        let _guard = ENV_LOCK.lock().await;
        configure_fake_codex_cmd(r#"{"threadStartThreadId":"thread-should-never-be-minted"}"#);
        let (st, mut rx) = state_with_bus();

        st.handle_create(FreshAgentCreate {
            request_id: "req-resume-1".to_string(),
            session_type: freshell_protocol::SessionType::Freshcodex,
            provider: Some(freshell_protocol::AgentProvider::Codex),
            cwd: None,
            legacy_restore_context: None,
            resume_session_id: None,
            session_ref: Some(freshell_protocol::SessionLocator {
                provider: "codex".to_string(),
                session_id: "thread-existing-durable".to_string(),
            }),
            model: None,
            model_selection: None,
            permission_mode: None,
            sandbox: None,
            effort: None,
            plugins: None,
        })
        .await;

        let frame: Value = tokio::time::timeout(std::time::Duration::from_secs(15), async {
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
            frame["type"], "freshAgent.created",
            "resuming an existing thread must succeed: {frame}"
        );
        assert_eq!(
            frame["sessionId"], "thread-existing-durable",
            "create-with-resume must preserve the CALLER's thread id, never mint a new one \
             (thread/start would have returned thread-should-never-be-minted): {frame}"
        );
        assert!(
            st.sessions
                .lock()
                .await
                .contains_key("thread-existing-durable"),
            "the resumed thread must be registered under its ORIGINAL id"
        );
    }

    /// Node parity (`runtime-manager.ts:106-108`): a `freshAgent.create` whose
    /// ONLY identity is a provider-matched `sessionRef` must resume the thread
    /// exactly like the legacy `resumeSessionId` carrier. Same wrong-mint
    /// canary as the sessionRef resume test above: `thread/start` is pinned to an
    /// obviously wrong id, so a passing sessionId assertion proves
    /// `thread/resume` was used.
    #[tokio::test]
    async fn handle_create_with_session_ref_only_resumes_the_same_thread() {
        let _guard = ENV_LOCK.lock().await;
        configure_fake_codex_cmd(r#"{"threadStartThreadId":"thread-should-never-be-minted"}"#);
        let (st, mut rx) = state_with_bus();

        st.handle_create(FreshAgentCreate {
            request_id: "req-sref-resume-1".to_string(),
            session_type: freshell_protocol::SessionType::Freshcodex,
            provider: Some(freshell_protocol::AgentProvider::Codex),
            cwd: None,
            legacy_restore_context: None,
            resume_session_id: None,
            session_ref: Some(freshell_protocol::SessionLocator {
                provider: "codex".to_string(),
                session_id: "thread-existing-durable".to_string(),
            }),
            model: None,
            model_selection: None,
            permission_mode: None,
            sandbox: None,
            effort: None,
            plugins: None,
        })
        .await;

        let frame: Value = tokio::time::timeout(std::time::Duration::from_secs(15), async {
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
            frame["type"], "freshAgent.created",
            "resuming via sessionRef must succeed: {frame}"
        );
        assert_eq!(
            frame["sessionId"], "thread-existing-durable",
            "sessionRef-only create must resume the CALLER's thread id, never mint a new one: {frame}"
        );
        assert!(
            st.sessions
                .lock()
                .await
                .contains_key("thread-existing-durable"),
            "the resumed thread must be registered under its ORIGINAL id"
        );
    }

    /// FINDING 1 (CODEX-FIRST triage): when the caller-supplied resume id is
    /// genuinely gone (`thread/resume` reports "not found"), the legacy reference has NO
    /// mint-new fallback inside `freshAgent.create`'s resume branch -- `runtime-manager.ts:
    /// 103-112` propagates the adapter's `resume()` failure unwrapped, and
    /// `ws-handler.ts:3388-3405`'s generic catch turns it into `freshAgent.create.failed`
    /// with the generic `FRESH_AGENT_CREATE_FAILED` code (the RPC error's numeric `.code`
    /// never satisfies the `typeof error.code === 'string'` guard). This port mirrors that:
    /// an error to the client, never a silently-minted fresh thread, and never a
    /// `lost_session_frame` (that shape is exclusive to `freshAgent.attach`).
    #[tokio::test]
    async fn handle_create_with_resume_on_genuinely_missing_thread_emits_create_failed() {
        let _guard = ENV_LOCK.lock().await;
        configure_fake_codex_cmd(
            &json!({
                "overrides": {
                    "thread/resume": {
                        "error": { "code": -32001, "message": "Thread not found" }
                    }
                }
            })
            .to_string(),
        );
        let (st, mut rx) = state_with_bus();

        st.handle_create(FreshAgentCreate {
            request_id: "req-resume-2".to_string(),
            session_type: freshell_protocol::SessionType::Freshcodex,
            provider: Some(freshell_protocol::AgentProvider::Codex),
            cwd: None,
            legacy_restore_context: None,
            resume_session_id: None,
            session_ref: Some(freshell_protocol::SessionLocator {
                provider: "codex".to_string(),
                session_id: "thread-truly-gone".to_string(),
            }),
            model: None,
            model_selection: None,
            permission_mode: None,
            sandbox: None,
            effort: None,
            plugins: None,
        })
        .await;

        let frame: Value = tokio::time::timeout(std::time::Duration::from_secs(15), async {
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
            frame["type"], "freshAgent.create.failed",
            "a genuinely-missing resume target must fail create, never silently mint a \
             fresh session: {frame}"
        );
        assert_eq!(frame["requestId"], "req-resume-2");
        assert_eq!(
            frame["code"], "FRESH_AGENT_CREATE_FAILED",
            "legacy's generic ws-handler.ts:3395-3397 fallback code (the RPC error's numeric \
             .code never satisfies the `typeof === 'string'` guard): {frame}"
        );
        assert!(
            !st.sessions.lock().await.contains_key("thread-truly-gone"),
            "no session may be registered for a resume target that was never actually created"
        );
    }

    // -- TERM-25: wrong-thread resume rejection --

    /// TERM-25 (restore-matrix SCENARIO 7): when `thread/resume` answers with a DIFFERENT
    /// thread id than the one requested, the create-with-resume path must REJECT the
    /// mismatch loudly -- `freshAgent.create.failed` to the client, no session registered
    /// under EITHER id, never a silent proceed against the wrong thread.
    #[tokio::test]
    async fn handle_create_with_resume_wrong_thread_id_fails_create_and_never_adopts() {
        let _guard = ENV_LOCK.lock().await;
        configure_fake_codex_cmd(r#"{"threadResumeThreadId":"thread-B-wrong"}"#);
        let (st, mut rx) = state_with_bus();

        st.handle_create(FreshAgentCreate {
            request_id: "req-term25-create".to_string(),
            session_type: freshell_protocol::SessionType::Freshcodex,
            provider: Some(freshell_protocol::AgentProvider::Codex),
            cwd: None,
            legacy_restore_context: None,
            resume_session_id: None,
            session_ref: Some(freshell_protocol::SessionLocator {
                provider: "codex".to_string(),
                session_id: "thread-A-requested".to_string(),
            }),
            model: None,
            model_selection: None,
            permission_mode: None,
            sandbox: None,
            effort: None,
            plugins: None,
        })
        .await;

        let frame: Value = tokio::time::timeout(std::time::Duration::from_secs(15), async {
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
            frame["type"], "freshAgent.create.failed",
            "a wrong-thread resume answer must fail the create loudly, never proceed \
             against the wrong thread: {frame}"
        );
        assert_eq!(frame["requestId"], "req-term25-create");
        assert_eq!(frame["code"], "FRESH_AGENT_CREATE_FAILED");
        let message = frame["message"].as_str().unwrap_or_default();
        assert!(
            message.contains("thread-B-wrong") && message.contains("thread-A-requested"),
            "the rejection must name BOTH ids so the mismatch is diagnosable: {frame}"
        );
        let sessions = st.sessions.lock().await;
        assert!(
            !sessions.contains_key("thread-A-requested"),
            "the requested id must not be registered against a sidecar on the wrong thread"
        );
        assert!(
            !sessions.contains_key("thread-B-wrong"),
            "the wrong thread id must never be adopted"
        );
    }

    /// TERM-25 (restore-matrix SCENARIO 7): the not-tracked `freshAgent.attach` resume
    /// path (`ensure_session_resumable`) must likewise reject a wrong-thread answer --
    /// a `CODEX_ATTACH_RESUME_FAILED` error (transient shape, so the frozen client keeps
    /// the durable identity instead of abandoning it), never an idle snapshot that
    /// silently binds the pane to a sidecar sitting on the wrong thread.
    #[tokio::test]
    async fn handle_attach_unknown_session_wrong_thread_id_is_rejected_not_adopted() {
        let _guard = ENV_LOCK.lock().await;
        configure_fake_codex_cmd(r#"{"threadResumeThreadId":"thread-B-wrong"}"#);
        let (st, mut rx) = state_with_bus();

        st.handle_attach(attach_msg("thread-A-requested")).await;

        let frame: Value = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
                if frame["type"] == "error" || frame["type"] == "freshAgent.event" {
                    return frame;
                }
            }
        })
        .await
        .expect("attach resolves within the budget");

        assert_eq!(
            frame["type"], "error",
            "a wrong-thread resume answer must surface as an error, never a session \
             snapshot adopting the wrong thread: {frame}"
        );
        let message = frame["message"].as_str().unwrap_or_default();
        assert!(
            message.starts_with("CODEX_ATTACH_RESUME_FAILED:"),
            "wrong-thread is a resume failure (transient shape -- the client must keep \
             the durable identity), got: {frame}"
        );
        assert!(
            message.contains("thread-B-wrong") && message.contains("thread-A-requested"),
            "the rejection must name BOTH ids so the mismatch is diagnosable: {frame}"
        );
        let sessions = st.sessions.lock().await;
        assert!(
            !sessions.contains_key("thread-A-requested"),
            "the requested id must not be registered against a sidecar on the wrong thread"
        );
        assert!(
            !sessions.contains_key("thread-B-wrong"),
            "the wrong thread id must never be adopted"
        );
    }

    /// TERM-25 (restore-matrix SCENARIO 7): crash recovery (`ensure_session_alive`'s
    /// resume-first path) must also reject a wrong-thread answer -- the tracked session's
    /// recovery fails loudly (`CODEX_ATTACH_RESPAWN_FAILED` on the attach surface) instead
    /// of silently re-registering the ORIGINAL id against a sidecar on the wrong thread.
    #[tokio::test]
    async fn crash_recovery_resume_wrong_thread_id_is_rejected_not_silently_recovered() {
        let _guard = ENV_LOCK.lock().await;
        configure_fake_codex_cmd(r#"{"threadResumeThreadId":"thread-B-wrong"}"#);
        let (st, mut rx) = state_with_bus();

        // A dead in-process client + a child that exits immediately: the exit-watcher
        // flips `exited`, so the next attach takes the crash-recovery resume path.
        let (transport, _peer) = freshell_codex::new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect(transport);
        let mut cmd = tokio::process::Command::new("true");
        cmd.kill_on_drop(true);
        let child = cmd.spawn().expect("spawn true fixture");
        insert_fake_session(
            &st,
            "thread-A-crashed",
            Arc::new(client),
            Arc::new(StdMutex::new(None)),
            child,
            "codex-sidecar-test-term25-recovery",
        )
        .await;

        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let exited = st
                    .sessions
                    .lock()
                    .await
                    .get("thread-A-crashed")
                    .map(|s| s.exited.load(Ordering::SeqCst))
                    .unwrap_or(false);
                if exited {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("the exit-watcher observes the crash within the budget");

        st.handle_attach(attach_msg("thread-A-crashed")).await;

        let frame: Value = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
                if frame["type"] == "error" {
                    return frame;
                }
            }
        })
        .await
        .expect("attach resolves within the budget");

        let message = frame["message"].as_str().unwrap_or_default();
        assert!(
            message.starts_with("CODEX_ATTACH_RESPAWN_FAILED:"),
            "wrong-thread crash recovery must fail the respawn loudly, got: {frame}"
        );
        assert!(
            message.contains("thread-B-wrong") && message.contains("thread-A-crashed"),
            "the rejection must name BOTH ids so the mismatch is diagnosable: {frame}"
        );
        assert!(
            !st.sessions.lock().await.contains_key("thread-B-wrong"),
            "the wrong thread id must never be adopted"
        );
    }

    // -- dead-thread negative cache (CODEX-FIRST triage Finding 2) --

    /// Unit-level: [`FreshCodexState::mark_thread_dead`]/[`FreshCodexState::is_known_dead_thread`]/
    /// [`FreshCodexState::clear_dead_thread`] in isolation, no sidecar involved.
    #[tokio::test]
    async fn dead_thread_cache_marks_checks_and_clears() {
        let (st, _rx) = state_with_bus();

        assert!(
            !st.is_known_dead_thread("cache-unit-t1").await,
            "a thread never marked dead must not be reported dead"
        );

        st.mark_thread_dead("cache-unit-t1").await;
        assert!(
            st.is_known_dead_thread("cache-unit-t1").await,
            "a freshly-marked thread must be reported dead within its TTL"
        );

        st.clear_dead_thread("cache-unit-t1").await;
        assert!(
            !st.is_known_dead_thread("cache-unit-t1").await,
            "an explicit clear (a successful resume/create) must remove the entry \
             immediately, not wait for its TTL to elapse"
        );
    }

    /// Unit-level: an entry stops being reported dead once its TTL elapses.
    #[tokio::test]
    async fn dead_thread_cache_entry_expires_after_its_ttl() {
        let (mut st, _rx) = state_with_bus();
        st.dead_thread_ttl = std::time::Duration::from_millis(20);

        st.mark_thread_dead("cache-unit-t2").await;
        assert!(st.is_known_dead_thread("cache-unit-t2").await);

        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
        assert!(
            !st.is_known_dead_thread("cache-unit-t2").await,
            "an entry must stop being reported dead once its TTL has elapsed"
        );
    }

    /// REVIEW FIX (Minor, item 2): the negative cache must never grow without bound.
    /// Marking many more distinct thread ids dead than [`DEAD_THREADS_CAP`] must keep the
    /// map's size at or under the cap -- a long-lived process that resumes many distinct,
    /// never-re-queried dead ids over its lifetime must not leak memory for that map for
    /// the life of the process.
    #[tokio::test]
    async fn dead_thread_cache_is_bounded_by_a_hard_cap() {
        let (st, _rx) = state_with_bus();

        for i in 0..(DEAD_THREADS_CAP + 50) {
            st.mark_thread_dead(&format!("cap-unit-thread-{i}")).await;
        }

        let len = st.dead_threads.lock().await.len();
        assert!(
            len <= DEAD_THREADS_CAP,
            "dead_threads must never exceed its hard cap of {DEAD_THREADS_CAP}, got {len}"
        );
    }

    /// FINDING 2 (CODEX-FIRST triage, empirically proven ~3 spawn/kill cycles PER SECOND): a
    /// client retrying `freshAgent.attach` against a permanently-dead thread id (no
    /// client-side backoff) must NOT spawn a fresh `codex app-server` sidecar on every
    /// attempt -- `ensure_session_resumable` fails fast against the negative cache after the
    /// FIRST resume genuinely proves the thread gone, so N sequential attempts spawn AT MOST
    /// once.
    #[tokio::test]
    async fn handle_attach_repeated_dead_thread_spawns_sidecar_at_most_once() {
        let _guard = ENV_LOCK.lock().await;
        configure_fake_codex_cmd(
            &json!({
                "overrides": {
                    "thread/resume": {
                        "error": { "code": -32001, "message": "Thread not found" }
                    }
                }
            })
            .to_string(),
        );
        let (st, mut rx) = state_with_bus();
        let capture = tracing_capture::capture_by_session("finding-2-storm-marker-unused");

        for attempt in 0..5 {
            st.handle_attach(attach_msg("thread-permanently-dead"))
                .await;

            let frame: Value = tokio::time::timeout(std::time::Duration::from_secs(15), async {
                loop {
                    let raw = rx.recv().await.expect("bus stays open");
                    let frame: Value = serde_json::from_str(&raw).unwrap();
                    if frame["type"] == "freshAgent.event" {
                        return frame;
                    }
                }
            })
            .await
            .unwrap_or_else(|_| panic!("attempt {attempt} resolves within the budget"));
            assert_eq!(frame["event"]["code"], "INVALID_SESSION_ID");
        }

        let spawn_count = capture
            .untagged_events_since_start()
            .into_iter()
            .filter(|e| e.message == "freshagent.sidecar.spawned")
            .count();
        assert_eq!(
            spawn_count, 1,
            "5 sequential attaches against a permanently-dead thread must spawn the codex \
             app-server sidecar exactly once, not once per attempt (the storm this fix bounds)"
        );
    }

    /// FINDING 2 (CODEX-FIRST triage): the negative cache must not be permanent -- once its
    /// TTL elapses, a later attach against the SAME (now-resumable) thread id must genuinely
    /// retry: a second sidecar spawn, a real `thread/resume`, and success.
    #[tokio::test]
    async fn handle_attach_dead_thread_retries_genuinely_after_cache_ttl_expires() {
        let _guard = ENV_LOCK.lock().await;
        configure_fake_codex_cmd(
            &json!({
                "overrides": {
                    "thread/resume": {
                        "error": { "code": -32001, "message": "Thread not found" }
                    }
                }
            })
            .to_string(),
        );
        let (mut st, mut rx) = state_with_bus();
        st.dead_thread_ttl = std::time::Duration::from_millis(50);
        let capture = tracing_capture::capture_by_session("finding-2-expiry-marker-unused");

        st.handle_attach(attach_msg("thread-temporarily-dead"))
            .await;
        let first: Value = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let raw = rx.recv().await.expect("bus stays open");
                let frame: Value = serde_json::from_str(&raw).unwrap();
                if frame["type"] == "freshAgent.event" {
                    return frame;
                }
            }
        })
        .await
        .expect("first attach resolves within the budget");
        assert_eq!(first["event"]["code"], "INVALID_SESSION_ID");

        tokio::time::sleep(std::time::Duration::from_millis(150)).await;

        // Now the thread is genuinely resumable.
        configure_fake_codex_cmd("{}");

        st.handle_attach(attach_msg("thread-temporarily-dead"))
            .await;
        let second: Value = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let raw = rx.recv().await.expect("bus stays open");
                let frame: Value = serde_json::from_str(&raw).unwrap();
                if frame["type"] == "freshAgent.event" {
                    return frame;
                }
            }
        })
        .await
        .expect("second attach resolves within the budget");
        assert_eq!(
            second["event"]["type"], "freshAgent.session.snapshot",
            "after the negative-cache TTL elapses, a retry must genuinely resume: {second}"
        );
        assert!(
            st.sessions
                .lock()
                .await
                .contains_key("thread-temporarily-dead"),
            "the retried resume must register the session for reuse"
        );

        let spawn_count = capture
            .untagged_events_since_start()
            .into_iter()
            .filter(|e| e.message == "freshagent.sidecar.spawned")
            .count();
        assert_eq!(
            spawn_count, 2,
            "expiry must allow a genuine SECOND spawn attempt (not permanently blocked): \
             {spawn_count}"
        );
    }

    /// REVIEW FIX (Important, item 1): two GENUINELY CONCURRENT attaches racing against a
    /// thread this process has NOT YET cached as dead must still spawn AT MOST ONE
    /// sidecar. The per-thread `resuming` lock alone does not guarantee this: the FIRST
    /// waiter marks the thread dead and releases the lock, but if the SECOND waiter (on
    /// acquiring the now-free lock) only re-checks `live_resumed_session` -- never
    /// resumable for a dead thread -- and NOT `is_known_dead_thread`, it repeats the
    /// FIRST waiter's entire spawn/resume/fail cycle instead of failing fast against the
    /// cache the first waiter just populated. `ensure_session_resumable`'s doc comment
    /// has long claimed the dead-cache is "checked before AND after acquiring the
    /// per-thread lock" -- this test is what makes that claim true instead of aspirational.
    #[tokio::test]
    async fn concurrent_attaches_against_a_not_yet_cached_dead_thread_spawn_at_most_one_sidecar() {
        let _guard = ENV_LOCK.lock().await;
        configure_fake_codex_cmd(
            &json!({
                // Widens the race window: while the FIRST waiter's resume is in flight,
                // the SECOND waiter has time to finish acquiring (and blocking on) the
                // per-thread lock, so it's guaranteed to be woken only AFTER the first
                // waiter has marked the thread dead and released the lock.
                "delayMethodsMs": { "thread/resume": 300 },
                "overrides": {
                    "thread/resume": {
                        "error": { "code": -32001, "message": "Thread not found" }
                    }
                }
            })
            .to_string(),
        );
        let (st, mut rx) = state_with_bus();
        let capture =
            tracing_capture::capture_by_session("concurrent-dead-thread-race-marker-unused");

        let st1 = st.clone();
        let st2 = st.clone();
        tokio::join!(
            st1.handle_attach(attach_msg("thread-race-not-yet-dead")),
            st2.handle_attach(attach_msg("thread-race-not-yet-dead")),
        );

        // Both racing attaches must resolve honestly (the thread really is gone), never
        // hang, never silently succeed.
        for _ in 0..2 {
            let frame: Value = tokio::time::timeout(std::time::Duration::from_secs(15), async {
                loop {
                    let raw = rx.recv().await.expect("bus stays open");
                    let frame: Value = serde_json::from_str(&raw).unwrap();
                    if frame["type"] == "freshAgent.event" {
                        return frame;
                    }
                }
            })
            .await
            .expect("both racing attaches resolve within the budget");
            assert_eq!(frame["event"]["code"], "INVALID_SESSION_ID");
        }

        let spawn_count = capture
            .untagged_events_since_start()
            .into_iter()
            .filter(|e| e.message == "freshagent.sidecar.spawned")
            .count();
        assert_eq!(
            spawn_count, 1,
            "two GENUINELY CONCURRENT attaches racing the per-thread lock against a \
             not-yet-cached dead thread must spawn the codex app-server sidecar exactly \
             once -- the second waiter must fail fast against the dead-cache the first \
             populated, not repeat the full spawn-resume-fail cycle: {spawn_count}"
        );
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

    const ISOLATED_CODEX_ENV_KEYS: [&str; 5] = [
        "CODEX_HOME",
        "CODEX_CMD",
        "FAKE_CODEX_APP_SERVER_BEHAVIOR",
        "FAKE_CODEX_APP_SERVER_ARG_LOG",
        "FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES",
    ];

    /// Serializes tests that mutate Codex process-global environment and gives every holder
    /// an explicit temporary `CODEX_HOME` plus the fake app-server's fixture-only write opt-in.
    /// Every variable a holder may mutate is snapshotted and restored by the guard, including
    /// during unwinding, so test ordering cannot leak configuration or durable fake sessions.
    pub(crate) struct IsolatedCodexEnvLock {
        inner: tokio::sync::Mutex<()>,
    }

    pub(crate) struct IsolatedCodexEnvGuard<'a> {
        _lock: tokio::sync::MutexGuard<'a, ()>,
        previous_env: Vec<(&'static str, Option<std::ffi::OsString>)>,
        _codex_home: tempfile::TempDir,
    }

    impl IsolatedCodexEnvLock {
        const fn new() -> Self {
            Self {
                inner: tokio::sync::Mutex::const_new(()),
            }
        }

        fn install<'a>(&self, lock: tokio::sync::MutexGuard<'a, ()>) -> IsolatedCodexEnvGuard<'a> {
            let codex_home = tempfile::tempdir().expect("create isolated Codex test home");
            let previous_env = ISOLATED_CODEX_ENV_KEYS
                .iter()
                .map(|key| (*key, std::env::var_os(key)))
                .collect();
            std::env::set_var("CODEX_HOME", codex_home.path());
            std::env::set_var("FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES", "1");
            IsolatedCodexEnvGuard {
                _lock: lock,
                previous_env,
                _codex_home: codex_home,
            }
        }

        pub(crate) async fn lock(&self) -> IsolatedCodexEnvGuard<'_> {
            self.install(self.inner.lock().await)
        }

        pub(crate) fn blocking_lock(&self) -> IsolatedCodexEnvGuard<'_> {
            self.install(self.inner.blocking_lock())
        }
    }

    impl Drop for IsolatedCodexEnvGuard<'_> {
        fn drop(&mut self) {
            for (key, value) in self.previous_env.drain(..) {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    pub(crate) static ENV_LOCK: IsolatedCodexEnvLock = IsolatedCodexEnvLock::new();

    const CODEX_ENV_UNWIND_CHILD: &str = "FRESHELL_CODEX_ENV_UNWIND_CHILD";

    #[test]
    fn isolated_codex_env_restores_every_mutated_variable_during_unwind() {
        // `ENV_LOCK` coordinates every test that deliberately configures the Codex
        // sidecar, but production-shaped tests in sibling modules may legitimately read
        // these variables without taking the test-only lock. Exercise wholesale mutation
        // in a one-test child process so the panic-safety proof cannot transiently poison
        // those readers when libtest runs this suite in parallel.
        if std::env::var_os(CODEX_ENV_UNWIND_CHILD).is_none() {
            let output = std::process::Command::new(
                std::env::current_exe().expect("resolve current freshagent test binary"),
            )
            .args([
                "--exact",
                "codex::tests::isolated_codex_env_restores_every_mutated_variable_during_unwind",
                "--nocapture",
            ])
            .env(CODEX_ENV_UNWIND_CHILD, "1")
            .output()
            .expect("run isolated Codex environment unwind test");
            assert!(
                output.status.success(),
                "isolated Codex environment unwind child failed\nstdout:\n{}\nstderr:\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr),
            );
            return;
        }

        let original: Vec<_> = ISOLATED_CODEX_ENV_KEYS
            .iter()
            .map(std::env::var_os)
            .collect();
        let mut installed_opt_in = None;
        let mut installed_home = None;

        let unwind = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = ENV_LOCK.blocking_lock();
            installed_opt_in = std::env::var_os("FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES");
            installed_home = std::env::var_os("CODEX_HOME").map(std::path::PathBuf::from);
            for (index, key) in ISOLATED_CODEX_ENV_KEYS.iter().enumerate() {
                std::env::set_var(key, format!("mutated-by-unwind-test-{index}"));
            }
            panic!("exercise panic-safe environment restoration");
        }));

        let after_unwind: Vec<_> = ISOLATED_CODEX_ENV_KEYS
            .iter()
            .map(std::env::var_os)
            .collect();
        // Restore eagerly before asserting so a RED run cannot contaminate another test process.
        for (key, value) in ISOLATED_CODEX_ENV_KEYS.iter().zip(original.iter()) {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }

        assert!(unwind.is_err(), "the test closure must unwind");
        assert_eq!(installed_opt_in.as_deref(), Some(std::ffi::OsStr::new("1")));
        assert!(
            !installed_home.expect("guard installs CODEX_HOME").exists(),
            "the temporary Codex home must be removed during unwinding"
        );
        assert_eq!(after_unwind, original);
    }

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

    /// Task 4 (P1.13): a healthy create writes a fresh-agent binding row (provider
    /// `codex`, mode `freshcodex`, FULL settings snapshot) through the identity sink
    /// at thread/start -- the ledger row a restarted server later resumes from.
    #[tokio::test(flavor = "multi_thread")]
    async fn create_records_fresh_agent_binding_with_settings() {
        let _guard = ENV_LOCK.lock().await;
        configure_fake_codex_cmd("{}");
        let (state, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        state.set_identity_sink(fake.clone());

        // Drive a real create through the fake app server, requesting explicit
        // settings -- `create_real_fake_session` doesn't accept settings, so this
        // inlines the same `freshAgent.create` the existing create tests send.
        let tmp_cwd = std::env::temp_dir().to_string_lossy().to_string();
        state
            .handle_create(FreshAgentCreate {
                request_id: "req-bind-1".to_string(),
                session_type: freshell_protocol::SessionType::Freshcodex,
                provider: Some(freshell_protocol::AgentProvider::Codex),
                cwd: Some(tmp_cwd),
                legacy_restore_context: None,
                resume_session_id: None,
                session_ref: None,
                model: Some("gpt-5.3-codex-spark".to_string()),
                model_selection: None,
                permission_mode: Some("on-request".to_string()),
                sandbox: Some(freshell_protocol::Sandbox::WorkspaceWrite),
                effort: Some("high".to_string()),
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
        let thread_id = created["sessionId"].as_str().unwrap().to_string();

        let bindings = fake.bindings.lock().unwrap();
        let b = bindings
            .iter()
            .find(|b| b.session_id == thread_id)
            .expect("binding row written at thread/start");
        assert_eq!(b.provider, "codex");
        assert_eq!(b.mode, "freshcodex");
        assert_eq!(b.settings.model.as_deref(), Some("gpt-5.3-codex-spark"));
        assert_eq!(b.settings.sandbox.as_deref(), Some("workspace-write"));
        assert_eq!(b.settings.permission_mode.as_deref(), Some("on-request"));
        assert_eq!(b.settings.effort.as_deref(), Some("high"));
    }

    /// Task 4 (P1.13, awaited-writes policy): a failed ledger write is surfaced as a
    /// live `freshAgent.error{code:'LEDGER_WRITE_FAILED'}` frame (never a silent
    /// warn-and-drop) AND the create still succeeds -- a write failure never blocks
    /// the identity event.
    #[tokio::test(flavor = "multi_thread")]
    async fn ledger_write_failure_is_surfaced_as_a_live_frame() {
        let _guard = ENV_LOCK.lock().await;
        configure_fake_codex_cmd("{}");
        let (state, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        fake.fail_writes
            .store(true, std::sync::atomic::Ordering::SeqCst);
        state.set_identity_sink(fake.clone());

        state
            .handle_create(FreshAgentCreate {
                request_id: "req-ledger-fail".to_string(),
                session_type: freshell_protocol::SessionType::Freshcodex,
                provider: Some(freshell_protocol::AgentProvider::Codex),
                cwd: None,
                legacy_restore_context: None,
                resume_session_id: None,
                session_ref: None,
                model: Some("gpt-5.3-codex-spark".to_string()),
                model_selection: None,
                permission_mode: None,
                sandbox: None,
                effort: None,
                plugins: None,
            })
            .await;

        // Drain the bus (bounded, as in the alarm tests): both the alarm frame and
        // the created frame must arrive -- in either order.
        let mut failure_frame: Option<Value> = None;
        let mut created_frame: Option<Value> = None;
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
                if frame["type"] == "freshAgent.event"
                    && frame["event"]["code"] == "LEDGER_WRITE_FAILED"
                {
                    failure_frame = Some(frame);
                } else if frame["type"] == "freshAgent.created" {
                    created_frame = Some(frame);
                }
                if failure_frame.is_some() && created_frame.is_some() {
                    return;
                }
            }
        })
        .await
        .expect("a LEDGER_WRITE_FAILED frame AND freshAgent.created arrive within the budget");

        let failure = failure_frame.expect("a LEDGER_WRITE_FAILED frame was broadcast");
        assert_eq!(failure["sessionType"], "freshcodex");
        assert_eq!(failure["provider"], "codex");
        assert_eq!(failure["event"]["type"], "freshAgent.error");
        assert!(
            failure["event"]["message"]
                .as_str()
                .is_some_and(|m| !m.is_empty()),
            "the alarm carries a user-facing message: {failure}"
        );

        // The create still succeeded: the session exists under the created id.
        let created = created_frame.expect("the create still succeeded");
        let thread_id = created["sessionId"].as_str().unwrap().to_string();
        let guard = state.sessions.lock().await;
        assert!(
            guard.contains_key(&thread_id),
            "a write failure never blocks the identity event"
        );
    }

    /// FIX-2 (codex-first triage): crash recovery is resume-first now. The crashed
    /// sidecar respawns, `thread/resume`s the ORIGINAL thread id, and the turn completes
    /// under that SAME id -- no `freshAgent.session.materialized` broadcast (the durable
    /// identity never changed), unlike the old mint-new-thread behavior this test used to
    /// pin (see the removed `assert_ne!(new_thread_id, thread_id, ...)` this replaces).
    #[tokio::test(flavor = "multi_thread")]
    // Intentional: `_guard` is held across every `.await` in this test BY DESIGN, so it
    // serializes against `attach_after_unrequested_crash_recovers_and_emits_a_snapshot`
    // (the other test mutating the process-global `CODEX_CMD`/`FAKE_CODEX_APP_SERVER_BEHAVIOR`
    // env vars) for the test's ENTIRE duration, not just around individual calls.
    async fn send_after_unrequested_crash_resumes_the_same_thread_id_and_completes_with_no_error_frame(
    ) {
        let _guard = ENV_LOCK.lock().await;
        let (st, mut rx) = state_with_bus();

        // The FIRST spawn crashes deterministically right after `thread/start` responds
        // (the fixture's `exitProcessAfterMethodsOnce`) -- a real, observable "the child
        // process exited on its own" crash, not a simulated flag flip.
        configure_fake_codex_cmd(
            r#"{"threadStartThreadId":"thread-original","exitProcessAfterMethodsOnce":["thread/start"]}"#,
        );
        let thread_id = create_real_fake_session(&st, &mut rx).await;
        wait_for_self_heal(&st, &mut rx, &thread_id).await;

        // The respawned sidecar must NOT immediately crash again; `thread/resume` on this
        // fixture always succeeds (echoing back whatever thread id it's asked to resume).
        configure_fake_codex_cmd("{}");

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

        // The turn was accepted under the SAME id, with NO user-facing error frame and NO
        // `freshAgent.session.materialized` broadcast along the way (recovery preserved
        // the durable identity -- conversation memory for this thread is intact).
        let accepted: Value = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
                assert_ne!(
                    frame["type"], "error",
                    "no user-facing error frame: {frame}"
                );
                assert_ne!(
                    frame["type"], "freshAgent.session.materialized",
                    "resume-first recovery must not materialize a new durable identity: {frame}"
                );
                if frame["type"] == "freshAgent.send.accepted" {
                    return frame;
                }
            }
        })
        .await
        .expect("send.accepted arrives within the budget -- the turn actually ran");
        assert_eq!(
            accepted["sessionId"], thread_id,
            "recovery must resume the SAME thread id, not mint a new one"
        );

        // The SAME id is (still) live -- no key change in the session map.
        let guard = st.sessions.lock().await;
        assert!(guard.contains_key(&thread_id));
    }

    /// FIX-2: when the app-server genuinely no longer has the thread (`thread/resume`
    /// fails with a "not found"-shaped error), recovery falls back to the ORIGINAL
    /// mint-new-thread behavior -- a `freshAgent.session.materialized` broadcast under a
    /// brand-new id, conversation memory for the old thread genuinely lost.
    #[tokio::test(flavor = "multi_thread")]
    async fn send_after_crash_falls_back_to_mint_new_thread_when_resume_reports_not_found() {
        let _guard = ENV_LOCK.lock().await;
        let (st, mut rx) = state_with_bus();

        configure_fake_codex_cmd(
            r#"{"threadStartThreadId":"thread-original","exitProcessAfterMethodsOnce":["thread/start"]}"#,
        );
        let thread_id = create_real_fake_session(&st, &mut rx).await;
        wait_for_self_heal(&st, &mut rx, &thread_id).await;

        // The respawned sidecar's `thread/resume` reports the thread as genuinely gone.
        configure_fake_codex_cmd(
            &json!({
                "threadStartThreadId": "thread-respawned",
                "overrides": {
                    "thread/resume": {
                        "error": { "code": -32001, "message": "Thread not found" }
                    }
                }
            })
            .to_string(),
        );

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
        assert_ne!(
            new_thread_id, thread_id,
            "a genuine thread-not-found on resume still mints a fresh thread id"
        );

        let accepted: Value = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
                if frame["type"] == "freshAgent.send.accepted" {
                    return frame;
                }
            }
        })
        .await
        .expect("send.accepted arrives within the budget -- the turn actually ran");
        assert_eq!(accepted["sessionId"], new_thread_id);

        let guard = st.sessions.lock().await;
        assert!(!guard.contains_key(&thread_id));
        assert!(guard.contains_key(&new_thread_id));
    }

    /// P1.13 §2.6b (Task 6): crash respawn discards conversation memory -- that loss must be
    /// user-visible. After the mint-new-thread fallback, a `THREAD_MEMORY_LOST` degradation
    /// frame is broadcast under the NEW thread id, AFTER the
    /// `freshAgent.session.materialized` frame (the frozen client re-keys its session state
    /// on materialized; an error frame emitted first would target an id the client no
    /// longer tracks).
    #[tokio::test(flavor = "multi_thread")]
    async fn send_after_crash_mint_new_thread_broadcasts_thread_memory_lost_after_materialized() {
        let _guard = ENV_LOCK.lock().await;
        let (st, mut rx) = state_with_bus();

        configure_fake_codex_cmd(
            r#"{"threadStartThreadId":"thread-original","exitProcessAfterMethodsOnce":["thread/start"]}"#,
        );
        let thread_id = create_real_fake_session(&st, &mut rx).await;
        wait_for_self_heal(&st, &mut rx, &thread_id).await;

        // The respawned sidecar's `thread/resume` reports the thread as genuinely gone,
        // forcing the mint-new-thread crash-respawn fallback.
        configure_fake_codex_cmd(
            &json!({
                "threadStartThreadId": "thread-respawned",
                "overrides": {
                    "thread/resume": {
                        "error": { "code": -32001, "message": "Thread not found" }
                    }
                }
            })
            .to_string(),
        );

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

        let mut saw_materialized = false;
        let mut new_thread_id = String::new();
        let mut degradation_after_materialized = false;
        while let Ok(frame) =
            tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv()).await
        {
            let Ok(text) = frame else { break };
            if text.contains("freshAgent.session.materialized") {
                saw_materialized = true;
                let materialized: Value = serde_json::from_str(&text).unwrap();
                new_thread_id = materialized["sessionId"].as_str().unwrap().to_string();
            }
            if text.contains("THREAD_MEMORY_LOST") {
                assert!(
                    saw_materialized,
                    "degradation frame must follow materialized (client re-keys on it)"
                );
                assert!(
                    text.contains(&new_thread_id),
                    "frame must target the NEW thread id"
                );
                degradation_after_materialized = true;
                break;
            }
        }
        assert!(
            degradation_after_materialized,
            "crash respawn must broadcast a user-visible degradation frame"
        );
    }

    /// FIX-2: a resume failure that is NOT "thread not found" (a transient RPC error) must
    /// NOT silently mint a new thread -- it reports `CODEX_RESPAWN_FAILED` and leaves the
    /// session mapped under its OLD id, still marked exited, for a future retry (mirroring
    /// the pre-existing `RespawnFailed` contract for a `thread/start` failure).
    #[tokio::test(flavor = "multi_thread")]
    async fn send_after_crash_with_transient_resume_failure_reports_respawn_failed_and_stays_exited(
    ) {
        let _guard = ENV_LOCK.lock().await;
        let (st, mut rx) = state_with_bus();

        configure_fake_codex_cmd(r#"{"exitProcessAfterMethodsOnce":["thread/start"]}"#);
        let thread_id = create_real_fake_session(&st, &mut rx).await;
        wait_for_self_heal(&st, &mut rx, &thread_id).await;

        // A transient failure (NOT a "not found"-shaped message) on EVERY `thread/resume`
        // attempt -- the first (with settings) AND the retry (with settings dropped).
        configure_fake_codex_cmd(
            &json!({
                "overrides": {
                    "thread/resume": {
                        "error": { "code": -32000, "message": "internal error: sidecar unreachable" }
                    }
                }
            })
            .to_string(),
        );

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

        let frame: Value = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
                if frame["type"] == "error" {
                    return frame;
                }
            }
        })
        .await
        .expect("an error frame arrives within the budget");
        assert!(
            frame["message"]
                .as_str()
                .unwrap()
                .starts_with("CODEX_RESPAWN_FAILED:"),
            "{frame}"
        );

        // Still mapped under the OLD id, still exited -- ripe for a future retry.
        let guard = st.sessions.lock().await;
        let session = guard.get(&thread_id).expect("session stays mapped");
        assert!(session.exited.load(Ordering::SeqCst));
    }

    /// FIX-2: `freshAgent.attach` recovering a crashed session emits its fresh snapshot
    /// under the SAME thread id (resume-first), not a new one.
    #[tokio::test(flavor = "multi_thread")]
    async fn attach_after_unrequested_crash_resumes_and_emits_a_snapshot_with_the_same_id() {
        let _guard = ENV_LOCK.lock().await;
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

        let frame: Value = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
                assert_ne!(
                    frame["type"], "error",
                    "attach recovers or reports honestly, never hangs silently: {frame}"
                );
                assert_ne!(
                    frame["type"], "freshAgent.session.materialized",
                    "resume-first recovery must not materialize a new durable identity: {frame}"
                );
                if frame["type"] == "freshAgent.event" {
                    return frame;
                }
            }
        })
        .await
        .expect("attach recovers within the budget");

        assert_eq!(frame["event"]["type"], "freshAgent.session.snapshot");
        assert_eq!(
            frame["sessionId"], thread_id,
            "the post-recovery snapshot must carry the SAME thread id"
        );
    }

    /// FIX-2: a `freshAgent.send` and a `freshAgent.attach` racing on the SAME crashed
    /// session must recover it exactly once -- one spawned sidecar, one `thread/resume`
    /// RPC -- never two independent respawns.
    #[tokio::test(flavor = "multi_thread")]
    async fn concurrent_send_and_attach_single_flight_recovery_for_the_same_crashed_session() {
        let _guard = ENV_LOCK.lock().await;
        let (st, mut rx) = state_with_bus();

        configure_fake_codex_cmd(r#"{"exitProcessAfterMethodsOnce":["thread/start"]}"#);
        let thread_id = create_real_fake_session(&st, &mut rx).await;
        wait_for_self_heal(&st, &mut rx, &thread_id).await;

        // A small delay on `thread/resume` widens the race window between the two
        // concurrent recovery attempts below.
        configure_fake_codex_cmd(
            &json!({ "delayMethodsMs": { "thread/resume": 200 } }).to_string(),
        );

        let st_send = st.clone();
        let send_thread_id = thread_id.clone();
        let send_task = tokio::spawn(async move {
            st_send
                .handle_send(FreshAgentSend {
                    request_id: Some("req-race-send".to_string()),
                    provider: freshell_protocol::AgentProvider::Codex,
                    session_id: send_thread_id,
                    session_type: freshell_protocol::SessionType::Freshcodex,
                    text: "racing send".to_string(),
                    images: None,
                    cwd: None,
                    settings: None,
                })
                .await;
        });

        let st_attach = st.clone();
        let attach_thread_id = thread_id.clone();
        let attach_task = tokio::spawn(async move {
            st_attach
                .handle_attach(FreshAgentAttach {
                    provider: freshell_protocol::AgentProvider::Codex,
                    session_id: attach_thread_id,
                    session_type: freshell_protocol::SessionType::Freshcodex,
                    cwd: None,
                    resume_session_id: None,
                    session_ref: None,
                })
                .await;
        });

        let (send_res, attach_res) = tokio::join!(send_task, attach_task);
        send_res.expect("send task doesn't panic");
        attach_res.expect("attach task doesn't panic");

        // Exactly one recovered session is live under the original id -- if two
        // concurrent respawns had raced past the single-flight guard, this thread id
        // would have been resumed twice (two sidecars), and the fixture's per-process
        // `activeThreadIds` bookkeeping / a duplicate resume would surface as an error
        // frame on the bus. Assert none arrived, and the session is alive.
        let mut saw_send_accepted = false;
        let timeout = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
                assert_ne!(
                    frame["type"], "error",
                    "no user-facing error frame from either racing caller: {frame}"
                );
                if frame["type"] == "freshAgent.send.accepted" {
                    saw_send_accepted = true;
                    break;
                }
            }
        })
        .await;
        assert!(timeout.is_ok(), "send.accepted arrives within the budget");
        assert!(saw_send_accepted);

        let guard = st.sessions.lock().await;
        assert!(
            guard.contains_key(&thread_id),
            "the single recovered session is live under the original id"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    // Intentional: same rationale as the sibling test above -- `_guard` must span every
    // `.await` in this test to serialize the two tests' shared env-var mutations.
    async fn attach_after_unrequested_crash_recovers_and_emits_a_snapshot() {
        let _guard = ENV_LOCK.lock().await;
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

    /// Read the fake app-server's cross-process op log once `want_rows` newline rows have
    /// landed (bounded poll). WHY THE POLL: the fixture SENDS each RPC result BEFORE
    /// appending the op row (same event-loop tick, `fake-app-server.mjs:697-701`), so a
    /// handler that resolves on the result can return with the last row not yet on disk
    /// (`handle_compact`'s final await IS the `thread/compact/start` result — zero
    /// slack); a read-once is a measured flake here (reproduced 4/13 runs pre-poll).
    async fn read_op_log_when_complete(log_path: &std::path::Path, want_rows: usize) -> String {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            match std::fs::read_to_string(log_path) {
                Ok(text) if text.lines().count() >= want_rows => return text,
                other => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "op log never reached {want_rows} rows within the budget: {other:?}"
                    );
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }

    /// Whole-branch review M-2: a Compact click on a crash-stale session (sidecar died
    /// unrequested; the self-heal design keeps the session MAPPED) must transparently
    /// respawn the sidecar FIRST — the `handle_send` ensure-alive precedent, and legacy's
    /// `ensureRuntime(sessionId, settings)` before compact (`adapter.ts:1030`) — then issue
    /// the compact RPC on the RESPAWNED sidecar. Dying loudly against the dead connection
    /// is reserved for genuinely unrespawnable sessions, not garden-variety crash-stale
    /// panes. Spawn-counting + the cross-process op log pin the recovery leg.
    #[tokio::test]
    async fn compact_after_unrequested_crash_respawns_the_sidecar_then_compacts() {
        let _guard = ENV_LOCK.lock().await;
        let log_path = std::env::temp_dir().join(format!(
            "freshell-compact-respawn-oplog-{}-{}.jsonl",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::remove_file(&log_path);
        let (st, mut rx) = state_with_bus();
        let capture = tracing_capture::capture_by_session("compact-respawn-marker-unused");

        // Spawn 1 crashes right after `thread/start` — a real unrequested-exit crash.
        configure_fake_codex_cmd(
            &json!({
                "exitProcessAfterMethodsOnce": ["thread/start"],
                "appendThreadOperationLogPath": log_path.to_string_lossy(),
            })
            .to_string(),
        );
        let thread_id = create_real_fake_session(&st, &mut rx).await;
        wait_for_self_heal(&st, &mut rx, &thread_id).await;
        assert_eq!(
            spawn_count(&capture),
            1,
            "sanity: exactly one spawn before the Compact click"
        );

        // The respawned sidecar serves thread/resume (echo) + thread/compact/start.
        configure_fake_codex_cmd(
            &json!({ "appendThreadOperationLogPath": log_path.to_string_lossy() }).to_string(),
        );

        st.handle_compact(compact_msg(&thread_id)).await;

        // The recovery was transparent: no user-facing error frame names this session.
        // (Checked FIRST — if a compact leg ever fails, the panic names the failing
        // branch instead of leaving a bare op-log diff.)
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(400);
        while let Ok(Ok(raw)) =
            tokio::time::timeout(deadline - std::time::Instant::now(), rx.recv()).await
        {
            let frame: Value = serde_json::from_str(&raw).unwrap();
            assert_ne!(
                frame["event"]["type"], "freshAgent.error",
                "a self-healed compact must never surface an error frame: {frame}"
            );
        }

        assert_eq!(
            spawn_count(&capture),
            2,
            "Compact on a crash-stale session must respawn the sidecar exactly once \
             (ensure-alive first), never fail loudly against the dead connection: {}",
            spawn_count(&capture)
        );

        // Per-connection RPC order over the TWO sidecars: the crashed spawn served only
        // thread/start; the respawned connection served thread/resume (the recovery)
        // THEN thread/compact/start (the actual Compact click).
        let log_text = read_op_log_when_complete(&log_path, 3).await;
        let mut by_url: HashMap<String, Vec<String>> = HashMap::new();
        for line in log_text.lines() {
            let entry: Value = serde_json::from_str(line).expect("op log line parses");
            by_url
                .entry(entry["listenUrl"].as_str().expect("listenUrl").to_string())
                .or_default()
                .push(entry["method"].as_str().expect("method").to_string());
        }
        assert_eq!(
            by_url.len(),
            2,
            "exactly two sidecar connections (crashed spawn + respawn): {log_text}"
        );
        let mut sequences: Vec<Vec<String>> = by_url.values().cloned().collect();
        sequences.sort();
        // Sorted order: ["thread/resume", "thread/compact/start"] < ["thread/start"].
        assert_eq!(
            sequences[0],
            vec!["thread/resume", "thread/compact/start"],
            "the respawned sidecar resumed the SAME thread, then ran the compact RPC: {log_text}"
        );
        assert_eq!(
            sequences[1],
            vec!["thread/start"],
            "the crashed spawn served only the create: {log_text}"
        );

        let _ = std::fs::remove_file(&log_path);
    }

    /// Whole-branch review M-2: a Fork click on a crash-stale parent must respawn the
    /// parent's sidecar FIRST (legacy `ensureRuntime` before fork, `adapter.ts:1056`) and
    /// fork the RESUMED parent — the child handoff (archive → child spawn → unarchive →
    /// resume) then proceeds exactly as it does for a healthy parent. Loudly failing the
    /// fork against a dead connection is the leg for genuinely unrespawnable parents only.
    #[tokio::test]
    async fn fork_after_unrequested_crash_respawns_the_parent_sidecar_then_forks() {
        let _guard = ENV_LOCK.lock().await;
        let log_path = std::env::temp_dir().join(format!(
            "freshell-fork-respawn-oplog-{}-{}.jsonl",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::remove_file(&log_path);
        let (st, mut rx) = state_with_bus();
        let capture = tracing_capture::capture_by_session("fork-respawn-marker-unused");

        configure_fake_codex_cmd(
            &json!({
                "exitProcessAfterMethodsOnce": ["thread/start"],
                "appendThreadOperationLogPath": log_path.to_string_lossy(),
            })
            .to_string(),
        );
        let parent_id = create_real_fake_session(&st, &mut rx).await;
        wait_for_self_heal(&st, &mut rx, &parent_id).await;
        assert_eq!(
            spawn_count(&capture),
            1,
            "sanity: exactly one spawn before the Fork click"
        );

        // The respawned parent AND the child's own sidecar share this config: resume
        // echoes the requested id; thread/fork mints a deterministic child id.
        configure_fake_codex_cmd(
            &json!({
                "overrides": {
                    "thread/fork": { "result": { "thread": { "id": "child-after-crash" } } }
                },
                "appendThreadOperationLogPath": log_path.to_string_lossy(),
            })
            .to_string(),
        );

        let (sink, captured) = capturing_sink();
        st.handle_fork(fork_msg(&parent_id, "fork-req-crash", None), sink)
            .await;

        // The fork SUCCEEDED on the requesting connection — never a loud failure
        // against the dead parent connection.
        let frames = captured_frames(&captured);
        assert_eq!(frames.len(), 1, "exactly one sink frame: {frames:?}");
        let forked = &frames[0];
        assert_eq!(forked["type"], "freshAgent.forked", "{forked}");
        assert_eq!(forked["requestId"], json!("fork-req-crash"), "{forked}");
        assert_eq!(
            forked["parentSessionId"],
            json!(parent_id),
            "the reply stays keyed to the CLICKED parent id: {forked}"
        );
        assert_eq!(forked["sessionId"], json!("child-after-crash"), "{forked}");

        assert_eq!(
            spawn_count(&capture),
            3,
            "parent respawn (spawn 2) + the fork child's own sidecar (spawn 3): {}",
            spawn_count(&capture)
        );

        // Per-connection RPC order over THREE sidecars: crashed spawn = thread/start;
        // respawned parent = thread/resume → thread/fork → thread/archive; child =
        // thread/unarchive → thread/resume.
        let log_text = read_op_log_when_complete(&log_path, 6).await;
        let mut by_url: HashMap<String, Vec<String>> = HashMap::new();
        for line in log_text.lines() {
            let entry: Value = serde_json::from_str(line).expect("op log line parses");
            by_url
                .entry(entry["listenUrl"].as_str().expect("listenUrl").to_string())
                .or_default()
                .push(entry["method"].as_str().expect("method").to_string());
        }
        assert_eq!(
            by_url.len(),
            3,
            "exactly three sidecar connections (crashed + respawned parent + child): {log_text}"
        );
        let mut sequences: Vec<Vec<String>> = by_url.values().cloned().collect();
        sequences.sort();
        // Sorted order: ["thread/resume", ...] < ["thread/start"] < ["thread/unarchive", ...].
        assert_eq!(
            sequences[0],
            vec!["thread/resume", "thread/fork", "thread/archive"],
            "the respawned parent was forked, never the dead connection: {log_text}"
        );
        assert_eq!(
            sequences[1],
            vec!["thread/start"],
            "the crashed spawn served only the create: {log_text}"
        );
        assert_eq!(
            sequences[2],
            vec!["thread/unarchive", "thread/resume"],
            "the child sidecar completed the archive→unarchive→resume handoff: {log_text}"
        );

        // Both the respawned parent and the child are registered and live.
        let guard = st.sessions.lock().await;
        assert!(
            guard.contains_key(&parent_id),
            "the respawned parent stays registered under the SAME id"
        );
        assert!(
            guard.contains_key("child-after-crash"),
            "the forked child is registered on its own sidecar"
        );
        drop(guard);

        // The recovery was transparent: no user-facing error frame names the parent.
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(400);
        while let Ok(Ok(raw)) =
            tokio::time::timeout(deadline - std::time::Instant::now(), rx.recv()).await
        {
            let frame: Value = serde_json::from_str(&raw).unwrap();
            assert_ne!(
                frame["event"]["type"], "freshAgent.error",
                "a self-healed fork must never surface an error frame: {frame}"
            );
        }

        let _ = std::fs::remove_file(&log_path);
    }

    /// Whole-branch fix review F-1 — the MINT-NEW (`Respawned { new_session_id }`) fork
    /// route, the sub-path the M-2 pair above does NOT drive (they drive Recovered, where
    /// `parent_id == msg.session_id`). The respawn machinery broadcasts
    /// `freshAgent.session.materialized{previousSessionId: OLD, sessionId: NEW}` DURING
    /// `ensure_session_alive` — strictly before the fork RPC chain starts, hence before any
    /// reply can exist — and the frozen client re-keys the pane's `sessionId` to NEW on that
    /// broadcast (`panesSlice.ts` materialized fold) and DELETES the old session record
    /// (`freshAgentSlice.ts`). Every post-resolution fork frame is therefore addressed by the
    /// RESOLVED parent id: the pane's ANDed fork correlation
    /// (`requestId === createRequestId && parentSessionId === paneContent.sessionId`,
    /// `FreshAgentView.tsx:1671-1676`) only matches when `parentSessionId` is the pane's
    /// CURRENT (NEW) id — a reply keyed to the clicked OLD id is DROPPED (orphan child,
    /// user-silent no-op). This test drives the genuine route end-to-end: crashed parent →
    /// negative-cache-confirmed dead thread → mint-new respawn → fork.
    ///
    /// The mint-new route is forced via the dead-thread negative cache
    /// ([`FreshCodexState::mark_thread_dead`] — a prior crash recovery already confirmed the
    /// durable rollout gone: disk cleanup / corruption / the RUN's probed `-32600 "no
    /// rollout found"`) rather than a `thread/resume` error override, because the override
    /// lands in the shared `FAKE_CODEX_APP_SERVER_BEHAVIOR` env var that EVERY subsequently
    /// spawned fake process reads at startup — it would break the fork CHILD sidecar's own
    /// `thread/resume` handoff step too. The negative-cache shortcut takes the same
    /// `respawn_as_new_thread_after_crash` machinery either way.
    #[tokio::test]
    async fn fork_on_a_mint_new_respawn_keys_the_forked_reply_to_the_resolved_parent_id() {
        let _guard = ENV_LOCK.lock().await;
        let log_path = std::env::temp_dir().join(format!(
            "freshell-fork-mint-new-oplog-{}-{}.jsonl",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::remove_file(&log_path);
        let (st, mut rx) = state_with_bus();
        let capture = tracing_capture::capture_by_session("fork-mint-new-marker-unused");

        // Spawn 1: the parent, which crashes right after `thread/start` (a real
        // unrequested exit, observed by the exit-watcher self-heal).
        configure_fake_codex_cmd(
            &json!({
                "threadStartThreadId": "parent-old-mint",
                "exitProcessAfterMethodsOnce": ["thread/start"],
                "appendThreadOperationLogPath": log_path.to_string_lossy(),
            })
            .to_string(),
        );
        let old_id = create_real_fake_session(&st, &mut rx).await;
        assert_eq!(old_id, "parent-old-mint", "fixture sanity: the clicked id");
        wait_for_self_heal(&st, &mut rx, &old_id).await;
        assert_eq!(
            spawn_count(&capture),
            1,
            "sanity: exactly one spawn before the Fork click"
        );

        // The durable rollout is confirmed genuinely gone (negative-cache hit) — ensure-alive
        // skips the doomed resume attempt and mints a fresh thread for this pane.
        st.mark_thread_dead(&old_id).await;

        // Spawn 2 (the respawned parent: `thread/start` mints "parent-new-mint", then
        // `thread/fork` of it mints the child) and spawn 3 (the child's own sidecar:
        // unarchive + resume handoff) share this config.
        configure_fake_codex_cmd(
            &json!({
                "threadStartThreadId": "parent-new-mint",
                "overrides": {
                    "thread/fork": { "result": { "thread": { "id": "child-after-mint" } } }
                },
                "appendThreadOperationLogPath": log_path.to_string_lossy(),
            })
            .to_string(),
        );

        let (sink, captured) = capturing_sink();
        st.handle_fork(fork_msg(&old_id, "fork-req-mint", None), sink)
            .await;

        // THE F-1 pin: the forked reply's EXACT envelope is keyed to the RESOLVED parent id
        // (the pane's current session id post-materialized), never the clicked old id.
        let frames = captured_frames(&captured);
        assert_eq!(frames.len(), 1, "exactly one sink frame: {frames:?}");
        assert_eq!(
            frames[0],
            json!({
                "type": "freshAgent.forked",
                "requestId": "fork-req-mint",
                "parentSessionId": "parent-new-mint",
                "sessionId": "child-after-mint",
                "sessionType": "freshcodex",
                "provider": "codex",
                "runtimeProvider": "codex",
                "sessionRef": { "provider": "codex", "sessionId": "child-after-mint" },
            }),
            "the forked reply must address the RESOLVED (respawned) parent the pane now tracks"
        );

        assert_eq!(
            spawn_count(&capture),
            3,
            "parent respawn (spawn 2) + the fork child's own sidecar (spawn 3): {}",
            spawn_count(&capture)
        );

        // Per-connection RPC order over THREE sidecars: crashed spawn = thread/start;
        // respawned parent = thread/start (the mint) → thread/fork → thread/archive,
        // with the fork RPC TARGETING the minted parent id; child = unarchive → resume.
        let log_text = read_op_log_when_complete(&log_path, 6).await;
        let mut by_url: HashMap<String, Vec<String>> = HashMap::new();
        let mut fork_target: Option<String> = None;
        for line in log_text.lines() {
            let entry: Value = serde_json::from_str(line).expect("op log line parses");
            by_url
                .entry(entry["listenUrl"].as_str().expect("listenUrl").to_string())
                .or_default()
                .push(entry["method"].as_str().expect("method").to_string());
            if entry["method"].as_str() == Some("thread/fork") {
                fork_target = Some(
                    entry["params"]["threadId"]
                        .as_str()
                        .expect("fork threadId")
                        .to_string(),
                );
            }
        }
        assert_eq!(
            fork_target.as_deref(),
            Some("parent-new-mint"),
            "thread/fork runs against the RESPAWNED parent thread: {log_text}"
        );
        assert_eq!(
            by_url.len(),
            3,
            "exactly three sidecar connections (crashed + respawned parent + child): {log_text}"
        );
        let mut sequences: Vec<Vec<String>> = by_url.values().cloned().collect();
        sequences.sort();
        // Sorted order: ["thread/start"] < ["thread/start", "thread/fork", ...] < ["thread/unarchive", ...].
        assert_eq!(
            sequences[0],
            vec!["thread/start"],
            "the crashed spawn served only the original create: {log_text}"
        );
        assert_eq!(
            sequences[1],
            vec!["thread/start", "thread/fork", "thread/archive"],
            "the respawned parent minted its new thread, then ran fork + archive: {log_text}"
        );
        assert_eq!(
            sequences[2],
            vec!["thread/unarchive", "thread/resume"],
            "the child sidecar completed the archive→unarchive→resume handoff: {log_text}"
        );

        // Registrations: the old id is GONE (the respawn re-keyed the session map), the
        // minted parent and the child are live.
        {
            let guard = st.sessions.lock().await;
            assert!(
                !guard.contains_key(&old_id),
                "the mint-new respawn removed the old parent id"
            );
            assert!(guard.contains_key("parent-new-mint"));
            assert!(guard.contains_key("child-after-mint"));
        }

        // Broadcast leg audit: the materialized OLD→NEW pair DID go out (the client re-key
        // this whole finding hinges on), and NO broadcast error frame is keyed to the old id
        // (the expected THREAD_MEMORY_LOST degradation frame is keyed to the NEW id).
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(400);
        let mut saw_materialized = false;
        while let Ok(Ok(raw)) =
            tokio::time::timeout(deadline - std::time::Instant::now(), rx.recv()).await
        {
            let frame: Value = serde_json::from_str(&raw).unwrap();
            if frame["type"] == "freshAgent.session.materialized" {
                assert_eq!(
                    frame["previousSessionId"],
                    json!(old_id),
                    "materialized names the clicked id as previous: {frame}"
                );
                assert_eq!(
                    frame["sessionId"],
                    json!("parent-new-mint"),
                    "materialized re-keys the pane to the minted id: {frame}"
                );
                saw_materialized = true;
            }
            if frame["event"]["type"] == "freshAgent.error" {
                assert_ne!(
                    frame["sessionId"],
                    json!(old_id),
                    "no broadcast error may target the discarded old id: {frame}"
                );
                assert_eq!(
                    frame["sessionId"], json!("parent-new-mint"),
                    "the degradation frame rides the new id, like the crate's own keying invariant: {frame}"
                );
            }
        }
        assert!(
            saw_materialized,
            "the mint-new respawn must broadcast the OLD→NEW materialized pair"
        );

        let _ = std::fs::remove_file(&log_path);
    }

    /// Whole-branch fix review F-1, failure leg: the DOMINANT real-world outcome on the
    /// mint-new route is a mid-flight fork failure (a freshly-minted thread is EMPTY, so
    /// `thread/fork` answers the PROBED `-32600 "no rollout found for thread id"`
    /// rejection). The nested `freshAgent.error` must key to the RESOLVED parent id: keyed
    /// to the clicked OLD id it would ENSURE-create a phantom deleted-id record in the
    /// client (`sessionError` → `resolveOrEnsureSession`) whose `lastError` no pane reads —
    /// an invisible banner, the precise silent-death class I-1 was chartered to kill.
    #[tokio::test]
    async fn fork_on_a_mint_new_respawn_keys_mid_flight_failures_to_the_resolved_parent_id() {
        let _guard = ENV_LOCK.lock().await;
        configure_fake_codex_cmd(
            &json!({
                "threadStartThreadId": "parent-old-mint",
                "exitProcessAfterMethodsOnce": ["thread/start"],
            })
            .to_string(),
        );
        let (st, mut rx) = state_with_bus();
        let capture = tracing_capture::capture_by_session("fork-mint-fail-marker-unused");
        let old_id = create_real_fake_session(&st, &mut rx).await;
        wait_for_self_heal(&st, &mut rx, &old_id).await;
        st.mark_thread_dead(&old_id).await;

        // The respawned parent mints "parent-new-mint"; its `thread/fork` then fails with
        // the probed empty-parent rejection. No child sidecar is spawned on this leg.
        configure_fake_codex_cmd(
            &json!({
                "threadStartThreadId": "parent-new-mint",
                "overrides": {
                    "thread/fork": {
                        "error": { "code": -32600, "message": "no rollout found for thread id" }
                    }
                },
            })
            .to_string(),
        );

        let (sink, captured) = capturing_sink();
        st.handle_fork(fork_msg(&old_id, "fork-req-mint-fail", None), sink)
            .await;

        // THE F-1 failure-leg pin: the FULL nested envelope, keyed to the RESOLVED parent.
        let frames = captured_frames(&captured);
        assert_single_fork_error_frame(
            &frames,
            "parent-new-mint",
            "INTERNAL_ERROR",
            "no rollout found for thread id",
        );
        assert_eq!(
            frames[0]["event"]["sessionId"],
            json!("parent-new-mint"),
            "the nested event's sessionId must be the RESOLVED parent id too: {}",
            frames[0]
        );

        assert_eq!(
            spawn_count(&capture),
            2,
            "a failed fork spawns ONLY the respawned parent — never a child sidecar"
        );
        {
            let guard = st.sessions.lock().await;
            assert!(!guard.contains_key(&old_id));
            assert!(guard.contains_key("parent-new-mint"));
            assert!(
                !guard.contains_key("child-after-mint"),
                "a failed fork registers no child"
            );
        }

        // Broadcast leg audit: mint-new materialization went out; the sink's failure frame is
        // a REQUESTING-connection answer, so no broadcast error besides the NEW-keyed
        // THREAD_MEMORY_LOST may name this pane's ids.
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(400);
        let mut saw_materialized = false;
        while let Ok(Ok(raw)) =
            tokio::time::timeout(deadline - std::time::Instant::now(), rx.recv()).await
        {
            let frame: Value = serde_json::from_str(&raw).unwrap();
            if frame["type"] == "freshAgent.session.materialized" {
                assert_eq!(frame["previousSessionId"], json!(old_id), "{frame}");
                assert_eq!(frame["sessionId"], json!("parent-new-mint"), "{frame}");
                saw_materialized = true;
            }
            if frame["event"]["type"] == "freshAgent.error" {
                assert_ne!(
                    frame["sessionId"],
                    json!(old_id),
                    "no broadcast error may target the discarded old id: {frame}"
                );
            }
        }
        assert!(saw_materialized, "mint-new must broadcast the OLD→NEW pair");
    }

    /// Delta-review round-3 Major: the fork single-flight guard keyed ONLY to the
    /// CLICKED, pre-recovery id (the round-2 shape) misses the duplicate click that
    /// matters most on the mint-new route. `ensure_session_alive`'s respawn broadcasts
    /// `freshAgent.session.materialized{OLD→NEW}` and the frozen client re-keys the
    /// pane MID-FLIGHT while leaving the Fork action enabled, so the second click
    /// arrives addressed to the NEW id — a guard that holds only OLD never collides
    /// with it, and both forks mint children whose replies race the pane's
    /// createRequestId re-key + parent-kill: whichever reply lands second can no
    /// longer correlate, leaving its child sidecar + durable thread UNOWNED. The guard
    /// must hold the RESOLVED parent id (plus the clicked id alongside it) for the
    /// fork's whole duration.
    ///
    /// Drives the genuine mint-new route (crash-stale parent + the dead-thread
    /// negative cache — the F-1 pins' machinery) with the respawned parent's
    /// `thread/fork` delayed, parking fork #1 mid-RPC (the second click's
    /// deterministic in-flight window). The duplicate, addressed to the re-keyed id,
    /// must be refused INLINE with the nested `freshAgent.error{INTERNAL_ERROR,
    /// "already in progress"}` shape on its own sink and must NEVER reach the wire;
    /// fork #1 then completes; BOTH guard keys release (a later fork addressed to the
    /// respawned id succeeds and mints a distinct child).
    #[tokio::test]
    async fn fork_in_flight_guard_covers_the_respawn_rekeyed_parent_id() {
        let _guard = ENV_LOCK.lock().await;
        let log_path = std::env::temp_dir().join(format!(
            "freshell-fork-mint-rekey-guard-oplog-{}-{}.jsonl",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::remove_file(&log_path);
        let (st, mut rx) = state_with_bus();
        let capture = tracing_capture::capture_by_session("fork-mint-rekey-guard-marker-unused");

        // Spawn 1: the parent, crashing right after `thread/start` (a real unrequested
        // exit observed by the exit-watcher self-heal).
        configure_fake_codex_cmd(
            &json!({
                "threadStartThreadId": "parent-old-mint",
                "exitProcessAfterMethodsOnce": ["thread/start"],
                "appendThreadOperationLogPath": log_path.to_string_lossy(),
            })
            .to_string(),
        );
        let old_id = create_real_fake_session(&st, &mut rx).await;
        assert_eq!(old_id, "parent-old-mint", "fixture sanity: the clicked id");
        wait_for_self_heal(&st, &mut rx, &old_id).await;
        // Dead-thread negative cache: ensure-alive goes straight to the mint-new
        // respawn fallback (the F-1 route).
        st.mark_thread_dead(&old_id).await;

        // Spawns 2+ (the respawned parent and every fork child's own sidecar) share
        // this config: `thread/start` mints the new parent id; `thread/fork` is
        // DELAYED long enough to hold fork #1's mid-RPC window deterministically,
        // minting a distinct `thread-fork-<pid>-<n>` child per call.
        configure_fake_codex_cmd(
            &json!({
                "threadStartThreadId": "parent-new-mint",
                "delayMethodsMs": { "thread/fork": 2000 },
                "appendThreadOperationLogPath": log_path.to_string_lossy(),
            })
            .to_string(),
        );

        // Fork #1 — addressed to the CLICKED old id, exactly the pane's pre-respawn id.
        let (sink1, captured1) = capturing_sink();
        let driver1 = {
            let st = st.clone();
            let old_id = old_id.clone();
            tokio::spawn(async move {
                st.handle_fork(fork_msg(&old_id, "fork-req-g1", None), sink1)
                    .await;
            })
        };

        // The mint-new respawn re-keyed the pane mid-flight: the materialized OLD→NEW
        // pair went out on the broadcast bus (the re-key this whole finding hinges on).
        let (previous, minted) = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
                if frame["type"] == "freshAgent.session.materialized" {
                    return (
                        frame["previousSessionId"].clone(),
                        frame["sessionId"].clone(),
                    );
                }
            }
        })
        .await
        .expect("the mint-new respawn broadcasts the OLD→NEW materialized pair");
        assert_eq!(previous, json!(old_id), "materialized names the clicked id");
        assert_eq!(
            minted,
            json!("parent-new-mint"),
            "materialized re-keys the pane"
        );

        // Deterministic witness that fork #1 cleared ensure-alive and is parked INSIDE
        // its guarded critical section (its `thread/fork` RPC blocked upstream): the
        // guard must hold the RESPAWNED id AND the clicked id — a successful probe of
        // either would prove the guard does not cover that key at all. (A probe that
        // acquires is dropped immediately, releasing nothing fork #1 holds.)
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if st.fork_in_flight.try_acquire("parent-new-mint").is_none()
                    && st.fork_in_flight.try_acquire(&old_id).is_none()
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .expect(
            "fork #1's in-flight guard must hold BOTH the respawned parent id and the \
             clicked id — otherwise a click addressed to the re-keyed id forks \
             concurrently and leaks an unowned child",
        );

        // Fork #2 — the second click, addressed to the NEW id the pane re-keyed to —
        // is refused INLINE on its own sink and never reaches the wire.
        let (sink2, captured2) = capturing_sink();
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            st.handle_fork(fork_msg("parent-new-mint", "fork-req-g2", None), sink2),
        )
        .await
        .expect("the re-keyed duplicate fork is refused inline, never upstream-blocking");
        assert_single_fork_error_frame(
            &captured_frames(&captured2),
            "parent-new-mint",
            "INTERNAL_ERROR",
            "already in progress",
        );

        // Fork #1 rides out its delayed RPC and completes: its reply keys to the
        // RESOLVED parent id (the F-1 pin) with the fixture-minted child.
        driver1.await.expect("fork #1 task");
        let frames1 = captured_frames(&captured1);
        assert_eq!(
            frames1.len(),
            1,
            "exactly one sink frame for fork #1: {frames1:?}"
        );
        assert_eq!(frames1[0]["type"], "freshAgent.forked", "{:?}", frames1[0]);
        assert_eq!(
            frames1[0]["parentSessionId"],
            json!("parent-new-mint"),
            "fork #1's reply keys to the resolved parent id: {:?}",
            frames1[0]
        );
        let child1 = frames1[0]["sessionId"]
            .as_str()
            .expect("child id")
            .to_string();
        assert!(
            child1.starts_with("thread-fork-"),
            "the fixture minted the child: {child1}"
        );

        // BOTH guard keys released at the terminal leg: the resolved id and the
        // clicked id are acquirable again...
        assert!(
            st.fork_in_flight.try_acquire("parent-new-mint").is_some(),
            "the resolved-id guard key released when fork #1 completed"
        );
        assert!(
            st.fork_in_flight.try_acquire(&old_id).is_some(),
            "the clicked-id guard key released when fork #1 completed"
        );

        // ...behaviorally: a later fork addressed to the respawned id succeeds and
        // mints a DISTINCT child (its RPC rides the same 2s fixture delay).
        let (sink3, captured3) = capturing_sink();
        let driver3 = {
            let st = st.clone();
            tokio::spawn(async move {
                st.handle_fork(fork_msg("parent-new-mint", "fork-req-g3", None), sink3)
                    .await;
            })
        };
        driver3.await.expect("fork #3 task");
        let frames3 = captured_frames(&captured3);
        assert_eq!(
            frames3.len(),
            1,
            "exactly one sink frame for fork #3: {frames3:?}"
        );
        assert_eq!(frames3[0]["type"], "freshAgent.forked", "{:?}", frames3[0]);
        let child2 = frames3[0]["sessionId"]
            .as_str()
            .expect("child id")
            .to_string();
        assert_ne!(child1, child2, "each successful fork mints its own child");

        // Wire audit: exactly TWO thread/fork RPCs crossed the wire (fork #1 and the
        // post-completion fork #3 — the refused duplicate produced NONE), both
        // targeting the respawned parent, over exactly four sidecar connections
        // (crashed spawn + respawned parent + one sidecar per child).
        assert_eq!(
            spawn_count(&capture),
            4,
            "crashed parent + respawn + two child sidecars: {}",
            spawn_count(&capture)
        );
        let log_text = read_op_log_when_complete(&log_path, 10).await;
        let fork_targets: Vec<String> = log_text
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).expect("op log row parses"))
            .filter(|entry| entry["method"] == "thread/fork")
            .map(|entry| {
                entry["params"]["threadId"]
                    .as_str()
                    .expect("fork target")
                    .to_string()
            })
            .collect();
        assert_eq!(
            fork_targets,
            vec!["parent-new-mint".to_string(), "parent-new-mint".to_string()],
            "exactly the two legitimate forks hit the wire — the refused duplicate none: {log_text}"
        );
        let urls: std::collections::HashSet<String> = log_text
            .lines()
            .map(|line| {
                serde_json::from_str::<Value>(line).unwrap()["listenUrl"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(
            urls.len(),
            4,
            "crashed + respawned parent + two child sidecars: {log_text}"
        );

        let _ = std::fs::remove_file(&log_path);
    }

    // -- GET /api/fresh-agent/threads/freshcodex/codex/:threadId (Batch D PR-5) --

    /// A thread the process has never seen now goes through ensure-runtime-on-demand
    /// (`snapshot_runtime_for`) rather than an immediate 404 -- see
    /// `get_snapshot_ensure_runtime_resumes_a_thread_not_in_the_live_map` for the SUCCESS
    /// path via a real (fake) app-server subprocess. This test covers what happens when no
    /// codex binary is reachable at all (`CODEX_CMD` unset, bare test env): the spawn itself
    /// fails, which is a genuine infra error, not "this specific thread doesn't exist" --
    /// mirrors the reference (`ensureRuntime` propagates an unwrapped spawn error, which
    /// `sendFreshAgentError`'s generic fallback turns into a plain 500).
    #[tokio::test]
    async fn get_snapshot_with_no_codex_binary_available_is_an_app_server_error() {
        // Force a definitely-nonexistent binary rather than relying on ambient `CODEX_CMD`:
        // the guard restores the caller's environment after this test, but the assertion
        // itself must remain deterministic even when that caller intentionally set an override.
        let _guard = ENV_LOCK.lock().await;
        std::env::set_var(
            "CODEX_CMD",
            "/definitely/not/a/real/codex/binary-xyz-does-not-exist",
        );
        std::env::remove_var("FAKE_CODEX_APP_SERVER_BEHAVIOR");
        let (st, _rx) = state_with_bus();

        let err = st
            .get_snapshot("does-not-exist", None)
            .await
            .expect_err("no codex binary reachable");
        assert!(
            matches!(
                err,
                CodexSnapshotError::AppServer(_) | CodexSnapshotError::Protocol(_)
            ),
            "expected a spawn/RPC-shaped error, got {err:?}"
        );
        std::env::remove_var("CODEX_CMD");
    }

    /// The actual Fix Task #2 deliverable: a thread id this process has NEVER created or
    /// attached to (a stand-in for a historical session opened from the sidebar) still
    /// serves a valid snapshot, because `get_snapshot` spawns a real app-server subprocess
    /// and `thread/resume`s the requested id on demand.
    #[tokio::test]
    async fn get_snapshot_ensure_runtime_resumes_a_thread_not_in_the_live_map() {
        let _guard = ENV_LOCK.lock().await;
        configure_fake_codex_cmd("{}");
        let (st, _rx) = state_with_bus();

        let snapshot = st
            .get_snapshot("historical-thread-1", None)
            .await
            .expect("ensure-runtime-on-demand resumes a not-yet-live thread");
        assert_eq!(snapshot["threadId"], json!("historical-thread-1"));
        assert_eq!(snapshot["sessionType"], json!("freshcodex"));

        // And it's now registered for reuse -- a second read doesn't need to resume again.
        let snapshot2 = st
            .get_snapshot("historical-thread-1", None)
            .await
            .expect("second read reuses the now-live session");
        assert_eq!(snapshot2["threadId"], json!("historical-thread-1"));
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
            tokio::spawn(async move { st.get_snapshot("thread-1", None).await })
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
        assert_eq!(snapshot["turns"][0]["summaryKind"], json!("echo"));
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
            tokio::spawn(async move { st.get_snapshot("thread-1", None).await })
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

    /// FIX-1 (codex-first triage): the freshly-read thread status is the reference's ONLY
    /// input to `isRunning`/`capabilities.send` (`normalizeCodexThreadSnapshot`,
    /// `normalize.ts:756,765` -- `isRunning = status === 'running' || status === 'compacting'`,
    /// nothing else). This process's independently-tracked `active_turn` bit is legitimate
    /// for targeting `freshAgent.interrupt` (`adapter.ts:1009`), but it is IN-MEMORY,
    /// server-local state that can lag the app-server's actual thread status for reasons
    /// having nothing to do with whether a turn is really still running (a missed/reordered
    /// notification, a resumed session inheriting stale bookkeeping, etc). Folding it into
    /// `is_running` (as a `Compacting`-status workaround) means ANY such lag permanently
    /// wedges the composer read-only even after the app-server itself reports `idle` --
    /// exactly the regression `test/e2e-browser/specs/restore-matrix.spec.ts`'s `test.fail`
    /// annotation documents: the FreshCodex composer never re-enables after the first live
    /// turn completes. A snapshot must be sendable whenever the app-server says `idle`,
    /// full stop -- matching the legacy adapter, which has no such fallback to begin with.
    #[tokio::test]
    async fn get_snapshot_is_sendable_once_thread_status_is_idle_even_if_active_turn_is_stale() {
        let (transport, peer) = freshell_codex::new_channel_transport();
        let (client, _notifs) = CodexAppServerClient::connect(transport);
        let client = Arc::new(client);

        let (st, _rx) = state_with_bus();
        insert_fake_session(
            &st,
            "thread-1",
            client,
            // A stale in-memory active-turn bit: the app-server has already moved this
            // thread to idle (below), but this process's own bookkeeping hasn't (or
            // can't, for reasons unrelated to the thread's real state) caught up.
            Arc::new(StdMutex::new(Some("turn-1".to_string()))),
            spawn_sleeper(),
            "codex-sidecar-test-snapshot-stale-active-turn",
        )
        .await;

        let driver = {
            let st = st.clone();
            tokio::spawn(async move { st.get_snapshot("thread-1", None).await })
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
            json!({ "thread": { "id": "thread-1", "status": { "type": "idle" }, "turns": [] } }),
        );

        let snapshot = driver.await.unwrap().expect("snapshot builds");
        assert_eq!(snapshot["status"], json!("idle"));
        assert_eq!(
            snapshot["capabilities"]["send"],
            json!(true),
            "a freshly-read idle thread status must be sendable regardless of stale \
             in-memory active-turn bookkeeping, matching the legacy adapter's pure \
             status-based capabilities computation"
        );
        assert_eq!(snapshot["capabilities"]["interrupt"], json!(false));
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
    fn map_codex_item_unrecognized_type_is_gracefully_skipped_not_an_error() {
        // CHANGED (was: `Err("Unsupported Codex thread item type: ...")`, matching legacy's
        // assertNever->500). The real codex CLI (0.144.5) emits `subAgentActivity`, unknown to
        // both frozen legacy and current `origin/main` -- hard-failing the whole thread over one
        // unrecognized item type made real historical threads unreadable. An unrecognized item
        // type now maps to an empty item list (the item is omitted; everything else renders).
        let item = json!({ "type": "subAgentActivity", "id": "item-7" });
        let mapped =
            map_codex_item("item-7", &item, "subAgentActivity").expect("unrecognized type is Ok");
        assert_eq!(mapped, Vec::<Value>::new());

        // Any other unrecognized type is handled the same way -- not special-cased on the name.
        let other_item = json!({ "type": "somethingNew", "id": "item-8" });
        let other_mapped =
            map_codex_item("item-8", &other_item, "somethingNew").expect("unrecognized type is Ok");
        assert_eq!(other_mapped, Vec::<Value>::new());
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
    fn build_codex_turn_json_skips_unrecognized_item_type_without_erroring_the_turn() {
        // CHANGED (was: an unrecognized item type errored the whole raw turn immediately).
        // Reproduces the real-world 500: `GET /api/fresh-agent/threads/freshcodex/codex/<id>`
        // returned "Unsupported Codex thread item type: subAgentActivity" for a real codex
        // 0.144.5 thread. A single unknown item must not make an otherwise-readable thread
        // unreadable: the known items around it still render, and building the turn succeeds.
        let raw_turn = json!({
            "id": "turn-mixed-unknown",
            "status": "completed",
            "items": [
                { "type": "agentMessage", "id": "known-1", "text": "known text item" },
                { "type": "subAgentActivity", "id": "unknown-1", "detail": "sub-agent ran" },
                { "type": "reasoning", "id": "known-2", "summary": ["known reasoning item"], "content": [] },
            ],
        });

        let turns =
            build_codex_turn_json(&raw_turn, 0).expect("unknown item type must not error the turn");

        // `agentMessage` and `reasoning` both classify as role `assistant`
        // (`classify_codex_item_role`), and the skipped unknown item never touches row
        // bookkeeping -- so all three raw items collapse into ONE contiguous-role row
        // containing exactly the two KNOWN items, role/split behavior unaffected.
        assert_eq!(
            turns.len(),
            1,
            "one assistant row, unknown item contributes nothing: {turns:?}"
        );
        assert_eq!(turns[0]["role"], json!("assistant"));
        let items = turns[0]["items"].as_array().expect("items array");
        assert_eq!(items.len(), 2, "only the two known items render: {items:?}");
        assert_eq!(items[0]["kind"], json!("text"));
        assert_eq!(items[0]["text"], json!("known text item"));
        assert_eq!(items[1]["kind"], json!("reasoning"));
        assert_eq!(items[1]["text"], json!("known reasoning item"));
    }

    #[test]
    fn build_codex_turn_json_unknown_item_type_does_not_perturb_role_splitting() {
        // The unknown item sits BETWEEN a user item and an assistant item -- proving the skip
        // touches no role/row bookkeeping (it must not appear as its own row, and must not
        // prevent the user/assistant split that would otherwise occur).
        let raw_turn = json!({
            "id": "turn-unknown-between-roles",
            "status": "completed",
            "items": [
                { "type": "userMessage", "id": "u-1", "content": [{ "type": "text", "text": "please check" }] },
                { "type": "subAgentActivity", "id": "unknown-1" },
                { "type": "agentMessage", "id": "a-1", "text": "checking now" },
            ],
        });

        let turns = build_codex_turn_json(&raw_turn, 0).expect("unknown item type must not error");

        assert_eq!(
            turns.len(),
            2,
            "user row + assistant row, unknown item is invisible: {turns:?}"
        );
        assert_eq!(turns[0]["role"], json!("user"));
        assert_eq!(turns[0]["items"].as_array().expect("items").len(), 1);
        assert_eq!(turns[1]["role"], json!("assistant"));
        assert_eq!(turns[1]["items"].as_array().expect("items").len(), 1);
    }

    // Genuinely malformed items (missing `id`/`type`) are NOT a distinct error path: a missing
    // `type` already falls back to the sentinel `"undefined"` (`build_codex_turn_json`'s
    // `item_type` read above) and a missing `id` already falls back to a synthetic
    // `{turnId}:item-{index}` (this function's own tolerant-read convention, documented on
    // [`map_codex_item`]). Both therefore flow through the exact same "unrecognized type ->
    // skip" path exercised above -- there is no separate malformed-item error behavior in this
    // module to preserve.
    #[test]
    fn build_codex_turn_json_item_missing_type_field_is_skipped_like_any_unrecognized_type() {
        let raw_turn = json!({
            "id": "turn-missing-type",
            "status": "completed",
            "items": [
                { "id": "no-type-1" },
                { "type": "agentMessage", "id": "known-1", "text": "still renders" },
            ],
        });
        let turns = build_codex_turn_json(&raw_turn, 0).expect("missing type must not error");
        assert_eq!(turns.len(), 1);
        let items = turns[0]["items"].as_array().expect("items");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["text"], json!("still renders"));
    }

    #[test]
    fn summarize_codex_items_uses_first_items_kind_specific_text_not_a_join() {
        let items = vec![
            json!({ "id": "a", "kind": "reasoning", "summary": ["thinking hard"], "content": [], "text": "thinking hard" }),
            json!({ "id": "b", "kind": "command", "command": "ls", "status": "completed", "output": null, "exitCode": null, "extensions": {} }),
        ];
        // A reasoning item carrying a provider summary array is the only authored
        // case; `text` is CONSTRUCTED as the joined provider summary by
        // `map_codex_item`, so the authored value is exactly today's value.
        assert_eq!(
            summarize_codex_items(&items),
            ("thinking hard".to_string(), SUMMARY_KIND_AUTHORED)
        );
    }

    #[test]
    fn summarize_codex_items_keeps_the_shipped_reasoning_fallback_order() {
        // Planning decision 6: the reasoning fallback order is UNCHANGED (direct
        // `text` -> provider `summary` array -> `content`); the reorder first
        // drafted here was reverted by load-bearing validation (LB-1 side
        // finding). Authored iff the RETURNED STRING is the provider summary
        // join. Construction-shaped items (`text` == the join, as `map_codex_item`
        // builds them) tag authored with an unchanged value:
        let construction_shaped = vec![json!({
            "id": "a", "kind": "reasoning",
            "summary": ["provider prose"], "content": ["raw chain"], "text": "provider prose",
        })];
        assert_eq!(
            summarize_codex_items(&construction_shaped),
            ("provider prose".to_string(), SUMMARY_KIND_AUTHORED)
        );

        // Direct text empty: the provider summary array supplies the value, so
        // the string IS provider prose -> authored (authored stays reachable
        // under the untouched order).
        let no_direct_text = vec![json!({
            "id": "b", "kind": "reasoning",
            "summary": ["provider prose"], "content": ["raw chain"], "text": "",
        })];
        assert_eq!(
            summarize_codex_items(&no_direct_text),
            ("provider prose".to_string(), SUMMARY_KIND_AUTHORED)
        );

        // A synthetic item whose direct text diverges from the provider summary
        // keeps today's value (the direct text) and tags echo — the value was not
        // taken from the provider array.
        let divergent = vec![json!({
            "id": "c", "kind": "reasoning",
            "summary": ["provider prose"], "content": [], "text": "direct text",
        })];
        assert_eq!(
            summarize_codex_items(&divergent),
            ("direct text".to_string(), SUMMARY_KIND_ECHO)
        );
    }

    #[test]
    fn summarize_codex_items_tags_reasoning_without_a_provider_summary_echo() {
        let items = vec![
            json!({ "id": "a", "kind": "reasoning", "summary": [], "content": ["raw chain"], "text": "raw chain" }),
        ];
        assert_eq!(
            summarize_codex_items(&items),
            ("raw chain".to_string(), SUMMARY_KIND_ECHO)
        );
    }

    #[test]
    fn summarize_codex_items_tags_tool_previews_echo() {
        let items = vec![
            json!({ "id": "c", "kind": "command", "command": "cat a.txt", "status": "completed", "output": null, "exitCode": null, "extensions": {} }),
        ];
        assert_eq!(
            summarize_codex_items(&items),
            ("cat a.txt".to_string(), SUMMARY_KIND_ECHO)
        );
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
            tokio::spawn(async move { st.get_snapshot("thread-rich", None).await })
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
        assert_eq!(turns[0]["summaryKind"], json!("authored"));
        assert_eq!(turns[1]["summaryKind"], json!("echo"));

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
