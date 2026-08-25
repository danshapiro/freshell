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
//! | `freshAgent.compact` | AGENT-04 (approval-respond Task 4): `POST /session/:id/summarize` with EXACTLY `{providerID, modelID}` (the VALIDATED 1.18.18 contract), sized between a running snapshot and an idle snapshot + gated turn-complete chime |
//! | `freshAgent.fork` | AGENT-07 (approval-respond Task 5): `POST /session/:id/fork` (optional `messageID` when the client pins a `^msg` turn), then register the child (bridge + binding row) and answer `freshAgent.forked` ON THE REQUESTING CONNECTION — every failure path also answers on that sink, never silence |
//!
//! PR-3 bridges the serve SSE stream into `freshAgent.event` frames (status snapshots +
//! the status-guarded `freshAgent.turn.complete` chime). PR-4 adds `freshAgent.attach`
//! (reload-rehydrate): a known session re-emits a status snapshot and restarts its
//! serve-SSE bridge if it died; an unknown session emits the `INVALID_SESSION_ID` shape
//! the client folds into `markSessionLost` instead of hanging.
//!
//! The turn this module runs on `freshAgent.send` DOES land in the real opencode session
//! (via [`freshell_opencode::OpencodeServeManager::run_turn`]) — the pane's live-updating
//! transcript just isn't wired to the WS bus yet, so nothing streams to the browser
//! until that turn resolves and a later `freshAgent.attach`/REST read observes it.
//! **Deferred to PR-4:** `freshAgent.attach`.
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
    ErrorCode, ErrorMsg, FreshAgentAttach, FreshAgentCompact, FreshAgentCreate,
    FreshAgentCreateFailed, FreshAgentCreated, FreshAgentEvent, FreshAgentFork, FreshAgentForked,
    FreshAgentInterrupt, FreshAgentKill, FreshAgentKilled, FreshAgentSend, FreshAgentSendAccepted,
    FreshAgentSessionMaterialized, ServerMessage, SessionLocator,
};
use freshell_terminal::FrameSink;

use crate::{
    FreshAgentCreateDedup, FreshAgentCreateOutcome, FreshAgentState, SharedPaneIdentitySink,
};

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
    /// `freshAgent.create` requestId dedup (parity gap fix -- see the module doc on
    /// [`crate::FreshAgentCreateDedup`]): single-flight + replay cache so a client
    /// resending the SAME `requestId` on every reconnect while a pane is
    /// `status==creating` reattaches to the ONE placeholder session it already created
    /// instead of overwriting it with a brand-new (and possibly already-materialized)
    /// [`OpencodeSession`] object. Cleared for a session's entries only on an explicit
    /// `freshAgent.kill` ([`Self::handle_kill`]).
    create_dedup: Arc<FreshAgentCreateDedup<OpencodeCreateRecord>>,
    /// P1.13 identity-event sink (the pane-ledger bridge,
    /// [`crate::identity_sink`]). Clone-shared + set-once: the state is cloned
    /// into consumer tasks, so the `OnceLock` sits behind an `Arc`. Wired
    /// post-construction by `freshell-server` (precedent:
    /// `TerminalRegistry::set_activity_observer`).
    identity_sink: Arc<std::sync::OnceLock<SharedPaneIdentitySink>>,
    /// The per-sessionRef create/resume lease (D8 for fresh agents, Task 13) —
    /// ALWAYS ON. Opencode NEVER records a kill handle on it: no per-session process
    /// exists, and the SHARED `opencode serve` sidecar must never be killed by the
    /// lease (it hosts other sessions) — a hung resume resolves via the bounded
    /// `get_session` (below) failing → `fail()` → the key reopens.
    pub(crate) leases: Arc<crate::session_lease::FreshAgentSessionLeases>,
    /// Task 13b: cross-kind liveness -- true when a live terminal PTY owns
    /// `(provider, session_id)`. Wired by `main.rs`; defaults to always-false.
    terminal_liveness: crate::TerminalLivenessProbe,
    /// Per-parent-session fork single-flight (delta-review round 2, D2-F2; the
    /// opencode arm of [`crate::FreshCodexState::fork_in_flight`]'s rationale): the
    /// client leaves the Fork action enabled during the op, so a duplicate click
    /// would otherwise mint a second child whose reply can no longer correlate after
    /// the first fork re-keys the pane — an orphaned `ses_*` row + serve session.
    fork_in_flight: crate::InFlightRegistry,
}

/// The cached result of a completed opencode `freshAgent.create`, keyed by `requestId` in
/// [`FreshOpencodeState::create_dedup`]. Only the placeholder id is needed: it is
/// deterministically derived from `requestId` (`freshopencode-<requestId>`), but caching
/// it explicitly (rather than re-deriving it on replay) keeps the replay branch a pure
/// cache-read, matching the codex/claude dedup shape.
#[derive(Clone)]
struct OpencodeCreateRecord {
    placeholder_id: String,
}

/// What the session's registered driving task is running (delta-review round 2,
/// D2-F1): every [`OpencodeSession::turn_task`] entry is tagged so
/// [`FreshOpencodeState::handle_send`] can REFUSE to overwrite an in-flight
/// COMPACT's handle (the overwrite would disconnect kill/interrupt from the
/// still-running compact drive and let ONE idle edge settle both operations into a
/// false/duplicate completion) while preserving the pre-existing
/// send-overwrites-send behavior.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum TurnTaskKind {
    /// A `freshAgent.send` turn drive (`handle_send`'s `run_turn` task).
    Send,
    /// A `freshAgent.compact` drive (`handle_compact`'s POST + await-idle + settle).
    Compact,
}

/// The session's registered driving task + its [`TurnTaskKind`]. Kill/interrupt abort
/// the handle regardless of kind (an aborted compact drops mid-await and never reaches
/// its settle tail — no false `freshAgent.turn.complete`).
struct TurnTask {
    kind: TurnTaskKind,
    handle: tokio::task::JoinHandle<()>,
}

impl TurnTask {
    fn is_finished(&self) -> bool {
        self.handle.is_finished()
    }

    fn abort(&self) {
        self.handle.abort();
    }
}

/// One live (or not-yet-materialized) freshopencode WS session.
struct OpencodeSession {
    placeholder_id: String,
    /// `None` until the first `freshAgent.send` materializes it (`adapter.ts:349`).
    real_session_id: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    /// The detached, kind-tagged task driving the current/most-recent operation
    /// (`manager.run_turn` for a send, the POST/await-idle/settle drive for a
    /// compact), so `freshAgent.kill`/`freshAgent.interrupt` can abort it. Not
    /// serialized against a concurrent `freshAgent.send` while a SEND is in flight —
    /// mirrors `adapter.ts`'s `sendQueue` only loosely (this crate does not yet
    /// serialize overlapping sends); the new drive's task simply overwrites the
    /// finished/hijacked handle. A send arriving while a COMPACT is in flight is
    /// REFUSED instead ([`FreshOpencodeState::handle_send`], D2-F1): overwriting the
    /// compact's handle would orphan its still-running drive.
    turn_task: Option<TurnTask>,
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

/// Why [`FreshOpencodeState::resume_durable_session`] could not produce a live session for
/// a `freshAgent.attach` id not tracked in [`FreshOpencodeState::sessions`].
enum ResumeOpencodeError {
    /// The shared `opencode serve` sidecar genuinely has no record of this id (a 404, or
    /// a non-object `/session/:id` body) -- a real lost session.
    NotFound,
    /// The manager/transport call itself failed (sidecar unreachable, cold-start failure,
    /// timeout, ...) -- NOT evidence the session is gone; safe to retry, never mapped to
    /// `INVALID_SESSION_ID`.
    Manager(freshell_opencode::ServeError),
    /// Task 13 (D8): another create/attach holds this sessionRef's lease -- the caller
    /// answers `freshAgent.error { code: "SESSION_RESERVED" }` (retryable, never lost).
    Reserved,
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

    /// The shared `FreshAgentState` this slice wraps. Surfaced for AUTO-01:
    /// the freshell-ws client-message dispatch feeds this state's
    /// [`crate::layout_store::LayoutStore`] from `ui.layout.sync` frames.
    pub fn fresh_agent(&self) -> &FreshAgentState {
        &self.fresh_agent
    }

    /// Replace the default lease map with the ONE server-wide shared map (Task 13;
    /// called by `main.rs` before this state is cloned into the router).
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

    /// Broadcast a `freshAgent.error` alarm/degradation frame (Task 8 consumes this
    /// too). Same envelope contract as codex.rs's helper (verified against
    /// `fresh-agent-ws.ts:182-193`): `{ "type": "freshAgent.event", "sessionId",
    /// "sessionType", "provider", "event": { "type": "freshAgent.error", "code",
    /// "message" } }` -- built on the SAME [`ServerMessage::FreshAgentEvent`] envelope
    /// [`lost_session_frame`] uses, so it is byte-compatible with the frozen client's
    /// banner path: top-level `sessionType`/`provider` are REQUIRED (locator
    /// resolution) and `message` is user-facing (the banner shows the message, never
    /// the code).
    fn emit_fresh_agent_error(&self, session_id: &str, code: &str, message: &str) {
        self.broadcast(&event_frame(
            session_id,
            json!({
                "type": "freshAgent.error",
                "sessionId": session_id,
                "code": code,
                "message": message,
            }),
        ));
    }

    fn broadcast(&self, msg: &ServerMessage) {
        self.fresh_agent.broadcast(msg);
    }

    /// The shared P1.13 binding-row write (materialization row, settings refresh,
    /// resume refresh, forked child): AWAITED (durable-before-answer), and a write
    /// failure surfaces as a user-visible `LEDGER_WRITE_FAILED` `freshAgent.error`
    /// broadcast but NEVER blocks the caller's reply — the same failure policy at
    /// every call site.
    async fn record_binding_row(&self, upsert: crate::identity_sink::FreshAgentBindingUpsert) {
        let Some(sink) = self.identity_sink() else {
            return;
        };
        let session_id = upsert.session_id.clone();
        if let Err(e) = sink.record_binding(upsert).await {
            tracing::warn!(error = %e, session = %session_id, "freshagent.opencode.binding_write_failed");
            self.emit_fresh_agent_error(
                &session_id,
                "LEDGER_WRITE_FAILED",
                "Failed to persist this session's resume record - settings may not survive a server restart.",
            );
        }
    }

    /// Broadcast a `freshAgent.create.failed` frame (mirrors codex.rs's `fail_create`;
    /// `ws-handler.ts:3388-3405`'s generic catch -- always `retryable: true`,
    /// `ws-handler.ts:3403`).
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

    // ── freshAgent.create (WS) ──────────────────────────────────────────────

    /// Handle a `freshAgent.create` for opencode: mint a placeholder session (NO serve
    /// spawn — `adapter.ts create():419-431`) and broadcast `freshAgent.created`.
    /// `sessionId == freshopencode-<requestId>` until a `send` materializes it.
    pub async fn handle_create(&self, msg: FreshAgentCreate) {
        let request_id = msg.request_id.clone();

        // Dedup by requestId (parity gap fix -- see [`crate::FreshAgentCreateDedup`]'s
        // doc and [`Self::create_dedup`]'s field doc). Without this, a client resending
        // `freshAgent.create` with the same requestId (e.g. on reconnect while a pane is
        // `status==creating`) would construct a brand-new [`OpencodeSession`] object and
        // overwrite the existing one in `sessions` -- silently wiping any materialization
        // (`real_session_id`) that had already happened since the first create.
        let _dedup_guard = match self.create_dedup.acquire_or_replay(&request_id).await {
            FreshAgentCreateOutcome::Replay(cached) => {
                self.broadcast(&ServerMessage::FreshAgentCreated(FreshAgentCreated {
                    provider: PROVIDER.to_string(),
                    request_id,
                    runtime_provider: PROVIDER.to_string(),
                    session_id: cached.placeholder_id.clone(),
                    session_type: SESSION_TYPE.to_string(),
                    session_ref: Some(SessionLocator {
                        provider: PROVIDER.to_string(),
                        session_id: cached.placeholder_id,
                    }),
                }));
                return;
            }
            FreshAgentCreateOutcome::Proceed(guard) => guard,
        };

        // P1.13 (Task 8, V2/A4 -- THE P1.13 wall-pin mechanism): after a page reload
        // the frozen client never sends `freshAgent.attach` -- its ONLY resume vehicle
        // is `freshAgent.create{resumeSessionId: ses_*}` (persistMiddleware strips
        // `sessionId`, gating both attach effects off). A create naming a durable
        // `ses_*` id must REBIND that surviving session (mirroring codex/claude's
        // resume-in-create), never mint a fresh `freshopencode-*` placeholder.
        let resume_target = msg
            .resume_session_id
            .clone()
            .or_else(|| msg.session_ref.as_ref().map(|r| r.session_id.clone()))
            .filter(|id| id.starts_with("ses_"));
        if let Some(durable_id) = resume_target {
            self.handle_create_resume(request_id, durable_id, &msg)
                .await;
            return;
        }

        let model = normalize_opencode_model(msg.model.as_deref());
        let effort = normalize_opencode_effort(model.as_deref(), msg.effort.as_deref());
        let placeholder = format!("freshopencode-{request_id}");

        let session = OpencodeSession::new(placeholder.clone(), msg.cwd.clone(), model, effort);
        self.sessions
            .lock()
            .await
            .insert(placeholder.clone(), Arc::new(TokioMutex::new(session)));

        // Cache the completed create for requestId dedup BEFORE responding (mirrors
        // codex/claude: a duplicate `create` arriving right after this point must see the
        // cache populated, never race past this guard's release).
        self.create_dedup
            .record_success(
                &request_id,
                OpencodeCreateRecord {
                    placeholder_id: placeholder.clone(),
                },
            )
            .await;

        // P1.13: pending marker (AWAITED before the created broadcast --
        // durable-before-answer). A failed write is surfaced user-visibly, never
        // silently dropped, and never blocks the create.
        if let Some(sink) = self.identity_sink() {
            if let Err(e) = sink
                .record_pending(&placeholder, SESSION_TYPE, msg.cwd.as_deref())
                .await
            {
                tracing::warn!(error = %e, placeholder = %placeholder, "freshagent.opencode.pending_write_failed");
                self.emit_fresh_agent_error(
                    &placeholder,
                    "LEDGER_WRITE_FAILED",
                    "Failed to persist this pane's identity marker - identity may not survive a crash.",
                );
            }
        }

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

    /// The resume branch of `handle_create` (P1.13 Task 8, V2/A4): rebind the
    /// surviving durable `ses_*` session instead of minting a `freshopencode-*`
    /// placeholder. Routes through the SAME resume machinery `freshAgent.attach`
    /// uses ([`Self::resume_durable_session`], which applies settings-from-ledger
    /// and the V7/A10 `SETTINGS_RESET` gate), then answers `freshAgent.created`
    /// with the durable id so the frozen client ends up re-keyed to the `ses_*`
    /// identity. Mirrors codex's `handle_create_resume`: a resume target that is
    /// genuinely gone (or an unreachable sidecar) fails the create loudly
    /// (`freshAgent.create.failed`) -- never a silently-minted fresh session,
    /// never a `lost_session_frame` (that shape is exclusive to `freshAgent.attach`).
    async fn handle_create_resume(
        &self,
        request_id: String,
        durable_id: String,
        msg: &FreshAgentCreate,
    ) {
        // Already tracked locally (a live pane, or an earlier attach/create already
        // rebound it)? Reuse it -- mirrors handle_attach's local-map-first lookup.
        let existing = {
            let guard = self.sessions.lock().await;
            guard.get(&durable_id).cloned()
        };
        let session_arc = match existing {
            Some(session_arc) => session_arc,
            None => match self
                .resume_durable_session(&durable_id, msg.cwd.as_deref())
                .await
            {
                Ok(session_arc) => session_arc,
                Err(ResumeOpencodeError::NotFound) => {
                    self.fail_create(
                        &request_id,
                        "FRESH_AGENT_CREATE_FAILED",
                        &format!("opencode session {durable_id} not found"),
                    );
                    return;
                }
                Err(ResumeOpencodeError::Manager(err)) => {
                    self.fail_create(&request_id, "FRESH_AGENT_CREATE_FAILED", &err.to_string());
                    return;
                }
                Err(ResumeOpencodeError::Reserved) => {
                    // Task 13 (D8): the create-resume loser answer -- retryable.
                    self.fail_create(
                        &request_id,
                        "SESSION_RESERVED",
                        "Another resume for this session is in flight",
                    );
                    return;
                }
            },
        };

        // Explicit client params on the create win over the ledger record (Task 5(d)
        // precedence): merge msg over the resumed session's values BEFORE
        // normalization, so an omitted param recovers the recorded value instead of
        // being rewritten to the default.
        {
            let mut session = session_arc.lock().await;
            let raw_model = msg.model.clone().or_else(|| session.model.clone());
            let model = normalize_opencode_model(raw_model.as_deref());
            let raw_effort = msg.effort.clone().or_else(|| session.effort.clone());
            let effort = normalize_opencode_effort(model.as_deref(), raw_effort.as_deref());
            session.model = model;
            session.effort = effort;
            if msg.cwd.is_some() {
                session.cwd = msg.cwd.clone();
            }
        }

        // requestId dedup cache: a duplicate create replays the DURABLE id (never a
        // placeholder), keeping the reconnect-resend behavior intact.
        self.create_dedup
            .record_success(
                &request_id,
                OpencodeCreateRecord {
                    placeholder_id: durable_id.clone(),
                },
            )
            .await;

        self.broadcast(&ServerMessage::FreshAgentCreated(FreshAgentCreated {
            provider: PROVIDER.to_string(),
            request_id,
            runtime_provider: PROVIDER.to_string(),
            session_id: durable_id.clone(),
            session_type: SESSION_TYPE.to_string(),
            session_ref: Some(SessionLocator {
                provider: PROVIDER.to_string(),
                session_id: durable_id,
            }),
        }));
    }

    /// Handle a `freshAgent.send` for opencode: `materializeOrSend` (`adapter.ts:324-361`).
    /// Creates the durable `ses_*` session ONLY if this session has not materialized yet
    /// (the continuity fix), broadcasts `freshAgent.session.materialized` exactly once,
    /// then `freshAgent.send.accepted`, then runs the turn against the real opencode
    /// serve session in a detached task (PR-3 bridges its completion signal onto the bus).
    ///
    /// BUSY REFUSAL (delta-review round 2, D2-F1): a send arriving while a COMPACT is
    /// in flight (the session's `turn_task` kind — the composer stays interactive, so
    /// this race is reachable) is refused with the nested
    /// `freshAgent.error{INTERNAL_ERROR}` BEFORE any side effect; overwriting the
    /// compact's registered handle would orphan its drive. A send arriving while a
    /// SEND is in flight keeps the pre-existing loose-overwrite behavior (the
    /// divergence documented on [`OpencodeSession::turn_task`]).
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

        // D2-F1 (delta-review round 2): a send arriving while a COMPACT is in flight
        // is REFUSED — the nested `freshAgent.error{INTERNAL_ERROR}` — BEFORE any side
        // effect (flag reset, busy snapshot, materialization, prompt POST). Registering
        // this send's drive would overwrite the compact's `turn_task` handle while the
        // compact keeps running: kill/interrupt would silently stop reaching it, and
        // the shared idle edge would settle both operations (a false/duplicate
        // completion). A send arriving while a SEND is in flight keeps the PRE-EXISTING
        // behavior: the new task overwrites the old registration (the documented
        // divergence — this crate does not serialize overlapping sends).
        if session
            .turn_task
            .as_ref()
            .is_some_and(|t| t.kind == TurnTaskKind::Compact && !t.is_finished())
        {
            drop(session);
            self.emit_fresh_agent_error(
                &session_id,
                "INTERNAL_ERROR",
                &format!(
                    "send while a compact is in progress is not supported (opencode session {session_id})"
                ),
            );
            return;
        }

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
            // Deliberately ungated (bccd item 4, council D-D evaluate-and-decide;
            // same decision as the REST send-keys cold arm in lib.rs): the
            // single-flighted singleton manager bounds sidecar forks to AT MOST
            // ONE server-wide, and gating would starve the spawn budget on
            // ~50-70s worst-case cold-start holds (see the lib.rs comment for
            // the arithmetic). Revisit if the sidecar ever grows fork fan-out.
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

            // P1.13: binding row at materialization (AWAITED BEFORE the materialized
            // broadcast -- durable-before-answer), resolving the create's pending
            // marker. Opencode has no sandbox/permission concepts -- always `None`.
            self.record_binding_row(crate::identity_sink::FreshAgentBindingUpsert {
                provider: PROVIDER.into(),
                session_id: durable_id.clone(),
                mode: SESSION_TYPE.into(),
                // Task 3 binding fix: the lineage key is the CREATE requestId,
                // derived from the placeholder minted at handle_create
                // (`freshopencode-<createRequestId>`) — NOT this send's
                // requestId (the old bug; every materialization re-keyed the
                // lineage to the triggering send). A born-durable placeholder
                // strips to None.
                create_request_id: session
                    .placeholder_id
                    .strip_prefix(crate::OPENCODE_PLACEHOLDER_PREFIX)
                    .map(str::to_string),
                resolves_pending: Some(session.placeholder_id.clone()),
                supersedes: None,
                settings: crate::identity_sink::FreshAgentSettings {
                    model: session.model.clone(),
                    sandbox: None,
                    permission_mode: None,
                    effort: session.effort.clone(),
                    cwd: session.cwd.clone(),
                },
            })
            .await;

            // `freshAgent.session.materialized` (ws-handler.ts:3477-3484): placeholder ->
            // durable, emitted EXACTLY ONCE (a later send never re-enters this branch).
            self.broadcast(&materialized_frame(&session.placeholder_id, &durable_id));

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

        // P1.13: settings-change refresh -- once durable, every send's committed
        // model/effort re-snapshot the binding row (AWAITED BEFORE send.accepted --
        // durable-before-answer). No pending resolution or supersession here.
        if acked_session_id.starts_with("ses_") {
            self.record_binding_row(crate::identity_sink::FreshAgentBindingUpsert {
                provider: PROVIDER.into(),
                session_id: acked_session_id.clone(),
                mode: SESSION_TYPE.into(),
                create_request_id: None,
                resolves_pending: None,
                supersedes: None,
                settings: crate::identity_sink::FreshAgentSettings {
                    model: session.model.clone(),
                    sandbox: None,
                    permission_mode: None,
                    effort: session.effort.clone(),
                    cwd: session.cwd.clone(),
                },
            })
            .await;
        }

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

            settle_turn_outcome(
                &fresh_agent,
                &real_id,
                result.is_ok(),
                &turn_aborted,
                &turn_errored,
                &last_turn_complete_at,
            );
        });
        session.turn_task = Some(TurnTask {
            kind: TurnTaskKind::Send,
            handle: turn_task,
        });
    }

    /// Reconcile liveness probe (campaign §4.3, Task 13): is this id tracked
    /// in the sessions map? The map is keyed by BOTH the placeholder AND the
    /// durable `ses_*` id (the `remember()` mirror), so a durable-id lookup
    /// resolves the same record.
    pub async fn has_live_session(&self, session_id: &str) -> bool {
        self.sessions.lock().await.contains_key(session_id)
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
            // Task 13: a killed session must reopen its durable id's lease binding.
            if let Some(real) = s.real_session_id.as_deref() {
                self.leases.clear_binding(PROVIDER, real);
            }
        }

        // Explicit kill evicts this session's requestId dedup cache entries (mirrors
        // `clearFreshAgentCreateCachesForSession`, `ws-handler.ts:1044-1050`) -- a later
        // duplicate `create` for the same requestId must genuinely mint a fresh
        // placeholder session, not replay (and thus reuse the bookkeeping of) the one
        // just killed.
        self.create_dedup
            .clear_for_session(|record| record.placeholder_id == msg.session_id)
            .await;

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

    // ── freshAgent.compact (WS, AGENT-04) ────────────────────────────────────

    /// Handle a `freshAgent.compact` for opencode (legacy `compact()` →
    /// `compactForState`, `adapter.ts:992-1011,356-399`) against the VALIDATED
    /// opencode 1.18.18 summarize contract (`POST /session/:id/summarize` with a body
    /// of EXACTLY `{providerID, modelID}` — required, `additionalProperties:false`).
    /// The client's `instructions` are DELIBERATELY DROPPED (no-op upstream; note the
    /// deliberate divergence: legacy Node's own `serve-manager.ts:465-471` body shape
    /// `{instructions?}` 400s on 1.18.18, so this port does NOT mirror it). A
    /// not-yet-materialized session is a SILENT NO-OP (`adapter.ts:992-994`), while a
    /// session id this server never tracked is the LOUD lost-session leg: nested
    /// `freshAgent.error{INVALID_SESSION_ID}` mirroring [`Self::handle_fork`] (review I-1),
    /// so the pane engages its recovery instead of dying invisibly.
    ///
    /// REVIEWED lifecycle (fresh-eyes F3, `adapter.ts:356-399`): FIRST reset the
    /// session's `turn_aborted`/`turn_errored` flags (a prior interrupted/errored turn
    /// must not suppress this compact's completion edge), broadcast the running-status
    /// snapshot (the busy indicator must be visible before the upstream request
    /// settles), subscribe BEFORE the POST (the idle edge cannot be missed), resolve
    /// the model pair (the serve crate stores no session metadata, so resolution lives
    /// here: the session's model split via `split_opencode_model`, else `GET /config`'s
    /// `model`, else a LOUD error), POST, await idle, and settle with the SAME
    /// idle-snapshot + gated `freshAgent.turn.complete` chime as a send turn. A serve
    /// error still returns the pane to idle and surfaces the error loudly — never a
    /// false completion.
    ///
    /// TURN-SCOPED LIFECYCLE (delta-review round 1, D1-F1): the composer stays
    /// interactive while a session is busy (queued sends) and the `/compact` slash
    /// action sends `freshAgent.compact` without a busy gate, so a compact CAN arrive
    /// mid-turn. Two defenses make a compact a first-class turn:
    ///
    /// (a) A compact arriving while the session's `turn_task` (a send OR an earlier
    ///     compact) is still in flight is REFUSED with a nested
    ///     `freshAgent.error{INTERNAL_ERROR}` naming the in-flight turn — before
    ///     touching the shared abort/error flags or opening an idle waiter (one
    ///     idle/error edge can never settle two operations into a false/duplicate
    ///     completion). This refusal EXCEEDS legacy: the Node adapter CHAINS compact
    ///     onto `state.sendQueue` (adapter.ts:992) rather than refusing.
    /// (b) An accepted compact's driving task (POST + await-idle + settle) is
    ///     REGISTERED as the session's `turn_task` (mirroring [`Self::handle_send`]'s
    ///     registration unit), so `freshAgent.kill`/`freshAgent.interrupt` abort a
    ///     mid-flight compact: dropped mid-await it never reaches the settle tail,
    ///     and the interrupt's `turn_aborted` flag would gate even a raced settle —
    ///     killing mid-compact yields NO false `freshAgent.turn.complete`.
    pub async fn handle_compact(&self, msg: FreshAgentCompact) {
        let session_id = msg.session_id.clone();
        let session_arc = {
            let guard = self.sessions.lock().await;
            guard.get(&session_id).cloned()
        };
        let Some(session_arc) = session_arc else {
            // Whole-branch review I-1: mirror handle_fork's untracked leg — the nested
            // `INVALID_SESSION_ID` lost-session envelope engages the client's
            // `markSessionLost` recovery (legacy `requireOrRecoverSession` →
            // `FreshAgentLostSessionError` parity, `runtime-manager.ts:309-313`). The
            // pre-I-1 shape — a request-less top-level `error` frame — never reached
            // any pane: `ws-client.ts` only correlates top-level errors with a pending
            // send's requestId, which a compact frame never establishes. Broadcast
            // (not a reply sink) is right here: the client routes nested frames by
            // sessionId, so post-restart stale panes and cross-device duplicates both
            // surface the recovery.
            self.emit_fresh_agent_error(
                &session_id,
                "INVALID_SESSION_ID",
                &format!("OpenCode fresh-agent session {session_id} is not available."),
            );
            return;
        };

        // Held across the whole preflight (busy-check → flag reset → model pair
        // resolution) so a compact's refusal check and its own `turn_task`
        // registration are one atomic unit against handle_send/handle_interrupt (the
        // same lock discipline handle_send uses across materialization).
        let mut session = session_arc.lock().await;
        let Some(real_id) = session.real_session_id.clone() else {
            // adapter.ts:992-994 — no server-side session to compact; silent no-op.
            return;
        };

        // D1-F1(a): REFUSE a compact while the session's turn is in flight.
        if session.turn_task.as_ref().is_some_and(|t| !t.is_finished()) {
            drop(session);
            self.emit_fresh_agent_error(
                &session_id,
                "INTERNAL_ERROR",
                &format!(
                    "compact while a turn is in progress is not supported (opencode session {session_id})"
                ),
            );
            return;
        }

        // adapter.ts:360-361 — FIRST: a fresh compact starts un-aborted/un-errored.
        session.turn_aborted.store(false, Ordering::SeqCst);
        session.turn_errored.store(false, Ordering::SeqCst);
        let model = session.model.clone();
        let route = session.cwd.clone();
        let turn_aborted = session.turn_aborted.clone();
        let turn_errored = session.turn_errored.clone();
        let last_turn_complete_at = session.last_turn_complete_at.clone();

        // adapter.ts:362 `emitStatus(state, 'running')` — BEFORE the upstream request.
        self.broadcast(&event_frame(&real_id, snapshot_event(&real_id, "running")));

        let manager = self.fresh_agent.ensure_manager().await;
        // Subscribe BEFORE the POST so the compact's idle edge cannot be missed (the
        // same mechanic as `run_turn`; legacy arms its `onceIdle` first too).
        let rx = manager.subscribe(&real_id);

        // Model-pair resolution: (1) the session's stored model via the existing
        // `build_prompt_body` helper; (2) `GET /config`'s `model` key (probed: present,
        // string-or-null); (3) a LOUD failure (no false success, NO POST).
        let model_pair = match freshell_opencode::split_opencode_model(model.as_deref()) {
            Some(pair) => Some(pair),
            None => match manager.get_config(&route).await {
                Ok(config) => freshell_opencode::split_opencode_model(
                    config.get("model").and_then(Value::as_str),
                ),
                Err(_) => None,
            },
        };
        let Some(model_pair) = model_pair else {
            // Never leave the pane stuck busy on the failure path (and nothing was
            // ever registered on turn_task — the failure is inline, pre-spawn).
            self.broadcast(&event_frame(&real_id, snapshot_event(&real_id, "idle")));
            self.emit_fresh_agent_error(
                &real_id,
                "OPENCODE_COMPACT_FAILED",
                &format!(
                    "Compact failed for opencode session {real_id}: no model/provider pair is resolvable (both the session model and the serve /config model are unset or unusable)"
                ),
            );
            return;
        };

        // D1-F1(b): run the compact's drive (POST + await-idle + settle) in the
        // session's DETACHED, REGISTERED turn task — mirroring handle_send so
        // kill/interrupt abort it (aborted mid-await ⇒ no settle ⇒ no chime).
        let fresh_agent = self.fresh_agent.clone();
        let compact_id = real_id.clone();
        let compact_task = tokio::spawn(async move {
            let result = match manager
                .compact(
                    &compact_id,
                    &model_pair.provider_id,
                    &model_pair.model_id,
                    &route,
                )
                .await
            {
                Ok(()) => {
                    manager
                        .await_idle(&compact_id, rx, DEFAULT_TURN_TIMEOUT, route)
                        .await
                }
                Err(err) => Err(err),
            };

            // adapter.ts:386-393 — the same settle tail as a send turn (idle snapshot
            // unconditionally + the gated chime); a serve error additionally surfaces
            // loudly (the SAME nested envelope `emit_fresh_agent_error` builds) and
            // never produces a false turn-complete.
            let succeeded = result.is_ok();
            settle_turn_outcome(
                &fresh_agent,
                &compact_id,
                succeeded,
                &turn_aborted,
                &turn_errored,
                &last_turn_complete_at,
            );
            if let Err(err) = result {
                fresh_agent.broadcast(&event_frame(
                    &compact_id,
                    json!({
                        "type": "freshAgent.error",
                        "sessionId": compact_id,
                        "code": "OPENCODE_COMPACT_FAILED",
                        "message": err.to_string(),
                    }),
                ));
            }
        });
        session.turn_task = Some(TurnTask {
            kind: TurnTaskKind::Compact,
            handle: compact_task,
        });
    }

    // ── freshAgent.fork (WS, AGENT-07, approval-respond Task 5) ─────────────

    /// Handle a `freshAgent.fork` for opencode (legacy `fork()` → `forkForState`,
    /// `adapter.ts:1005-1020,401-409`): `POST /session/:id/fork`, register the child
    /// session locally (bridge + identity binding row), and answer ON THE REQUESTING
    /// CONNECTION's sink (`conn_sink`) — unlike the broadcast-only handlers, fork is a
    /// request/response op (`freshAgent.forked` echoes the request's `requestId`), and
    /// EVERY failure path also answers on that sink (the silent-hang defect class this
    /// run exists to kill):
    ///
    /// | failure | reply |
    /// |---|---|
    /// | session id not tracked at all | nested `freshAgent.error{INVALID_SESSION_ID}` (`requireState` parity, adapter.ts:223) — the lost-session shape the client folds into `markSessionLost`/recovery (`fresh-agent-ws.ts:343`) |
    /// | placeholder never materialized | nested `freshAgent.error{INVALID_SESSION_ID}` with the legacy parity text (adapter.ts:403) |
    /// | a fork for this parent is already in flight (duplicate click, D2-F2) | nested `freshAgent.error{INTERNAL_ERROR}`, NO other action — no second fork POST, no child minted (a second child could never correlate after the first fork re-keys the pane) |
    /// | serve failure (400/500/…) | nested `freshAgent.error{INTERNAL_ERROR}` carrying the serve error text, BEFORE any state change |
    pub async fn handle_fork(&self, msg: FreshAgentFork, reply_sink: FrameSink) {
        // D2-F2 single-flight: acquire BEFORE any lookup/POST; the RAII guard
        // releases on every terminal leg (success AND every failure), so a refreshed
        // Fork click once this op settles is never stranded.
        let Some(_fork_guard) = self.fork_in_flight.try_acquire(&msg.session_id) else {
            reply_sink(event_frame(
                &msg.session_id,
                json!({
                    "type": "freshAgent.error",
                    "sessionId": msg.session_id,
                    "code": "INTERNAL_ERROR",
                    "message": format!("fork already in progress for {}", msg.session_id),
                }),
            ));
            return;
        };

        let session_arc = {
            let guard = self.sessions.lock().await;
            guard.get(&msg.session_id).cloned()
        };
        let Some(session_arc) = session_arc else {
            reply_sink(event_frame(
                &msg.session_id,
                json!({
                    "type": "freshAgent.error",
                    "sessionId": msg.session_id,
                    "code": "INVALID_SESSION_ID",
                    "message": format!(
                        "OpenCode fresh-agent session {} is not available.",
                        msg.session_id
                    ),
                }),
            ));
            return;
        };

        let (real_id, route, model, effort) = {
            let session = session_arc.lock().await;
            let Some(real_id) = session.real_session_id.clone() else {
                // Legacy throws FreshAgentLostSessionError BEFORE calling the serve
                // manager; the port answers the same lost-session code so the client's
                // recovery path engages.
                reply_sink(event_frame(
                    &msg.session_id,
                    json!({
                        "type": "freshAgent.error",
                        "sessionId": msg.session_id,
                        "code": "INVALID_SESSION_ID",
                        "message": format!(
                            "OpenCode session {} has not materialized; cannot fork.",
                            session.placeholder_id
                        ),
                    }),
                ));
                return;
            };
            (
                real_id,
                session.cwd.clone(),
                session.model.clone(),
                session.effort.clone(),
            )
        };

        // The selected-turn knob (REVIEWED, fresh-eyes F4/F5): the probed opencode
        // 1.18.18 `POST /session/:id/fork` body schema is `{messageID?: ^msg…}` with
        // `additionalProperties:false`, so the client's `input.atTurnId` passes as
        // `messageID` ONLY when it is opencode-message-shaped (`^msg`); anything else
        // is dropped and the fork proceeds from the tip.
        let message_id = msg
            .input
            .as_ref()
            .and_then(|input| input.get("atTurnId"))
            .and_then(Value::as_str)
            .filter(|id| id.starts_with("msg"));

        let manager = self.fresh_agent.ensure_manager().await;
        let child = match manager.fork(&real_id, &route, message_id).await {
            Ok(child) => child,
            Err(err) => {
                reply_sink(event_frame(
                    &msg.session_id,
                    json!({
                        "type": "freshAgent.error",
                        "sessionId": msg.session_id,
                        "code": "INTERNAL_ERROR",
                        "message": err.to_string(),
                    }),
                ));
                return;
            }
        };

        // A pathological 200 body without a usable `id` parses to an EMPTY child id
        // (serve.rs `ForkedSession.id` defaults to ""); treat it as a serve failure —
        // reply and NEVER register/bind a "" child (a wrong "success" that would
        // repoint the pane at a garbage session).
        if child.id.trim().is_empty() {
            reply_sink(event_frame(
                &msg.session_id,
                json!({
                    "type": "freshAgent.error",
                    "sessionId": msg.session_id,
                    "code": "INTERNAL_ERROR",
                    "message": format!(
                        "OpenCode serve fork of session {} returned a malformed response: missing session \"id\".",
                        real_id
                    ),
                }),
            ));
            return;
        }

        // adapter.ts fork:1005-1020 — the child lands in the SAME session map (its
        // placeholder IS its durable id), inherits model/effort from the parent, takes
        // cwd from `child.directory ?? state.cwd`, and gets its own serve-SSE bridge
        // (`bindServeStream(childState)`).
        let child_cwd = child
            .directory
            .clone()
            .filter(|d| !d.is_empty())
            .or(route.clone());
        let mut child_session = OpencodeSession::new(
            child.id.clone(),
            child_cwd.clone(),
            model.clone(),
            effort.clone(),
        );
        child_session.real_session_id = Some(child.id.clone());
        child_session.serve_bridge = Some(self.spawn_serve_bridge(
            manager,
            child.id.clone(),
            child_session.turn_errored.clone(),
        ));
        self.sessions
            .lock()
            .await
            .insert(child.id.clone(), Arc::new(TokioMutex::new(child_session)));

        // P1.13: binding row for the child (the materialization record pattern,
        // `_pattern :600-626`) — AWAITED BEFORE the forked reply
        // (durable-before-answer). Opencode has no sandbox/permission concepts —
        // always `None`.
        self.record_binding_row(crate::identity_sink::FreshAgentBindingUpsert {
            provider: PROVIDER.into(),
            session_id: child.id.clone(),
            mode: SESSION_TYPE.into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            settings: crate::identity_sink::FreshAgentSettings {
                model,
                sandbox: None,
                permission_mode: None,
                effort,
                cwd: child_cwd.clone(),
            },
        })
        .await;

        reply_sink(ServerMessage::FreshAgentForked(FreshAgentForked {
            request_id: msg.request_id.clone(),
            parent_session_id: msg.session_id.clone(),
            session_id: child.id.clone(),
            session_type: SESSION_TYPE.to_string(),
            provider: PROVIDER.to_string(),
            runtime_provider: PROVIDER.to_string(),
            session_ref: Some(SessionLocator {
                provider: PROVIDER.to_string(),
                session_id: child.id.clone(),
            }),
        }));
    }

    // ── freshAgent.attach (reload-rehydrate, PR-4) ──────────────────────────

    /// Handle a `freshAgent.attach` for opencode: emit a session snapshot carrying the
    /// current status (running/idle from turn-task liveness), and restart the serve-SSE
    /// bridge if it died (e.g. the shared `opencode serve` sidecar was restarted).
    ///
    /// A session id NOT tracked locally (e.g. a page reload re-attaching after a server
    /// restart, when this process's WS session map is empty but the shared `opencode
    /// serve` sidecar still remembers the durable session) is looked up against the
    /// serve manager (THE FIX -- [`Self::resume_durable_session`]) before being declared
    /// lost: if serve still knows about it, it's registered locally (bridge spawned) and
    /// rehydrated with a real snapshot. Only a session serve GENUINELY has no record of
    /// emits the `INVALID_SESSION_ID` shape the client folds into `markSessionLost`
    /// (`fresh-agent-ws.ts:326-328`); a manager/transport failure degrades to a
    /// `freshAgent.error` frame instead (never panics, never tears down the shared
    /// sidecar, never mis-declares a possibly-live session lost).
    pub async fn handle_attach(&self, msg: FreshAgentAttach) {
        let session_arc = {
            let guard = self.sessions.lock().await;
            guard.get(&msg.session_id).cloned()
        };
        let session_arc = match session_arc {
            Some(session_arc) => session_arc,
            None => match self
                .resume_durable_session(&msg.session_id, msg.cwd.as_deref())
                .await
            {
                Ok(session_arc) => session_arc,
                Err(ResumeOpencodeError::NotFound) => {
                    self.broadcast(&lost_session_frame(&msg.session_id));
                    return;
                }
                Err(ResumeOpencodeError::Manager(err)) => {
                    self.send_error(&None, "OPENCODE_ATTACH_RESUME_FAILED", &err.to_string());
                    return;
                }
                Err(ResumeOpencodeError::Reserved) => {
                    // Task 13 (D8): loser answer -- retryable, never lost.
                    self.emit_fresh_agent_error(
                        &msg.session_id,
                        "SESSION_RESERVED",
                        "Another resume for this session is in flight",
                    );
                    return;
                }
            },
        };

        let (status_session_id, running, real_session_id) = {
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
            (status_session_id, running, session.real_session_id.clone())
        };

        // Attach addressed by the PLACEHOLDER id of an already-materialized session:
        // the requesting pane cannot correlate frames stamped with the real ses_* id
        // (locatorMatchesPane), so its snapshot fetch would 404 into a false
        // restore-error. Re-key it first via the same wire event the send path uses
        // (materialize-on-send) -- the client fold updates slice AND pane content.
        if let Some(real_id) = real_session_id.as_ref() {
            if real_id != &msg.session_id {
                self.broadcast(&materialized_frame(&msg.session_id, real_id));
            }
        }

        let status = if running { "running" } else { "idle" };
        self.broadcast(&event_frame(
            &status_session_id,
            snapshot_event(&status_session_id, status),
        ));
    }

    /// Look up `session_id` against the shared `opencode serve` sidecar (`GET
    /// /session/:id`) and, if it's still there, register a local session row for it
    /// (`real_session_id = Some(session_id)`, a fresh serve-SSE bridge) so a
    /// `freshAgent.attach` for a session this process's WS map never heard of -- e.g. a
    /// page reload after a server restart -- can rehydrate instead of being declared lost.
    /// There is no separate placeholder id here: attach only ever resumes an ALREADY
    /// durable `ses_*` id, so the placeholder and real id are the same value.
    async fn resume_durable_session(
        &self,
        session_id: &str,
        cwd: Option<&str>,
    ) -> Result<Arc<TokioMutex<OpencodeSession>>, ResumeOpencodeError> {
        let manager = self.fresh_agent.ensure_manager().await;
        let route: freshell_opencode::Route = cwd.map(str::to_string);

        // Task 13 (D8): claim the per-sessionRef lease before the resume. Opencode
        // never records a kill handle (the shared serve sidecar must never be killed
        // by the lease), so a hung holder resolves via the BOUNDED `get_session`
        // below failing -> the guard's `fail()` reopening the key -- never a tree-kill
        // and never a permanent hold.
        // Task 13b (cross-kind liveness): a live terminal PTY owning
        // `(opencode, session)` is the one writer -- refuse the resume (retryable).
        if (self.terminal_liveness)(PROVIDER, session_id) {
            tracing::warn!(target: "freshell_freshagent::opencode", session_id = %session_id,
                "fresh_agent_resume_refused: a live terminal PTY owns this session (Task 13b cross-kind live-guard)");
            return Err(ResumeOpencodeError::Reserved);
        }
        let resume_request_id = format!("attach-resume-{}", uuid::Uuid::new_v4());
        let mut lease_guard = match self.leases.claim(
            PROVIDER,
            session_id,
            &resume_request_id,
            crate::session_lease::now_epoch_ms(),
        ) {
            crate::session_lease::FreshSessionClaim::Acquired => {
                crate::FreshSessionLeaseGuard::armed(
                    Arc::clone(&self.leases),
                    PROVIDER,
                    session_id,
                    &resume_request_id,
                )
            }
            crate::session_lease::FreshSessionClaim::BoundLive { live_session_key } => {
                // The winner completed while we contended -- adopt its live session.
                if let Some(existing) = self.sessions.lock().await.get(&live_session_key) {
                    return Ok(existing.clone());
                }
                return Err(ResumeOpencodeError::Reserved);
            }
            crate::session_lease::FreshSessionClaim::Held { .. }
            | crate::session_lease::FreshSessionClaim::ExpiredNeedsKill { .. } => {
                // Handle-less by design: expired holders are revoked + held closed by
                // the primitive; both shapes answer RESERVED (retryable).
                return Err(ResumeOpencodeError::Reserved);
            }
        };

        // V5 caveat (b): `RequestOptions.timeout` defaults to `None`, so a
        // wedged-but-accepting `opencode serve` would hang this await forever and hold
        // the sessionRef reserved until restart. Bound it (env-tunable for tests) —
        // resolved through the SAME pure function the REST resume door uses
        // (`crate::resolve_probe_timeout_ms`: env parse > 10_000ms default) so the
        // two doors can never drift.
        let budget = crate::resolve_probe_timeout_ms(
            None,
            std::env::var("FRESHELL_OPENCODE_GET_SESSION_TIMEOUT_MS")
                .ok()
                .as_deref(),
        );
        let get = tokio::time::timeout(
            std::time::Duration::from_millis(budget),
            manager.get_session(session_id, &route),
        )
        .await;
        let info = match get {
            Err(_elapsed) => {
                lease_guard.fail();
                return Err(ResumeOpencodeError::Manager(
                    freshell_opencode::ServeError::Transport(format!(
                        "GET /session/{session_id} did not answer within {budget}ms"
                    )),
                ));
            }
            Ok(Ok(value)) if value.is_object() => value,
            Ok(Ok(_)) => {
                lease_guard.fail();
                return Err(ResumeOpencodeError::NotFound);
            }
            Ok(Err(freshell_opencode::ServeError::Http { status: 404, .. })) => {
                lease_guard.fail();
                return Err(ResumeOpencodeError::NotFound);
            }
            Ok(Err(err)) => {
                lease_guard.fail();
                return Err(ResumeOpencodeError::Manager(err));
            }
        };
        // P1.13 (Task 8): recover this session's recorded settings snapshot, gated
        // per V7/A10 (same vocabulary + gating as codex.rs's Task 5 site).
        let sink = self.identity_sink();
        let recovered = sink
            .as_ref()
            .and_then(|s| s.load_settings(PROVIDER, session_id));
        if recovered.is_none()
            && sink
                .as_ref()
                .is_some_and(|s| s.was_recorded(PROVIDER, session_id))
        {
            // Recorded before, unrecoverable now -- the genuine anomaly. Never-recorded
            // sessions (pre-ship / serve-known-but-ledger-unknown, the ROUTINE attach
            // population per this handler's own doc above) resume silently with defaults.
            tracing::warn!(session = %session_id, "freshagent.opencode.settings_record_unrecoverable");
            self.emit_fresh_agent_error(
                session_id,
                "SETTINGS_RESET",
                "Session settings could not be recovered after restart - the agent is running with default model and effort. Reconfirm your settings.",
            );
        }
        let rec = recovered.clone().unwrap_or_default();

        // Stop discarding the serve body (the old `let _ = info;`): its `directory`
        // is the session's REAL working directory -- a better cwd than the attach
        // message's, though the ledger record's still wins.
        let serve_dir = info
            .get("directory")
            .and_then(Value::as_str)
            .filter(|d| !d.is_empty())
            .map(str::to_string);
        let cwd = rec
            .cwd
            .clone()
            .or(serve_dir)
            .or_else(|| cwd.map(str::to_string));

        let mut session = OpencodeSession::new(
            session_id.to_string(),
            cwd.clone(),
            rec.model.clone(),
            rec.effort.clone(),
        );
        session.real_session_id = Some(session_id.to_string());
        session.serve_bridge = Some(self.spawn_serve_bridge(
            manager,
            session_id.to_string(),
            session.turn_errored.clone(),
        ));
        let session_arc = Arc::new(TokioMutex::new(session));

        self.sessions
            .lock()
            .await
            .insert(session_id.to_string(), session_arc.clone());

        // Task 13: bind the durable id to this live session + release the lease. A
        // revoked lease (expired handle-less holder held closed) means a contender may
        // believe the key is poisoned -- we are still the only writer, so keep the
        // registered session and reopen the key (has-live lookups adopt it from here).
        if !lease_guard.complete(session_id) {
            lease_guard.fail();
        }

        // P1.13 (Task 8): refresh the binding row after a successful resume -- AWAITED
        // (durable-before-answer), and ONLY when a record was actually recovered: never
        // launder a defaults row for a never-recorded session (V7).
        if recovered.is_some() {
            self.record_binding_row(crate::identity_sink::FreshAgentBindingUpsert {
                provider: PROVIDER.into(),
                session_id: session_id.to_string(),
                mode: SESSION_TYPE.into(),
                create_request_id: None,
                resolves_pending: None,
                supersedes: None,
                settings: crate::identity_sink::FreshAgentSettings {
                    model: rec.model.clone(),
                    sandbox: None,
                    permission_mode: None,
                    effort: rec.effort.clone(),
                    cwd,
                },
            })
            .await;
        }

        Ok(session_arc)
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

/// The shared settle tail of a turn-scoped opencode pipeline (a send turn, a compact):
/// broadcast the idle snapshot UNCONDITIONALLY (`emitStatus(state, 'idle')`,
/// adapter.ts:371/384 — it flows whether the turn succeeded or errored), then the
/// positive-completion `freshAgent.turn.complete` chime gated on a clean finish
/// (`succeeded && !turn_aborted && !turn_errored`, adapter.ts:377), stamped by the
/// session's monotonic turn-complete clock.
fn settle_turn_outcome(
    fresh_agent: &FreshAgentState,
    real_id: &str,
    succeeded: bool,
    turn_aborted: &AtomicBool,
    turn_errored: &AtomicBool,
    last_turn_complete_at: &StdMutex<Option<i64>>,
) {
    fresh_agent.broadcast(&event_frame(real_id, snapshot_event(real_id, "idle")));
    if succeeded && !turn_aborted.load(Ordering::SeqCst) && !turn_errored.load(Ordering::SeqCst) {
        let at = {
            let mut guard = last_turn_complete_at
                .lock()
                .expect("last_turn_complete_at mutex");
            let at = next_monotonic_turn_complete_at(*guard, now_ms());
            *guard = Some(at);
            at
        };
        fresh_agent.broadcast(&event_frame(real_id, turn_complete_event(real_id, at)));
    }
}

/// `freshAgent.session.materialized` (legacy reference: server/ws-handler.ts's
/// emission of the same event; line numbers drift — cite by name): placeholder -> durable
/// re-key frame. Shared by the materialize-on-send path and the tracked attach arm
/// (Task 5: re-key a placeholder-addressed pane BEFORE its real-id-stamped ack
/// snapshot, so the pane can correlate the ack it is about to receive).
fn materialized_frame(previous_session_id: &str, real_id: &str) -> ServerMessage {
    ServerMessage::FreshAgentSessionMaterialized(FreshAgentSessionMaterialized {
        previous_session_id: previous_session_id.to_string(),
        provider: PROVIDER.to_string(),
        session_id: real_id.to_string(),
        session_type: SESSION_TYPE.to_string(),
        session_ref: Some(SessionLocator {
            provider: PROVIDER.to_string(),
            session_id: real_id.to_string(),
        }),
    })
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

    // The identity-sink trait's methods (record_binding/load_settings/
    // was_recorded/lookup_by_create_request_id) are trait methods on the fake,
    // unlike its inherent seed/field knobs.
    use crate::identity_sink::PaneIdentitySink;
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

    /// Fix Task #3 (defect 3): mimics a REAL `opencode serve` more faithfully than
    /// [`FakeHttp`] for the placeholder-snapshot regression below -- `POST /session`
    /// mints a fresh `ses_N` id and REMEMBERS it; a `GET /session/:id` (or its
    /// `/message` page) for any id NOT in that set 404s, exactly like the real serve
    /// genuinely never having heard of a `freshopencode-*` placeholder id. This is what
    /// lets the test prove the bug (a pre-fix `get_opencode_snapshot` call for a live
    /// placeholder id reaches this fake and comes back 404/500-shaped, not a silently
    /// benign `{}`) as well as the fix (post-fix, the placeholder id never reaches this
    /// fake at all) and the materialized-turns follow-up (the real `ses_N` id DOES
    /// resolve, with a scripted message page).
    struct RealisticServeHttp {
        created: StdMutex<std::collections::HashSet<String>>,
        next_session: AtomicUsize,
    }
    impl RealisticServeHttp {
        fn new() -> Self {
            Self {
                created: StdMutex::new(std::collections::HashSet::new()),
                next_session: AtomicUsize::new(0),
            }
        }
    }
    impl ServeHttp for RealisticServeHttp {
        fn request<'a>(
            &'a self,
            req: ServeHttpRequest,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<ServeHttpResponse, String>> + Send + 'a>,
        > {
            let is_create = matches!(req.method, freshell_opencode::serve::HttpMethod::Post)
                && (req.url.ends_with("/session") || req.url.contains("/session?"));
            if is_create {
                let n = self.next_session.fetch_add(1, Ordering::SeqCst) + 1;
                let id = format!("ses_{n}");
                self.created.lock().unwrap().insert(id.clone());
                let body = serde_json::to_vec(
                    &json!({ "id": id, "title": "materialized session", "time": { "updated": 5 } }),
                )
                .unwrap();
                return Box::pin(async move { Ok(ServeHttpResponse::new(200, body)) });
            }
            if req.url.contains("/global/health") || req.url.contains("/session/status") {
                // `/global/health` (serve health probe) and the GLOBAL `/session/status`
                // busy-map poll (no id in the path, unlike `/session/:id`) both always
                // report "nothing busy" -- `run_turn`'s status-poll idle-fallback resolves
                // immediately without depending on SSE dispatch (this fake's `EventSource`
                // is a no-op), and it runs in `handle_send`'s DETACHED turn task, never
                // awaited by this test, so its outcome doesn't gate the assertions below.
                return Box::pin(async move { Ok(ServeHttpResponse::new(200, b"{}".to_vec())) });
            }
            // `GET /session/:id/message` and `GET /session/:id` both contain
            // `/session/<id>`; extract the id segment to check against `created`.
            let id = req
                .url
                .split("/session/")
                .nth(1)
                .and_then(|rest| rest.split(['/', '?']).next())
                .unwrap_or("")
                .to_string();
            if !req.url.contains("/session/") || !self.created.lock().unwrap().contains(&id) {
                return Box::pin(
                    async move { Ok(ServeHttpResponse::new(404, b"not found".to_vec())) },
                );
            }
            let body = if req.url.contains("/message") {
                serde_json::to_vec(&json!([
                    { "info": { "id": "m1", "role": "user" }, "parts": [{ "type": "text", "text": "hello" }] },
                ]))
                .unwrap()
            } else {
                // Like the real serve, `GET /session/:id` carries the session's own
                // `directory` -- Task 8's resume path consumes it instead of
                // discarding the body (`let _ = info;`).
                serde_json::to_vec(
                    &json!({ "id": id, "title": "materialized session", "time": { "updated": 5 }, "directory": "/serve/dir" }),
                )
                .unwrap()
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

    /// A `ServeHttp` fake that answers health probes but NEVER resolves anything else --
    /// the wedged-but-accepting `opencode serve` shape (V5 caveat b).
    struct WedgedHttp;
    impl ServeHttp for WedgedHttp {
        fn request<'a>(
            &'a self,
            req: ServeHttpRequest,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<ServeHttpResponse, String>> + Send + 'a>,
        > {
            if req.url.contains("/global/health") {
                return Box::pin(async { Ok(ServeHttpResponse::new(200, b"{}".to_vec())) });
            }
            Box::pin(std::future::pending())
        }
    }

    /// V5 caveat (b): `RequestOptions.timeout` defaults to `None`, so a wedged serve
    /// would hang `get_session` forever and hold the sessionRef reserved until restart.
    /// The bounded call must error within its budget, and the lease guard's `fail()`
    /// must reopen the key (a fresh claim acquires).
    #[tokio::test]
    async fn resume_durable_session_get_session_is_bounded_and_reopens_the_lease() {
        std::env::set_var("FRESHELL_OPENCODE_GET_SESSION_TIMEOUT_MS", "200");
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
        let fresh_agent = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx));
        let deps = ServeDeps {
            spawner: Arc::new(TrackedSpawner {
                killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            }),
            http: Arc::new(WedgedHttp),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        manager
            .ensure_started()
            .await
            .expect("healthy (but wedged) fake serve starts");
        fresh_agent.set_manager_for_test(manager).await;
        let state = FreshOpencodeState::new(fresh_agent);

        let started = std::time::Instant::now();
        let out = state.resume_durable_session("ses_wedged_1", None).await;
        std::env::remove_var("FRESHELL_OPENCODE_GET_SESSION_TIMEOUT_MS");
        assert!(
            matches!(out, Err(ResumeOpencodeError::Manager(_))),
            "a wedged get_session must resolve to a transient Manager error"
        );
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "the get_session await must be BOUNDED (was: {:?})",
            started.elapsed()
        );
        // The guard's fail() reopened the sessionRef -- a fresh claim acquires.
        assert_eq!(
            state.leases.claim(
                "opencode",
                "ses_wedged_1",
                "req-next",
                crate::session_lease::now_epoch_ms()
            ),
            crate::session_lease::FreshSessionClaim::Acquired,
            "a bounded failure must reopen the lease"
        );
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

    // ── freshAgent.create requestId dedup (parity gap fix) ──────────────────

    /// THE regression this task fixes: a duplicate `freshAgent.create` sharing a
    /// `requestId` (the frozen client's reconnect-resend while a pane is
    /// `status==creating`) must NOT construct a brand-new [`OpencodeSession`] object --
    /// which would silently wipe any materialization (`real_session_id`) a `send` had
    /// already produced since the first create. The second response must replay the
    /// SAME placeholder session id.
    #[tokio::test]
    async fn handle_create_duplicate_request_id_preserves_materialized_session_state() {
        let (st, killed) = state().await;
        let _ = &killed;

        st.handle_create(create_msg("req-dedup-seq")).await;
        let placeholder = "freshopencode-req-dedup-seq";
        st.handle_send(send_msg(placeholder, "hi")).await;

        let real_session_id = {
            let sessions = st.sessions.lock().await;
            let session_arc = sessions
                .get(placeholder)
                .expect("placeholder session tracked after create")
                .clone();
            drop(sessions);
            let guard = session_arc.lock().await;
            guard
                .real_session_id
                .clone()
                .expect("send must have materialized a durable session")
        };

        // A duplicate create for the SAME requestId, as the frozen client resends on
        // every reconnect while the pane is still `status==creating` on its side.
        st.handle_create(create_msg("req-dedup-seq")).await;

        let sessions = st.sessions.lock().await;
        assert_eq!(
            sessions.len(),
            2,
            "exactly two keys tracked (placeholder + durable) -- the duplicate create \
             must not insert a second, fresh session object"
        );
        let session_arc = sessions
            .get(placeholder)
            .expect("placeholder must still resolve to a session")
            .clone();
        drop(sessions);
        assert_eq!(
            session_arc.lock().await.real_session_id,
            Some(real_session_id),
            "a duplicate create must NOT reset the already-materialized session's \
             real_session_id back to None"
        );
    }

    /// The concurrent variant: two GENUINELY CONCURRENT creates sharing a `requestId`
    /// must still construct exactly ONE session object (never two, racing to overwrite
    /// each other in the `sessions` map).
    #[tokio::test]
    async fn handle_create_concurrent_duplicate_request_id_constructs_session_once() {
        let (st, _killed) = state().await;

        let st1 = st.clone();
        let st2 = st.clone();
        tokio::join!(
            st1.handle_create(create_msg("req-dedup-race")),
            st2.handle_create(create_msg("req-dedup-race")),
        );

        assert_eq!(
            st.sessions.lock().await.len(),
            1,
            "two CONCURRENT creates racing on the same requestId must construct exactly \
             one session object"
        );
    }

    /// Control: DISTINCT requestIds must never dedup against each other.
    #[tokio::test]
    async fn handle_create_distinct_request_ids_create_distinct_sessions() {
        let (st, _killed) = state().await;

        st.handle_create(create_msg("req-dedup-a")).await;
        st.handle_create(create_msg("req-dedup-b")).await;

        assert_eq!(
            st.sessions.lock().await.len(),
            2,
            "two distinct requestIds must each construct their own session"
        );
    }

    /// Cache invalidation: an EXPLICIT `freshAgent.kill` DOES evict the requestId dedup
    /// cache, so a duplicate `create` for the SAME requestId after the kill genuinely
    /// mints a FRESH session (not materialized), not a replay of the killed one.
    ///
    /// NOTE (task-specified suite reduction, justified): unlike codex, opencode has no
    /// exit-watcher/self-heal state machine for its `create` path at all -- `create()`
    /// never spawns a process ([`FreshOpencodeState::handle_create`]'s own doc: "NO
    /// serve spawn, NO durable session yet"; the ONE shared `opencode serve` sidecar is
    /// never torn down per-session). There is no "replay after unrequested exit" code
    /// path distinct from the plain sequential-duplicate case above, so that codex-suite
    /// test would be a duplicate of
    /// `handle_create_duplicate_request_id_preserves_materialized_session_state` here --
    /// dropped rather than mirrored redundantly. 4 tests, not 5.
    #[tokio::test]
    async fn handle_create_duplicate_after_explicit_kill_creates_a_fresh_session() {
        let (st, _killed) = state().await;
        let placeholder = "freshopencode-req-dedup-kill";

        st.handle_create(create_msg("req-dedup-kill")).await;
        st.handle_send(send_msg(placeholder, "hi")).await;
        assert!(
            st.sessions
                .lock()
                .await
                .get(placeholder)
                .unwrap()
                .lock()
                .await
                .real_session_id
                .is_some(),
            "sanity: the session materialized before the kill"
        );

        st.handle_kill(FreshAgentKill {
            provider: AgentProvider::Opencode,
            session_id: placeholder.to_string(),
            session_type: SessionType::Freshopencode,
            cwd: None,
        })
        .await;

        st.handle_create(create_msg("req-dedup-kill")).await;

        let sessions = st.sessions.lock().await;
        assert_eq!(
            sessions.len(),
            1,
            "a duplicate create after an EXPLICIT kill must mint a genuinely FRESH \
             (unmaterialized) session -- only the placeholder key, no durable key"
        );
        let session_arc = sessions.get(placeholder).cloned();
        drop(sessions);
        assert_eq!(
            session_arc
                .expect("the fresh session is tracked under the placeholder id")
                .lock()
                .await
                .real_session_id,
            None,
            "the dedup cache must have been evicted by the kill, so this create is a \
             genuinely fresh (unmaterialized) session, not a replay of the killed one"
        );
    }

    /// Fix Task #3 (defect 3): `GET /api/fresh-agent/threads/freshopencode/opencode/<id>`
    /// for a `freshopencode-*` placeholder id -- created via `handle_create`, BEFORE any
    /// `handle_send` materializes it into a real `ses_*` session -- must build a
    /// schema-valid, EMPTY snapshot, never reach the serve manager, and never 500/404.
    /// Once materialized, the SAME flow (now addressed by the durable `ses_*` id) must
    /// return the session's real turns.
    #[tokio::test]
    async fn get_opencode_snapshot_of_live_placeholder_before_first_send_is_empty_then_real_after_materialization(
    ) {
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
        let fresh_agent = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx));
        let deps = ServeDeps {
            spawner: Arc::new(TrackedSpawner {
                killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            }),
            http: Arc::new(RealisticServeHttp::new()),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        manager
            .ensure_started()
            .await
            .expect("healthy fake serve starts");
        fresh_agent.set_manager_for_test(manager).await;
        let st = FreshOpencodeState::new(fresh_agent);

        st.handle_create(create_msg("req-t3")).await;
        let placeholder = "freshopencode-req-t3";

        // BEFORE the fix, this call falls straight through to
        // `manager.get_session(placeholder, ..)` -- which `RealisticServeHttp` (mimicking
        // the REAL serve genuinely never having heard of this synthetic id) 404s, exactly
        // reproducing the reported "Failed to load session" defect. AFTER the fix, the
        // placeholder-shaped id short-circuits before ever touching the manager.
        let snapshot = st
            .fresh_agent
            .get_opencode_snapshot(placeholder, None)
            .await
            .expect("a live, not-yet-materialized placeholder must not 404/500");

        assert_eq!(snapshot["sessionType"], json!("freshopencode"));
        assert_eq!(snapshot["provider"], json!("opencode"));
        assert_eq!(snapshot["threadId"], json!(placeholder));
        assert_eq!(snapshot["sessionId"], json!(placeholder));
        assert_eq!(snapshot["status"], json!("idle"));
        assert_eq!(snapshot["revision"], json!(0));
        assert_eq!(snapshot["latestTurnId"], Value::Null);
        assert_eq!(snapshot["turns"], json!([]));
        assert_eq!(snapshot["pendingApprovals"], json!([]));
        assert_eq!(snapshot["pendingQuestions"], json!([]));
        assert_eq!(snapshot["worktrees"], json!([]));
        assert_eq!(snapshot["diffs"], json!([]));
        assert_eq!(snapshot["childThreads"], json!([]));
        assert_eq!(snapshot["capabilities"]["send"], json!(true));
        assert_eq!(snapshot["capabilities"]["interrupt"], json!(true));
        assert_eq!(
            snapshot.get("summary"),
            None,
            "no title yet -- omitted like `normalizeOpencodeSnapshot`'s undefined `summary`"
        );

        // Now materialize (first `handle_send`) and confirm the SAME flow, addressed by
        // the new durable id, returns the session's real turns instead of the empty shape.
        st.handle_send(send_msg(placeholder, "hello")).await;
        let durable_id = {
            let guard = st.sessions.lock().await;
            let session_arc = guard.get(placeholder).cloned().expect("session exists");
            let s = session_arc.lock().await;
            s.real_session_id.clone().expect("materialized after send")
        };
        assert!(durable_id.starts_with("ses_"));

        let materialized_snapshot = st
            .fresh_agent
            .get_opencode_snapshot(&durable_id, None)
            .await
            .expect("materialized session snapshot builds");
        assert_eq!(materialized_snapshot["threadId"], json!(durable_id));
        assert_eq!(
            materialized_snapshot["summary"],
            json!("materialized session")
        );
        let turns = materialized_snapshot["turns"]
            .as_array()
            .expect("turns array");
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0]["role"], json!("user"));
        assert_eq!(turns[0]["items"][0]["text"], json!("hello"));
    }

    /// Fix Task #3: a `ses_*` id the shared serve genuinely doesn't know about (NOT a
    /// `freshopencode-*` placeholder) must still 404 -- the placeholder short-circuit must
    /// not swallow real "lost session" cases.
    #[tokio::test]
    async fn get_opencode_snapshot_of_unknown_ses_id_is_still_not_found() {
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
        let fresh_agent = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx));
        let deps = ServeDeps {
            spawner: Arc::new(TrackedSpawner {
                killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            }),
            http: Arc::new(RealisticServeHttp::new()),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        manager
            .ensure_started()
            .await
            .expect("healthy fake serve starts");
        fresh_agent.set_manager_for_test(manager).await;

        let err = fresh_agent
            .get_opencode_snapshot("ses_never_created", None)
            .await
            .expect_err("unknown ses_* id");
        assert!(matches!(err, crate::OpencodeSnapshotError::NotFound));
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

    /// Decision-table row: NOT tracked locally + serve genuinely has no record of the id
    /// (a real 404) -> `lost_session_frame` (`INVALID_SESSION_ID`) is still correct.
    #[tokio::test]
    async fn attach_unknown_session_with_genuinely_missing_serve_session_emits_lost_session_error()
    {
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let fresh_agent = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx));
        let deps = ServeDeps {
            spawner: Arc::new(TrackedSpawner {
                killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            }),
            http: Arc::new(RealisticServeHttp::new()),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        manager
            .ensure_started()
            .await
            .expect("healthy fake serve starts");
        fresh_agent.set_manager_for_test(manager).await;
        let st = FreshOpencodeState::new(fresh_agent);

        st.handle_attach(attach_msg("does-not-exist")).await;

        let frame: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(frame["type"], "freshAgent.event");
        assert_eq!(frame["sessionId"], "does-not-exist");
        assert_eq!(frame["event"]["type"], "freshAgent.error");
        assert_eq!(frame["event"]["code"], "INVALID_SESSION_ID");
    }

    /// THE FIX (defect 2, opencode half): a durable `ses_*` session the shared `opencode
    /// serve` sidecar still knows about, but which this process's WS session map has
    /// never heard of (e.g. a page reload after a server restart), must be resumed and
    /// registered instead of declared lost.
    #[tokio::test]
    async fn attach_unknown_session_resumes_a_durable_serve_session_not_in_the_local_map() {
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let fresh_agent = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx));
        let deps = ServeDeps {
            spawner: Arc::new(TrackedSpawner {
                killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            }),
            http: Arc::new(RealisticServeHttp::new()),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        manager
            .ensure_started()
            .await
            .expect("healthy fake serve starts");

        // Seed a durable session directly through the manager -- simulating a session
        // that exists in opencode serve's own store but was never created/attached
        // through this process's WS session map.
        let created = manager
            .create_session(None, None, None)
            .await
            .expect("create_session");
        let durable_id = created.id.clone();

        fresh_agent.set_manager_for_test(manager).await;
        let st = FreshOpencodeState::new(fresh_agent);
        assert!(
            !st.sessions.lock().await.contains_key(&durable_id),
            "not tracked locally yet"
        );

        st.handle_attach(attach_msg(&durable_id)).await;

        let frame: serde_json::Value =
            tokio::time::timeout(std::time::Duration::from_secs(5), async {
                loop {
                    let raw = rx.recv().await.expect("bus stays open");
                    let frame: serde_json::Value = serde_json::from_str(&raw).unwrap();
                    if frame["type"] == "freshAgent.event" {
                        return frame;
                    }
                }
            })
            .await
            .expect("attach resumes within the budget");

        assert_eq!(frame["sessionId"], durable_id);
        assert_eq!(frame["event"]["type"], "freshAgent.session.snapshot");
        assert_eq!(frame["event"]["status"], "idle");
        assert_ne!(
            frame["event"]["code"], "INVALID_SESSION_ID",
            "a durable serve session must never be declared lost"
        );

        let session_arc = st
            .sessions
            .lock()
            .await
            .get(&durable_id)
            .cloned()
            .expect("registered for reuse");
        let real_id = session_arc.lock().await.real_session_id.clone();
        assert_eq!(real_id.as_deref(), Some(durable_id.as_str()));
    }

    /// A `ProcessSpawner` that always fails, so `ensure_manager`/`get_session` surfaces a
    /// genuine manager/transport failure rather than a 404.
    struct FailingSpawner;
    impl ProcessSpawner for FailingSpawner {
        fn spawn(&self, _req: SpawnRequest) -> Result<Box<dyn ServeProcess>, String> {
            Err("boom: no opencode binary reachable".to_string())
        }
    }

    /// Decision-table row: NOT tracked locally + the manager/transport call itself fails
    /// (not a 404) -> a `OPENCODE_ATTACH_RESUME_FAILED` error frame, NEVER
    /// `INVALID_SESSION_ID` -- a transient infra hiccup must not cause the client to
    /// abandon an otherwise-healthy durable session via `markSessionLost`.
    #[tokio::test]
    async fn attach_unknown_session_with_transient_manager_failure_emits_resume_failed_error() {
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let fresh_agent = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx));
        let deps = ServeDeps {
            spawner: Arc::new(FailingSpawner),
            http: Arc::new(RealisticServeHttp::new()),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        // Deliberately do NOT call `ensure_started()` -- the resume path itself must
        // trigger the (failing) cold-start via `get_session`.
        fresh_agent.set_manager_for_test(manager).await;
        let st = FreshOpencodeState::new(fresh_agent);

        st.handle_attach(attach_msg("ses_some_durable_id")).await;

        let frame: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(frame["type"], "error");
        assert!(
            frame["message"]
                .as_str()
                .unwrap()
                .starts_with("OPENCODE_ATTACH_RESUME_FAILED:"),
            "{frame}"
        );
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

    /// Task 5 (reconnect-revive): a pane restored from the persisted layout may still be
    /// addressed by the PLACEHOLDER id of an already-materialized session (it missed the
    /// original materialized frame while disconnected). Its tracked `freshAgent.attach`
    /// must re-key it FIRST via `freshAgent.session.materialized` — otherwise the ack
    /// snapshot (stamped with the real `ses_*` id per the `real ?? placeholder` rule)
    /// fails `locatorMatchesPane` and the pane's next snapshot GET 404s into a false
    /// `durable_artifact_missing` against a live session.
    #[tokio::test]
    async fn attach_placeholder_addressed_session_emits_materialized_first() {
        let (st, mut rx) = state_with_status_poll_and_receiver(1).await;

        st.handle_create(create_msg("req-attach-ph")).await;
        let placeholder = "freshopencode-req-attach-ph";
        st.handle_send(send_msg(placeholder, "hello")).await;
        let real_id = {
            let guard = st.sessions.lock().await;
            let session_arc = guard.get(placeholder).cloned().expect("session exists");
            let s = session_arc.lock().await;
            s.real_session_id.clone().expect("materialized after send")
        };

        // Same settle-wait as `attach_known_materialized_session_emits_idle_snapshot`:
        // the ack snapshot's `status` must not race the detached turn task.
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

        // Drain every pre-attach frame (created / materialized-on-send / status / turn
        // frames) so what is collected below is exactly what THIS attach emits; the
        // awaited `handle_attach` queues all of its frames before it returns.
        while rx.try_recv().is_ok() {}

        st.handle_attach(attach_msg(placeholder)).await;
        let mut frames: Vec<serde_json::Value> = Vec::new();
        while let Ok(raw) = rx.try_recv() {
            frames.push(serde_json::from_str(&raw).unwrap());
        }

        let materialized_idx = frames
            .iter()
            .position(|f| f["type"] == "freshAgent.session.materialized")
            .expect("a placeholder-addressed attach must emit the materialized re-key");
        let materialized = &frames[materialized_idx];
        assert_eq!(materialized["previousSessionId"], placeholder);
        assert_eq!(materialized["sessionId"], real_id);
        assert_eq!(materialized["provider"], "opencode");
        assert_eq!(materialized["sessionType"], "freshopencode");
        assert_eq!(materialized["sessionRef"]["sessionId"], real_id);
        assert_eq!(materialized["sessionRef"]["provider"], "opencode");

        let snapshot_idx = frames
            .iter()
            .position(|f| {
                f["event"]["type"] == "freshAgent.session.snapshot" && f["sessionId"] == real_id
            })
            .expect("the ack snapshot is still emitted");
        assert!(
            materialized_idx < snapshot_idx,
            "the re-key must precede the real-id-stamped snapshot: {frames:?}"
        );

        // Regression guard (identity already matches): an attach addressed by the
        // REAL id must NOT re-emit the materialized frame — only the snapshot.
        while rx.try_recv().is_ok() {}
        st.handle_attach(attach_msg(&real_id)).await;
        let mut saw_materialized = false;
        let mut saw_snapshot = false;
        while let Ok(raw) = rx.try_recv() {
            let frame: serde_json::Value = serde_json::from_str(&raw).unwrap();
            if frame["type"] == "freshAgent.session.materialized" {
                saw_materialized = true;
            }
            if frame["event"]["type"] == "freshAgent.session.snapshot" {
                saw_snapshot = true;
            }
        }
        assert!(
            !saw_materialized,
            "an attach addressed by the real id must not spam the materialized frame"
        );
        assert!(
            saw_snapshot,
            "the real-id attach still answers with a snapshot"
        );
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

    // ── P1.13: identity-sink writes (pending at create, binding at materialization,
    // refresh on settings change) ──────────────────────────────────────────

    #[tokio::test]
    async fn materialization_resolves_pending_into_binding_with_settings() {
        // Harness: same FakeHttp setup the existing materialization test uses.
        let (state, _killed) = state().await;
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        state.set_identity_sink(fake.clone());

        // Create with settings, then first send (materializes ses_*):
        // freshAgent.create { requestId: "r1", sessionType: "freshopencode",
        //                     cwd: "/w", model: "big-model", effort: "high" }
        let mut create = create_msg("r1");
        create.cwd = Some("/w".to_string());
        create.model = Some("big-model".to_string());
        create.effort = Some("high".to_string());
        state.handle_create(create).await;
        state
            .handle_send(send_msg("freshopencode-r1", "hello"))
            .await;

        // Pending was recorded at create under the placeholder:
        let pendings = fake.pendings.lock().unwrap();
        assert!(pendings
            .iter()
            .any(|(id, mode, _)| id.starts_with("freshopencode-") && mode == "freshopencode"));
        drop(pendings);

        // Binding recorded at materialization, resolving the pending:
        let bindings = fake.bindings.lock().unwrap();
        let b = bindings
            .iter()
            .find(|b| b.session_id.starts_with("ses_"))
            .expect("binding at materialization");
        assert_eq!(b.provider, "opencode");
        assert_eq!(b.settings.model.as_deref(), Some("big-model"));
        assert_eq!(b.settings.effort.as_deref(), Some("high"));
        assert!(
            b.settings.cwd.is_some(),
            "cwd captured (upgraded from created.directory)"
        );
        assert!(b
            .resolves_pending
            .as_deref()
            .unwrap_or("")
            .starts_with("freshopencode-"));
        // Task 3 (corrected semantics): `create_request_id` is the CREATE's
        // requestId ("r1") — derived from the placeholder id — NOT this send's
        // requestId ("req-hello"), which was the lineage keying bug.
        assert_eq!(
            b.create_request_id.as_deref(),
            Some("r1"),
            "lineage is keyed by the CREATE requestId (placeholder-derived), never the send's"
        );
    }

    #[tokio::test]
    async fn send_with_changed_settings_refreshes_the_binding() {
        // Same harness; after materialization, send again with
        // settings: { model: "small-model", effort: "low" } (FreshAgentSendSettings,
        // consumed per-turn by handle_send's normalize block).
        let (state, _killed) = state().await;
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        state.set_identity_sink(fake.clone());

        let mut create = create_msg("r2");
        create.cwd = Some("/w".to_string());
        create.model = Some("big-model".to_string());
        create.effort = Some("high".to_string());
        state.handle_create(create).await;
        let placeholder = "freshopencode-r2";
        state.handle_send(send_msg(placeholder, "first")).await;

        let mut second = send_msg(placeholder, "second");
        second.settings = Some(freshell_protocol::FreshAgentSendSettings {
            cwd: None,
            effort: Some("low".to_string()),
            model: Some("small-model".to_string()),
            permission_mode: None,
            sandbox: None,
        });
        state.handle_send(second).await;

        // Assert the LAST recorded binding for the ses_* id carries the new values:
        let bindings = fake.bindings.lock().unwrap();
        let b = bindings
            .iter()
            .rev()
            .find(|b| b.session_id.starts_with("ses_"))
            .unwrap();
        assert_eq!(b.settings.model.as_deref(), Some("small-model"));
        assert_eq!(b.settings.effort.as_deref(), Some("low"));
    }

    // ── P1.13 Task 8: settings-from-ledger resume (attach + create-with-resume) ──

    /// The durable `ses_*` id [`RealisticServeHttp`] mints for its FIRST
    /// `POST /session` -- the one durable serve session the Task 8 harness
    /// pre-creates.
    const DURABLE_ID: &str = "ses_1";

    /// Task 8 harness: a [`RealisticServeHttp`]-backed state (same fakes as the
    /// donor test `attach_unknown_session_resumes_a_durable_serve_session_not_in_the_local_map`)
    /// with ONE durable serve session pre-created ([`DURABLE_ID`]) that the local WS
    /// session map has never heard of, plus a bus receiver subscribed BEFORE any
    /// handler runs. Each test wires its own identity-sink fixture.
    async fn state_with_durable_serve_session(
    ) -> (FreshOpencodeState, tokio::sync::broadcast::Receiver<String>) {
        let (tx, rx) = tokio::sync::broadcast::channel::<String>(64);
        let fresh_agent = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx));
        let deps = ServeDeps {
            spawner: Arc::new(TrackedSpawner {
                killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            }),
            http: Arc::new(RealisticServeHttp::new()),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        manager
            .ensure_started()
            .await
            .expect("healthy fake serve starts");
        let created = manager
            .create_session(None, None, None)
            .await
            .expect("create_session");
        assert_eq!(
            created.id, DURABLE_ID,
            "sanity: RealisticServeHttp mints ses_1 for its first create"
        );
        fresh_agent.set_manager_for_test(manager).await;
        let st = FreshOpencodeState::new(fresh_agent);
        assert!(
            !st.sessions.lock().await.contains_key(DURABLE_ID),
            "not tracked locally yet"
        );
        (st, rx)
    }

    #[tokio::test]
    async fn resume_durable_session_reapplies_settings_from_ledger() {
        // Same RealisticServeHttp harness as the donor test.
        let (state, _rx) = state_with_durable_serve_session().await;
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        fake.seed(
            "opencode",
            DURABLE_ID,
            crate::identity_sink::FreshAgentSettings {
                model: Some("big-model".into()),
                sandbox: None,
                permission_mode: None,
                effort: Some("high".into()),
                cwd: Some("/real/project".into()),
            },
        );
        state.set_identity_sink(fake);

        // Drive the same attach the donor test drives -- with a COMPETING cwd on
        // the attach message, so the cwd assertion below proves precedence rather
        // than absence.
        let mut attach = attach_msg(DURABLE_ID);
        attach.cwd = Some("/attach/cwd".to_string());
        state.handle_attach(attach).await;

        let sessions = state.sessions.lock().await;
        let s = sessions.get(DURABLE_ID).expect("resumed").lock().await;
        assert_eq!(s.model.as_deref(), Some("big-model"));
        assert_eq!(s.effort.as_deref(), Some("high"));
        assert_eq!(
            s.cwd.as_deref(),
            Some("/real/project"),
            "cwd from the record, not the attach message"
        );
    }

    /// Task 3: a lineage-only ledger row (binding exists with create_request_id
    /// lineage but an all-blank settings snapshot — exactly what the now-
    /// unconditional materialization writes produce for a default create) must
    /// NEVER arm the V7/A10 SETTINGS_RESET alarm on resume: `was_recorded` now
    /// keys off settings-bearing records, so the gate's second arm is false.
    /// Regression guard for the false-alarm shape (`was_recorded == true` with
    /// `load_settings == None`) the old keying produced.
    #[tokio::test]
    async fn lineage_only_binding_does_not_arm_settings_reset_on_resume() {
        let (state, mut rx) = state_with_durable_serve_session().await;
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        fake.record_binding(crate::identity_sink::FreshAgentBindingUpsert {
            provider: "opencode".into(),
            session_id: DURABLE_ID.into(),
            mode: "freshopencode".into(),
            create_request_id: Some("cr-lineage".into()),
            resolves_pending: Some("freshopencode-cr-lineage".into()),
            supersedes: None,
            settings: crate::identity_sink::FreshAgentSettings::default(),
        })
        .await
        .expect("lineage binding write ok");
        state.set_identity_sink(fake.clone());

        // The lineage row exists but is NOT a settings-bearing record.
        assert!(
            fake.load_settings("opencode", DURABLE_ID).is_none(),
            "a lineage-only row answers no settings snapshot"
        );
        assert!(
            !fake.was_recorded("opencode", DURABLE_ID),
            "a lineage-only row must not count as recorded"
        );

        state.handle_attach(attach_msg(DURABLE_ID)).await;

        let mut saw_settings_reset = false;
        while let Ok(frame) =
            tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv()).await
        {
            let Ok(text) = frame else { break };
            if text.contains("SETTINGS_RESET") {
                saw_settings_reset = true;
            }
        }
        assert!(
            !saw_settings_reset,
            "a lineage-only row must never arm SETTINGS_RESET on resume"
        );
    }

    #[tokio::test]
    async fn resume_without_record_is_silent_and_uses_serve_directory() {
        // Same harness; NO seed (never-recorded session -- the ROUTINE case, V7:
        // handle_attach's own doc describes this attach population).
        let (state, mut rx) = state_with_durable_serve_session().await;
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        state.set_identity_sink(fake.clone());

        state.handle_attach(attach_msg(DURABLE_ID)).await;

        // RealisticServeHttp's GET /session/:id directory is now used instead of
        // being discarded.
        {
            let sessions = state.sessions.lock().await;
            let s = sessions.get(DURABLE_ID).expect("resumed").lock().await;
            assert_eq!(
                s.cwd.as_deref(),
                Some("/serve/dir"),
                "the serve GET /session/:id body's directory must be used, not discarded"
            );
        }

        // NO SETTINGS_RESET frame was broadcast (bounded bus drain -- Task 5 pattern).
        while let Ok(frame) =
            tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv()).await
        {
            let Ok(text) = frame else { break };
            assert!(
                !text.contains("SETTINGS_RESET"),
                "never-recorded resume must stay silent"
            );
        }

        // NO refresh binding was written for the session (no defaults laundering).
        assert!(
            !fake
                .bindings
                .lock()
                .unwrap()
                .iter()
                .any(|b| b.session_id == DURABLE_ID),
            "a load_settings miss must not write a defaults row"
        );
    }

    #[tokio::test]
    async fn resume_with_prior_record_but_unrecoverable_settings_alarms() {
        // fake.seed_recorded_only("opencode", DURABLE_ID) -- was_recorded=true,
        // load_settings=None. The genuine anomaly: the only case that alarms (V7/A10).
        let (state, mut rx) = state_with_durable_serve_session().await;
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        fake.seed_recorded_only("opencode", DURABLE_ID);
        state.set_identity_sink(fake);

        state.handle_attach(attach_msg(DURABLE_ID)).await;

        let mut found = false;
        while let Ok(frame) =
            tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv()).await
        {
            let Ok(text) = frame else { break };
            if text.contains("SETTINGS_RESET") {
                let frame: serde_json::Value = serde_json::from_str(&text).unwrap();
                // Top-level sessionType/provider (locator resolution) + a
                // user-facing message (the banner shows the message, not the code).
                assert_eq!(frame["sessionType"], "freshopencode");
                assert_eq!(frame["provider"], "opencode");
                assert_eq!(frame["event"]["code"], "SETTINGS_RESET");
                assert!(frame["event"]["message"]
                    .as_str()
                    .unwrap()
                    .contains("Reconfirm your settings"));
                found = true;
                break;
            }
        }
        assert!(
            found,
            "recorded-but-unrecoverable resume must broadcast SETTINGS_RESET"
        );
    }

    #[tokio::test]
    async fn create_with_session_ref_rebinds_the_durable_session() {
        // V2/A4: the frozen client's ONLY post-reload resume vehicle is
        // freshAgent.create{sessionRef: {provider: "opencode", sessionId: ses_*}}
        // -- donor shape: codex's
        // handle_create_with_session_ref_resumes_the_same_thread.
        let (state, mut rx) = state_with_durable_serve_session().await;
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        fake.seed(
            "opencode",
            DURABLE_ID,
            crate::identity_sink::FreshAgentSettings {
                model: Some("big-model".into()),
                sandbox: None,
                permission_mode: None,
                effort: Some("high".into()),
                cwd: Some("/real/project".into()),
            },
        );
        state.set_identity_sink(fake);

        let mut create = create_msg("req-resume-oc");
        create.session_ref = Some(freshell_protocol::SessionLocator {
            provider: "opencode".to_string(),
            session_id: DURABLE_ID.to_string(),
        });
        state.handle_create(create).await;

        let sessions = state.sessions.lock().await;
        assert!(
            sessions.contains_key(DURABLE_ID),
            "rebound to the surviving ses_*"
        );
        let s = sessions.get(DURABLE_ID).unwrap().lock().await;
        assert_eq!(
            s.model.as_deref(),
            Some("big-model"),
            "settings-from-ledger applied on the create path"
        );
        drop(s);
        drop(sessions);

        // And the FreshAgentCreated broadcast answered with the ses_* id (not a
        // freshopencode-* placeholder) -- capture it via the bus receiver.
        let mut created_frame: Option<serde_json::Value> = None;
        while let Ok(frame) =
            tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv()).await
        {
            let Ok(text) = frame else { break };
            let frame: serde_json::Value = serde_json::from_str(&text).unwrap();
            if frame["type"] == "freshAgent.created" {
                created_frame = Some(frame);
                break;
            }
        }
        let created = created_frame.expect("a freshAgent.created frame was broadcast");
        assert_eq!(
            created["sessionId"], DURABLE_ID,
            "created must answer with the durable ses_* id, not a placeholder"
        );
        assert_eq!(created["sessionRef"]["sessionId"], DURABLE_ID);
        assert!(
            !created["sessionId"]
                .as_str()
                .unwrap()
                .starts_with("freshopencode-"),
            "never a freshopencode-* placeholder on a resume-create"
        );
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

    // ── freshAgent.compact (AGENT-04, approval-respond Task 4) ─────────────

    fn compact_msg(session_id: &str) -> FreshAgentCompact {
        FreshAgentCompact {
            provider: AgentProvider::Opencode,
            session_id: session_id.to_string(),
            session_type: SessionType::Freshopencode,
            cwd: None,
            instructions: None,
        }
    }

    /// One recorded fake-serve request.
    #[derive(Clone, Debug)]
    struct RecordedRequest {
        method: String,
        url: String,
        body: Option<Value>,
    }

    /// The compact-suite serve fake: records EVERY request, scripts `/config`, fails
    /// summarize on demand, and re-arms a per-session busy budget (two polls) on every
    /// `prompt_async`/`summarize` POST so `await_idle`'s status-poll fallback resolves
    /// deterministically. `summarize` additionally pins the reviewed lifecycle ORDER:
    /// drained synchronously from its own bus probe, the LAST session snapshot before
    /// the POST must be the busy `running` one (the busy indicator is visible before
    /// the upstream request settles).
    struct CompactFakeHttp {
        next_session: AtomicUsize,
        requests: StdMutex<Vec<RecordedRequest>>,
        busy_budget: StdMutex<std::collections::HashMap<String, usize>>,
        summarize_fails: bool,
        config_body: Vec<u8>,
        bus_probe: StdMutex<tokio::sync::broadcast::Receiver<String>>,
        /// D1-F1: when set, the summarize POST parks on `notified()` AFTER
        /// recording itself + the order pin — a deterministic "compact in
        /// flight" window for the kill/interrupt lifecycle tests.
        summarize_gate: Option<Arc<tokio::sync::Notify>>,
    }

    impl CompactFakeHttp {
        fn new(
            config_body: Vec<u8>,
            summarize_fails: bool,
            bus_probe: tokio::sync::broadcast::Receiver<String>,
            summarize_gate: Option<Arc<tokio::sync::Notify>>,
        ) -> Self {
            Self {
                next_session: AtomicUsize::new(0),
                requests: StdMutex::new(Vec::new()),
                busy_budget: StdMutex::new(std::collections::HashMap::new()),
                summarize_fails,
                config_body,
                bus_probe: StdMutex::new(bus_probe),
                summarize_gate,
            }
        }

        fn recorded(&self) -> Vec<RecordedRequest> {
            self.requests.lock().expect("requests mutex").clone()
        }

        fn summarize_requests(&self) -> Vec<RecordedRequest> {
            self.recorded()
                .into_iter()
                .filter(|r| r.method == "POST" && r.url.contains("/summarize"))
                .collect()
        }

        fn get_config_count(&self) -> usize {
            self.recorded()
                .iter()
                .filter(|r| r.method == "GET" && r.url.contains("/config"))
                .count()
        }

        /// Synchronously drain the bus probe and return the LAST `running`/`idle`
        /// snapshot status seen for `session_id`, if any.
        fn last_snapshot_status_for(&self, session_id: &str) -> Option<String> {
            let mut last = None;
            let mut probe = self.bus_probe.lock().expect("bus probe mutex");
            while let Ok(text) = probe.try_recv() {
                let Ok(v) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                if v["type"] == "freshAgent.event"
                    && v["sessionId"] == session_id
                    && v["event"]["type"] == "freshAgent.session.snapshot"
                {
                    last = v["event"]["status"].as_str().map(str::to_string);
                }
            }
            last
        }
    }

    impl ServeHttp for CompactFakeHttp {
        fn request<'a>(
            &'a self,
            req: ServeHttpRequest,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<ServeHttpResponse, String>> + Send + 'a>,
        > {
            let method = format!("{:?}", req.method).to_uppercase();
            let body_value = req
                .body
                .as_ref()
                .and_then(|b| serde_json::from_slice::<Value>(b).ok());
            self.requests
                .lock()
                .expect("requests mutex")
                .push(RecordedRequest {
                    method: method.clone(),
                    url: req.url.clone(),
                    body: body_value,
                });

            if req.url.contains("/global/health") {
                return Box::pin(async { Ok(ServeHttpResponse::new(200, b"{}".to_vec())) });
            }
            // Precise create-match: exactly `POST /session` (optionally `?directory=...`).
            if method == "POST" && (req.url.ends_with("/session") || req.url.contains("/session?"))
            {
                let n = self.next_session.fetch_add(1, Ordering::SeqCst) + 1;
                let body =
                    serde_json::to_vec(&json!({ "id": format!("ses_{n}"), "directory": null }))
                        .unwrap();
                return Box::pin(async move { Ok(ServeHttpResponse::new(200, body)) });
            }
            if method == "POST" && req.url.contains("/summarize") {
                let id = req
                    .url
                    .split("/session/")
                    .nth(1)
                    .and_then(|rest| rest.split(['/', '?']).next())
                    .unwrap_or("")
                    .to_string();
                // ORDER PIN: the busy snapshot must already be on the bus when the
                // summarize POST lands (reviewed lifecycle: running FIRST, then POST).
                assert_eq!(
                    self.last_snapshot_status_for(&id).as_deref(),
                    Some("running"),
                    "the busy `running` snapshot must precede the summarize POST"
                );
                if self.summarize_fails {
                    return Box::pin(async {
                        Ok(ServeHttpResponse::new(500, b"summarize exploded".to_vec()))
                    });
                }
                self.busy_budget
                    .lock()
                    .expect("busy budget mutex")
                    .insert(id, 2);
                let gate = self.summarize_gate.clone();
                return Box::pin(async move {
                    if let Some(gate) = gate {
                        gate.notified().await;
                    }
                    Ok(ServeHttpResponse::new(200, b"true".to_vec()))
                });
            }
            if method == "POST" && req.url.contains("/prompt_async") {
                let id = req
                    .url
                    .split("/session/")
                    .nth(1)
                    .and_then(|rest| rest.split(['/', '?']).next())
                    .unwrap_or("")
                    .to_string();
                self.busy_budget
                    .lock()
                    .expect("busy budget mutex")
                    .insert(id, 2);
                return Box::pin(async { Ok(ServeHttpResponse::new(200, b"{}".to_vec())) });
            }
            if method == "GET" && req.url.contains("/session/status") {
                let mut budgets = self.busy_budget.lock().expect("busy budget mutex");
                let mut map = serde_json::Map::new();
                for (id, budget) in budgets.iter_mut() {
                    if *budget > 0 {
                        *budget -= 1;
                        map.insert(id.clone(), json!({ "type": "busy" }));
                    }
                }
                let body = serde_json::to_vec(&Value::Object(map)).unwrap();
                return Box::pin(async move { Ok(ServeHttpResponse::new(200, body)) });
            }
            if method == "GET" && req.url.contains("/config") {
                let body = self.config_body.clone();
                return Box::pin(async move { Ok(ServeHttpResponse::new(200, body)) });
            }
            Box::pin(async { Ok(ServeHttpResponse::new(200, b"{}".to_vec())) })
        }
    }

    /// Build a [`FreshOpencodeState`] over a [`CompactFakeHttp`]-backed serve manager,
    /// returning the state, the fake, and a bus receiver subscribed BEFORE any handler
    /// runs.
    async fn compact_state(
        config_body: &str,
        summarize_fails: bool,
    ) -> (
        FreshOpencodeState,
        Arc<CompactFakeHttp>,
        tokio::sync::broadcast::Receiver<String>,
    ) {
        compact_state_gated(config_body, summarize_fails, None).await
    }

    /// [`compact_state`] with an optional summarize gate (D1-F1: a deterministic
    /// in-flight-compact window for the kill/interrupt lifecycle tests).
    async fn compact_state_gated(
        config_body: &str,
        summarize_fails: bool,
        summarize_gate: Option<Arc<tokio::sync::Notify>>,
    ) -> (
        FreshOpencodeState,
        Arc<CompactFakeHttp>,
        tokio::sync::broadcast::Receiver<String>,
    ) {
        let (tx, rx) = tokio::sync::broadcast::channel::<String>(64);
        let fresh_agent = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx.clone()));
        let http = Arc::new(CompactFakeHttp::new(
            config_body.as_bytes().to_vec(),
            summarize_fails,
            tx.subscribe(),
            summarize_gate,
        ));
        let deps = ServeDeps {
            spawner: Arc::new(TrackedSpawner {
                killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            }),
            http: http.clone(),
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
        (FreshOpencodeState::new(fresh_agent), http, rx)
    }

    /// Insert a directly-materialized session (no send drove it) with the given model.
    async fn insert_compact_session(st: &FreshOpencodeState, id: &str, model: Option<&str>) {
        let mut session =
            OpencodeSession::new(id.to_string(), None, model.map(str::to_string), None);
        session.real_session_id = Some(id.to_string());
        st.sessions
            .lock()
            .await
            .insert(id.to_string(), Arc::new(TokioMutex::new(session)));
    }

    /// Drain every buffered bus frame in arrival order (full parsed payloads).
    fn drain_frames(rx: &mut tokio::sync::broadcast::Receiver<String>) -> Vec<Value> {
        let mut out = Vec::new();
        while let Ok(raw) = rx.try_recv() {
            let Ok(v) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            out.push(v);
        }
        out
    }

    /// Collect bus frames (in arrival order) until `pred` matches one of them,
    /// returning everything seen INCLUDING the matching frame. Bounded: panics
    /// after 5s with no match, so a missing terminal frame fails loudly instead
    /// of hanging the suite. Needed wherever a handler's settle tail runs in a
    /// DETACHED driving task (D1-F1: a compact's settle lives on the session's
    /// `turn_task`, exactly like a send turn's).
    async fn frames_until(
        rx: &mut tokio::sync::broadcast::Receiver<String>,
        pred: impl Fn(&Value) -> bool,
    ) -> Vec<Value> {
        let mut out = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let raw = rx.recv().await.expect("the bus stays open");
                let Ok(v) = serde_json::from_str::<Value>(&raw) else {
                    continue;
                };
                let hit = pred(&v);
                out.push(v);
                if hit {
                    break;
                }
            }
        })
        .await
        .expect("a matching frame arrives within the budget");
        out
    }

    /// `true` when `frame` is a `freshAgent.event` whose inner `event.type == wanted`
    /// (and, when given, whose inner `status == status`).
    fn is_event(frame: &Value, wanted: &str, status: Option<&str>) -> bool {
        frame["type"] == "freshAgent.event"
            && frame["event"]["type"] == wanted
            && status
                .map(|s| frame["event"]["status"] == s)
                .unwrap_or(true)
    }

    #[tokio::test]
    async fn compact_posts_summarize_with_the_session_model_then_busy_idle_and_one_chime() {
        let (st, http, mut rx) = compact_state(r#"{"model":null}"#, false).await;
        insert_compact_session(&st, "ses_1", Some("prov-a/mdl-x")).await;

        // The pane's Compact click carries instructions, but opencode's summarize
        // schema has NO instructions field -- they are deliberately DROPPED.
        let mut msg = compact_msg("ses_1");
        msg.instructions = Some("focus the diff".to_string());
        st.handle_compact(msg).await;

        // The drive is detached+registered (D1-F1): await its terminal chime so
        // the POST/idle assertions below never race the spawned task.
        let frames = frames_until(&mut rx, |f| is_event(f, "freshAgent.turn.complete", None)).await;

        let summarize = http.summarize_requests();
        assert_eq!(summarize.len(), 1, "exactly one summarize POST");
        assert!(summarize[0].url.contains("/session/ses_1/summarize"));
        let body = summarize[0].body.clone().expect("a JSON body");
        let obj = body.as_object().unwrap();
        assert_eq!(
            obj.len(),
            2,
            "additionalProperties:false — EXACTLY providerID+modelID: {body}"
        );
        assert_eq!(body["providerID"], "prov-a");
        assert_eq!(body["modelID"], "mdl-x");
        assert_eq!(
            http.get_config_count(),
            0,
            "a splittable session model wins -- /config is NOT consulted"
        );
        assert!(
            frames
                .iter()
                .any(|f| is_event(f, "freshAgent.session.snapshot", Some("running"))),
            "busy snapshot present: {frames:?}"
        );
        let idle_idx = frames
            .iter()
            .position(|f| is_event(f, "freshAgent.session.snapshot", Some("idle")))
            .expect("an idle snapshot was broadcast");
        let complete_idx = frames
            .iter()
            .position(|f| is_event(f, "freshAgent.turn.complete", None))
            .expect("the gated turn.complete was broadcast");
        assert!(
            idle_idx < complete_idx,
            "idle precedes the chime: {frames:?}"
        );
        assert!(
            frames[complete_idx]["event"]["at"].as_i64().unwrap_or(0) > 0,
            "the chime carries a positive monotonic at: {frames:?}"
        );
    }

    #[tokio::test]
    async fn compact_falls_back_to_the_serve_config_model_when_the_session_has_none() {
        let (st, http, mut rx) =
            compact_state(r#"{"model":"conf-prov/conf-mdl","theme":"dark"}"#, false).await;
        // A resumed session never touched by a send can carry NO model.
        insert_compact_session(&st, "ses_1", None).await;

        st.handle_compact(compact_msg("ses_1")).await;

        // GET /config ran inline (pre-spawn); the POST runs on the detached
        // drive — await its terminal chime before asserting over it.
        assert_eq!(http.get_config_count(), 1, "GET /config ran exactly once");
        let frames = frames_until(&mut rx, |f| is_event(f, "freshAgent.turn.complete", None)).await;
        let summarize = http.summarize_requests();
        assert_eq!(summarize.len(), 1);
        let body = summarize[0].body.clone().unwrap();
        assert_eq!(body["providerID"], "conf-prov");
        assert_eq!(body["modelID"], "conf-mdl");

        assert!(
            frames
                .iter()
                .any(|f| is_event(f, "freshAgent.turn.complete", None)),
            "resolution via /config still completes: {frames:?}"
        );
    }

    #[tokio::test]
    async fn compact_with_no_resolvable_model_errors_loudly_and_never_posts() {
        let (st, http, mut rx) = compact_state(r#"{"model":null}"#, false).await;
        // An unsplittable session model forces the /config fallback, which is null.
        insert_compact_session(&st, "ses_1", Some("noslash")).await;

        st.handle_compact(compact_msg("ses_1")).await;

        assert_eq!(
            http.get_config_count(),
            1,
            "the unsplittable session model did consult /config"
        );
        assert!(
            http.summarize_requests().is_empty(),
            "NO POST when no model pair is resolvable"
        );

        let frames = drain_frames(&mut rx);
        assert!(
            frames
                .iter()
                .any(|f| is_event(f, "freshAgent.session.snapshot", Some("running"))),
            "the busy snapshot precedes the resolution attempt: {frames:?}"
        );
        assert!(
            frames
                .iter()
                .any(|f| is_event(f, "freshAgent.session.snapshot", Some("idle"))),
            "the pane is NOT left stuck busy: {frames:?}"
        );
        assert!(
            !frames
                .iter()
                .any(|f| is_event(f, "freshAgent.turn.complete", None)),
            "no false success chime: {frames:?}"
        );
        let error_frame = frames
            .iter()
            .find(|f| is_event(f, "freshAgent.error", None))
            .expect("the failure is LOUD (a freshAgent.error frame)");
        assert_eq!(
            error_frame["event"]["code"], "OPENCODE_COMPACT_FAILED",
            "{error_frame}"
        );
        let message = error_frame["event"]["message"].as_str().unwrap_or("");
        assert!(
            message.to_ascii_lowercase().contains("compact"),
            "the message names the failed compact: {message}"
        );
    }

    #[tokio::test]
    async fn compact_on_a_not_yet_materialized_session_is_a_silent_noop() {
        let (st, http, mut rx) = compact_state(r#"{"model":null}"#, false).await;

        st.handle_create(create_msg("req-noop")).await;
        let placeholder = "freshopencode-req-noop";
        // Drain the freshAgent.created frame.
        assert!(rx.try_recv().is_ok());

        st.handle_compact(compact_msg(placeholder)).await;

        assert!(
            http.summarize_requests().is_empty(),
            "unmaterialized -> NO POST at all (legacy adapter.ts:992-994)"
        );
        assert_eq!(
            http.get_config_count(),
            0,
            "unmaterialized -> no model resolution either"
        );
        assert!(rx.try_recv().is_err(), "a silent no-op broadcasts NOTHING");
    }

    #[tokio::test]
    async fn compact_after_an_interrupted_or_errored_turn_resets_the_stale_flags_and_chimes() {
        let (st, http, mut rx) = compact_state(r#"{"model":null}"#, false).await;
        insert_compact_session(&st, "ses_1", Some("prov-a/mdl-x")).await;
        {
            let session_arc = st.sessions.lock().await.get("ses_1").cloned().unwrap();
            let session = session_arc.lock().await;
            // Stale flags from a prior interrupted AND errored turn: a compact that
            // completes successfully MUST still chime (they get reset FIRST).
            session.turn_aborted.store(true, Ordering::SeqCst);
            session.turn_errored.store(true, Ordering::SeqCst);
        }

        st.handle_compact(compact_msg("ses_1")).await;

        let frames = frames_until(&mut rx, |f| is_event(f, "freshAgent.turn.complete", None)).await;
        assert_eq!(http.summarize_requests().len(), 1);
        assert!(
            frames
                .iter()
                .any(|f| is_event(f, "freshAgent.turn.complete", None)),
            "stale aborted/errored flags must not suppress this compact's completion: {frames:?}"
        );
    }

    #[tokio::test]
    async fn compact_serve_error_broadcasts_idle_and_a_loud_error_without_a_chime() {
        let (st, http, mut rx) = compact_state(r#"{"model":null}"#, true).await;
        insert_compact_session(&st, "ses_1", Some("prov-a/mdl-x")).await;

        st.handle_compact(compact_msg("ses_1")).await;

        // The failure settles on the detached drive (D1-F1): the terminal frame
        // is the loud error (idle precedes it inside the settle tail).
        let frames = frames_until(&mut rx, |f| is_event(f, "freshAgent.error", None)).await;
        assert_eq!(http.summarize_requests().len(), 1, "the POST did land");
        assert!(
            frames
                .iter()
                .any(|f| is_event(f, "freshAgent.session.snapshot", Some("running"))),
            "busy shown first: {frames:?}"
        );
        assert!(
            frames
                .iter()
                .any(|f| is_event(f, "freshAgent.session.snapshot", Some("idle"))),
            "the pane returns to idle even on failure (legacy emitStatus idle): {frames:?}"
        );
        let error_frame = frames
            .iter()
            .find(|f| is_event(f, "freshAgent.error", None))
            .expect("a loud freshAgent.error");
        assert_eq!(
            error_frame["event"]["code"], "OPENCODE_COMPACT_FAILED",
            "{error_frame}"
        );
        assert!(
            error_frame["event"]["message"]
                .as_str()
                .unwrap_or("")
                .contains("summarize exploded"),
            "the serve error text crosses the wire: {error_frame}"
        );
        assert!(
            !frames
                .iter()
                .any(|f| is_event(f, "freshAgent.turn.complete", None)),
            "a serve error never fabricates a completion: {frames:?}"
        );
    }

    // ── D1-F1: compact is turn-scoped — busy refusal + kill/interrupt ──────

    /// Wait (bounded) until the fake has recorded its first summarize POST —
    /// with the gated fake this is the deterministic "compact parked mid-drive"
    /// state for the kill/interrupt tests below.
    async fn await_summarize_posted(http: &Arc<CompactFakeHttp>) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if !http.summarize_requests().is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the summarize POST lands within the budget");
    }

    /// D1-F1(a): the composer stays interactive while a session is busy, so a
    /// `/compact` gesture CAN arrive while a turn is in flight. The compact
    /// must be REFUSED with a nested `freshAgent.error{INTERNAL_ERROR}` naming
    /// the in-flight turn — and must never reach the summarize POST (a second
    /// idle-waiter on one edge would settle both operations and produce a
    /// false/duplicate completion). This refusal EXCEEDS legacy: the Node
    /// adapter CHAINS compact onto `state.sendQueue` (adapter.ts:992); we
    /// refuse loudly instead of queueing.
    #[tokio::test]
    async fn compact_while_a_turn_is_in_flight_is_refused_and_never_posts() {
        let (st, http, mut rx) = compact_state(r#"{"model":null}"#, false).await;
        insert_compact_session(&st, "ses_1", Some("prov-a/mdl-x")).await;
        let session_arc = st.sessions.lock().await.get("ses_1").cloned().unwrap();
        // A genuinely in-flight turn (never resolves) parked as the session's
        // driving task — the exact state a queued-send busy pane leaves behind.
        session_arc.lock().await.turn_task = Some(TurnTask {
            kind: TurnTaskKind::Send,
            handle: tokio::spawn(std::future::pending::<()>()),
        });

        st.handle_compact(compact_msg("ses_1")).await;

        assert!(
            http.summarize_requests().is_empty(),
            "a busy session must NEVER reach the summarize POST"
        );
        assert_eq!(
            http.get_config_count(),
            0,
            "a refused compact resolves no model pair"
        );
        let frames = drain_frames(&mut rx);
        let refusal = frames
            .iter()
            .find(|f| is_event(f, "freshAgent.error", None))
            .expect("the refusal is a LOUD nested freshAgent.error");
        assert_eq!(refusal["event"]["code"], "INTERNAL_ERROR", "{refusal}");
        assert!(
            refusal["event"]["message"]
                .as_str()
                .unwrap_or("")
                .contains("turn is in progress"),
            "the message names the in-flight turn: {refusal}"
        );
        assert!(
            !frames
                .iter()
                .any(|f| is_event(f, "freshAgent.turn.complete", None)),
            "a refusal never chimes: {frames:?}"
        );
        // The in-flight turn's task is untouched — still registered, still running.
        let task = session_arc
            .lock()
            .await
            .turn_task
            .take()
            .expect("the refusal must not steal the turn's task");
        assert!(
            !task.is_finished(),
            "the refused compact left the turn alone"
        );
        task.abort();
    }

    /// D1-F1(b): the compact's driving task is the session's `turn_task`, so a
    /// `freshAgent.kill` mid-compact aborts it — dropped mid-await, it never
    /// reaches the settle tail: NO false `freshAgent.turn.complete` (and the
    /// released gate resurrects nothing).
    #[tokio::test]
    async fn kill_during_an_in_flight_compact_aborts_it_without_a_false_completion() {
        let gate = Arc::new(tokio::sync::Notify::new());
        let (st, http, mut rx) =
            compact_state_gated(r#"{"model":null}"#, false, Some(gate.clone())).await;
        insert_compact_session(&st, "ses_1", Some("prov-a/mdl-x")).await;
        let session_arc = st.sessions.lock().await.get("ses_1").cloned().unwrap();

        // The handler spawns + registers the driving task, then returns — the
        // drive runs DETACHED (a pre-fix regression would block inline on the
        // gate here, which the timeout turns into a clean failure).
        tokio::time::timeout(
            Duration::from_secs(2),
            st.handle_compact(compact_msg("ses_1")),
        )
        .await
        .expect("handle_compact returns after registering the driving task");

        {
            let session = session_arc.lock().await;
            let task = session
                .turn_task
                .as_ref()
                .expect("the compact's driving task is registered as turn_task");
            assert!(
                !task.is_finished(),
                "the registered compact is parked on the summarize gate"
            );
        }
        // Wait until the summarize POST is parked on the gate — deterministically
        // in-flight — before the kill lands.
        await_summarize_posted(&http).await;

        st.handle_kill(FreshAgentKill {
            provider: AgentProvider::Opencode,
            session_id: "ses_1".to_string(),
            session_type: SessionType::Freshopencode,
            cwd: None,
        })
        .await;
        assert!(
            !st.has_live_session("ses_1").await,
            "kill removes the session's bookkeeping"
        );
        gate.notify_waiters(); // released AFTER the abort: nothing may resume
        tokio::time::sleep(Duration::from_millis(50)).await; // settle window

        let frames = drain_frames(&mut rx);
        assert!(
            frames
                .iter()
                .any(|f| is_event(f, "freshAgent.session.snapshot", Some("running"))),
            "the compact's busy snapshot was broadcast: {frames:?}"
        );
        assert!(
            frames.iter().any(|f| f["type"] == "freshAgent.killed"),
            "the kill frame was broadcast: {frames:?}"
        );
        assert!(
            !frames
                .iter()
                .any(|f| is_event(f, "freshAgent.turn.complete", None)),
            "an aborted compact must NEVER fabricate a turn-complete: {frames:?}"
        );
    }

    /// D1-F1(b), symmetric interrupt case: `freshAgent.interrupt` mid-compact
    /// sets `turn_aborted` BEFORE aborting the registered task and issues the
    /// best-effort serve abort — the pane hears the interrupt's idle and NEVER
    /// a chime (even a settle that outran the abort would be gated by the flag).
    #[tokio::test]
    async fn interrupt_during_an_in_flight_compact_aborts_it_and_emits_idle_without_a_chime() {
        let gate = Arc::new(tokio::sync::Notify::new());
        let (st, http, mut rx) =
            compact_state_gated(r#"{"model":null}"#, false, Some(gate.clone())).await;
        insert_compact_session(&st, "ses_1", Some("prov-a/mdl-x")).await;
        let session_arc = st.sessions.lock().await.get("ses_1").cloned().unwrap();

        tokio::time::timeout(
            Duration::from_secs(2),
            st.handle_compact(compact_msg("ses_1")),
        )
        .await
        .expect("handle_compact returns after registering the driving task");
        await_summarize_posted(&http).await;

        st.handle_interrupt(FreshAgentInterrupt {
            provider: AgentProvider::Opencode,
            session_id: "ses_1".to_string(),
            session_type: SessionType::Freshopencode,
            cwd: None,
        })
        .await;
        gate.notify_waiters(); // the aborted task can never consume this
        tokio::time::sleep(Duration::from_millis(50)).await; // settle window

        let frames = drain_frames(&mut rx);
        assert!(
            frames
                .iter()
                .any(|f| is_event(f, "freshAgent.session.snapshot", Some("idle"))),
            "the interrupt's own idle snapshot lands: {frames:?}"
        );
        assert!(
            !frames
                .iter()
                .any(|f| is_event(f, "freshAgent.turn.complete", None)),
            "an interrupted compact must NEVER fabricate a turn-complete: {frames:?}"
        );
        assert!(
            http.recorded().iter().any(|r| r.url.contains("/abort")),
            "the best-effort serve abort reached the fake"
        );
        assert!(
            session_arc
                .lock()
                .await
                .turn_task
                .as_ref()
                .map(|t| t.is_finished())
                .unwrap_or(true),
            "the interrupt took + aborted the compact's registered task"
        );
    }

    /// D2-F1 (delta-review round 2): the composer stays interactive while a session
    /// is busy, so a send CAN arrive mid-compact. The send must be REFUSED — a nested
    /// `freshAgent.event{freshAgent.error{INTERNAL_ERROR}}` naming the compact — rather
    /// than overwriting the compact's registered `turn_task`: such an overwrite would
    /// disconnect kill/interrupt from the still-running compact drive and let ONE idle
    /// edge settle both operations (a false/duplicate completion). The refused send
    /// takes NO other action (no prompt POST, no send.accepted, no busy snapshot), the
    /// compact's task stays registered, and a later kill still aborts it.
    #[tokio::test]
    async fn send_during_an_in_flight_compact_is_refused_and_leaves_the_compact_owned() {
        let gate = Arc::new(tokio::sync::Notify::new());
        let (st, http, mut rx) =
            compact_state_gated(r#"{"model":null}"#, false, Some(gate.clone())).await;
        insert_compact_session(&st, "ses_1", Some("prov-a/mdl-x")).await;
        let session_arc = st.sessions.lock().await.get("ses_1").cloned().unwrap();

        // The handler spawns + registers the compact drive, then returns.
        tokio::time::timeout(
            Duration::from_secs(2),
            st.handle_compact(compact_msg("ses_1")),
        )
        .await
        .expect("handle_compact returns after registering the driving task");
        await_summarize_posted(&http).await; // the compact is deterministically in flight

        // The mid-compact send is refused inline (never waits on upstream, never
        // spawns a drive): a clean inline-return assertion pins that ordering.
        tokio::time::timeout(
            Duration::from_secs(2),
            st.handle_send(send_msg("ses_1", "mid-compact")),
        )
        .await
        .expect("the mid-compact send is refused inline, never upstream-blocking");

        let frames = drain_frames(&mut rx);
        let refusal = frames
            .iter()
            .find(|f| is_event(f, "freshAgent.error", None))
            .expect("the refused send answers a LOUD nested freshAgent.error");
        assert_eq!(refusal["event"]["code"], "INTERNAL_ERROR", "{refusal}");
        assert!(
            refusal["event"]["message"]
                .as_str()
                .unwrap_or("")
                .contains("compact"),
            "the message names the in-flight compact: {refusal}"
        );
        assert!(
            !frames
                .iter()
                .any(|f| f["type"] == "freshAgent.send.accepted"),
            "a refused send never broadcasts send.accepted: {frames:?}"
        );
        assert!(
            !http
                .recorded()
                .iter()
                .any(|r| r.url.contains("/prompt_async")),
            "a refused send never reaches the prompt POST"
        );

        // The compact's driving task is STILL the registered turn task (never stolen).
        let still_live = {
            let session = session_arc.lock().await;
            session
                .turn_task
                .as_ref()
                .map(|t| !t.is_finished())
                .unwrap_or(false)
        };
        assert!(
            still_live,
            "the refused send must not overwrite the compact's registered task"
        );

        // The ownership invariant holds end-to-end: a kill mid-compact aborts the
        // registered drive — no false completion after the gate releases.
        st.handle_kill(FreshAgentKill {
            provider: AgentProvider::Opencode,
            session_id: "ses_1".to_string(),
            session_type: SessionType::Freshopencode,
            cwd: None,
        })
        .await;
        gate.notify_waiters();
        tokio::time::sleep(Duration::from_millis(50)).await; // settle window

        let frames = drain_frames(&mut rx);
        assert!(
            frames.iter().any(|f| f["type"] == "freshAgent.killed"),
            "the kill frame lands: {frames:?}"
        );
        assert!(
            !frames
                .iter()
                .any(|f| is_event(f, "freshAgent.turn.complete", None)),
            "the aborted compact never fabricates a turn-complete: {frames:?}"
        );
        assert!(
            session_arc
                .lock()
                .await
                .turn_task
                .as_ref()
                .map(|t| t.is_finished())
                .unwrap_or(true),
            "the kill took + aborted the compact's registered task"
        );
    }

    // ── freshAgent.fork (AGENT-07, approval-respond Task 5) ────────────────

    fn fork_msg(session_id: &str, request_id: &str, at_turn_id: Option<&str>) -> FreshAgentFork {
        FreshAgentFork {
            provider: AgentProvider::Opencode,
            session_id: session_id.to_string(),
            session_type: SessionType::Freshopencode,
            input: at_turn_id.map(|id| json!({ "atTurnId": id })),
            request_id: Some(request_id.to_string()),
            cwd: None,
        }
    }

    /// A `FrameSink` that records every delivered frame — the requesting
    /// connection's sink the fork handler answers on (`conn_sink` in terminal.rs).
    fn capturing_sink() -> (FrameSink, Arc<StdMutex<Vec<ServerMessage>>>) {
        let captured = Arc::new(StdMutex::new(Vec::new()));
        let sink: FrameSink = {
            let captured = captured.clone();
            Arc::new(move |msg| captured.lock().expect("captured mutex").push(msg))
        };
        (sink, captured)
    }

    /// The fork-suite serve fake: records EVERY request and scripts the
    /// `POST /session/:id/fork` response (`fork_status` + `fork_body`).
    struct ForkFakeHttp {
        requests: StdMutex<Vec<RecordedRequest>>,
        fork_status: u16,
        fork_body: Vec<u8>,
        /// D2-F2 test seam: when set, the FIRST fork POST records itself then parks on
        /// `notified()` — a deterministic "fork in flight" window. `take()` one-shots
        /// it, so a later fork proceeds without needing a second release.
        fork_gate: StdMutex<Option<Arc<tokio::sync::Notify>>>,
    }

    impl ForkFakeHttp {
        fn child_ok() -> Self {
            Self {
                requests: StdMutex::new(Vec::new()),
                fork_status: 200,
                fork_body: br#"{"id":"ses_child","directory":"/forked/dir"}"#.to_vec(),
                fork_gate: StdMutex::new(None),
            }
        }

        fn recorded(&self) -> Vec<RecordedRequest> {
            self.requests.lock().expect("requests mutex").clone()
        }

        fn fork_requests(&self) -> Vec<RecordedRequest> {
            self.recorded()
                .into_iter()
                .filter(|r| r.method == "POST" && r.url.contains("/fork"))
                .collect()
        }
    }

    impl ServeHttp for ForkFakeHttp {
        fn request<'a>(
            &'a self,
            req: ServeHttpRequest,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<ServeHttpResponse, String>> + Send + 'a>,
        > {
            let method = format!("{:?}", req.method).to_uppercase();
            let body_value = req
                .body
                .as_ref()
                .and_then(|b| serde_json::from_slice::<Value>(b).ok());
            self.requests
                .lock()
                .expect("requests mutex")
                .push(RecordedRequest {
                    method: method.clone(),
                    url: req.url.clone(),
                    body: body_value,
                });
            if req.url.contains("/global/health") {
                return Box::pin(async { Ok(ServeHttpResponse::new(200, b"{}".to_vec())) });
            }
            if method == "POST" && req.url.contains("/fork") {
                let status = self.fork_status;
                let body = self.fork_body.clone();
                let gate = self.fork_gate.lock().expect("fork gate mutex").take();
                return Box::pin(async move {
                    if let Some(gate) = gate {
                        gate.notified().await;
                    }
                    Ok(ServeHttpResponse::new(status, body))
                });
            }
            Box::pin(async { Ok(ServeHttpResponse::new(200, b"{}".to_vec())) })
        }
    }

    /// Build a [`FreshOpencodeState`] over a [`ForkFakeHttp`]-backed serve manager.
    async fn fork_state(http: Arc<ForkFakeHttp>) -> FreshOpencodeState {
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
        let fresh_agent = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx));
        let deps = ServeDeps {
            spawner: Arc::new(TrackedSpawner {
                killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            }),
            http,
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        manager
            .ensure_started()
            .await
            .expect("healthy fake serve starts");
        fresh_agent.set_manager_for_test(manager).await;
        FreshOpencodeState::new(fresh_agent)
    }

    /// Insert a directly-materialized parent session (no send drove it) with the
    /// given settings.
    async fn insert_fork_parent(
        st: &FreshOpencodeState,
        id: &str,
        cwd: Option<&str>,
        model: Option<&str>,
        effort: Option<&str>,
    ) {
        let mut session = OpencodeSession::new(
            id.to_string(),
            cwd.map(str::to_string),
            model.map(str::to_string),
            effort.map(str::to_string),
        );
        session.real_session_id = Some(id.to_string());
        st.sessions
            .lock()
            .await
            .insert(id.to_string(), Arc::new(TokioMutex::new(session)));
    }

    #[tokio::test]
    async fn fork_registers_the_child_and_replies_forked_on_the_requesting_sink() {
        let http = Arc::new(ForkFakeHttp::child_ok());
        let st = fork_state(http.clone()).await;
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());
        insert_fork_parent(
            &st,
            "ses_parent",
            Some("/parent/cwd"),
            Some("prov-a/mdl-x"),
            Some("low"),
        )
        .await;

        let (sink, captured) = capturing_sink();
        st.handle_fork(fork_msg("ses_parent", "fork-req-1", None), sink)
            .await;

        // The exact `freshAgent.forked` reply — every field, request_id echoed
        // (the client matches on requestId + parentSessionId to repoint the pane).
        let frames = captured.lock().expect("captured mutex").clone();
        assert_eq!(
            frames,
            vec![ServerMessage::FreshAgentForked(FreshAgentForked {
                request_id: Some("fork-req-1".to_string()),
                parent_session_id: "ses_parent".to_string(),
                session_id: "ses_child".to_string(),
                session_type: "freshopencode".to_string(),
                provider: "opencode".to_string(),
                runtime_provider: "opencode".to_string(),
                session_ref: Some(SessionLocator {
                    provider: "opencode".to_string(),
                    session_id: "ses_child".to_string(),
                }),
            })],
            "exactly one forked reply on the requesting sink"
        );

        // The child session is registered: bridge started, settings inherited from
        // the parent, cwd from the fork response's directory (legacy
        // `child.directory ?? state.cwd`, adapter.ts fork).
        assert!(st.has_live_session("ses_child").await);
        let child = st
            .sessions
            .lock()
            .await
            .get("ses_child")
            .cloned()
            .expect("the child is in the session map");
        {
            let child = child.lock().await;
            assert_eq!(child.placeholder_id, "ses_child");
            assert_eq!(child.real_session_id.as_deref(), Some("ses_child"));
            assert_eq!(child.cwd.as_deref(), Some("/forked/dir"));
            assert_eq!(child.model.as_deref(), Some("prov-a/mdl-x"));
            assert_eq!(child.effort.as_deref(), Some("low"));
            assert!(
                child.serve_bridge.is_some(),
                "the child's serve-SSE bridge started (bindServeStream)"
            );
        }

        // The identity row for the child was recorded (materialization pattern).
        let bindings = fake.bindings.lock().unwrap();
        let b = bindings
            .iter()
            .find(|b| b.session_id == "ses_child")
            .expect("a binding row for the forked child");
        assert_eq!(b.provider, "opencode");
        assert_eq!(b.mode, "freshopencode");
        assert_eq!(b.settings.model.as_deref(), Some("prov-a/mdl-x"));
        assert_eq!(b.settings.effort.as_deref(), Some("low"));
        assert_eq!(b.settings.cwd.as_deref(), Some("/forked/dir"));

        // No atTurnId → the legacy no-body fork POST.
        let forks = http.fork_requests();
        assert_eq!(forks.len(), 1, "exactly one fork POST");
        assert!(forks[0].url.contains("/session/ses_parent/fork"));
        assert!(
            forks[0].url.contains("directory=%2Fparent%2Fcwd"),
            "the parent's cwd crosses as the `directory=` route query (with_route propagation): {}",
            forks[0].url
        );
        assert!(forks[0].body.is_none(), "no atTurnId -> no body: {forks:?}");
    }

    #[tokio::test]
    async fn fork_child_inherits_the_parent_cwd_when_the_response_carries_no_directory() {
        let mut fake = ForkFakeHttp::child_ok();
        fake.fork_body = br#"{"id":"ses_child"}"#.to_vec();
        let http = Arc::new(fake);
        let st = fork_state(http.clone()).await;
        insert_fork_parent(&st, "ses_parent", Some("/parent/cwd"), None, None).await;

        let (sink, captured) = capturing_sink();
        st.handle_fork(fork_msg("ses_parent", "fork-req-2", None), sink)
            .await;

        assert_eq!(captured.lock().unwrap().len(), 1, "the forked reply landed");
        let child = st.sessions.lock().await.get("ses_child").cloned().unwrap();
        let child = child.lock().await;
        assert_eq!(
            child.cwd.as_deref(),
            Some("/parent/cwd"),
            "child.directory ?? state.cwd (adapter.ts fork)"
        );
    }

    #[tokio::test]
    async fn fork_on_an_unmaterialized_placeholder_replies_invalid_session_id_and_posts_nothing() {
        let http = Arc::new(ForkFakeHttp::child_ok());
        let st = fork_state(http.clone()).await;
        st.handle_create(create_msg("req-fork")).await;
        let placeholder = "freshopencode-req-fork";

        let (sink, captured) = capturing_sink();
        st.handle_fork(fork_msg(placeholder, "fork-req-3", None), sink)
            .await;

        let frames = captured.lock().expect("captured mutex").clone();
        assert_eq!(frames.len(), 1, "the failure ALWAYS replies on the sink");
        let v = serde_json::to_value(&frames[0]).unwrap();
        assert_eq!(v["type"], "freshAgent.event");
        assert_eq!(v["provider"], "opencode");
        assert_eq!(v["sessionId"], placeholder);
        assert_eq!(v["sessionType"], "freshopencode");
        assert_eq!(v["event"]["type"], "freshAgent.error");
        assert_eq!(v["event"]["code"], "INVALID_SESSION_ID");
        let message = v["event"]["message"].as_str().unwrap_or("");
        assert!(
            message.contains("has not materialized; cannot fork"),
            "the legacy parity text (adapter.ts:403): {message}"
        );
        assert!(
            http.fork_requests().is_empty(),
            "unmaterialized -> NO POST at all (legacy throws before serveManager.fork)"
        );
    }

    #[tokio::test]
    async fn fork_on_an_unknown_session_replies_the_lost_session_shape() {
        let http = Arc::new(ForkFakeHttp::child_ok());
        let st = fork_state(http.clone()).await;

        let (sink, captured) = capturing_sink();
        st.handle_fork(fork_msg("ses_ghost", "fork-req-4", None), sink)
            .await;

        let frames = captured.lock().expect("captured mutex").clone();
        assert_eq!(frames.len(), 1, "the failure ALWAYS replies on the sink");
        let v = serde_json::to_value(&frames[0]).unwrap();
        assert_eq!(v["type"], "freshAgent.event");
        assert_eq!(v["event"]["type"], "freshAgent.error");
        assert_eq!(
            v["event"]["code"], "INVALID_SESSION_ID",
            "the lost-session shape the client folds into recovery (never silence): {v}"
        );
    }

    #[tokio::test]
    async fn fork_serve_error_replies_internal_error_and_registers_no_child() {
        let mut fake = ForkFakeHttp::child_ok();
        fake.fork_status = 500;
        fake.fork_body = b"fork exploded".to_vec();
        let http = Arc::new(fake);
        let st = fork_state(http.clone()).await;
        insert_fork_parent(&st, "ses_parent", None, None, None).await;

        let (sink, captured) = capturing_sink();
        st.handle_fork(fork_msg("ses_parent", "fork-req-5", None), sink)
            .await;

        let frames = captured.lock().expect("captured mutex").clone();
        assert_eq!(
            frames.len(),
            1,
            "failure-without-reply is the exact defect class this kills"
        );
        let v = serde_json::to_value(&frames[0]).unwrap();
        assert_eq!(v["type"], "freshAgent.event");
        assert_eq!(v["event"]["type"], "freshAgent.error");
        assert_eq!(v["event"]["code"], "INTERNAL_ERROR");
        assert!(
            v["event"]["message"]
                .as_str()
                .unwrap_or("")
                .contains("fork exploded"),
            "the serve error text crosses the reply: {v}"
        );
        assert_eq!(http.fork_requests().len(), 1, "the POST did land");
        assert!(
            !st.has_live_session("ses_child").await,
            "no child insert on failure"
        );
    }

    /// D2-F2 (delta-review round 2): the client leaves the Fork action enabled while a
    /// fork is in flight, so a rapid duplicate click would otherwise mint TWO children
    /// for one parent — once the first reply re-keys the pane and kills the parent, the
    /// second reply can no longer correlate, leaving its child (a live serve session +
    /// local registration) UNOWNED. The duplicate must be refused ON THE REQUESTING
    /// SINK (nested `freshAgent.error{INTERNAL_ERROR}`) with NO second fork POST and no
    /// other action; when the first fork completes, the guard releases and a fresh
    /// fork for the same parent proceeds.
    #[tokio::test]
    async fn fork_duplicate_in_flight_is_refused_and_releases_on_success() {
        let gate = Arc::new(tokio::sync::Notify::new());
        let fake = ForkFakeHttp::child_ok();
        *fake.fork_gate.lock().expect("fork gate mutex") = Some(gate.clone());
        let http = Arc::new(fake);
        let st = fork_state(http.clone()).await;
        insert_fork_parent(&st, "ses_parent", Some("/parent/cwd"), None, None).await;

        // Fork #1 parks mid-POST — the duplicate click's deterministic in-flight window.
        let (sink1, captured1) = capturing_sink();
        let driver = {
            let st = st.clone();
            tokio::spawn(async move {
                st.handle_fork(fork_msg("ses_parent", "fork-req-dup-1", None), sink1)
                    .await;
            })
        };
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if !http.fork_requests().is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the first fork POST lands within the budget");

        // Fork #2 — the duplicate — is refused INLINE (never waits upstream).
        let (sink2, captured2) = capturing_sink();
        tokio::time::timeout(
            Duration::from_secs(2),
            st.handle_fork(fork_msg("ses_parent", "fork-req-dup-2", None), sink2),
        )
        .await
        .expect("the duplicate fork is refused inline, never upstream-blocking");

        let frames = captured2.lock().expect("captured mutex").clone();
        assert_eq!(frames.len(), 1, "the refusal ALWAYS replies on the sink");
        let v = serde_json::to_value(&frames[0]).unwrap();
        assert_eq!(v["type"], "freshAgent.event");
        assert_eq!(v["sessionId"], "ses_parent");
        assert_eq!(v["event"]["type"], "freshAgent.error");
        assert_eq!(v["event"]["code"], "INTERNAL_ERROR");
        assert!(
            v["event"]["message"]
                .as_str()
                .unwrap_or("")
                .contains("already in progress"),
            "the refusal names the in-flight fork: {v}"
        );
        assert_eq!(
            http.fork_requests().len(),
            1,
            "the duplicate takes NO action — no second fork POST"
        );
        assert!(
            !st.has_live_session("ses_child").await,
            "the duplicate registers no child"
        );

        // Release fork #1: it completes with the forked reply, and the guard's
        // release lets a fresh fork for the same parent reach the wire.
        gate.notify_waiters();
        driver.await.expect("fork #1 task");
        let frames1 = captured1.lock().expect("captured mutex").clone();
        assert!(
            matches!(frames1.as_slice(), [ServerMessage::FreshAgentForked(_)]),
            "fork #1 completes with the forked reply: {frames1:?}"
        );

        let (sink3, captured3) = capturing_sink();
        st.handle_fork(fork_msg("ses_parent", "fork-req-dup-3", None), sink3)
            .await;
        let frames3 = captured3.lock().expect("captured mutex").clone();
        assert!(
            matches!(frames3.as_slice(), [ServerMessage::FreshAgentForked(_)]),
            "a post-completion fork for the same parent proceeds: {frames3:?}"
        );
        assert_eq!(
            http.fork_requests().len(),
            2,
            "the guard released on success — the retry reached the wire"
        );
    }

    /// D2-F2: the in-flight guard releases on EVERY terminal path — after a serve
    /// failure a refreshed Fork click for the same parent must reach the wire again
    /// (a stranded guard would refuse the session's forks forever).
    #[tokio::test]
    async fn fork_in_flight_guard_releases_on_the_failure_path() {
        let mut fake = ForkFakeHttp::child_ok();
        fake.fork_status = 500;
        fake.fork_body = b"fork exploded".to_vec();
        let http = Arc::new(fake);
        let st = fork_state(http.clone()).await;
        insert_fork_parent(&st, "ses_parent", None, None, None).await;

        let (sink1, captured1) = capturing_sink();
        st.handle_fork(fork_msg("ses_parent", "fork-req-f1", None), sink1)
            .await;
        let frames1 = captured1.lock().expect("captured mutex").clone();
        let v1 = serde_json::to_value(&frames1[0]).unwrap();
        assert!(
            v1["event"]["message"]
                .as_str()
                .unwrap_or("")
                .contains("fork exploded"),
            "the first fork fails on the serve error leg (NOT an in-flight refusal): {v1}"
        );

        // The retry reaches the wire — the failure path released the guard.
        let (sink2, captured2) = capturing_sink();
        st.handle_fork(fork_msg("ses_parent", "fork-req-f2", None), sink2)
            .await;
        let frames2 = captured2.lock().expect("captured mutex").clone();
        let v2 = serde_json::to_value(&frames2[0]).unwrap();
        assert!(
            v2["event"]["message"]
                .as_str()
                .unwrap_or("")
                .contains("fork exploded"),
            "the retry fails on the serve error too (not stranded on the guard): {v2}"
        );
        assert_eq!(
            http.fork_requests().len(),
            2,
            "the retry reached the fake — the guard released on failure"
        );
    }

    #[tokio::test]
    async fn fork_with_a_malformed_child_response_replies_internal_error_and_registers_no_child() {
        // A pathological 200 fork body without a usable `id` yields an EMPTY child id
        // from the serve parse (serve.rs `ForkedSession.id` defaults to "") — treat it
        // as a serve failure (nested INTERNAL_ERROR naming the malformed response) and
        // NEVER register/bind a "" child (a wrong "success" that would repoint the
        // pane at a garbage session). Both the missing-id and blank-id shapes:
        for body in [b"{}".to_vec(), br#"{"id":"   "}"#.to_vec()] {
            let mut fake = ForkFakeHttp::child_ok();
            fake.fork_body = body;
            let http = Arc::new(fake);
            let st = fork_state(http.clone()).await;
            let identity = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
            st.set_identity_sink(identity.clone());
            insert_fork_parent(&st, "ses_parent", Some("/parent/cwd"), None, None).await;

            let (sink, captured) = capturing_sink();
            st.handle_fork(fork_msg("ses_parent", "fork-req-8", None), sink)
                .await;

            let frames = captured.lock().expect("captured mutex").clone();
            assert_eq!(frames.len(), 1, "the failure ALWAYS replies on the sink");
            let v = serde_json::to_value(&frames[0]).unwrap();
            assert_eq!(v["type"], "freshAgent.event");
            assert_eq!(v["event"]["type"], "freshAgent.error");
            assert_eq!(v["event"]["code"], "INTERNAL_ERROR");
            assert!(
                v["event"]["message"]
                    .as_str()
                    .unwrap_or("")
                    .contains("missing session \"id\""),
                "the message names the malformed fork response: {v}"
            );
            assert_eq!(http.fork_requests().len(), 1, "the fork POST did land");
            let sessions = st.sessions.lock().await;
            let keys: Vec<&String> = sessions.keys().collect();
            assert_eq!(sessions.len(), 1, "no child insert at all: {keys:?}");
            assert!(
                !sessions.contains_key(""),
                "no child registration under the empty id"
            );
            drop(sessions);
            assert!(
                identity.bindings.lock().unwrap().is_empty(),
                "no binding row for a malformed child"
            );
        }
    }

    #[tokio::test]
    async fn fork_with_a_msg_shaped_at_turn_id_passes_it_as_message_id() {
        let http = Arc::new(ForkFakeHttp::child_ok());
        let st = fork_state(http.clone()).await;
        insert_fork_parent(&st, "ses_parent", None, None, None).await;

        let (sink, captured) = capturing_sink();
        st.handle_fork(fork_msg("ses_parent", "fork-req-6", Some("msg_abc")), sink)
            .await;

        assert_eq!(captured.lock().unwrap().len(), 1, "the forked reply landed");
        let forks = http.fork_requests();
        assert_eq!(forks.len(), 1);
        assert_eq!(
            forks[0].body.clone().expect("a messageID body"),
            json!({ "messageID": "msg_abc" }),
            "the selected-turn knob: the strict-schema body carries EXACTLY messageID"
        );
    }

    #[tokio::test]
    async fn fork_with_a_non_msg_at_turn_id_omits_message_id_entirely() {
        // A non-`msg` atTurnId is DROPPED and the fork proceeds from the tip — the
        // strict `additionalProperties:false` 1.18.18 schema must never receive an
        // unknown/malformed keying (probed: GET /doc `{messageID?: ^msg…}`).
        let http = Arc::new(ForkFakeHttp::child_ok());
        let st = fork_state(http.clone()).await;
        insert_fork_parent(&st, "ses_parent", None, None, None).await;

        let (sink, captured) = capturing_sink();
        st.handle_fork(
            fork_msg("ses_parent", "fork-req-7", Some("not-a-msg")),
            sink,
        )
        .await;

        assert_eq!(
            captured.lock().unwrap().len(),
            1,
            "the fork still proceeded from the tip"
        );
        let forks = http.fork_requests();
        assert_eq!(forks.len(), 1, "the fork POST landed");
        assert!(
            forks[0].body.is_none(),
            "the strict schema never receives a non-msg id: {forks:?}"
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
