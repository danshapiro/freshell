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
    SdkProviderEvent, ServeError, SessionSignal, SnapshotStatus,
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
    ///
    /// LOCK ORDER (retire-on-kill round 6, focused-ep5-r5 Finding 1): the
    /// `sessions` map guard is NEVER held across a per-session lock
    /// acquisition — clone the session's `Arc` out under a short map section,
    /// drop the guard, THEN await `session_arc.lock()`. The reverse direction
    /// is the one permitted pair: `handle_send` re-acquires `sessions` while
    /// holding the session lock (the materialization insert), so the wait-for
    /// graph carries edges only session→map, never map→session, and no cycle
    /// can close. (The finding's deadlock: `handle_kill`'s capture phase held
    /// the map while awaiting the session lock, and a first send held that
    /// session lock across its cold-start `create_session` before awaiting
    /// the map to register the durable key — kill owns the map and waits for
    /// the session, send owns the session and waits for the map, freezing the
    /// close BEFORE its durable retire and wedging every other opencode map
    /// reader. Pinned by `handle_kill_never_holds_the_sessions_map_across_
    /// its_session_lock_wait` and its teardown/refusal-teardown twins.)
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
    /// Rollback-vs-rollback single-flight (kata 1wxv Task 3) — the opencode arm of
    /// [`crate::FreshCodexState::rollback_in_flight`]'s rationale. Acquired FIRST in
    /// [`FreshOpencodeState::handle_rollback`], before the per-session mutex (lock
    /// order is never the reverse); `handle_send` NEVER acquires or consults it —
    /// its only wait point is the per-session mutex, so a send issued mid-rollback
    /// blocks behind it, then proceeds and destroys redo (no circular wait).
    rollback_in_flight: crate::InFlightRegistry,
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
    /// ep4-r6 (F2): a Compact drive's pre-drive-redo compensation settles
    /// through this channel from [`PreDriveRedoGuard`]'s drop. The abort paths
    /// AWAIT it after joining the aborted handle, so a following send can
    /// never observe the still-destroyed interim state mid-restore.
    compact_settled_rx: Option<tokio::sync::oneshot::Receiver<()>>,
}

/// Focused ep4-r5 (opencode_ws.rs:1155): the pre-drive redo destroy must be
/// restored when the compact drive dies without ever dispatching the
/// summarize POST — INCLUDING the kill/interrupt-during-cold-start leg that
/// drops the drive task before `manager.compact()` even returns (the match
/// arm never runs for a dropped future). Owned by the drive task; `disarm()`
/// marks the resolutions that already settled the ledger (success stands,
/// answered-failure stands, never-dispatched restored inline), so a dropped-
/// while-armed guard is alive ONLY on the provably-undelivered abort window.
struct PreDriveRedoGuard {
    identity_sink:
        std::sync::Arc<std::sync::OnceLock<crate::identity_sink::SharedPaneIdentitySink>>,
    session_id: String,
    /// `Some` while the pre-drive destroy is still uncompensated on the drive
    /// path — the NONE shape IS the disarm (every settled resolution emptying
    /// it names a ledger state already written).
    pre_drive_record: Option<crate::rollback_record::RollbackRecord>,
    destroy_now: i64,
    /// Flipped by [`OpencodeServeManager::compact`] exactly at the crossing
    /// from the cancellable cold-start leg into the HTTP request leg. An
    /// aborted drive past that point is ambiguous-possibly-mutated: the
    /// pre-drive destroy stands (never restored).
    summarize_dispatched: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// The abort paths await the matching receiver AFTER joining the aborted
    /// handle — a following send can never observe/keep the interim destroyed
    /// state. `take()`n at drop.
    settled_tx: Option<tokio::sync::oneshot::Sender<()>>,
}

impl PreDriveRedoGuard {
    fn disarm(&mut self) {
        self.pre_drive_record = None;
    }
}

impl Drop for PreDriveRedoGuard {
    fn drop(&mut self) {
        let dispatched = self
            .summarize_dispatched
            .load(std::sync::atomic::Ordering::SeqCst);
        let pre = self.pre_drive_record.take();
        if !dispatched {
            if let Some(pre) = pre {
                let sink = self.identity_sink.get().cloned();
                let id = self.session_id.clone();
                let destroy_now = self.destroy_now;
                let settled_tx = self.settled_tx.take();
                tokio::spawn(async move {
                    // Test-only knob: a delay before the restore runs models
                    // the real disk write being a beat — it makes the
                    // interrupt-answer-vs-restore interleaving deterministic
                    // for the ep4-r6 settle test (never used in production).
                    if let Ok(ms) = std::env::var("FRESHELL_TEST_OPENCODE_REDO_RESTORE_DELAY_MS") {
                        if let Ok(ms) = ms.parse::<u64>() {
                            tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
                        }
                    }
                    if let Some(e) = crate::rollback_record::restore_redo_on_undelivered_compact(
                        &sink,
                        PROVIDER,
                        &id,
                        pre,
                        destroy_now,
                        crate::rollback_record::now_ms(),
                    )
                    .await
                    {
                        tracing::warn!(error = %e, session = %id, "freshagent.opencode.redo_restore_on_aborted_compact_failed");
                    }
                    // The settle signal fires only after the restore LANDED.
                    if let Some(tx) = settled_tx {
                        let _ = tx.send(());
                    }
                });
                return;
            }
        }
        // Dispatched-or-disarmed: nothing to restore — the signal is
        // immediate (the abort path's settle wait resolves without a 5s leg).
        if let Some(tx) = self.settled_tx.take() {
            let _ = tx.send(());
        }
    }
}

impl TurnTask {
    fn is_finished(&self) -> bool {
        self.handle.is_finished()
    }

    /// Abort + join + (for compacts) settle-wait. Every abort site runs this —
    /// ep4-r6 F2: the compensation must have LANDED before this handler
    /// answers, or a send that follows inside the window reads
    /// `redoDestroyed:true` for a drive whose POST provably never existed,
    /// and the deferred restore would then resurrect `[canRedo: true]` behind
    /// it (destroy-at-submit treats the still-destroyed state as a no-op).
    async fn abort_and_settle(self) {
        self.handle.abort();
        let _ = self.handle.await;
        if let Some(rx) = self.compact_settled_rx {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), rx).await;
        }
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
    /// Retire-on-kill (delta-review round 5): set by `handle_kill` inside its
    /// session-lock phase. A send that took this session's Arc just before the
    /// kill's map removal is Parking on this lock and would otherwise
    /// materialize + re-bind a ledger row for the pane that is going away;
    /// `handle_send` consults the flag BEFORE any side effect and refuses
    /// (SESSION_NOT_FOUND — the same answer the map-removed arm gives).
    killed: Arc<AtomicBool>,
    /// Focused-episode-6 round 4 (Finding F6): the kill's enumeration gate —
    /// nonzero while a kill is between its one critical-section enumeration
    /// (under THIS session lock) and its durable-close outcome. `handle_send`
    /// refuses (SESSION_NOT_FOUND — the same answer the killed arm gives)
    /// instead of materializing, so the
    /// enumerated identity set is COMPLETE by construction: no session id can
    /// mint behind the envelope's back, and the post-envelope discovery +
    /// second close the pre-fix code needed is gone. Guarded by the session
    /// mutex (no lock ordering change — every read/write of it runs under
    /// the session guard the kill/send already hold). Decremented only when
    /// the envelope fails Clean (the kill aborts; the session is genuinely
    /// untouched); a durable close tears the session down with the gate
    /// still standing.
    close_pending: usize,
    /// D8 (restore-open-sessions-only): the LATEST connection-scoped provenance
    /// this session was attached under. Parked by `handle_create` at create, by
    /// the in-memory-hit arm AND by `resume_durable_session` at a
    /// connection-scoped resume (focused-ep1-r3: the cold-resume reconstruction
    /// parks it too, so the fork consumer's `session.provenance` read and the
    /// per-send refresh write always assert the CURRENT attribution). Read by
    /// every downstream binder: the materialization row (born at first SEND,
    /// mediations after `handle_create` returned), the per-send refresh, and
    /// the fork child's precedence source (2) (the FORKING connection's
    /// stamps win, focused-ep1-r5 Finding 1). Conn-less cold reconstruction
    /// (attach-resume rehydrate) seeds it from the DURABLE row's stamps
    /// (focused-ep1-r4 Finding 2); a row that genuinely has none leaves `None`
    /// parked — never invented — and conn-less writes let the ledger merge
    /// keep any prior stamps. Every park/refresh gate filters hollow `Some`s
    /// away (focused-ep1-r5 Finding 2): a partially initialized client's
    /// hello never lands or overrides here.
    provenance: Option<crate::BindProvenance>,
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
            killed: Arc::new(AtomicBool::new(false)),
            close_pending: 0,
            provenance: None,
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
            rollback_in_flight: crate::InFlightRegistry::new(),
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

    /// Retire-on-kill round 2/3 (focused-ep5-r1 Finding 2, -r2 Finding 4),
    /// the claim lifecycle's COMMIT: an explicit resume/attach of a durable
    /// `ses_*` id is a NEW pane GENUINELY CLAIMING that identity — invoked
    /// only once the rebuilt session is registered (the replacement session
    /// is established) — clearing the durable kill fence BEFORE the claim's
    /// own binding writes can be mistaken for the killed session's orphaned
    /// write and suppressed, AND returning a kill-closed ledger row to Bound
    /// (Finding 4: unconditional — the V7-gated refresh write below skips a
    /// lineage-only record for a conn-less attach, and the row once stayed
    /// Closed while the live session ran, so the next recovery omitted a
    /// genuinely open session). Unconditional by design — idempotent on a
    /// never-killed identity — warn-logged on failure, never a resume
    /// blocker. The first-send materialization lane never commits: its
    /// `ses_*` id is freshly minted server-side (never tombstoned).
    /// Round 4 (focused-ep5-r3 Finding 1): the commit is CONDITIONAL on the
    /// claim-START dead-state snapshot — a kill landing mid-claim (the user
    /// closed the pane while the resume awaited the serve manager) advances
    /// the durable tombstone past it, and the commit is REFUSED with no
    /// durable side effects: the caller tears the just-rebuilt session down
    /// and the row the kill retired stays Retired. A reviving claim must
    /// never undo a newer close — this also ends round 3's UNCONDITIONAL
    /// commit on the lease-failure arm (a revoked lease caused by a kill now
    /// tears the session down; a revocation with an UNCHANGED dead-state —
    /// an expired handle-less holder, no kill — still commits and keeps the
    /// registered session, the round-3 keep behavior). On commit the
    /// fence-clear AND the row revive are ONE ledger transition (Finding 3:
    /// no split-write intermediate). Returns true iff the claim committed;
    /// an `Err` (io failure deciding or writing) provably left the durable
    /// close untouched (round 5, focused-ep5-r4 Finding 5): warn-loud and
    /// report false — the caller tears the session down, kill wins.
    async fn commit_session_claim(&self, durable_id: &str, expect_killed_at_ms: Option<i64>) -> bool {
        let Some(sink) = self.identity_sink() else {
            return true;
        };
        match sink.commit_claim(PROVIDER, durable_id, expect_killed_at_ms).await {
            Ok(crate::identity_sink::ClaimCommit::Committed) => true,
            Ok(crate::identity_sink::ClaimCommit::RefusedStale) => {
                tracing::info!(target: "freshell_freshagent::opencode",
                    durable = %durable_id,
                    "freshagent.opencode.claim_refused_stale_dead_state: a close landed while \
                     this resume was in flight; the claim commits nothing and the lane tears down"
                );
                false
            }
            Err(e) => {
                // Round 5 (focused-ep5-r4 Finding 5): the ledger's commit is
                // crash-atomic, so an `Err` means the durable close was left
                // UNTOUCHED (fence stands, row Closed). Registering anyway
                // would run a live session over the Closed row — treat the
                // error like a refusal (kill wins): the caller tears the
                // just-rebuilt session down.
                tracing::warn!(error = %e, session = %durable_id,
                    "freshagent.opencode.claim_commit_failed: the durable close left the claim \
                     undecidable; the lane tears down and leaves the close standing");
                false
            }
        }
    }

    /// Focused-ep5-r3 Finding 1: the claim attempt's dead-state snapshot,
    /// read at claim START (before the serve-manager awaits) and handed to
    /// [`Self::commit_session_claim`] at commit time.
    fn claim_dead_state_snapshot(&self, durable_id: &str) -> Option<i64> {
        self.identity_sink()
            .and_then(|sink| sink.kill_tombstone_at_ms(PROVIDER, durable_id))
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
    /// `provenance` (D8): the WS connection's stamped identity for this create
    /// (`None` on conn-less lanes); carried on the session to the materialization
    /// binding write (opencode's row is written at first send, not at create).
    pub async fn handle_create(
        &self,
        msg: FreshAgentCreate,
        provenance: Option<crate::BindProvenance>,
    ) {
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
            self.handle_create_resume(request_id, durable_id, &msg, provenance)
                .await;
            return;
        }

        let model = normalize_opencode_model(msg.model.as_deref());
        let effort = normalize_opencode_effort(model.as_deref(), msg.effort.as_deref());
        let placeholder = format!("freshopencode-{request_id}");

        let mut session = OpencodeSession::new(placeholder.clone(), msg.cwd.clone(), model, effort);
        // D8: park the connection provenance ON the session — the binding row
        // is written at materialization (first send), well after this create
        // returns. A HOLLOW `Some` (a partially initialized client's hello,
        // focused-ep1-r5 Finding 2) parks `None` instead — never a hollow
        // value downstream readers would treat as truth.
        session.provenance = provenance.filter(|p| p.is_meaningful());
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
    /// `provenance` (D8): a resume-CREATE is still a connection-scoped create —
    /// this pane IS open in that client's tab — so the resume's binding refresh
    /// re-stamps the CURRENT connection's identity/tab (delta-r1 Finding 3).
    async fn handle_create_resume(
        &self,
        request_id: String,
        durable_id: String,
        msg: &FreshAgentCreate,
        provenance: Option<crate::BindProvenance>,
    ) {
        // D8 (focused-ep1-r5 Finding 2): "meaningful provenance" only — a
        // HOLLOW `Some` (a partially initialized client's hello without
        // device/client fields) behaves like `None` on every gate below: the
        // in-memory re-park and the refresh write never let a hollow value
        // override parked/row truth, and the cold path falls through to the
        // durable row's seed.
        let provenance = provenance.filter(|p| p.is_meaningful());

        // Already tracked locally (a live pane, or an earlier attach/create already
        // rebound it)? Reuse it -- mirrors handle_attach's local-map-first lookup.
        let existing = {
            let guard = self.sessions.lock().await;
            guard.get(&durable_id).cloned()
        };
        let in_memory_hit = existing.is_some();
        let session_arc = match existing {
            Some(session_arc) => session_arc,
            None => match self
                .resume_durable_session(&durable_id, msg.cwd.as_deref(), provenance.clone())
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
            // D8 (focused-ep1 Finding A, branch 1 — same-process in-memory
            // hit): a resume reached through a CONNECTION-SCOPED create must
            // re-park the CURRENT connection's provenance on the session —
            // otherwise every later per-send refresh write keeps re-asserting
            // the OLD tab's attribution into the ledger row (the merge's
            // REPLACE rule). Conn-less resumes keep the parked stamps (the
            // ledger keep-when-None merge's in-memory twin).
            if in_memory_hit && provenance.is_some() {
                session.provenance = provenance.clone();
            }
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

        // D8 (focused-ep1 Finding A, branch 1): the in-memory hit bypasses
        // `resume_durable_session`, so it must perform that lane's SAME
        // awaited refresh write itself (durable-before-answer) — the CURRENT
        // connection's attribution lands on the row immediately, even if no
        // send ever follows this resume. Conn-less resumes write nothing here
        // (nothing new to assert; the row keeps its stamps).
        if let Some(p) = provenance.filter(|_| in_memory_hit) {
            let (model, effort, cwd) = {
                let session = session_arc.lock().await;
                (
                    session.model.clone(),
                    session.effort.clone(),
                    session.cwd.clone(),
                )
            };
            self.record_binding_row(crate::identity_sink::FreshAgentBindingUpsert {
                provider: PROVIDER.into(),
                session_id: durable_id.clone(),
                mode: SESSION_TYPE.into(),
                create_request_id: None,
                resolves_pending: None,
                supersedes: None,
                provenance: crate::identity_sink::ProvenanceUpdate::Replace(p),
                settings: crate::identity_sink::FreshAgentSettings {
                    model,
                    sandbox: None,
                    permission_mode: None,
                    effort,
                    cwd,
                },
            })
            .await;
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

        // Retire-on-kill (delta-review round 5, the resolution arm): a send that
        // took this session's Arc just before `handle_kill`'s map removal parks
        // on this very lock — see the killed flag the kill set inside its own
        // session-lock phase and refuse with the SAME SESSION_NOT_FOUND the
        // map-removed arm gives, BEFORE any side effect. Without this gate the
        // send would materialize + re-bind a ledger row for the pane that just
        // closed (the finding class: a created-then-closed row re-offered in
        // the creation-race grace window).
        if session.killed.load(Ordering::SeqCst) || session.close_pending > 0 {
            // Focused-episode-6 round 4 (Finding F6): the `close_pending`
            // half — a kill has enumerated this session's identity set and
            // is writing its ONE durable close; no materialization may land
            // behind that envelope's back (a refused send retries cleanly if
            // the close fails Clean and the gate drops).
            drop(session);
            self.send_error(
                &request_id,
                "SESSION_NOT_FOUND",
                "opencode session not found",
            );
            return;
        }

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

        // Decision 5 (kata 1wxv Task 3): any new submission permanently destroys redo
        // (AWAITED before the prompt POST; the r3 marker-union `entries` survives —
        // only the redo-capable chain state dies). r2 lock discipline: the
        // per-session mutex is ALREADY held at this point — a send issued while a
        // rollback held it simply WAITED on the mutex (`handle_send` NEVER
        // acquires/consults `rollback_in_flight`, so no circular wait exists).
        if let Some(real_id) = session.real_session_id.clone() {
            if let Some(err) = crate::rollback_record::destroy_redo_on_submit(
                &self.identity_sink(),
                PROVIDER,
                &real_id,
                crate::rollback_record::now_ms(),
            )
            .await
            {
                tracing::warn!(error = %err, session = %real_id, "freshagent.opencode.redo_destroy_write_failed");
            }
        }

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

            // D8: stamps parked on the session at create reach the
            // materialization row here (Some asserts, None inherits).
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
                provenance: session.provenance.clone().into(),
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
            // D8: same session-carried stamps (a per-send refresh re-asserts
            // them via `Replace`; a conn-less refresh lane carries `None` →
            // `Inherit` and the ledger merge preserves them).
            self.record_binding_row(crate::identity_sink::FreshAgentBindingUpsert {
                provider: PROVIDER.into(),
                session_id: acked_session_id.clone(),
                mode: SESSION_TYPE.into(),
                create_request_id: None,
                resolves_pending: None,
                supersedes: None,
                provenance: session.provenance.clone().into(),
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
            compact_settled_rx: None,
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
        // Retire-on-kill close-durability rule (delta-r6): the durable close
        // — every row retire plus every pending-marker delete — is recorded
        // BEFORE any live-state mutation (map removal, the killed flag) and
        // BEFORE any await that can park (the per-session lock, whose wait
        // can span a first send's cold-start materialization). A restart or
        // task cancellation anywhere in that wait must never strand a
        // just-closed pane as recoverable. And a FAILED durable write fails
        // the kill: the answer reports `success:false` and NOTHING was
        // touched (never warn-and-continue into a Bound row for a pane the
        // user closed).
        //
        // Round 6 lock order (focused-ep5-r5 Finding 1) is preserved
        // throughout: the `sessions` map is only ever held for short
        // SYNCHRONOUS sections (lookup/scan/removal), never across a
        // per-session lock acquisition — the wait-for graph carries only
        // session→map edges.
        //
        // Phase 1 — discovery completes BEFORE the envelope and BEFORE
        // teardown (focused-episode-6 round 4, Finding F6). The session
        // lock is the serialization point: a materialization holds it
        // through its map insert + binding-row write, so acquiring it here
        // parks behind any in-flight materialization and then sees its
        // complete result. Under that ONE acquisition the kill BOTH
        // enumerates the COMPLETE identity set (placeholder, the wire id,
        // the durable id(s) resolvable from the map mirror and the
        // session's `real_session_id`, plus the pending markers) AND arms
        // the mint gate (`close_pending`) — so the set written to the ONE
        // envelope below is complete by construction and no second close
        // can ever exist. A send taking the lock past this point reads the
        // gate and refuses; the gate releases ONLY if the envelope fails
        // Clean (the kill aborts, the session untouched).
        let session_arc = {
            let guard = self.sessions.lock().await;
            guard.get(&msg.session_id).cloned()
        };
        let mut retire_ids: Vec<String> = Vec::new();
        let mut marker_ids: Vec<String> = Vec::new();
        {
            // Focused-episode-6 round 3, Finding 1: EVERY key this kill
            // answers to — durable `ses_*` ids AND placeholders — is
            // close evidence (the durable record the recovery verdict
            // join consults); a placeholder additionally names its
            // pending marker for deletion. The pre-first-send shape
            // (placeholders only) used to skip the identity set entirely
            // (`retire_ids` empty ⇒ marker delete only), leaving a
            // retained snapshot claiming the placeholder with no standing
            // close fence — verdict `unknown`, re-offerable. The
            // placeholder-keyed close IS the fresh-agent lane's close
            // record (delta-r6-r2), so a kill with nothing else to close
            // still writes it.
            let consider = |retire_ids: &mut Vec<String>, marker_ids: &mut Vec<String>, id: &str| {
                if id.starts_with(crate::OPENCODE_PLACEHOLDER_PREFIX)
                    && !marker_ids.iter().any(|m| m == id)
                {
                    marker_ids.push(id.to_string());
                }
                if !retire_ids.iter().any(|r| r == id) {
                    retire_ids.push(id.to_string());
                }
            };
            if let Some(session_arc) = &session_arc {
                let mut s = session_arc.lock().await;
                {
                    let guard = self.sessions.lock().await;
                    for (key, candidate) in guard.iter() {
                        if Arc::ptr_eq(candidate, session_arc) {
                            consider(&mut retire_ids, &mut marker_ids, key);
                        }
                    }
                }
                if let Some(real_id) = s.real_session_id.clone() {
                    consider(&mut retire_ids, &mut marker_ids, &real_id);
                }
                consider(&mut retire_ids, &mut marker_ids, &msg.session_id);
                s.close_pending += 1;
            } else {
                // A kill naming an id the map never held still retires that
                // DURABLE id by name (an evicted session's row is durable)
                // and still clears a marker under that placeholder name.
                consider(&mut retire_ids, &mut marker_ids, &msg.session_id);
            }
        }

        // Phase 2 — THE durable close: ONE failure-atomic envelope over the
        // COMPLETE identity set plus the pending markers
        // (`retire_closed_batch` → `PaneLedger::close_identities`,
        // delta-r6-r3, focused-episode-6 round 2 Finding 5). An explicit
        // kill is an intentional session END: it retires the session's
        // DURABLE row(s) `Closed` (the ledger row is keyed on the
        // materialized `ses_*` id) so the recovery inventory (Bound-only
        // pre-filter) can never re-offer a pane the user just closed inside
        // the 7s creation-race grace window; and deletes the pending marker
        // (LAST — once the closes are durable) so a late materialization
        // resolution can never carry evidence for a pane that provably no
        // longer exists. The per-identity loop it replaced wrote several
        // retires + marker deletes BEFORE checking any failure: an early
        // success stayed durable over the still-live session a later failure
        // left behind — recovery would classify that session closed. The
        // delta-r6-r2 post-envelope completion retire (whose Clean failure
        // could not roll back the phase-2 placeholder close, focused-
        // episode-6 round 4 Finding F6) is gone: phase 1's session-lock
        // enumeration + mint gate made post-envelope discovery impossible,
        // and this envelope's Clean failure also rolls nothing back BY
        // CONSTRUCTION — nothing stands yet. The answer is classed (delta-
        // r6-r4, round 3 Finding 3): `Failed` (Clean): nothing durable —
        // the kill releases the enumeration gate and leaves ALL live state
        // untouched: the session stays live and Bound (self-consistent:
        // nothing has been closed), and a retried kill re-attempts
        // idempotently. `Persisted`: the close IS durable despite the
        // reported error — the kill PROCEEDS (the session ends, consistent
        // with the durable close) while the answer still reports
        // `success:false` (the kill visibly fails).
        let mut close_reported_failure = false;
        let mut close_invariant_broken = false;
        if let Some(sink) = self.identity_sink() {
            match sink
                .retire_closed_batch(PROVIDER, &retire_ids, &marker_ids)
                .await
            {
                Ok(()) => {}
                Err(e) => {
                    let persisted = e.is_persisted();
                    if persisted {
                        tracing::error!(error = %e, sessions = ?retire_ids,
                            "freshagent.opencode.retire_on_kill_persisted_despite_error: the close \
                             is durable; the kill ends the session and answers failure");
                        close_reported_failure = true;
                    } else {
                        tracing::warn!(error = %e, sessions = ?retire_ids, "freshagent.opencode.retire_on_kill_failed");
                        // Failure propagation: the durable close did not
                        // land — NOTHING of it survived — so the kill must
                        // NOT acknowledge success and must leave ALL live
                        // state untouched. Release the enumeration gate
                        // first: the session is resumable exactly as if the
                        // kill never ran (F6: no placeholder close stands to
                        // roll back — the one envelope landed nothing).
                        if let Some(session_arc) = &session_arc {
                            let mut s = session_arc.lock().await;
                            s.close_pending = s.close_pending.saturating_sub(1);
                        }
                        self.broadcast(&ServerMessage::FreshAgentKilled(FreshAgentKilled {
                            provider: PROVIDER.to_string(),
                            session_id: msg.session_id,
                            session_type: SESSION_TYPE.to_string(),
                            success: false,
                        }));
                        return;
                    }
                }
            }
        }

        // Phase 3 — ONE per-session lock take: the killed flag, then the
        // teardown-field extraction. Retire-on-kill (delta-review round 5):
        // mark the session killed BEFORE removing the map keys — a send
        // that took this Arc just before the removal parks on this very
        // lock and must observe the flag (never materialize + re-bind a row
        // for the pane that is going away). The enumeration completeness is
        // not re-PROVEN here: phase 1's gate made it structural (a send
        // between the gate and this flag is refused by the gate; the flag
        // and the gate observe under the same lock). A defect there would
        // still be caught loud (the invariant probe below) and the kill
        // would answer failure — never masquerade a broken gate as success.
        if let Some(session_arc) = &session_arc {
            let (turn_task, bridge, real, strays) = {
                let mut s = session_arc.lock().await;
                let strays: Vec<String> = s
                    .real_session_id
                    .clone()
                    .filter(|real_id| !retire_ids.iter().any(|id| id == real_id))
                    .into_iter()
                    .collect();
                s.killed.store(true, Ordering::SeqCst);
                (s.turn_task.take(), s.serve_bridge.take(), s.real_session_id.clone(), strays)
            };
            // DEFENSIVE invariant probe (F6, must never fire): an identity
            // discovered here slipped the phase-1 gate. Retire it under the
            // teardown and make the kill visibly FAIL — the externally
            // visible state is then: the session ended, the identity's close
            // is whatever the probe's retire managed, and NO answer pretends
            // consistency.
            if !strays.is_empty() {
                close_invariant_broken = true;
                tracing::error!(target: "freshell_freshagent::opencode",
                    strays = ?strays,
                    session = %msg.session_id,
                    "freshagent.opencode.kill_post_envelope_discovery_invariant_broken: a real \
                     session id surfaced after the gated one-envelope enumeration; retiring it \
                     under the teardown and answering failure"
                );
                if let Some(sink) = self.identity_sink() {
                    for stray in &strays {
                        if let Err(e) = sink.retire_closed(PROVIDER, stray).await {
                            tracing::error!(error = %e, session = %stray,
                                "freshagent.opencode.invariant_probe_retire_failed");
                        }
                    }
                }
            }

            // Phase 4 — the map removal, its own short synchronous section
            // (every key aliasing this Arc goes; the killed flag has gated
            // sends since phase 3, so no new key can appear for it).
            {
                let mut guard = self.sessions.lock().await;
                guard.retain(|_, candidate| !Arc::ptr_eq(candidate, session_arc));
            }

            // Phase 5 — the settlement awaits, strictly after the durable
            // close (round 5: teardown failure never loses the close).
            if let Some(task) = turn_task {
                // ep4-r6 F2: join + await the compact's pre-drive-redo settle
                // before the kill answers — the compensation must have landed.
                task.abort_and_settle().await;
            }
            // PR-3: stop the persistent serve-SSE bridge too (`unsubscribeServe?.()`,
            // adapter.ts:568) so it doesn't keep broadcasting for a dead session.
            if let Some(bridge) = bridge {
                bridge.abort();
            }
            // Task 13: a killed session must reopen its durable id's lease binding.
            if let Some(real) = real.as_deref() {
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
        // `freshAgent.killed{success:true}` pattern. Every durable-close
        // CLEAN failure aborts BEFORE any live state is touched (the ONE
        // envelope in phase 2 — the enumeration gate released with it; F6
        // retired the post-envelope completion retire entirely); a
        // PERSISTED-despite-error close ends the session (consistent with
        // the durable close) while the kill visibly fails (delta-r6-r4,
        // round 3 Finding 3).
        self.broadcast(&ServerMessage::FreshAgentKilled(FreshAgentKilled {
            provider: PROVIDER.to_string(),
            session_id: msg.session_id,
            session_type: SESSION_TYPE.to_string(),
            success: !close_reported_failure && !close_invariant_broken,
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
                // ep4-r6 F2: join + await the compact's pre-drive-redo settle
                // — the interrupt's answer must never precede the restore.
                task.abort_and_settle().await;
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
    ///
    /// REDO DISCIPLINE (delta-r1 F5; focused ep1-r2 F4 — the destroy is
    /// PRE-DRIVE; focused ep1-r3 F2 — the destroy is FINAL once the POST may
    /// have left): opencode summarizes natively delete the reverted tail
    /// exactly like a new submission — and OpenCode ≥1.18.21's summarize
    /// handler runs `revertSvc.cleanup` FIRST (its error-able stages come
    /// after), so ANY failure timed at/after the send is a possibly-destroyed
    /// tail. The ledger's redo state therefore retires via
    /// `destroy_redo_before_compact_drive` once the preflight has fully
    /// succeeded (model pair resolved), synchronously under the session lock
    /// and BEFORE the summarize drive/task exists (durable-BEFORE-mutation —
    /// an aborted drive over an accepted POST can never leave `canRedo` true
    /// across a tail the provider may have deleted). The ONLY failure that
    /// compensates the pre-record back (`restore_redo_on_undelivered_compact`)
    /// is one PROVING the POST never left the process
    /// (`ServeError::never_dispatched` — the connect-phase refusal AND every
    /// startup-phase failure, since the drive runs `ensure_started()` before
    /// the request exists, ep2-r1 F3); the refusal/preflight no-POST paths
    /// likewise leave redo valid. EVERY in-flight / HTTP-response outcome after
    /// the POST may have arrived — a non-2xx ANSWER, a timeout, a mid-flight
    /// reset, an abort — keeps the destroy forever (error-after-send ≠ tail
    /// survived).
    /// Markers survive regardless (decision 6).
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

        // Focused-review ep1-r2 F4 (redo discipline is PRE-DRIVE): the preflight
        // has fully succeeded (model pair resolved, submissions permitted) — the
        // destroy runs HERE, under this session lock, BEFORE the summarize
        // drive/task exists (durable-BEFORE-mutation): from this point `canRedo`
        // is already false in memory + persisted, so a drive ABORTED
        // mid-summarize (interrupt/kill/response loss over an accepted POST whose
        // provider-side application is ambiguous) can never leave the record
        // advertising redo over a tail the provider may have deleted. The
        // preflight legs above (untracked session, unmaterialized placeholder,
        // busy refusal, the no-model failure) and ONLY those still skip the
        // destroy (ep1-r1 F2 unchanged). ep1-r3 F2 (widened ep2-r1 F3): the
        // destroy is FINAL once the drive is engaged — the ONLY compensation is
        // a failure PROVING the POST never left the process
        // (`ServeError::never_dispatched`: connect-phase refusal AND every
        // startup-phase failure — the drive runs `ensure_started()` before the
        // request exists ⇒ the serve provably never saw the POST ⇒ the tail
        // provably survives); every post-send failure class (incl. ANY answered
        // non-2xx — OpenCode ≥1.18.21's summarize runs revertSvc.cleanup FIRST)
        // lets the destroy stand. ep2-r1 F2: durable-BEFORE-mutation runs BOTH
        // ways —
        // when the pre-drive destroy CANNOT be persisted, the compact is
        // REFUSED with zero provider traffic (never warn+continue: OpenCode
        // would delete the reverted tail while the durable ledger still
        // advertises redo over it, panes-wide and cross-device). Refusing
        // keeps the untouched row TRUE exactly because nothing ran.
        let destroy_now = crate::rollback_record::now_ms();
        let pre_drive_record = match crate::rollback_record::destroy_redo_before_compact_drive(
            &self.identity_sink(),
            PROVIDER,
            &real_id,
            destroy_now,
        )
        .await
        {
            Ok(pre) => pre,
            Err(err) => {
                tracing::warn!(error = %err, session = %real_id, "freshagent.opencode.redo_destroy_before_compact_failed");
                // Never leave the pane stuck busy on the refusal (nothing was
                // ever registered on turn_task — the refusal is inline,
                // pre-spawn).
                self.broadcast(&event_frame(&real_id, snapshot_event(&real_id, "idle")));
                self.emit_fresh_agent_error(
                    &real_id,
                    "OPENCODE_COMPACT_FAILED",
                    crate::rollback_record::LEDGER_WRITE_REFUSAL_COPY,
                );
                return;
            }
        };

        // D1-F1(b): run the compact's drive (POST + await-idle + settle) in the
        // session's DETACHED, REGISTERED turn task — mirroring handle_send so
        // kill/interrupt abort it (aborted mid-await ⇒ no settle ⇒ no chime).
        let fresh_agent = self.fresh_agent.clone();
        let identity_sink = std::sync::Arc::clone(&self.identity_sink);
        let compact_id = real_id.clone();
        // Focused ep4-r5 (opencode_ws.rs:1155): an abort (kill/interrupt)
        // that drops this task WHILE the drive is parked inside
        // `ensure_started` (a cold start, or any point before the summarize
        // POST left the process) never enters the match below. Worse, the
        // FIRST poll may never happen at all (the test harness's interrupt
        // races the spawn): the guard is therefore CONSTRUCTED OUTSIDE the
        // async block and moved in — a never-started future still drops its
        // captures, and the armed-but-undropped guard restores the pre-drive
        // record exactly like the never-dispatched failure leg.
        let summarize_dispatched = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (compact_settled_tx, compact_settled_rx) = tokio::sync::oneshot::channel::<()>();
        let mut undo_guard = PreDriveRedoGuard {
            identity_sink: identity_sink.clone(),
            session_id: compact_id.clone(),
            pre_drive_record: pre_drive_record.clone(),
            destroy_now,
            summarize_dispatched: summarize_dispatched.clone(),
            settled_tx: Some(compact_settled_tx),
        };
        let collected_witness = summarize_dispatched.clone();
        let compact_task = tokio::spawn(async move {
            let result = match manager
                .compact(
                    &compact_id,
                    &model_pair.provider_id,
                    &model_pair.model_id,
                    &route,
                    Some(collected_witness),
                )
                .await
            {
                Ok(()) => {
                    // The 2xx landed — the reverted tail is genuinely deleted
                    // and the PRE-DRIVE destroy already retired redo (F4);
                    // nothing more to persist. Settle waits on idle.
                    undo_guard.disarm();
                    manager
                        .await_idle(&compact_id, rx, DEFAULT_TURN_TIMEOUT, route)
                        .await
                }
                Err(err) => {
                    // ep1-r3 F2 compensation: ONLY a failure PROVING the
                    // summarize POST never left the process
                    // (`ServeError::never_dispatched` — the connect-phase
                    // refusal AND every startup-phase failure: the compact
                    // drive runs `ensure_started()` before the request is even
                    // constructed, ep2-r1 F3) proves the reverted tail
                    // survived; restoring the pre-drive record is honest
                    // exactly there. EVERY failure timed at/after the send — a
                    // non-2xx ANSWER (OpenCode ≥1.18.21 summarize runs
                    // revertSvc.cleanup FIRST — the tail may already be gone),
                    // RequestTimeout, mid-flight Transport, Decode lets the
                    // destroy stand forever (error-after-send ≠ tail
                    // survived). ep4-r5: an ABORT never reaches this match at
                    // all — it is the guard's drop-cancellation leg, and it
                    // restores on the SAME provable premise (a cancelled-but-
                    // never-dispatched drive provably touched nothing).
                    if err.never_dispatched() {
                        if let Some(pre) = pre_drive_record {
                            if let Some(e) =
                                crate::rollback_record::restore_redo_on_undelivered_compact(
                                    &identity_sink.get().cloned(),
                                    PROVIDER,
                                    &compact_id,
                                    pre,
                                    destroy_now,
                                    crate::rollback_record::now_ms(),
                                )
                                .await
                            {
                                tracing::warn!(error = %e, session = %compact_id, "freshagent.opencode.redo_restore_on_undelivered_compact_failed");
                            }
                        }
                        undo_guard.disarm();
                    } else {
                        undo_guard.disarm();
                    }
                    Err(err)
                }
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
            compact_settled_rx: Some(compact_settled_rx),
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
    /// `provenance` (D8, focused-ep1-r5 Finding 1) is the FORKING connection's
    /// stamped identity (the WS dispatch composes it from the hello identity
    /// + the fork's `tabId`, exactly like the create lanes).
    ///
    /// Fork is always connection-initiated (a user clicks Fork in a specific
    /// browser tab), so the child row's attribution resolves by precedence:
    /// first the forking connection's provenance — a HOLLOW `Some` (a
    /// partially initialized client's hello, Finding 2) behaves like `None`
    /// and never overrides real stamps — then the parent's PARKED provenance,
    /// then the parent's DURABLE ROW stamps via
    /// [`crate::identity_sink::PaneIdentitySink::load_provenance`].
    pub async fn handle_fork(
        &self,
        msg: FreshAgentFork,
        provenance: Option<crate::BindProvenance>,
        reply_sink: FrameSink,
    ) {
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

        let (real_id, route, model, effort, parent_provenance) = {
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
                // Fork precedence source (2) (focused-ep1-r3/r5): the
                // parent's PARKED provenance.
                session.provenance.clone(),
            )
        };

        // D8 (focused-ep1-r5 Findings 1+2): fork provenance by precedence —
        // (1) the FORKING connection's provenance (fork is always
        // connection-initiated; parked provenance is SHARED across the
        // globally-shared session, so a fork from tab B must not stamp the
        // child with tab A's most-recent park). A HOLLOW connection `Some`
        // (a partially initialized client's hello) behaves like `None` —
        // it never overrides real stamps. (2) the parent's parked value.
        // (3) the parent's DURABLE row stamps — the last source that can
        // know, and the child's NEW ledger key is where a `None` resolution
        // (merged keep-when-None against an empty row) could never be
        // rescued.
        let fork_provenance = provenance
            .filter(|p| p.is_meaningful())
            .or(parent_provenance)
            .or_else(|| {
                self.identity_sink()
                    .and_then(|s| s.load_provenance(PROVIDER, &real_id))
            });

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
        child_session.provenance = fork_provenance.clone();
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
            // D8 (focused-ep1-r5): the RESOLVED fork provenance (forking
            // connection > parent's parked > parent's row); `Inherit` only
            // when no source knows the attribution — never invented.
            provenance: fork_provenance.into(),
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

    // ── freshAgent.undo / freshAgent.redo (kata 1wxv Task 3) ─────────────────

    /// Handle a `freshAgent.undo`/`freshAgent.redo` for opencode: opencode's NATIVE
    /// message-targeted `revert`/`unrevert` on the shared serve (1.18.21, verified):
    /// the boundary is INCLUSIVE of the named message (an empty-prefix revert — the
    /// first user message — legally empties the conversation); stepwise redo =
    /// re-revert at a LATER in-tail user message; full restore = `unrevert`
    /// (all-or-nothing).
    ///
    /// Ordering (durable-BEFORE-mutation + the r2 serialization discipline):
    ///   1. `rollback_in_flight` single-flight (rollback-vs-rollback only — the
    ///      registry never grows send-path legs), acquired FIRST, then the
    ///      per-session mutex HELD ACROSS THE WHOLE REST OF THIS HANDLER (busy check
    ///      → reads → record pre-write → mutate → post-verify read →
    ///      broadcast/reply). `handle_send` NEVER acquires/consults
    ///      `rollback_in_flight`: it simply waits on the same mutex, then proceeds
    ///      and destroys redo — no circular wait exists (pinned semantic: send
    ///      waits, rollback wins, then the trailing send destroys);
    ///   2. the busy gate (`turn_task` unfinished ⇒ `BUSY_TURN`) — no HTTP call at
    ///      all leaves this handler for a refused attempt;
    ///   3. the post-op record is computed from the PRE-mutation reads, then AWAITED
    ///      BEFORE revert/unrevert runs — a pre-write failure refuses with
    ///      `INTERNAL_ERROR` + `LEDGER_WRITE_REFUSAL_COPY` and the provider history
    ///      is NEVER mutated;
    ///   4. the mutation + post-verify read run through
    ///      [`Self::mutate_and_verify`]'s r3 triad — NEVER a compensating rewrite
    ///      after a possibly-applied mutation.
    ///
    /// Record semantics (r3 UNION rule): the marker bucket is the union of EVERY
    /// epoch's rolled-back turns — FROZEN prior-epoch markers (recorded turns whose
    /// ids no longer appear in the served message list: their tail rows were natively
    /// DELETED by a resend, so the ledger is their only home, decision 6) PRECEDE the
    /// rebuilt current-epoch tail in conversation order, and a redo removes EXACTLY
    /// the restored turns from the current-epoch portion. An undo landing while
    /// `redo_destroyed` is set starts a NEW epoch that clears ONLY the redo-capable
    /// chain state (`redo_destroyed` clears; the prior chain's redo stays permanently
    /// dead — its provider tail no longer exists). `can_redo` is STAMPED AT WRITE
    /// TIME and gates ONLY on the current chain's remaining tail (frozen markers are
    /// not restorable, so they must not keep redo alive). The serve owns the current
    /// chain's boundary pointer (top-level `session.revert.messageID`); the record
    /// owns the destroyed bit, the stored `can_redo`, and the union marker bucket.
    /// A rollback NEVER chimes: the broadcast is `freshAgent.session.rolledBack`
    /// with `revokeAttention:true`, never a `turn.complete`.
    pub async fn handle_rollback(
        &self,
        op: crate::rollback_record::RollbackRequest,
        reply_sink: FrameSink,
    ) {
        use crate::rollback_record::*;

        // Rollback-vs-rollback single-flight, acquired FIRST (lock order:
        // rollback_in_flight, then the per-session mutex — never the reverse).
        let Some(_guard) = self.rollback_in_flight.try_acquire(&op.session_id) else {
            reply_sink(rollback_error_frame(
                &op,
                "INTERNAL_ERROR",
                &format!("rollback already in progress for {}", op.session_id),
            ));
            return;
        };
        let session_arc = { self.sessions.lock().await.get(&op.session_id).cloned() };
        let Some(session_arc) = session_arc else {
            reply_sink(rollback_error_frame(
                &op,
                "INVALID_SESSION_ID",
                &format!(
                    "opencode fresh-agent session {} is not available.",
                    op.session_id
                ),
            ));
            return;
        };
        // The per-session mutex is HELD ACROSS THE ENTIRE HANDLER — no mid-handler
        // release (a send issued while this holds waits behind it; the busy check's
        // check-then-act window against concurrent sends is closed).
        let session = session_arc.lock().await;
        let Some(real_id) = session.real_session_id.clone() else {
            reply_sink(rollback_error_frame(
                &op,
                "INVALID_SESSION_ID",
                &format!(
                    "OpenCode session {} has not materialized; cannot roll back.",
                    session.placeholder_id
                ),
            ));
            return;
        };
        if session.turn_task.as_ref().is_some_and(|t| !t.is_finished()) {
            reply_sink(rollback_error_frame(
                &op,
                "BUSY_TURN",
                ROLLBACK_BUSY_MESSAGE,
            ));
            return;
        }
        // `turnId` absent on a toTurn frame is a server-side validation error (never
        // a zod refinement — the frozen contract keeps bare objects).
        if op.mode == RollbackModeReq::ToTurn && op.turn_id.is_none() {
            reply_sink(rollback_error_frame(
                &op,
                "INVALID_ROLLBACK_TARGET",
                "rollback toTurn requires a turnId",
            ));
            return;
        }
        let route = session.cwd.clone();
        let manager = self.fresh_agent.ensure_manager().await;
        let info = match manager.get_session(&real_id, &route).await {
            Ok(v) => v,
            Err(err) => {
                reply_sink(rollback_error_frame(
                    &op,
                    "INTERNAL_ERROR",
                    &err.to_string(),
                ));
                return;
            }
        };
        let messages: Vec<Value> = match manager.list_messages(&real_id, &route).await {
            Ok(v) => v.as_array().cloned().unwrap_or_default(),
            Err(err) => {
                reply_sink(rollback_error_frame(
                    &op,
                    "INTERNAL_ERROR",
                    &err.to_string(),
                ));
                return;
            }
        };
        // VERIFIED shape (load-bearing correction item 2): `revert` is TOP-LEVEL on
        // the session body — session.revert = { messageID, snapshot?, diff?, partID? },
        // omitted entirely when no rollback is active. No `info.revert` exists
        // anywhere. The list returns the reverted tail UNFLAGGED; the boundary is
        // INCLUSIVE of the named message.
        let pointer: Option<String> = info
            .get("revert")
            .and_then(|r| r.get("messageID"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let boundary_idx = pointer
            .as_deref()
            .and_then(|p| {
                messages
                    .iter()
                    .position(|m| m.pointer("/info/id").and_then(Value::as_str) == Some(p))
            })
            .unwrap_or(messages.len());

        match op.direction {
            RollbackDirection::Undo => {
                let active = &messages[..boundary_idx];
                let target = match op.mode {
                    RollbackModeReq::Step => match last_user_message_id(active) {
                        Some(id) => id,
                        None => {
                            reply_sink(rollback_error_frame(
                                &op,
                                "NOTHING_TO_UNDO",
                                UNDO_EMPTY_MESSAGE,
                            ));
                            return;
                        }
                    },
                    RollbackModeReq::ToTurn => {
                        let t = op.turn_id.clone().expect("validated above");
                        let target_row = active.iter().find(|m| {
                            m.pointer("/info/id").and_then(Value::as_str) == Some(t.as_str())
                        });
                        if !(t.starts_with("msg") && target_row.is_some()) {
                            reply_sink(rollback_error_frame(
                                &op,
                                "INVALID_ROLLBACK_TARGET",
                                &format!("turn {t} is not in the active conversation"),
                            ));
                            return;
                        }
                        // r3 pre-flight role refusal: the serve normalizes an assistant
                        // messageID to its parent USER message and GENUINELY applies the
                        // revert — freshell's removed slice would then exclude the parent
                        // turn, and the exact-pointer post-verify would read a MOVED
                        // pointer at the parent id, mis-firing the silent-no-op
                        // compensation leg after an APPLIED mutation. Only USER rows are
                        // legal toTurn targets (the client renders the icon there alone);
                        // refuse BEFORE any ledger write or mutation.
                        if target_row
                            .expect("membership checked")
                            .pointer("/info/role")
                            .and_then(Value::as_str)
                            != Some("user")
                        {
                            reply_sink(rollback_error_frame(
                                &op,
                                "INVALID_ROLLBACK_TARGET",
                                &format!(
                                    "turn {t} is not a user message; toTurn undo targets user turns only"
                                ),
                            ));
                            return;
                        }
                        t
                    }
                };
                let target_idx = active
                    .iter()
                    .position(|m| {
                        m.pointer("/info/id").and_then(Value::as_str) == Some(target.as_str())
                    })
                    .expect("validated in range");
                let removed_msgs = &active[target_idx..];
                let removed_turns: Vec<Value> = removed_msgs
                    .iter()
                    .enumerate()
                    .filter_map(|(i, m)| crate::opencode_message_turn_json(m, target_idx + i))
                    .collect();
                let removed_ids: Vec<String> = removed_msgs
                    .iter()
                    .filter_map(|m| {
                        m.pointer("/info/id")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
                    .collect();
                // The composer-refill payload: plain text of the first removed USER
                // message.
                let prompt = first_user_prompt_text(removed_msgs);
                // Post-op record FIRST (durable-BEFORE-mutation): the CURRENT-epoch
                // portion of `entries` is REBUILT to exactly the current
                // serve-revert tail — ONE entry when non-empty, its turns in
                // ORIGINAL CONVERSATION ORDER (the r3 union: frozen prior-epoch
                // entries PRECEDE it) — per the plan's opencode wire-design
                // bullet. The rebuild merge dedupes by turn id, so a RETRY whose
                // provider-slice re-derives the SAME turns (plan triad (c)'s
                // deliberately-kept speculative entry, provider unmoved) is
                // IDEMPOTENT at the ledger — never a duplicated bucket
                // (ep2-r3). (Conversation position never reads timestamps.)
                let now = crate::rollback_record::now_ms();
                let previous = self
                    .identity_sink()
                    .and_then(|s| s.load_rollback(PROVIDER, &real_id));
                let mut record = match previous.clone() {
                    Some(p) => p,
                    None => RollbackRecord::empty(now),
                };
                // Epoch rule (r3): an undo landing while redo_destroyed is set (a
                // submission — OR, delta-r1 F5, a compact/summarize — natively
                // deleted the reverted tail) starts a NEW epoch: bump
                // `current_epoch` so every existing entry freezes with its own
                // epoch; ONLY the redo-capable chain state clears — `entries`
                // (the marker union) is NEVER dropped.
                if record.redo_destroyed {
                    record.redo_destroyed = false;
                    record.begin_new_epoch();
                }
                record.rebuild_current_epoch_tail(removed_turns, prompt.clone(), now);
                // The new tail is provably non-empty (it contains the target), so the
                // fresh chain is redoable.
                record.set_can_redo(true, now);
                if !self
                    .persist_record_or_refuse(&op, &real_id, record.clone(), &reply_sink)
                    .await
                {
                    return; // provider history NEVER mutated on this path
                }
                if !self
                    .mutate_and_verify(
                        &manager,
                        &op,
                        &real_id,
                        &route,
                        OpencodeMutationPlan {
                            boundary: Some(&target),
                            previous: previous.as_ref(),
                            now,
                            verb: "revert",
                        },
                        reply_sink.clone(),
                    )
                    .await
                {
                    return;
                }
                let can_redo = record.can_redo();
                // Converge siblings + revoke attention (decisions 6/10); NEVER a
                // chime. The broadcast carries NO prompt text (other devices'
                // composers are untouched).
                self.broadcast(&event_frame(
                    &real_id,
                    changed_event(&real_id, "opencode-rollback"),
                ));
                self.broadcast(&rollback_broadcast_frame(
                    &op,
                    &real_id,
                    &removed_ids,
                    can_redo,
                ));
                reply_sink(rollback_ack_frame(
                    &op,
                    &real_id,
                    Some(&prompt),
                    &removed_ids,
                    can_redo,
                    None,
                ));
            }
            RollbackDirection::Redo => {
                let Some(_pointer) = pointer else {
                    reply_sink(rollback_error_frame(
                        &op,
                        "REDO_UNAVAILABLE",
                        REDO_EMPTY_MESSAGE,
                    ));
                    return;
                };
                let existing = self
                    .identity_sink()
                    .and_then(|s| s.load_rollback(PROVIDER, &real_id));
                // The durable record's STORED write-time bit gates redo availability
                // (never entries-derived) ahead of the served-tail math.
                match existing.as_ref() {
                    Some(r) if r.can_redo() => {}
                    Some(r) if r.redo_destroyed => {
                        reply_sink(rollback_error_frame(
                            &op,
                            "REDO_UNAVAILABLE",
                            REDO_DESTROYED_MESSAGE,
                        ));
                        return;
                    }
                    _ => {
                        reply_sink(rollback_error_frame(
                            &op,
                            "REDO_UNAVAILABLE",
                            REDO_EMPTY_MESSAGE,
                        ));
                        return;
                    }
                }
                let tail = &messages[boundary_idx..];
                if tail.is_empty() {
                    // A stale pointer (named message no longer served) leaves nothing
                    // restorable.
                    reply_sink(rollback_error_frame(
                        &op,
                        "REDO_UNAVAILABLE",
                        REDO_EMPTY_MESSAGE,
                    ));
                    return;
                }
                // Uniform group math, one formula for both modes: Step restores the
                // pointer's own group (t_pos = 0); toTurn restores through T's group.
                // Kept-through end = the first USER message strictly AFTER the
                // address; unrevert (all-or-nothing) when none. (r3: the rolled-back
                // TAIL the pointer defines is the CURRENT epoch only — the frozen
                // prior-epoch markers live in the ledger union, never the served
                // list, so this math can never name them.)
                let t_pos = match op.mode {
                    RollbackModeReq::Step => 0usize,
                    RollbackModeReq::ToTurn => {
                        let t = op.turn_id.clone().expect("validated");
                        match tail.iter().position(|m| {
                            m.pointer("/info/id").and_then(Value::as_str) == Some(t.as_str())
                        }) {
                            Some(pos) => pos,
                            None => {
                                reply_sink(rollback_error_frame(
                                    &op,
                                    "INVALID_ROLLBACK_TARGET",
                                    &format!("turn {t} is not in the rolled-back tail"),
                                ));
                                return;
                            }
                        }
                    }
                };
                let kept_end = messages
                    .iter()
                    .enumerate()
                    .skip(boundary_idx + t_pos + 1)
                    .find(|(_, m)| m.pointer("/info/role").and_then(Value::as_str) == Some("user"))
                    .map(|(i, _)| i);
                let new_boundary_id: Option<String> = kept_end.map(|i| {
                    messages[i]
                        .pointer("/info/id")
                        .and_then(Value::as_str)
                        .expect("served message id")
                        .to_string()
                });
                let restored_slice = &messages[boundary_idx..kept_end.unwrap_or(messages.len())];
                // Post-op record FIRST (durable-BEFORE-mutation): the restored turns
                // leave the CURRENT-epoch marker entries BEFORE the revert/unrevert
                // POST goes out — frozen prior-epoch markers can never match a
                // restorable id (the served tail is the current epoch only, r3) and
                // are never dropped by a redo.
                let restored_id_set: std::collections::HashSet<&str> = restored_slice
                    .iter()
                    .filter_map(|m| m.pointer("/info/id").and_then(Value::as_str))
                    .collect();
                let now = crate::rollback_record::now_ms();
                let previous = existing.clone();
                let mut record = existing.unwrap_or_else(|| RollbackRecord::empty(now));
                record.entries.retain_mut(|e| {
                    e.removed_turns.retain(|t| {
                        !marker_turn_id(t).is_some_and(|id| restored_id_set.contains(id))
                    });
                    !e.removed_turns.is_empty()
                });
                record.last_op_at_ms = now;
                // can_redo gates ONLY on the current epoch's remaining tail (r3).
                let current_tail_non_empty = record
                    .entries
                    .iter()
                    .any(|e| e.epoch == record.current_epoch && !e.removed_turns.is_empty());
                record.set_can_redo(!record.redo_destroyed && current_tail_non_empty, now);
                if !self
                    .persist_record_or_refuse(&op, &real_id, record.clone(), &reply_sink)
                    .await
                {
                    return; // provider history NEVER mutated on this path
                }
                if !self
                    .mutate_and_verify(
                        &manager,
                        &op,
                        &real_id,
                        &route,
                        OpencodeMutationPlan {
                            boundary: new_boundary_id.as_deref(),
                            previous: previous.as_ref(),
                            now,
                            verb: "redo",
                        },
                        reply_sink.clone(),
                    )
                    .await
                {
                    return;
                }
                let restored_ids: Vec<String> = restored_slice
                    .iter()
                    .filter_map(|m| {
                        m.pointer("/info/id")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
                    .collect();
                let can_redo = record.can_redo();
                self.broadcast(&event_frame(
                    &real_id,
                    changed_event(&real_id, "opencode-rollback"),
                ));
                self.broadcast(&rollback_broadcast_frame(
                    &op,
                    &real_id,
                    &restored_ids,
                    can_redo,
                ));
                reply_sink(rollback_ack_frame(
                    &op,
                    &real_id,
                    None,
                    &restored_ids,
                    can_redo,
                    None,
                ));
            }
        }
    }

    /// The shared mutation + post-verify tail of both rollback directions: issue
    /// `POST /session/:id/revert{messageID}` (boundary `Some`) or `/unrevert`
    /// (`None`), then re-read the session and classify the r3 TRIAD (NEVER a
    /// compensating rewrite after a possibly-applied mutation):
    ///   (a) the read SUCCEEDS and the observed pointer equals exactly the requested
    ///       boundary (or is ABSENT after a full unrevert) ⇒ success (`true`);
    ///   (b) the read SUCCEEDS and the pointer provably did NOT move (the verified
    ///       silent-200 rule is pointer-untouched-on-no-op, so the provider is
    ///       PROVABLY unmoved) ⇒ `INVALID_ROLLBACK_TARGET` + a compensating rewrite
    ///       (the ledger never describes a rollback the serve provably rejected);
    ///   (c) the read ITSELF FAILS (transport/5xx — the mutation may have applied) ⇒
    ///       `INTERNAL_ERROR`, the ledger KEPT verbatim (never compensated), and the
    ///       retry/reconciliation note: the next snapshot derives the active prefix
    ///       from provider rows, so pane + record reconverge automatically.
    /// Mutation-RPC ERROR legs compensate ONLY on an HTTP ANSWER (a 4xx/5xx the serve
    /// provably sent back — the revert provably did not apply); transport legs (no
    /// answer at all) are treated like (c): keep the ledger.
    async fn mutate_and_verify(
        &self,
        manager: &OpencodeServeManager,
        op: &crate::rollback_record::RollbackRequest,
        real_id: &str,
        route: &freshell_opencode::Route,
        plan: OpencodeMutationPlan<'_>,
        reply_sink: FrameSink,
    ) -> bool {
        let result = match plan.boundary {
            Some(target) => manager.revert(real_id, target, route).await,
            None => manager.unrevert(real_id, route).await,
        };
        if let Err(err) = result {
            // ep3-r1 F2 (the compact path's compensation discipline applied to
            // rollback): an answered non-2xx (`ServeError::Http`) means the
            // serve REJECTED the mutation, and `ServeError::never_dispatched()`
            // (connect-phase refusal + every startup-phase failure) means the
            // POST provably never left this process — in BOTH cases the provider
            // history is untouched, so the speculative pre-write must be
            // compensated or the ledger would describe a mutation the provider
            // provably did not perform (a failed undo would expose the same
            // turns as active AND rolled back; a failed full redo would durably
            // destroy redo availability while the provider remains reverted).
            // Timed-at/after-send failures stay uncompensated forever
            // (error-after-send ≠ mutation refused).
            if matches!(&err, ServeError::Http { .. }) || err.never_dispatched() {
                self.compensate_opencode_record(real_id, plan.previous, plan.now)
                    .await;
            }
            reply_sink(map_opencode_serve_error(op, &err));
            return false;
        }
        // POST-VERIFY (unknown/stale messageID is a silent 200 no-op serve-side).
        let verb = plan.verb;
        let verified = match manager.get_session(real_id, route).await {
            Ok(v) => v
                .get("revert")
                .and_then(|r| r.get("messageID"))
                .and_then(Value::as_str)
                .map(str::to_string),
            Err(err) => {
                // (c) the READ failed — the mutation may have applied: KEEP the
                // ledger (no compensating rewrite) and report INTERNAL_ERROR.
                reply_sink(crate::rollback_record::rollback_error_frame(
                    op,
                    "INTERNAL_ERROR",
                    &format!("{verb} issued but the post-rollback verification read failed: {err}"),
                ));
                return false;
            }
        };
        let verified_ok = match plan.boundary {
            Some(target) => verified.as_deref() == Some(target),
            None => verified.is_none(),
        };
        if !verified_ok {
            // (b) read SUCCEEDED + the pointer provably did not move ⇒ compensate,
            // then refuse.
            self.compensate_opencode_record(real_id, plan.previous, plan.now)
                .await;
            reply_sink(crate::rollback_record::rollback_error_frame(
                op,
                "INVALID_ROLLBACK_TARGET",
                &format!(
                    "the serve accepted the {verb} but the rollback pointer did not move (unknown or stale messageID)"
                ),
            ));
            return false;
        }
        true
    }

    /// The durable-BEFORE-mutation pre-write shared by both rollback directions:
    /// AWAIT the post-op record write; a failure REFUSES the rollback
    /// (`INTERNAL_ERROR` + `LEDGER_WRITE_REFUSAL_COPY`) and the provider history is
    /// NEVER mutated. `true` when the mutation may proceed.
    async fn persist_record_or_refuse(
        &self,
        op: &crate::rollback_record::RollbackRequest,
        real_id: &str,
        record: crate::rollback_record::RollbackRecord,
        reply_sink: &FrameSink,
    ) -> bool {
        if let Some(sink) = self.identity_sink() {
            if let Err(e) = sink.record_rollback(PROVIDER, real_id, record).await {
                tracing::warn!(error = %e, session = %real_id, "freshagent.opencode.rollback_pre_write_failed");
                reply_sink(crate::rollback_record::rollback_error_frame(
                    op,
                    "INTERNAL_ERROR",
                    crate::rollback_record::LEDGER_WRITE_REFUSAL_COPY,
                ));
                return false;
            }
        }
        true
    }

    /// Compensating write after a provider failure that followed a successful record
    /// pre-write: restores the pre-op record (or an empty one) so the ledger never
    /// describes a rollback the serve provably rejected. Warn-only — the refusal is
    /// answered regardless.
    async fn compensate_opencode_record(
        &self,
        real_id: &str,
        previous: Option<&crate::rollback_record::RollbackRecord>,
        now: i64,
    ) {
        if let Some(sink) = self.identity_sink() {
            let restore = previous
                .cloned()
                .unwrap_or_else(|| crate::rollback_record::RollbackRecord::empty(now));
            if let Err(e) = sink.record_rollback(PROVIDER, real_id, restore).await {
                tracing::warn!(error = %e, session = %real_id, "freshagent.opencode.rollback_compensate_failed");
            }
        }
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
            // Conn-less lane (D8): attach carries no tab identity — keep-when-None
            // merge preserves the create's provenance stamps.
            None => match self
                .resume_durable_session(&msg.session_id, msg.cwd.as_deref(), None)
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
    /// `provenance` (D8): the CURRENT connection's provenance when this resume flows
    /// from a connection-scoped create ([`Self::handle_create_resume`]; delta-r1
    /// Finding 3) — parked on the reconstructed session (focused-ep1-r3) AND re-stamped
    /// by the binding refresh below, so a resume-into-a-new-tab never keeps the OLD
    /// tab's attribution. `None` from conn-less lanes (`handle_attach`): the session
    /// then parks the DURABLE row's stamps instead (focused-ep1-r4 Finding 2 — the
    /// row is the authoritative record of where this session last lived; the fork
    /// child's NEW ledger key is where a `None` park could never be rescued), and
    /// the conn-less refresh below writes `None` stamps so the ledger's
    /// keep-when-None merge preserves whatever the row had.
    async fn resume_durable_session(
        &self,
        session_id: &str,
        cwd: Option<&str>,
        provenance: Option<crate::BindProvenance>,
    ) -> Result<Arc<TokioMutex<OpencodeSession>>, ResumeOpencodeError> {
        // D8 (focused-ep1-r5 Finding 2): "meaningful provenance" only — a
        // HOLLOW `Some` (a partially initialized client's hello) behaves like
        // `None` on every decision below: the park falls through to the
        // durable row's stamp seed, and the refresh gate never fires on
        // hollow alone.
        let provenance = provenance.filter(|p| p.is_meaningful());
        // Round 4 (focused-ep5-r3 Finding 1): the claim's dead-state
        // SNAPSHOT — taken at claim start, before the serve-manager awaits
        // (`get_session` and friends) — so a kill landing while this resume
        // is in flight advances the durable tombstone past it and the commit
        // below REFUSES instead of undoing the newer close.
        let claim_dead_state = self.claim_dead_state_snapshot(session_id);
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
        // D8 (focused-ep1-r3 + focused-ep1-r4 Finding 2 — the COMPLETE parking
        // invariant): a session (re)attached to a client connection must hold
        // that connection's LATEST provenance; a session reconstructed by a
        // CONN-LESS cold resume (`handle_attach` carries no tab identity)
        // holds the DURABLE row's stamps instead — the authoritative record of
        // where this session last lived. Park BEFORE insertion so every
        // downstream reader of `session.provenance` (the per-send refresh
        // write, the fork consumer's child-row inheritance — a NEW ledger key
        // where keep-when-None could never rescue a `None` park) asserts a
        // known attribution. The connection's provenance still wins when
        // present (the current-tab truth for a live move). A row that
        // genuinely carries no stamps seeds nothing: `None` stays parked —
        // never invented — and the conn-less refresh below preserves whatever
        // the row had.
        session.provenance = provenance.clone().or_else(|| {
            sink.as_ref()
                .and_then(|s| s.load_provenance(PROVIDER, session_id))
        });
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

        // Retire-on-kill round 2/3 (focused-ep5-r1 Finding 2, -r2 Finding
        // 4): this resume/attach GENUINELY CLAIMS the durable session — the
        // claim COMMITS here (the rebuilt session is registered, the lease
        // resolution is final): clear the durable kill fence BEFORE any
        // binding write of this rebuilt session (the refresh below AND every
        // later per-send refresh), so the claim is never suppressed as the
        // killed session's stale orphan, AND return a kill-closed row to
        // Bound now — the refresh write below is V7-gated on a recovered
        // settings snapshot / connection provenance, so a lineage-only row
        // attached conn-less would otherwise stay Closed while the session
        // runs live (the finding).
        //
        // Round 4 (focused-ep5-r3 Finding 1): the commit is CONDITIONAL on
        // the claim-start dead-state snapshot — including on the
        // lease-revoked arm above (the round-3 lane committed UNCONDITIONALLY
        // there, the finding's exact headline). A kill that landed while this
        // resume was in flight advanced the tombstone; a revoked lease CAUSED
        // by that kill therefore refuses the commit now with NO side effects,
        // and the just-registered session is torn back down (map entry
        // dropped, bridge aborted, lease failed open) — a revoked lease whose
        // dead-state is UNCHANGED (an expired handle-less holder, no kill)
        // still commits and keeps the registered session (the round-3 keep).
        if !self.commit_session_claim(session_id, claim_dead_state).await {
            // Round 6 lock order (focused-ep5-r5 Finding 1): the map removal
            // is its OWN synchronous critical section, completed before the
            // session-lock teardown begins. (The pre-fix `if let Some(removed)
            // = self.sessions.lock().await.remove(...)` kept the scrutinee
            // guard alive through the whole body on edition 2021 — the map
            // stayed locked across `removed.lock().await` and the settle
            // await, wedging every other opencode map reader for the
            // duration of an arbitrarily slow settle.)
            let removed = {
                let mut guard = self.sessions.lock().await;
                guard.remove(session_id)
            };
            if let Some(removed) = removed {
                let mut s = removed.lock().await;
                s.killed.store(true, Ordering::SeqCst);
                if let Some(task) = s.turn_task.take() {
                    task.abort_and_settle().await;
                }
                if let Some(bridge) = s.serve_bridge.take() {
                    bridge.abort();
                }
            }
            lease_guard.fail();
            return Err(ResumeOpencodeError::Manager(
                freshell_opencode::ServeError::Transport(format!(
                    "opencode session {session_id} closed while the resume was in flight; torn down"
                )),
            ));
        }

        // P1.13 (Task 8): refresh the binding row after a successful resume -- AWAITED
        // (durable-before-answer). The SETTINGS payload rides only when a record was
        // actually recovered (never launder a defaults row for a never-recorded
        // session, V7); the D8 provenance re-stamp rides whenever the resume is
        // connection-scoped — INCLUDING the settings-None (lineage-only row) case,
        // which must still assert the CURRENT connection's identity/tab
        // (focused-ep1 Finding A, branch 2). A conn-less resume of a
        // never-recorded session still writes nothing (V7's no-laundering rule,
        // unchanged).
        if recovered.is_some() || provenance.is_some() {
            // D8 provenance (delta-r1 Finding 3): a connection-scoped
            // create-resume re-stamps the row with the CURRENT connection's
            // identity/tab (a resume-into-a-new-tab must not keep the OLD tab's
            // attribution). When no connection identity is available the write
            // is `Inherit` (never invent) and the ledger merge preserves the
            // create's stamps.
            let provenance: crate::identity_sink::ProvenanceUpdate = provenance.into();
            // Settings merge stays as-is: recovered values when a snapshot
            // exists; otherwise a blank payload (a replace-no-op — a
            // lineage-only row has no settings to clobber, and a never-recorded
            // session gains provenance WITHOUT a laundered defaults snapshot).
            let settings = if recovered.is_some() {
                crate::identity_sink::FreshAgentSettings {
                    model: rec.model.clone(),
                    sandbox: None,
                    permission_mode: None,
                    effort: rec.effort.clone(),
                    cwd,
                }
            } else {
                crate::identity_sink::FreshAgentSettings::default()
            };
            self.record_binding_row(crate::identity_sink::FreshAgentBindingUpsert {
                provider: PROVIDER.into(),
                session_id: session_id.to_string(),
                mode: SESSION_TYPE.into(),
                create_request_id: None,
                resolves_pending: None,
                supersedes: None,
                provenance,
                settings,
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

// ── kata 1wxv Task 3: opencode rollback turn math + error mapping ────────────────

/// One direction's mutation plan for `mutate_and_verify` — the requested post-state
/// boundary (`Some(id)` ⇒ `revert`; `None` ⇒ `unrevert`), the pre-op record for the
/// compensation legs, and the copy noun for refusal messages.
struct OpencodeMutationPlan<'a> {
    boundary: Option<&'a str>,
    previous: Option<&'a crate::rollback_record::RollbackRecord>,
    now: i64,
    verb: &'static str,
}

/// The LAST user-role message id of `msgs` (conversation order), if any.
fn last_user_message_id(msgs: &[Value]) -> Option<String> {
    msgs.iter()
        .rev()
        .find(|m| m.pointer("/info/role").and_then(Value::as_str) == Some("user"))
        .and_then(|m| {
            m.pointer("/info/id")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
}

/// Plain text of the FIRST user message's text parts — the composer-refill payload.
fn first_user_prompt_text(msgs: &[Value]) -> String {
    msgs.iter()
        .find(|m| m.pointer("/info/role").and_then(Value::as_str) == Some("user"))
        .and_then(|m| m.get("parts").and_then(Value::as_array))
        .map(|parts| {
            parts
                .iter()
                .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n\n")
        })
        .unwrap_or_default()
}

/// A marker row's conversation id — `turnId`, falling back to `id`.
fn marker_turn_id(turn: &Value) -> Option<&str> {
    turn.get("turnId")
        .or_else(|| turn.get("id"))
        .and_then(Value::as_str)
}

/// Revert/unrevert error mapping (load-bearing correction item 4 + r1 remediation):
/// an HTTP 404 / unknown-route ANSWER means the CLI predates the revert surface;
/// only unknown transport/other failures map to INTERNAL_ERROR.
fn map_opencode_serve_error(
    op: &crate::rollback_record::RollbackRequest,
    err: &ServeError,
) -> ServerMessage {
    if matches!(err, ServeError::Http { status: 404, .. }) {
        crate::rollback_record::rollback_error_frame(
            op,
            "UNSUPPORTED_CAPABILITY",
            crate::rollback_record::OPENCODE_OLD_CLI_COPY,
        )
    } else {
        crate::rollback_record::rollback_error_frame(op, "INTERNAL_ERROR", &err.to_string())
    }
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
        ProcessSpawner, ServeConfig, ServeDeps, ServeHttp, ServeHttpError, ServeHttpRequest,
        ServeHttpResponse, ServeProcess, SpawnRequest,
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
            Box<
                dyn std::future::Future<Output = Result<ServeHttpResponse, ServeHttpError>>
                    + Send
                    + 'a,
            >,
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

    /// ep2-r1 F3: a spawner whose `spawn` ALWAYS refuses — the compact drive's
    /// `ensure_started()` fails BEFORE the summarize request exists (the
    /// provably-no-POST startup leg).
    const FAILSPAWN_MARK: &str = "test spawn refusal";

    struct FailSpawner;
    impl ProcessSpawner for FailSpawner {
        fn spawn(&self, _req: SpawnRequest) -> Result<Box<dyn ServeProcess>, String> {
            Err(FAILSPAWN_MARK.to_string())
        }
    }

    /// ep4-r6 (the interrupt-window unmask): the FIRST spawn succeeds, every
    /// later one refuses — with a parked health gate the compact drive stays in
    /// its cold-start window, while the interrupt handler's best-effort
    /// `manager.abort` (which re-derives ensure_started) fails fast instead of
    /// burning the health budget and hiding the compensation window.
    struct SpawnOnceThenRefuse {
        spawned: Arc<std::sync::atomic::AtomicBool>,
    }
    impl ProcessSpawner for SpawnOnceThenRefuse {
        fn spawn(&self, _req: SpawnRequest) -> Result<Box<dyn ServeProcess>, String> {
            if self.spawned.swap(true, std::sync::atomic::Ordering::SeqCst) {
                Err(FAILSPAWN_MARK.to_string())
            } else {
                Ok(Box::new(TrackedProcess {
                    killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                }))
            }
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
            Box<
                dyn std::future::Future<Output = Result<ServeHttpResponse, ServeHttpError>>
                    + Send
                    + 'a,
            >,
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
            Box<
                dyn std::future::Future<Output = Result<ServeHttpResponse, ServeHttpError>>
                    + Send
                    + 'a,
            >,
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
            // Like the real serve, `POST /session/:id/fork` mints a FRESH child
            // `ses_N` (sharing the create counter) and remembers it, so a fork
            // of a genuinely-known parent yields a distinct, itself-resolvable id.
            if matches!(req.method, freshell_opencode::serve::HttpMethod::Post)
                && req.url.contains("/fork")
            {
                let n = self.next_session.fetch_add(1, Ordering::SeqCst) + 1;
                let child = format!("ses_{n}");
                self.created.lock().unwrap().insert(child.clone());
                let body = serde_json::to_vec(
                    &json!({ "id": child, "title": "forked session", "time": { "updated": 6 }, "directory": "/serve/dir" }),
                )
                .unwrap();
                return Box::pin(async move { Ok(ServeHttpResponse::new(200, body)) });
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
            Box<
                dyn std::future::Future<Output = Result<ServeHttpResponse, ServeHttpError>>
                    + Send
                    + 'a,
            >,
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
        let out = state.resume_durable_session("ses_wedged_1", None, None).await;
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
            tab_id: None,
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

        st.handle_create(create_msg("req-1"), None).await;

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

        st.handle_create(create_msg("req-dedup-seq"), None).await;
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
        st.handle_create(create_msg("req-dedup-seq"), None).await;

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
            st1.handle_create(create_msg("req-dedup-race"), None),
            st2.handle_create(create_msg("req-dedup-race"), None),
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

        st.handle_create(create_msg("req-dedup-a"), None).await;
        st.handle_create(create_msg("req-dedup-b"), None).await;

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

        st.handle_create(create_msg("req-dedup-kill"), None).await;
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

        st.handle_create(create_msg("req-dedup-kill"), None).await;

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

    /// Retire-on-kill (delta-review round 5, restore-open-sessions-only): an
    /// explicit kill is an intentional session END. Killing a MATERIALIZED
    /// session must (a) retire its durable row `Closed` through the identity
    /// sink — so the recovery inventory (Bound-only pre-filter) can never
    /// re-offer a pane the user just closed inside the 7s creation-race grace
    /// window — and (b) clear the pending marker, so a late resolution can
    /// never carry evidence for a pane that provably no longer exists.
    #[tokio::test]
    async fn handle_kill_retires_the_materialized_row_and_clears_the_pending_marker() {
        let (st, _killed) = state().await;
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        st.handle_create(create_msg("req-kill-retire"), None).await;
        let placeholder = "freshopencode-req-kill-retire";
        assert!(
            fake.pendings.lock().unwrap().iter().any(|(p, _, _)| p.as_str() == placeholder),
            "precondition: create recorded the pending marker"
        );
        st.handle_send(send_msg(placeholder, "hi")).await;
        let real_id = {
            let sessions = st.sessions.lock().await;
            let guard = sessions
                .get(placeholder)
                .expect("placeholder tracked")
                .lock()
                .await;
            guard
                .real_session_id
                .clone()
                .expect("sanity: the session materialized before the kill")
        };

        st.handle_kill(FreshAgentKill {
            provider: AgentProvider::Opencode,
            session_id: placeholder.to_string(),
            session_type: SessionType::Freshopencode,
            cwd: None,
        })
        .await;

        let retires = fake.retires.lock().unwrap().clone();
        assert!(
            retires.contains(&("opencode".to_string(), real_id.clone())),
            "the kill must retire (opencode, {real_id}) — the durable-keyed row: {retires:?}"
        );
        assert!(
            !fake
                .pendings
                .lock()
                .unwrap()
                .iter()
                .any(|(p, _, _)| p.as_str() == placeholder),
            "the kill must delete the pending marker for {placeholder}"
        );
    }

    /// The PENDING arm of the same contract: a kill arriving before the first
    /// send materialized the session deletes the pending marker (so the marker
    /// can never resolve into a Bound row after the pane is gone), and a kill
    /// naming an id the session map never held — a durable id whose sidecar
    /// was already evicted — still retires the row that id names.
    #[tokio::test]
    async fn handle_kill_before_materialization_clears_the_marker_and_evicted_ids_still_retire() {
        let (st, _killed) = state().await;
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        st.handle_create(create_msg("req-kill-pending"), None).await;
        let placeholder = "freshopencode-req-kill-pending";
        assert!(
            fake.pendings.lock().unwrap().iter().any(|(p, _, _)| p.as_str() == placeholder),
            "precondition: create recorded the pending marker"
        );

        st.handle_kill(FreshAgentKill {
            provider: AgentProvider::Opencode,
            session_id: placeholder.to_string(),
            session_type: SessionType::Freshopencode,
            cwd: None,
        })
        .await;
        assert!(
            !fake.pendings.lock().unwrap().iter().any(|(p, _, _)| p.as_str() == placeholder),
            "the pre-materialization kill must delete the pending marker"
        );
        // Focused-episode-6 round 3, Finding 1: the marker delete alone is
        // NOT the close — a kill whose retire set is empty leaves NO durable
        // close evidence for the placeholder, so a retained snapshot claiming
        // it verdicts `unknown` and can re-offer the pane the user closed.
        // The envelope's IDENTITY set must carry the placeholder itself (the
        // placeholder-keyed close record the verdict join consults).
        let batches = fake.retire_batches.lock().unwrap().clone();
        assert_eq!(
            batches.len(),
            1,
            "the pre-lock close is ONE envelope call: {batches:?}"
        );
        let (provider, ids, pendings) = &batches[0];
        assert_eq!(provider, "opencode");
        assert!(
            ids.contains(&placeholder.to_string()),
            "a no-retire-ids kill must STILL close the placeholder durably \
             (the verdict join's closed evidence): {ids:?}"
        );
        assert!(
            pendings.contains(&placeholder.to_string()),
            "the envelope's marker deletes still cover the placeholder: {pendings:?}"
        );

        // The evicted-session arm: a durable id no longer in the session map
        // still retires the row it names (idempotent when no row exists).
        st.handle_kill(FreshAgentKill {
            provider: AgentProvider::Opencode,
            session_id: "ses_evicted".to_string(),
            session_type: SessionType::Freshopencode,
            cwd: None,
        })
        .await;
        let retires = fake.retires.lock().unwrap().clone();
        assert!(
            retires.contains(&("opencode".to_string(), "ses_evicted".to_string())),
            "the kill must retire (opencode, ses_evicted): {retires:?}"
        );
    }

    /// Retire-on-kill round 5 (focused-ep5-r4 Finding 4), the opencode lane:
    /// the durable close (row retire + pending-marker deletion, the first
    /// write phase) must be recorded BEFORE any teardown/settlement await —
    /// the kill handler runs in a detached task and the client removes the
    /// pane without a durable acknowledgement, so a server crash inside the
    /// turn settlement would otherwise lose the close (Bound row survives,
    /// re-offerable by the next recovery). THE HOOKED TEARDOWN STALL: the
    /// session carries a compact drive whose settle channel the test holds
    /// (ep4-r6's settle knob) — `abort_and_settle` parks on it for seconds —
    /// the close must already be observable while the settlement never
    /// lands.
    #[tokio::test(flavor = "multi_thread")]
    async fn handle_kill_records_the_close_before_the_turn_settlement() {
        let (st, _killed) = state().await;
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        st.handle_create(create_msg("req-kill-settle"), None).await;
        let placeholder = "freshopencode-req-kill-settle";
        assert!(
            fake.pendings
                .lock()
                .unwrap()
                .iter()
                .any(|(p, _, _)| p.as_str() == placeholder),
            "precondition: the create recorded the pending marker"
        );

        // The stalled settlement: a Compact-kind drive task whose settle
        // channel the test holds — `abort_and_settle` joins the (aborted)
        // drive instantly, then parks on the settle wait up to 5s.
        let (settled_tx, settled_rx) = tokio::sync::oneshot::channel();
        {
            let sessions = st.sessions.lock().await;
            let session_arc = sessions.get(placeholder).expect("session tracked").clone();
            session_arc.lock().await.turn_task = Some(TurnTask {
                kind: TurnTaskKind::Compact,
                handle: tokio::spawn(std::future::pending::<()>()),
                compact_settled_rx: Some(settled_rx),
            });
        }

        let st2 = st.clone();
        let kill = tokio::spawn(async move {
            st2.handle_kill(FreshAgentKill {
                provider: AgentProvider::Opencode,
                session_id: placeholder.to_string(),
                session_type: SessionType::Freshopencode,
                cwd: None,
            })
            .await;
        });

        // The settle never lands while held, so the ONLY way the close can be
        // observable within this budget is if it was recorded FIRST. (The
        // settle wait is 5s; 1.5s here is comfortably inside the stall.)
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(1500);
        loop {
            let marker_gone = !fake
                .pendings
                .lock()
                .unwrap()
                .iter()
                .any(|(p, _, _)| p.as_str() == placeholder);
            if marker_gone {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the durable close (row retire + pending-marker delete) must be recorded \
                 BEFORE the turn-settlement await — a crash inside it lost the close"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        assert!(
            !kill.is_finished(),
            "fixture: the settlement is still stalled (the close preceded it, not followed it)"
        );
        // Release the settle; the kill completes.
        let _ = settled_tx.send(());
        tokio::time::timeout(std::time::Duration::from_secs(15), kill)
            .await
            .expect("the kill completes after the settle lands")
            .expect("kill task completed");
    }

    /// Delta-r6 close-durability finding, re-staged for the round-4 (F6)
    /// topology: the enumeration's session-lock wait (the FIRST acquisition)
    /// must carry NOTHING — no durable close ever waits behind a park, and
    /// no live state is touched before it resolves. A restart or task
    /// cancellation during that wait loses nothing (no close evidence, no
    /// torn state), and once the hold releases the ONE envelope covers the
    /// complete set and the lane runs to completion. This retargets the
    /// pre-F6 pin "the close precedes the session-lock wait": the finding
    /// that ordering caused was discovery AFTER the envelope — enumeration
    /// now parks first, carrying nothing.
    #[tokio::test(flavor = "multi_thread")]
    async fn handle_kills_enumeration_park_carries_nothing_durable_then_the_one_envelope_lands() {
        let (st, _killed) = state().await;
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        st.handle_create(create_msg("req-kill-before-lock"), None).await;
        let placeholder = "freshopencode-req-kill-before-lock";
        st.handle_send(send_msg(placeholder, "materialize")).await;
        let session_arc = {
            let sessions = st.sessions.lock().await;
            sessions.get(placeholder).expect("session tracked").clone()
        };
        assert_eq!(
            session_arc.lock().await.real_session_id.as_deref(),
            Some("ses_1"),
            "fixture: the send materialized the durable id"
        );

        // The gate: the test holds the per-session lock (the cold-start
        // materialization hold) — the kill's ENUMERATION parks on it.
        let killed_flag = session_arc.lock().await.killed.clone();
        let session_guard = session_arc.lock().await;

        let st2 = st.clone();
        let ph = placeholder.to_string();
        let mut kill = tokio::spawn(async move {
            st2.handle_kill(FreshAgentKill {
                provider: freshell_protocol::AgentProvider::Opencode,
                session_id: ph,
                session_type: SessionType::Freshopencode,
                cwd: None,
            })
            .await;
        });

        // While the kill parks, NOTHING is durable and nothing is torn: no
        // retires, no pending-marker deletes, the killed flag unset. (A
        // cancel here is a no-op.)
        for _ in 0..4 {
            tokio::task::yield_now().await;
            assert!(
                !kill.is_finished(),
                "fixture: the kill is still parked on the held session lock"
            );
        }
        assert!(
            fake.retires.lock().unwrap().is_empty(),
            "the enumeration park records nothing: {:?}",
            fake.retires.lock().unwrap()
        );
        assert!(
            fake.pendings.lock().unwrap().iter().any(|(p, _, _)| p == placeholder),
            "the pending marker stands (nothing deleted) while the kill parks"
        );
        assert!(
            !killed_flag.load(Ordering::SeqCst),
            "the killed flag is unset while the kill parks"
        );
        drop(session_guard);
        tokio::time::timeout(std::time::Duration::from_secs(15), &mut kill)
            .await
            .expect("the kill completes once the hold releases")
            .expect("kill task completed");
        assert!(st.sessions.lock().await.is_empty(), "both map keys removed");
        let retires = fake.retires.lock().unwrap().clone();
        for id in [placeholder, "ses_1"] {
            assert!(
                retires.contains(&("opencode".to_string(), id.to_string())),
                "the envelope covers {id}: {retires:?}"
            );
        }
    }

    /// Delta-r6 close-durability (failures propagate): a kill whose durable
    /// close could NOT be recorded must FAIL — the `freshAgent.killed` answer
    /// reports `success:false` and NO live state was touched (the session
    /// map, the killed flag, the pending marker, the in-flight turn all
    /// stand). Warn-and-continue would leave the row Bound and eligible for
    /// the recovery pipeline while the client believes the pane is closed.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_kill_whose_durable_close_fails_reports_failure_and_touches_no_live_state() {
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let fresh_agent = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx));
        let (manager, _killed) = started_manager().await;
        fresh_agent.set_manager_for_test(manager).await;
        let st = FreshOpencodeState::new(fresh_agent);
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        st.handle_create(create_msg("req-kill-fail"), None).await;
        let placeholder = "freshopencode-req-kill-fail";
        st.handle_send(send_msg(placeholder, "materialize")).await;
        let session_arc = {
            let sessions = st.sessions.lock().await;
            sessions.get(placeholder).expect("session tracked").clone()
        };
        assert_eq!(
            session_arc.lock().await.real_session_id.as_deref(),
            Some("ses_1"),
            "fixture: the send materialized the durable id"
        );
        // Drain the frames emitted so far (created/accepted/snapshots) so the
        // only frames in the channel are the kill's answer.
        while rx.try_recv().is_ok() {}

        // The ledger fails every write (disk-full/permission shape).
        fake.set_fail_writes(true);
        st.handle_kill(FreshAgentKill {
            provider: freshell_protocol::AgentProvider::Opencode,
            session_id: placeholder.to_string(),
            session_type: SessionType::Freshopencode,
            cwd: None,
        })
        .await;

        // NO live state was mutated: both map keys stand, the killed flag was
        // never set, the surviving pending marker was never deleted (the
        // delete failed), and the session is untouched.
        {
            let sessions = st.sessions.lock().await;
            assert!(
                sessions.contains_key(placeholder) && sessions.contains_key("ses_1"),
                "a failed durable close must leave the session map untouched"
            );
        }
        assert!(
            !session_arc.lock().await.killed.load(Ordering::SeqCst),
            "a failed durable close must never mark the session killed"
        );
        assert!(
            !fake.retires.lock().unwrap().contains(&("opencode".to_string(), "ses_1".to_string())),
            "sanity: the failed retire recorded nothing"
        );
        assert!(
            fake.pendings
                .lock()
                .unwrap()
                .iter()
                .any(|(p, _, _)| p == placeholder),
            "the pending marker survives (its delete failed)"
        );

        // The answer reports failure (never a success acknowledgement).
        let mut killed_frame = None;
        while let Ok(raw) = rx.try_recv() {
            let frame: serde_json::Value = serde_json::from_str(&raw).unwrap();
            if frame["type"] == "freshAgent.killed" {
                killed_frame = Some(frame);
            }
        }
        let killed_frame = killed_frame.expect("the kill answers freshAgent.killed");
        assert_eq!(
            killed_frame["success"], false,
            "a kill whose durable close failed must report success:false: {killed_frame}"
        );
    }

    /// Delta-r6-r4 (focused-episode-6 round 3, Finding 3), the opencode
    /// lane's PERSISTED class on the pre-lock envelope: the whole identity
    /// set's journal record IS durable although its write reports failure.
    /// The kill must END the session (map removal, killed flag, teardown —
    /// never a live session beside durable close evidence) while the answer
    /// reports `success:false`.
    #[tokio::test]
    async fn a_kill_whose_close_persists_despite_the_reported_error_ends_the_session_and_fails_visibly() {
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let fresh_agent = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx));
        let (manager, _killed) = started_manager().await;
        fresh_agent.set_manager_for_test(manager).await;
        let st = FreshOpencodeState::new(fresh_agent);
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        st.handle_create(create_msg("req-kill-pers"), None).await;
        let placeholder = "freshopencode-req-kill-pers";
        st.handle_send(send_msg(placeholder, "materialize")).await;
        let session_arc = {
            let sessions = st.sessions.lock().await;
            sessions.get(placeholder).expect("session tracked").clone()
        };
        assert_eq!(
            session_arc.lock().await.real_session_id.as_deref(),
            Some("ses_1"),
            "fixture: the send materialized the durable id"
        );
        while rx.try_recv().is_ok() {}

        fake.fail_retires_as_persisted
            .store(true, std::sync::atomic::Ordering::SeqCst);
        st.handle_kill(FreshAgentKill {
            provider: freshell_protocol::AgentProvider::Opencode,
            session_id: placeholder.to_string(),
            session_type: SessionType::Freshopencode,
            cwd: None,
        })
        .await;

        {
            let sessions = st.sessions.lock().await;
            assert!(
                !sessions.contains_key(placeholder) && !sessions.contains_key("ses_1"),
                "the close IS durable: the session ends (never a live session beside close evidence)"
            );
        }
        assert!(
            session_arc.lock().await.killed.load(Ordering::SeqCst),
            "the session was torn down"
        );
        let retires = fake.retires.lock().unwrap().clone();
        for id in [placeholder, "ses_1"] {
            assert!(
                retires.contains(&("opencode".to_string(), id.to_string())),
                "the close's facts are on record for {id}: {retires:?}"
            );
        }
        let mut killed_frame = None;
        while let Ok(raw) = rx.try_recv() {
            let frame: serde_json::Value = serde_json::from_str(&raw).unwrap();
            if frame["type"] == "freshAgent.killed" {
                killed_frame = Some(frame);
            }
        }
        let killed_frame = killed_frame.expect("the kill answers freshAgent.killed");
        assert_eq!(
            killed_frame["success"], false,
            "the kill fails VISIBLY even though the close is durable: {killed_frame}"
        );
    }

    /// Delta-r6 close-durability (the completion pass): the kill's retire set
    /// is derived WITHOUT the session lock (from the map's placeholder/durable
    /// mirror), so a first send that materializes WHILE the kill sits between
    /// its map read and its session-lock phase adds the durable key behind
    /// Delta-r6-r3 (focused-episode-6 round 2, Finding 5): the pre-lock
    /// durable close is ONE envelope call over the WHOLE identity set +
    /// pending markers — never the delta-r6-r2 loop (per-identity retires
    /// and per-placeholder marker deletes before any failure check, whose
    /// earlier successful writes stayed durable over the still-live session
    /// a later failure left behind). The completion retire in the
    /// session-lock phase is separate (single id, post-dating any mid-kill
    /// materialization) — the envelope covers the map-derived set.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_kill_closes_the_whole_identity_set_in_one_envelope_call() {
        let (st, _killed) = state().await;
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        st.handle_create(create_msg("req-kill-one-envelope"), None).await;
        let placeholder = "freshopencode-req-kill-one-envelope";
        st.handle_send(send_msg(placeholder, "materialize")).await;
        let session_arc = {
            let sessions = st.sessions.lock().await;
            sessions.get(placeholder).expect("session tracked").clone()
        };
        assert_eq!(
            session_arc.lock().await.real_session_id.as_deref(),
            Some("ses_1"),
            "fixture: the send materialized the durable id"
        );

        st.handle_kill(FreshAgentKill {
            provider: freshell_protocol::AgentProvider::Opencode,
            session_id: placeholder.to_string(),
            session_type: SessionType::Freshopencode,
            cwd: None,
        })
        .await;

        let batches = fake.retire_batches.lock().unwrap().clone();
        assert_eq!(
            batches.len(),
            1,
            "the pre-lock close is ONE envelope call (no per-identity write loop): {batches:?}"
        );
        let (provider, ids, pendings) = &batches[0];
        assert_eq!(provider, "opencode");
        assert!(ids.contains(&"ses_1".to_string()), "the envelope covers the durable id: {ids:?}");
        // Focused-episode-6 round 3, Finding 1: the placeholder is close
        // evidence too, not only a marker — it belongs in the IDENTITY set of
        // every kill's envelope (a placeholder-claiming retained snapshot
        // verdicts closed only while a standing close fence exists).
        assert!(
            ids.contains(&placeholder.to_string()),
            "the envelope covers the placeholder itself (durable close evidence): {ids:?}"
        );
        assert!(
            pendings.contains(&placeholder.to_string()),
            "the envelope's marker deletes cover the placeholder: {pendings:?}"
        );
    }

    /// Focused-episode-6 round 4 (Finding F6): a materialization that
    /// completes while the kill is PARKED on the session lock (the send's
    /// materialization critical section holds that same lock, so the kill's
    /// enumeration provably post-dates it) joins the ONE envelope — never a
    /// second close call, never a discovered-after-the-envelope identity.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_materialization_completing_behind_the_kills_park_joins_the_one_envelope() {
        let (st, _killed) = state().await;
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        st.handle_create(create_msg("req-kill-mid-mat"), None).await;
        let placeholder = "freshopencode-req-kill-mid-mat";
        let session_arc = {
            let sessions = st.sessions.lock().await;
            sessions.get(placeholder).expect("session tracked").clone()
        };
        assert!(
            session_arc.lock().await.real_session_id.is_none(),
            "fixture: the session has NOT materialized"
        );

        // Hold the session lock: the kill cannot even ENUMERATE until it
        // drops — it parks before its envelope (nothing durable yet).
        let mut session_guard = session_arc.lock().await;
        let st2 = st.clone();
        let ph = placeholder.to_string();
        let mut kill = tokio::spawn(async move {
            st2.handle_kill(FreshAgentKill {
                provider: freshell_protocol::AgentProvider::Opencode,
                session_id: ph,
                session_type: SessionType::Freshopencode,
                cwd: None,
            })
            .await;
        });
        // Let the kill run to its park point (deterministic: it cannot pass
        // the held guard), then the materialization completes behind it.
        tokio::task::yield_now().await;
        session_guard.real_session_id = Some("ses_late".to_string());
        // The mint observed by the enumeration... the gate the kill then
        // arms is what the send half must refuse behind.
        assert_eq!(session_guard.close_pending, 0, "pre-enumeration fixture");
        drop(session_guard);

        tokio::time::timeout(std::time::Duration::from_secs(15), &mut kill)
            .await
            .expect("the kill completes once the hold releases")
            .expect("kill task completed");
        let batches = fake.retire_batches.lock().unwrap().clone();
        assert_eq!(
            batches.len(),
            1,
            "ONE envelope — never a second, discovered-later close call (F6): {batches:?}"
        );
        let (provider, ids, pendings) = &batches[0];
        assert_eq!(provider, "opencode");
        assert!(
            ids.contains(&placeholder.to_string()) && ids.contains(&"ses_late".to_string()),
            "the envelope covers the placeholder AND the mid-kill materialized id: {ids:?}"
        );
        assert!(pendings.contains(&placeholder.to_string()));
        assert_eq!(
            fake.retires
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, id)| id == "ses_late")
                .count(),
            1,
            "ses_late retires exactly once (the envelope's fold, not a second call): {:?}",
            fake.retires.lock().unwrap()
        );
    }

    /// Focused-episode-6 round 4 (Finding F6), the ORDER half: the ONE
    /// envelope — covering the mid-park materialized id — is durable BEFORE
    /// the killed flag is set (which is what makes the kill
    /// cancellation-safe: a task cancel or a failed close BEFORE that flag
    /// can never strand a Bound row behind a destroyed session). The
    /// envelope's answer parks on the retire stall with its mutation landed
    /// — and the flag must still read false.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_one_envelope_is_durable_before_the_killed_flag_is_set() {
        let (st, _killed) = state().await;
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        st.handle_create(create_msg("req-kill-late-order"), None).await;
        let placeholder = "freshopencode-req-kill-late-order";
        let session_arc = {
            let sessions = st.sessions.lock().await;
            sessions.get(placeholder).expect("session tracked").clone()
        };
        let killed_flag = session_arc.lock().await.killed.clone();
        assert!(
            session_arc.lock().await.real_session_id.is_none(),
            "fixture: the session has NOT materialized"
        );

        let stall = fake.arm_retire_stall("opencode", "ses_late");
        let mut session_guard = session_arc.lock().await;
        let st2 = st.clone();
        let ph = placeholder.to_string();
        let mut kill = tokio::spawn(async move {
            st2.handle_kill(FreshAgentKill {
                provider: freshell_protocol::AgentProvider::Opencode,
                session_id: ph,
                session_type: SessionType::Freshopencode,
                cwd: None,
            })
            .await;
        });

        // The kill parks on the held session lock; the mid-park
        // materialization lands behind it, then the hold releases.
        tokio::task::yield_now().await;
        session_guard.real_session_id = Some("ses_late".to_string());
        drop(session_guard);

        stall
            .entered
            .recv_timeout(std::time::Duration::from_secs(15))
            .expect("the one envelope's mutations landed (its answer is parked)");
        assert!(
            !killed_flag.load(Ordering::SeqCst),
            "the killed flag must NOT be set before the whole identity set's close is durable"
        );
        stall.release.send(()).expect("release the stall");
        tokio::time::timeout(std::time::Duration::from_secs(15), &mut kill)
            .await
            .expect("the kill completes")
            .expect("kill task completed");
        assert!(killed_flag.load(Ordering::SeqCst), "post-close the flag stands");
        assert!(
            fake.retires
                .lock()
                .unwrap()
                .contains(&("opencode".to_string(), "ses_late".to_string())),
            "the mid-park id retired in the one envelope"
        );
    }

    /// Focused-episode-6 round 4 (Finding F6), the FAILURE half: the close
    /// covering the COMPLETE identity set (placeholder AND the mid-park
    /// materialized id) fails Clean — the kill ABORTS: NOTHING durable
    /// stands (no placeholder fence to roll back — the one-envelope
    /// construct makes the first/second-close split impossible by
    /// construction; the finding's "placeholder close survives the failed
    /// late close" shape cannot form), the enumeration gate releases, the
    /// killed flag is never set, the map stands, no teardown runs, and the
    /// answer reports `success:false`.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_failed_close_over_the_complete_set_leaves_nothing_durable_and_releases_the_gate() {
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let fresh_agent = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx));
        let (manager, _killed) = started_manager().await;
        fresh_agent.set_manager_for_test(manager).await;
        let st = FreshOpencodeState::new(fresh_agent);
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        st.handle_create(create_msg("req-kill-late-fails"), None).await;
        let placeholder = "freshopencode-req-kill-late-fails";
        let session_arc = {
            let sessions = st.sessions.lock().await;
            sessions.get(placeholder).expect("session tracked").clone()
        };
        let killed_flag = session_arc.lock().await.killed.clone();

        // Identity-conditional failure (F6's honest staging under the
        // one-envelope discipline): the close covering the materialized id
        // fails Clean — the whole envelope fails, nothing of it lands.
        fake.fail_retires_for("opencode", "ses_late");

        let mut session_guard = session_arc.lock().await;
        let st2 = st.clone();
        let ph = placeholder.to_string();
        let mut kill = tokio::spawn(async move {
            st2.handle_kill(FreshAgentKill {
                provider: freshell_protocol::AgentProvider::Opencode,
                session_id: ph,
                session_type: SessionType::Freshopencode,
                cwd: None,
            })
            .await;
        });
        tokio::task::yield_now().await;
        session_guard.real_session_id = Some("ses_late".to_string());
        drop(session_guard);

        tokio::time::timeout(std::time::Duration::from_secs(15), &mut kill)
            .await
            .expect("the kill completes")
            .expect("kill task completed");

        assert!(
            !killed_flag.load(Ordering::SeqCst),
            "a failed envelope aborts BEFORE the kill point of no return: the flag is never set"
        );
        assert_eq!(
            session_arc.lock().await.close_pending,
            0,
            "the enumeration gate released with the abort"
        );
        assert!(
            st.sessions.lock().await.contains_key(placeholder),
            "the map stands — nothing was torn down"
        );
        let retires = fake.retires.lock().unwrap().clone();
        assert!(
            !retires.iter().any(|(_, id)| id == "ses_late" || id == placeholder),
            "NOTHING of the close is durable — no placeholder fence stands to mis-close \
             the preserved live session (F6's exact regression): {retires:?}"
        );
        let mut killed_frame = None;
        while let Ok(raw) = rx.try_recv() {
            let frame: serde_json::Value = serde_json::from_str(&raw).unwrap();
            if frame["type"] == "freshAgent.killed" {
                killed_frame = Some(frame);
            }
        }
        let killed_frame = killed_frame.expect("the kill answers freshAgent.killed");
        assert_eq!(
            killed_frame["success"], false,
            "the kill reports failure: {killed_frame}"
        );
    }

    /// Retire-on-kill round 5 (focused-ep5-r4 Finding 5), the opencode lane:
    /// the claim commit's `Err` (an io failure deciding or writing the
    /// durable transition) left the close untouched (fence stands, row
    /// Closed) — the resume must FAIL instead of registering a live session
    /// over the Closed row.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_claim_commit_error_stops_the_resume_and_leaves_the_close_standing() {
        let (state, mut rx) = state_with_durable_serve_session().await;
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        fake.seed(
            "opencode",
            DURABLE_ID,
            crate::identity_sink::FreshAgentSettings {
                cwd: Some("/w".into()),
                ..crate::identity_sink::FreshAgentSettings::default()
            },
        );
        state.set_identity_sink(fake.clone());

        // The close the user MEANT (before this attach): row Closed + fence.
        state
            .handle_kill(FreshAgentKill {
                provider: AgentProvider::Opencode,
                session_id: DURABLE_ID.to_string(),
                session_type: SessionType::Freshopencode,
                cwd: None,
            })
            .await;
        assert!(
            fake.kill_tombstone_at_ms("opencode", DURABLE_ID).is_some(),
            "fixture: the fence is durable"
        );

        // The commit's io failure knob (Finding 5's shape).
        fake.set_fail_writes(true);
        state.handle_attach(attach_msg(DURABLE_ID)).await;

        let mut saw_resume_failed = false;
        while let Ok(raw) = rx.try_recv() {
            if raw.contains("OPENCODE_ATTACH_RESUME_FAILED") {
                saw_resume_failed = true;
            }
        }
        assert!(
            saw_resume_failed,
            "a commit error must FAIL the resume, never register a live session over a Closed row"
        );
        assert!(
            !state.sessions.lock().await.contains_key(DURABLE_ID),
            "nothing registers when the commit could not run"
        );
        assert_eq!(
            fake.states
                .lock()
                .unwrap()
                .get(&("opencode".to_string(), DURABLE_ID.to_string()))
                .copied(),
            Some(crate::identity_sink::FakeRowState::Closed),
            "the close stands: the row stays Retired"
        );
        assert!(
            fake.kill_tombstone_at_ms("opencode", DURABLE_ID).is_some(),
            "the close stands: the fence was never cleared"
        );
    }

    /// The resurrection gate (the same repair's resolution arm): a send that
    /// holds the session's Arc across the kill — the real client sequence is
    /// "send in flight, pane closed" — must NOT materialize + re-bind a row for
    /// the pane that is going away. The kill marks the session killed inside
    /// its session-lock phase; the send's own critical section sees the flag and
    /// is refused (SESSION_NOT_FOUND, the same answer the map-removed arm gives)
    /// BEFORE any side effect.
    #[tokio::test]
    async fn a_send_against_a_killed_session_is_refused_and_writes_no_binding_row() {
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let fresh_agent = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx));
        let (manager, _killed) = started_manager().await;
        fresh_agent.set_manager_for_test(manager).await;
        let st = FreshOpencodeState::new(fresh_agent);
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        st.handle_create(create_msg("req-killed-gate"), None).await;
        let placeholder = "freshopencode-req-killed-gate";
        let session_arc = {
            let sessions = st.sessions.lock().await;
            sessions.get(placeholder).expect("session tracked").clone()
        };
        // Drive the kill's state reach directly (same-crate white-box seam):
        // what the send must obey is the killed flag the kill sets inside its
        // session-lock phase.
        session_arc.lock().await.killed.store(true, Ordering::SeqCst);

        st.handle_send(send_msg(placeholder, "hi")).await;

        // SESSION_NOT_FOUND through the error channel…
        let frame: serde_json::Value = loop {
            let frame: serde_json::Value =
                serde_json::from_str(&rx.recv().await.expect("a frame")).unwrap();
            if frame["type"] == "error" || frame["type"] == "freshAgent.send.accepted" {
                break frame;
            }
        };
        assert_eq!(
            frame["type"], "error",
            "a send against a killed session is refused, never accepted: {frame}"
        );
        // `send_error` maps to ErrorCode::InternalError with the textual code in
        // the message (the opencode slice's refusal convention, same as the
        // map-removed arm).
        assert_eq!(frame["code"], "INTERNAL_ERROR");
        assert!(
            frame["message"]
                .as_str()
                .is_some_and(|m| m.starts_with("SESSION_NOT_FOUND")),
            "the refusal answers SESSION_NOT_FOUND: {frame}"
        );
        // …and the identity is never re-bound: no materialization, no row.
        assert!(
            session_arc.lock().await.real_session_id.is_none(),
            "the refused send must not materialize the killed session"
        );
        assert!(
            fake.bindings.lock().unwrap().is_empty(),
            "the refused send must not record a binding row: {:?}",
            fake.bindings.lock().unwrap()
        );
    }

    /// Focused-episode-6 round 4 (Finding F6): a send that lands between the
    /// kill's gated enumeration and its durable close is REFUSED — never a
    /// materialization behind the one envelope's back. Driven through the
    /// real lane: the kill's close answer is parked (mutations landed, gate
    /// armed); the send must answer SESSION_NOT_FOUND and record nothing.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_send_is_refused_while_the_kills_close_gate_is_armed() {
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let fresh_agent = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx));
        let (manager, _killed) = started_manager().await;
        fresh_agent.set_manager_for_test(manager).await;
        let st = FreshOpencodeState::new(fresh_agent);
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        st.handle_create(create_msg("req-gate-send"), None).await;
        let placeholder = "freshopencode-req-gate-send";
        let session_arc = {
            let sessions = st.sessions.lock().await;
            sessions.get(placeholder).expect("session tracked").clone()
        };

        // Park the kill inside its one durable close: the gate is armed.
        let stall = fake.arm_retire_stall("opencode", placeholder);
        let st2 = st.clone();
        let mut kill = tokio::spawn(async move {
            st2.handle_kill(FreshAgentKill {
                provider: freshell_protocol::AgentProvider::Opencode,
                session_id: placeholder.to_string(),
                session_type: SessionType::Freshopencode,
                cwd: None,
            })
            .await;
        });
        stall
            .entered
            .recv_timeout(std::time::Duration::from_secs(15))
            .expect("the durable close is in flight (the gate is armed)");

        st.handle_send(send_msg(placeholder, "hi")).await;
        let frame: serde_json::Value = loop {
            let frame: serde_json::Value =
                serde_json::from_str(&rx.recv().await.expect("a frame")).unwrap();
            if frame["type"] == "error" || frame["type"] == "freshAgent.send.accepted" {
                break frame;
            }
        };
        assert_eq!(
            frame["type"], "error",
            "a send under the armed close gate is refused, never accepted: {frame}"
        );
        assert!(
            frame["message"]
                .as_str()
                .is_some_and(|m| m.starts_with("SESSION_NOT_FOUND")),
            "the refusal answers SESSION_NOT_FOUND (the map-removed arm's shape): {frame}"
        );
        assert!(
            session_arc.lock().await.real_session_id.is_none(),
            "the refused send must not materialize behind the envelope"
        );
        assert!(
            fake.bindings.lock().unwrap().is_empty(),
            "the refused send must not record a binding row: {:?}",
            fake.bindings.lock().unwrap()
        );

        stall.release.send(()).expect("release the stall");
        tokio::time::timeout(std::time::Duration::from_secs(15), &mut kill)
            .await
            .expect("the kill completes")
            .expect("kill task completed");
    }

    /// Retire-on-kill round 6 (focused-ep5-r5 Finding 1): the ONE lock rule —
    /// `sessions` is NEVER held across a per-session lock acquisition (clone
    /// the Arc out, drop the map guard, THEN await the session lock). The
    /// finding's deadlock: `handle_kill`'s capture phase held the map guard
    /// while awaiting the session lock, and a first send holds that session
    /// lock across its cold-start `create_session` before re-acquiring the
    /// map to register the materialized key — kill owns the map and waits
    /// for the session, send owns the session and waits for the map. This
    /// test holds the session lock directly (the exact gate the first send's
    /// materialization hold applies, per the struct's lock-order rule) while
    /// a kill runs: the map must stay acquirable THROUGHOUT the kill's
    /// session-lock wait, and the kill must still complete (killed flag set,
    /// map keys removed, `freshAgent.killed` broadcast) once the in-flight
    /// hold releases.
    #[tokio::test]
    async fn handle_kill_never_holds_the_sessions_map_across_its_session_lock_wait() {
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let fresh_agent = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx));
        let (manager, _killed) = started_manager().await;
        fresh_agent.set_manager_for_test(manager).await;
        let st = FreshOpencodeState::new(fresh_agent);
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        st.handle_create(create_msg("req-lock-order"), None).await;
        let placeholder = "freshopencode-req-lock-order";
        let session_arc = {
            let sessions = st.sessions.lock().await;
            sessions.get(placeholder).expect("session tracked").clone()
        };

        // The gate: the test holds the per-session lock, exactly the hold a
        // first send's materialization critical section applies (its
        // `create_session` cold start awaits while the lock is held).
        let session_guard = session_arc.lock().await;

        let st2 = st.clone();
        let ph = placeholder.to_string();
        let mut kill = tokio::spawn(async move {
            st2.handle_kill(FreshAgentKill {
                provider: freshell_protocol::AgentProvider::Opencode,
                session_id: ph,
                session_type: SessionType::Freshopencode,
                cwd: None,
            })
            .await;
        });

        // After one scheduler pass the kill has run to its session-lock
        // park; every observation while it parks there must find the map
        // FREE (the pre-fix shape held the map across this wait — the
        // finding's deadlock half). A bounded yield loop, never a wall-clock
        // sleep: the interleave gate is the session lock itself.
        for _ in 0..8 {
            tokio::task::yield_now().await;
            assert!(
                st.sessions.try_lock().is_ok(),
                "the sessions map must stay acquirable while the kill waits on the session lock"
            );
            assert!(
                !kill.is_finished(),
                "fixture: the kill is still parked on the session lock"
            );
        }

        // Release the in-flight hold: the kill completes its full lane.
        drop(session_guard);
        tokio::time::timeout(std::time::Duration::from_secs(15), &mut kill)
            .await
            .expect("the kill completes once the in-flight hold releases")
            .expect("kill task completed");
        assert!(
            session_arc.lock().await.killed.load(Ordering::SeqCst),
            "the kill's session-lock phase ran (the killed flag is set)"
        );
        assert!(
            st.sessions.lock().await.get(placeholder).is_none(),
            "the map key is removed"
        );
        let mut saw_killed = false;
        while let Ok(raw) = rx.try_recv() {
            if raw.contains("\"freshAgent.killed\"") {
                saw_killed = true;
            }
        }
        assert!(saw_killed, "the kill answers freshAgent.killed");
    }

    /// Finding 1, the kill's TEARDOWN half, re-staged for the round-4 (F6)
    /// topology (the gated one-envelope close precedes the flag phase): the
    /// pre-fix `let mut guard = sessions.lock(); let mut s =
    /// session_arc.lock();` block held the map guard across the session-lock
    /// take. The rule is unchanged — the map guard is NEVER held across a
    /// session-lock acquisition; every map touch is its own synchronous
    /// section. Staged deterministically: the fake sink's retire stall parks
    /// the kill inside its (already-applied) durable close, the test takes
    /// the session lock, and the release lets the kill run to its flag +
    /// field-extraction phase — where its re-acquisition must park on a
    /// FREELY ACQUIRABLE map. The map removal lands after that phase
    /// completes, as its own short section.
    #[tokio::test(flavor = "multi_thread")]
    async fn handle_kill_teardown_never_holds_the_sessions_map_across_its_session_lock_wait() {
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let fresh_agent = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx));
        let (manager, _killed) = started_manager().await;
        fresh_agent.set_manager_for_test(manager).await;
        let st = FreshOpencodeState::new(fresh_agent);
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        st.handle_create(create_msg("req-lock-order-teardown"), None).await;
        let placeholder = "freshopencode-req-lock-order-teardown";
        // Materialize (a first send through the fake serve), so the kill's
        // retire batch has the durable id (`ses_1`) to close.
        st.handle_send(send_msg(placeholder, "materialize")).await;
        let session_arc = {
            let sessions = st.sessions.lock().await;
            sessions.get(placeholder).expect("session tracked").clone()
        };
        assert_eq!(
            session_arc.lock().await.real_session_id.as_deref(),
            Some("ses_1"),
            "fixture: the send materialized the durable id"
        );

        let stall = fake.arm_retire_stall("opencode", "ses_1");
        let st2 = st.clone();
        let ph = placeholder.to_string();
        let mut kill = tokio::spawn(async move {
            st2.handle_kill(FreshAgentKill {
                provider: freshell_protocol::AgentProvider::Opencode,
                session_id: ph,
                session_type: SessionType::Freshopencode,
                cwd: None,
            })
            .await;
        });
        stall
            .entered
            .recv_timeout(std::time::Duration::from_secs(15))
            .expect("the kill parked inside its durable close");
        assert!(
            fake.kill_tombstone_at_ms("opencode", "ses_1") .is_some(),
            "the close is already recorded (the stall only parks the answer)"
        );

        // NOW the test holds the session lock when the kill's session-lock
        // phase needs it; the release moves the kill to that wait. The
        // discriminating observation while it parks there: the map stays
        // FREELY ACQUIRABLE (the kill never holds the map guard across this
        // wait) — the finding's shape (a map guard held across the
        // session-lock wait) fails `try_lock` on every pass. The map removal
        // lands only after the session-lock phase completes, in its own
        // short section. A bounded yield loop, never a wall-clock sleep (the
        // sibling pin's convention): the interleave gate is the session lock
        // itself.
        let session_guard = session_arc.lock().await;
        stall.release.send(()).expect("release the stalled close");
        for _ in 0..8 {
            tokio::task::yield_now().await;
            assert!(
                st.sessions.try_lock().is_ok(),
                "the sessions map must stay acquirable while the kill waits on the \
                 session lock — a map guard held ACROSS the wait is the finding's \
                 deadlock half"
            );
            assert!(
                !kill.is_finished(),
                "fixture: the kill is parked at its session-lock phase"
            );
        }
        drop(session_guard);
        tokio::time::timeout(std::time::Duration::from_secs(15), &mut kill)
            .await
            .expect("the kill completes once the hold releases")
            .expect("kill task completed");
        assert!(st.sessions.lock().await.is_empty(), "both map keys removed");
        let mut saw_killed = false;
        while let Ok(raw) = rx.try_recv() {
            if raw.contains("\"freshAgent.killed\"") {
                saw_killed = true;
            }
        }
        assert!(saw_killed, "the kill answers freshAgent.killed");
    }

    /// Finding 1, the resume-refusal teardown (`resume_durable_session`'s
    /// refused-commit arm): the pre-fix `if let Some(removed) =
    /// self.sessions.lock().await.remove(session_id)` kept the map guard
    /// alive through the whole `if let` body (edition 2021 scrutinee
    /// temporaries) — the map stayed locked across `removed.lock().await`
    /// AND the settle await. Same rule, same probe: the refusal's teardown
    /// must acquire the session lock only after the map guard is gone.
    #[tokio::test(flavor = "multi_thread")]
    async fn resume_refusal_teardown_never_holds_the_sessions_map_across_its_session_lock_wait() {
        let (state, mut rx) = state_with_durable_serve_session().await;
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        fake.seed(
            "opencode",
            DURABLE_ID,
            crate::identity_sink::FreshAgentSettings {
                cwd: Some("/w".into()),
                ..crate::identity_sink::FreshAgentSettings::default()
            },
        );
        state.set_identity_sink(fake.clone());

        // Park the resume AT its commit gate, then advance the fence
        // mid-resume WITHOUT touching the map (a kill that landed before the
        // registration — the refusal arm runs with the session still
        // registered, so its real teardown body is what the probe covers).
        let gate = fake.arm_claim_commit_gate("opencode", DURABLE_ID);
        let st2 = state.clone();
        let mut attach = tokio::spawn(async move { st2.handle_attach(attach_msg(DURABLE_ID)).await });
        gate.entered
            .recv_timeout(std::time::Duration::from_secs(15))
            .expect("the resume reached its commit");
        let session_arc = {
            let sessions = state.sessions.lock().await;
            sessions
                .get(DURABLE_ID)
                .expect("the resume registers before its commit")
                .clone()
        };
        let session_guard = session_arc.lock().await;
        fake.retire_closed("opencode", DURABLE_ID)
            .await
            .expect("the mid-resume close records");
        gate.release.send(()).expect("release the commit decision");

        // Same discriminating probe while the refusal teardown parks on the
        // session lock: the DURABLE_ID key must ALREADY be removed from a
        // FREELY ACQUIRABLE map (the removal is its own synchronous critical
        // section). A guard held across the session-lock take (the finding's
        // `if let` scrutinee shape) fails both halves at once. Deadline-
        // bounded observation, lock-gated interleaving (the test convention).
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        let removed_while_parked = loop {
            if let Ok(map) = state.sessions.try_lock() {
                if !map.contains_key(DURABLE_ID) {
                    break true;
                }
            }
            if tokio::time::Instant::now() >= deadline {
                break false;
            }
            tokio::task::yield_now().await;
        };
        assert!(
            removed_while_parked,
            "the refusal teardown's map removal must run before its session-lock wait — \
             the key was still present (or the map stayed locked) while the lane parked"
        );
        assert!(
            !attach.is_finished(),
            "fixture: the refusal teardown is parked on the session lock"
        );
        drop(session_guard);
        tokio::time::timeout(std::time::Duration::from_secs(15), &mut attach)
            .await
            .expect("the attach completes once the hold releases")
            .expect("attach task completed");

        let mut saw_resume_failed = false;
        while let Ok(raw) = rx.try_recv() {
            if raw.contains("OPENCODE_ATTACH_RESUME_FAILED") {
                saw_resume_failed = true;
            }
        }
        assert!(
            saw_resume_failed,
            "the refused resume fails loudly (never registers over a Closed row)"
        );
        assert!(
            state.sessions.lock().await.get(DURABLE_ID).is_none(),
            "the refusal teardown removed the just-registered session"
        );
        assert!(
            fake.claim_refusals
                .lock()
                .unwrap()
                .contains(&("opencode".to_string(), DURABLE_ID.to_string())),
            "the refusal is positively logged"
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

        st.handle_create(create_msg("req-t3"), None).await;
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
        st.handle_create(create_msg("req-cont"), None).await;
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

        st.handle_create(create_msg("req-attach"), None).await;
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

        st.handle_create(create_msg("req-attach-ph"), None).await;
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

        st.handle_create(create_msg("req-mat"), None).await;
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
        st.handle_create(create_msg("req-kill"), None).await;
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
        state.handle_create(create, None).await;
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
        state.handle_create(create, None).await;
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

    /// D8 lane-reach (restore-open-sessions-only, review round 3): opencode's
    /// binding write happens at MATERIALIZATION (first send), not create — the
    /// create-time connection provenance must survive on the session and reach
    /// the sink write. Optional ledger fields would otherwise let this lane
    /// keep writing `None` silently (and the recovery judgment would then
    /// drop genuinely-open freshopencode sessions).
    #[tokio::test]
    async fn materialization_binding_carries_the_creates_connection_provenance() {
        let (state, _killed) = state().await;
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        state.set_identity_sink(fake.clone());

        let mut create = create_msg("r1");
        create.cwd = Some("/w".to_string());
        state
            .handle_create(
                create,
                Some(crate::BindProvenance::for_create(
                    Some("client-oc"),
                    Some("device-oc"),
                    Some("tab-oc"),
                    7_777,
                )),
            )
            .await;
        state
            .handle_send(send_msg("freshopencode-r1", "hello"))
            .await;

        let bindings = fake.bindings.lock().unwrap();
        let b = bindings
            .iter()
            .find(|b| b.session_id.starts_with("ses_"))
            .expect("binding at materialization");
        assert_eq!(b.asserted_stamps().client_instance_id.as_deref(), Some("client-oc"));
        assert_eq!(b.asserted_stamps().device_id.as_deref(), Some("device-oc"));
        assert_eq!(b.asserted_stamps().tab_key.as_deref(), Some("device-oc:tab-oc"));
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

    /// Focused-ep5-r1 Finding 2 (retire-on-kill round 2), the tombstone
    /// lifecycle's exit on the opencode lane: a kill folds the durable kill
    /// tombstone (the evicted arm — the session map is process memory, the
    /// row is durable), and an EXPLICIT late attach-resume of the same
    /// `ses_*` id GENUINELY CLAIMS it — clearing the tombstone BEFORE the
    /// resume's own refresh write, so the claim's write lands and is never
    /// suppressed as a stale orphan.
    #[tokio::test]
    async fn resume_after_a_kill_clears_the_tombstone_and_rebinds() {
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
        state.set_identity_sink(fake.clone());

        // The close, naming the durable id (the evicted arm of handle_kill —
        // the map never held this session; the row is durable).
        state
            .handle_kill(FreshAgentKill {
                provider: freshell_protocol::AgentProvider::Opencode,
                session_id: DURABLE_ID.to_string(),
                session_type: SessionType::Freshopencode,
                cwd: None,
            })
            .await;
        assert!(
            fake.kill_tombstones
                .lock()
                .unwrap()
                .contains_key(&("opencode".to_string(), DURABLE_ID.to_string())),
            "the kill folded the durable kill tombstone"
        );

        // The explicit late attach-resume (the REAL handle_attach →
        // resume_durable_session lane the fixture drives).
        state.handle_attach(attach_msg(DURABLE_ID)).await;

        assert!(
            fake.claim_commits
                .lock()
                .unwrap()
                .contains(&("opencode".to_string(), DURABLE_ID.to_string())),
            "the genuine claim COMMITS (round 4: fence-clear + revive in one conditional \
             transition) BEFORE its own write"
        );
        assert!(
            !fake
                .kill_tombstones
                .lock()
                .unwrap()
                .contains_key(&("opencode".to_string(), DURABLE_ID.to_string())),
            "the durable fence is gone post-commit"
        );
        let writes = fake
            .bindings
            .lock()
            .unwrap()
            .iter()
            .filter(|b| b.provider == "opencode" && b.session_id == DURABLE_ID)
            .count();
        assert_eq!(
            writes, 2,
            "the seed PLUS the resume's refresh write — the claim's write landed"
        );
        assert!(
            !fake
                .suppressed
                .lock()
                .unwrap()
                .contains(&("opencode".to_string(), DURABLE_ID.to_string())),
            "the claim's own write is never suppressed"
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
            provenance: crate::identity_sink::ProvenanceUpdate::Inherit,
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

    /// Focused-ep5-r2 Finding 4 (retire-on-kill round 3), the headline shape
    /// (`opencode_ws.rs` resume lane): a kill-closed, LINEAGE-ONLY row plus a
    /// CONN-LESS attach — `load_settings` answers None and no connection
    /// provenance exists, so the conditional refresh write is skipped and the
    /// row once stayed Closed forever. A successful attach must record the
    /// row live-again regardless: Bound again, fence cleared, and STILL no
    /// laundered settings write (V7 untouched — revive is not a settings
    /// concern).
    #[tokio::test]
    async fn attach_of_a_killed_lineage_only_session_revives_the_row_without_a_settings_write() {
        let (state, _rx) = state_with_durable_serve_session().await;
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        // The lineage-only seed (blank settings — same construction the Task 3
        // keying test uses).
        fake.record_binding(crate::identity_sink::FreshAgentBindingUpsert {
            provider: "opencode".into(),
            session_id: DURABLE_ID.into(),
            mode: "freshopencode".into(),
            create_request_id: Some("cr-lineage-killed".into()),
            resolves_pending: Some("freshopencode-cr-lineage-killed".into()),
            supersedes: None,
            provenance: crate::identity_sink::ProvenanceUpdate::Inherit,
            settings: crate::identity_sink::FreshAgentSettings::default(),
        })
        .await
        .expect("lineage seed write");
        state.set_identity_sink(fake.clone());
        assert!(
            fake.load_settings("opencode", DURABLE_ID).is_none(),
            "fixture: lineage-only — the refresh gate's skip case"
        );

        // The close: row Closed + fence (the evicted-becomes-live arm is the
        // durable serve session the local map never tracked — retired by name).
        state
            .handle_kill(FreshAgentKill {
                provider: freshell_protocol::AgentProvider::Opencode,
                session_id: DURABLE_ID.to_string(),
                session_type: SessionType::Freshopencode,
                cwd: None,
            })
            .await;
        assert_eq!(
            fake.states
                .lock()
                .unwrap()
                .get(&("opencode".to_string(), DURABLE_ID.to_string()))
                .copied(),
            Some(crate::identity_sink::FakeRowState::Closed),
            "fixture: the kill closed the row"
        );

        // The conn-less attach: the resume rebuilds the live session; the
        // row must follow it back to Bound.
        state.handle_attach(attach_msg(DURABLE_ID)).await;

        assert_eq!(
            fake.states
                .lock()
                .unwrap()
                .get(&("opencode".to_string(), DURABLE_ID.to_string()))
                .copied(),
            Some(crate::identity_sink::FakeRowState::Bound),
            "a successful attach must return the kill-closed row to Bound"
        );
        assert!(
            !fake
                .kill_tombstones
                .lock()
                .unwrap()
                .contains_key(&("opencode".to_string(), DURABLE_ID.to_string())),
            "the claim cleared the fence (inside its one-transition commit)"
        );
        assert!(
            fake.claim_commits
                .lock()
                .unwrap()
                .contains(&("opencode".to_string(), DURABLE_ID.to_string())),
            "the claim's revive fired even though the conditional refresh write was skipped"
        );
        // The V7 gate held: the ONLY bindings entry for the session is the
        // lineage seed — no laundered defaults row was written by the resume.
        assert_eq!(
            fake.bindings
                .lock()
                .unwrap()
                .iter()
                .filter(|b| b.provider == "opencode" && b.session_id == DURABLE_ID)
                .count(),
            1,
            "no laundered settings write for the lineage-only attach"
        );
    }

    /// Focused-ep5-r3 Finding 1 (retire-on-kill round 4), the opencode lane
    /// — including the finding's called-out sub-shape, round 3's
    /// UNCONDITIONAL commit even when the lease failed or the kill had
    /// already removed the newly-registered session: with the user's close
    /// recorded mid-resume, the commit must REFUSE — the row stays Retired,
    /// the newer fence stands, the just-registered session is torn back down
    /// (its kill did that), and no binding write lands. (The fake sink's
    /// claim gate holds the commit's decide point — the deterministic twin
    /// of the ledger guard contended mid-claim.)
    #[tokio::test(flavor = "multi_thread")]
    async fn a_kill_landing_mid_resume_is_never_undone_by_the_claim_commit() {
        let (state, _rx) = state_with_durable_serve_session().await;
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        fake.seed(
            "opencode",
            DURABLE_ID,
            crate::identity_sink::FreshAgentSettings {
                cwd: Some("/w".into()),
                ..crate::identity_sink::FreshAgentSettings::default()
            },
        );
        state.set_identity_sink(fake.clone());

        // The close the user will MEAN: row Closed + fence, before the resume.
        state
            .handle_kill(FreshAgentKill {
                provider: freshell_protocol::AgentProvider::Opencode,
                session_id: DURABLE_ID.to_string(),
                session_type: SessionType::Freshopencode,
                cwd: None,
            })
            .await;
        let claim_start_snapshot = fake.kill_tombstone_at_ms("opencode", DURABLE_ID);
        assert!(claim_start_snapshot.is_some(), "fixture: the fence is durable");

        // Gate the claim's commit, then start the resume.
        let gate = fake.arm_claim_commit_gate("opencode", DURABLE_ID);
        let st2 = state.clone();
        let attach = tokio::spawn(async move {
            st2.handle_attach(attach_msg(DURABLE_ID)).await;
        });

        // The resume reached its commit point (the rebuilt session IS
        // registered at this point on the opencode lane).
        gate.entered
            .recv_timeout(std::time::Duration::from_secs(15))
            .expect("the claim reached its commit");
        assert!(
            state.sessions.lock().await.contains_key(DURABLE_ID),
            "fixture: the rebuilt session registered before the commit"
        );

        // THE INTERLEAVING: the user closes the pane now — the kill removes
        // the newly-registered session AND advances the dead-state before
        // the commit decides.
        state
            .handle_kill(FreshAgentKill {
                provider: freshell_protocol::AgentProvider::Opencode,
                session_id: DURABLE_ID.to_string(),
                session_type: SessionType::Freshopencode,
                cwd: None,
            })
            .await;
        assert_ne!(
            fake.kill_tombstone_at_ms("opencode", DURABLE_ID),
            claim_start_snapshot,
            "fixture: the mid-claim close advanced the durable dead-state"
        );
        assert!(
            !state.sessions.lock().await.contains_key(DURABLE_ID),
            "the kill removed the session mid-claim"
        );
        gate.release.send(()).expect("release the claim decision");
        gate.decided
            .recv_timeout(std::time::Duration::from_secs(15))
            .expect("the commit decided");
        tokio::time::timeout(std::time::Duration::from_secs(15), attach)
            .await
            .expect("the attach resolves")
            .expect("attach task completed");

        // No commit side effect ran: the row stays Retired and the newer
        // fence stands — and the refresh writes never fired.
        assert_eq!(
            fake.states
                .lock()
                .unwrap()
                .get(&("opencode".to_string(), DURABLE_ID.to_string()))
                .copied(),
            Some(crate::identity_sink::FakeRowState::Closed),
            "the claim must never revive the row the newer close retired"
        );
        assert!(
            fake.kill_tombstones
                .lock()
                .unwrap()
                .contains_key(&("opencode".to_string(), DURABLE_ID.to_string())),
            "the newer kill's fence stands — never cleared by the stale claim"
        );
        assert!(
            fake.claim_refusals
                .lock()
                .unwrap()
                .contains(&("opencode".to_string(), DURABLE_ID.to_string())),
            "the refusal is positively logged"
        );
        assert!(
            !fake
                .claim_commits
                .lock()
                .unwrap()
                .contains(&("opencode".to_string(), DURABLE_ID.to_string())),
            "no commit side effect ran"
        );
        assert!(
            !state.sessions.lock().await.contains_key(DURABLE_ID),
            "the orphan session stays torn down"
        );
        let writes = fake
            .bindings
            .lock()
            .unwrap()
            .iter()
            .filter(|b| b.provider == "opencode" && b.session_id == DURABLE_ID)
            .count();
        assert_eq!(
            writes, 1,
            "no refresh binding write landed for the identity the close outranked (the seed alone)"
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
        state.handle_create(create, None).await;

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

    /// Delta-r1 Finding 3: a durable-session resume driven by a CONNECTION-SCOPED
    /// create (`freshAgent.create{sessionRef}` — e.g. a recovery-restored pane in
    /// a NEW tab) must stamp the resume's binding write with the CURRENT
    /// connection's identity/tab, exactly like the normal create lane. Passing
    /// `None`s here would let the keep-when-None merge keep the OLD tab's
    /// attribution (wrong placement data on the next recovery offer), and a
    /// first-time resume would stay unattributed (never offered at all).
    #[tokio::test]
    async fn create_resume_binding_carries_the_current_connections_provenance() {
        let (state, _rx) = state_with_durable_serve_session().await;
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        // The resume refresh write is gated on a recoverable settings record.
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
        state.set_identity_sink(fake.clone());

        let mut create = create_msg("req-resume-prov");
        create.session_ref = Some(freshell_protocol::SessionLocator {
            provider: "opencode".to_string(),
            session_id: DURABLE_ID.to_string(),
        });
        state
            .handle_create(
                create,
                Some(crate::BindProvenance::for_create(
                    Some("client-new"),
                    Some("device-new"),
                    Some("tab-new"),
                    7_777,
                )),
            )
            .await;

        let bindings = fake.bindings.lock().unwrap();
        let b = bindings
            .iter()
            .rev()
            .find(|b| b.session_id == DURABLE_ID)
            .expect("the resume refresh binding write (the seed's stamps are all None)");
        assert_eq!(
            b.asserted_stamps().client_instance_id.as_deref(),
            Some("client-new"),
            "stale/None: the resume must stamp the CURRENT connection"
        );
        assert_eq!(b.asserted_stamps().device_id.as_deref(), Some("device-new"));
        assert_eq!(b.asserted_stamps().tab_key.as_deref(), Some("device-new:tab-new"));
    }

    /// Focused-ep1 Finding A (branch 1 — same-process in-memory hit): a
    /// connection-scoped resume-create (`freshAgent.create{sessionRef}`) for a
    /// session ALREADY live in this process's local map must re-stamp the
    /// CURRENT connection's identity/tab — on the parked in-memory provenance
    /// AND on the ledger row. Otherwise every later per-send refresh write
    /// keeps re-asserting the OLD tab's attribution (the ledger merge's
    /// REPLACE rule then cements the stale tab into the recovery-offer
    /// placement data).
    #[tokio::test]
    async fn create_resume_hitting_the_in_memory_map_restamps_the_current_connections_provenance()
    {
        let (state, _killed) = state().await;
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        state.set_identity_sink(fake.clone());

        // Live, materialized session parked with the OLD connection's stamps
        // (create + first send drive the materialization binding write).
        state
            .handle_create(
                create_msg("r1"),
                Some(crate::BindProvenance::for_create(
                    Some("client-old"),
                    Some("device-old"),
                    Some("tab-old"),
                    7_777,
                )),
            )
            .await;
        state
            .handle_send(send_msg("freshopencode-r1", "hello"))
            .await;
        let durable_id = "ses_1"; // FakeHttp's first POST /session mint
        assert!(
            state.sessions.lock().await.contains_key(durable_id),
            "the materialized session is live in the local map"
        );
        let bindings_before = fake.bindings.lock().unwrap().len();
        assert!(
            bindings_before > 0,
            "materialization already wrote binding rows (stamped OLD)"
        );

        // The resume-create arrives via a DIFFERENT connection (e.g. a
        // recovery-accept into a new tab): the same-process in-memory hit arm.
        let mut create = create_msg("req-resume-in-mem");
        create.session_ref = Some(freshell_protocol::SessionLocator {
            provider: "opencode".to_string(),
            session_id: durable_id.to_string(),
        });
        state
            .handle_create(
                create,
                Some(crate::BindProvenance::for_create(
                    Some("client-new"),
                    Some("device-new"),
                    Some("tab-new"),
                    7_777,
                )),
            )
            .await;

        // The parked in-memory provenance now carries the CURRENT connection…
        {
            let sessions = state.sessions.lock().await;
            let s = sessions.get(durable_id).expect("live session").lock().await;
            let p = s.provenance.clone().expect("parked provenance present");
            assert_eq!(p.client_instance_id.as_deref(), Some("client-new"));
            assert_eq!(p.device_id.as_deref(), Some("device-new"));
            assert_eq!(p.tab_key.as_deref(), Some("device-new:tab-new"));
        }

        // …and the resume itself re-asserted the row with the CURRENT stamps
        // (durable-before-the-created-answer; no send needed)…
        {
            let bindings = fake.bindings.lock().unwrap();
            let b = bindings
                .iter()
                .rev()
                .find(|b| b.session_id == durable_id)
                .expect("the in-memory resume's refresh write");
            assert_eq!(
                b.asserted_stamps().client_instance_id.as_deref(),
                Some("client-new"),
                "the in-memory resume must NOT keep re-asserting the OLD connection"
            );
            assert_eq!(b.asserted_stamps().device_id.as_deref(), Some("device-new"));
            assert_eq!(b.asserted_stamps().tab_key.as_deref(), Some("device-new:tab-new"));
        }

        // …and a SUBSEQUENT per-send refresh write asserts the CURRENT
        // attribution — never the stale tab.
        state.handle_send(send_msg(durable_id, "again")).await;
        let bindings = fake.bindings.lock().unwrap();
        let b = bindings
            .iter()
            .rev()
            .find(|b| b.session_id == durable_id)
            .expect("the post-resume send's refresh write");
        assert_eq!(b.asserted_stamps().client_instance_id.as_deref(), Some("client-new"));
        assert_eq!(b.asserted_stamps().device_id.as_deref(), Some("device-new"));
        assert_eq!(b.asserted_stamps().tab_key.as_deref(), Some("device-new:tab-new"));
    }

    /// Focused-ep1 Finding A (branch 2 — settings-None skip): a
    /// connection-scoped create-resume whose ledger row is LINEAGE-ONLY
    /// (default settings — `load_settings` answers `None`) must STILL re-stamp
    /// the row's provenance to the CURRENT connection: the provenance refresh,
    /// not the settings write, is the point of the resume refresh.
    #[tokio::test]
    async fn create_resume_with_a_lineage_only_row_still_restamps_the_current_connections_provenance()
    {
        let (state, _rx) = state_with_durable_serve_session().await;
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        // A lineage-only row (the "default settings" shape): binding lineage
        // exists, but no settings snapshot is recoverable (`load_settings`
        // answers None). Same fixture as
        // `lineage_only_binding_does_not_arm_settings_reset_on_resume`.
        fake.record_binding(crate::identity_sink::FreshAgentBindingUpsert {
            provider: "opencode".into(),
            session_id: DURABLE_ID.into(),
            mode: "freshopencode".into(),
            create_request_id: Some("cr-lineage".into()),
            resolves_pending: Some("freshopencode-cr-lineage".into()),
            supersedes: None,
            provenance: crate::identity_sink::ProvenanceUpdate::Replace(crate::BindProvenance {
                client_instance_id: Some("client-old".into()),
                device_id: Some("device-old".into()),
                tab_key: Some("device-old:tab-old".into()),
                asserted_at: 7_777,
            }),
            settings: crate::identity_sink::FreshAgentSettings::default(),
        })
        .await
        .expect("lineage binding write ok");
        assert!(
            fake.load_settings("opencode", DURABLE_ID).is_none(),
            "fixture sanity: the settings-None case (lineage-only row)"
        );
        state.set_identity_sink(fake.clone());

        let mut create = create_msg("req-resume-lineage-prov");
        create.session_ref = Some(freshell_protocol::SessionLocator {
            provider: "opencode".to_string(),
            session_id: DURABLE_ID.to_string(),
        });
        state
            .handle_create(
                create,
                Some(crate::BindProvenance::for_create(
                    Some("client-new"),
                    Some("device-new"),
                    Some("tab-new"),
                    7_777,
                )),
            )
            .await;

        let bindings = fake.bindings.lock().unwrap();
        let b = bindings
            .iter()
            .rev()
            .find(|b| b.session_id == DURABLE_ID)
            .expect("the settings-None resume's provenance refresh write");
        assert_eq!(
            b.asserted_stamps().client_instance_id.as_deref(),
            Some("client-new"),
            "the provenance refresh must not be gated on settings presence"
        );
        assert_eq!(b.asserted_stamps().device_id.as_deref(), Some("device-new"));
        assert_eq!(b.asserted_stamps().tab_key.as_deref(), Some("device-new:tab-new"));
        // Settings merge stays as-is: no recoverable snapshot ⇒ the write
        // carries a blank (replace-no-op) settings payload — never invented
        // defaults, and the row stays lineage-only.
        assert_eq!(
            b.settings,
            crate::identity_sink::FreshAgentSettings::default(),
            "the settings payload is untouched by the provenance refresh"
        );
    }

    /// The paired never-invert arm (delta-r1 Finding 3): a resume with NO
    /// connection identity available (the conn-less attach lane) keeps `None`
    /// stamps on its refresh write, so the ledger's keep-when-None merge
    /// preserves whatever the original create stamped.
    #[tokio::test]
    async fn attach_resume_binding_keeps_none_stamps_for_ledger_inheritance() {
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
        state.set_identity_sink(fake.clone());

        state.handle_attach(attach_msg(DURABLE_ID)).await;

        let bindings = fake.bindings.lock().unwrap();
        let b = bindings
            .iter()
            .rev()
            .find(|b| b.session_id == DURABLE_ID)
            .expect("the attach-resume refresh binding write");
        assert_eq!(b.asserted_stamps().client_instance_id, None);
        assert_eq!(b.asserted_stamps().device_id, None);
        assert_eq!(b.asserted_stamps().tab_key, None);
    }

    /// Focused-ep1-r3 (the parking invariant): a COLD durable resume driven by a
    /// connection-scoped create (`freshAgent.create{sessionRef}` with the local
    /// map empty — the post-restart recovery-accept shape) must PARK the resume
    /// connection's provenance on the reconstructed session before insertion.
    /// Every downstream writer (the per-send refresh, the fork consumer's
    /// `session.provenance` read) asserts the CURRENT attribution from the
    /// parked value — parking nothing leaves the session permanently orphaned
    /// from the connection that provably has it open.
    #[tokio::test]
    async fn cold_resume_parks_the_resume_connections_provenance_on_the_session() {
        let (state, _rx) = state_with_durable_serve_session().await;

        let mut create = create_msg("req-cold-park");
        create.session_ref = Some(freshell_protocol::SessionLocator {
            provider: "opencode".to_string(),
            session_id: DURABLE_ID.to_string(),
        });
        state
            .handle_create(
                create,
                Some(crate::BindProvenance::for_create(
                    Some("client-cold"),
                    Some("device-cold"),
                    Some("tab-cold"),
                    7_777,
                )),
            )
            .await;

        let sessions = state.sessions.lock().await;
        let s = sessions
            .get(DURABLE_ID)
            .expect("the cold resume registered the session")
            .lock()
            .await;
        let p = s
            .provenance
            .clone()
            .expect("the cold-resume construction parks the resume connection's provenance");
        assert_eq!(p.client_instance_id.as_deref(), Some("client-cold"));
        assert_eq!(p.device_id.as_deref(), Some("device-cold"));
        assert_eq!(p.tab_key.as_deref(), Some("device-cold:tab-cold"));
    }

    /// Focused-ep1-r3, the confirmed finding's D8 consumer chain: cold-resume a
    /// durable session over a stamped connection, then FORK it. The child
    /// binding row must carry the RESUME connection's identity/tab (the fork
    /// inherits the parent's parked provenance) — a `None`-stamped child row is
    /// unattributed and `recovery_inventory`'s parent-relative keep drops the
    /// genuinely-open fork child from the recovery offer.
    #[tokio::test]
    async fn cold_resume_then_fork_child_row_carries_the_resume_connections_provenance() {
        let (state, _rx) = state_with_durable_serve_session().await;
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        state.set_identity_sink(fake.clone());

        let mut create = create_msg("req-cold-chain");
        create.session_ref = Some(freshell_protocol::SessionLocator {
            provider: "opencode".to_string(),
            session_id: DURABLE_ID.to_string(),
        });
        state
            .handle_create(
                create,
                Some(crate::BindProvenance::for_create(
                    Some("client-chain"),
                    Some("device-chain"),
                    Some("tab-chain"),
                    7_777,
                )),
            )
            .await;

        let (sink, captured) = capturing_sink();
        state
            .handle_fork(fork_msg(DURABLE_ID, "fork-req-cold-chain", None), None, sink)
            .await;
        let frames = captured.lock().expect("captured mutex").clone();
        let child_id = match frames.as_slice() {
            [ServerMessage::FreshAgentForked(FreshAgentForked { session_id, .. })] => {
                session_id.clone()
            }
            other => panic!("exactly one forked reply on the requesting sink: {other:?}"),
        };
        assert_ne!(child_id, DURABLE_ID, "the fork mints a fresh child id");

        // The child SESSION parks the same stamps (a fork-of-fork stays
        // attributed — the chain is connection > session > child rows).
        {
            let sessions = state.sessions.lock().await;
            let c = sessions
                .get(&child_id)
                .expect("the fork child is registered")
                .lock()
                .await;
            let p = c
                .provenance
                .clone()
                .expect("the fork child parks the parent's provenance");
            assert_eq!(p.client_instance_id.as_deref(), Some("client-chain"));
            assert_eq!(p.device_id.as_deref(), Some("device-chain"));
            assert_eq!(p.tab_key.as_deref(), Some("device-chain:tab-chain"));
        }

        // …and the child's ledger ROW asserts the same attribution (never the
        // unattributed row the D8 judgment drops).
        let bindings = fake.bindings.lock().unwrap();
        let b = bindings
            .iter()
            .find(|b| b.session_id == child_id)
            .expect("a binding row for the forked child");
        assert_eq!(
            b.asserted_stamps().client_instance_id.as_deref(),
            Some("client-chain"),
            "the child row must carry the RESUME connection's identity, not None"
        );
        assert_eq!(b.asserted_stamps().device_id.as_deref(), Some("device-chain"));
        assert_eq!(b.asserted_stamps().tab_key.as_deref(), Some("device-chain:tab-chain"));
    }

    /// The paired never-invent pin (session-level twin of
    /// [`attach_resume_binding_keeps_none_stamps_for_ledger_inheritance`]): the
    /// conn-less cold resume (the attach lane carries no tab identity) parks
    /// NOTHING on the reconstructed session, so later conn-less refresh lanes
    /// keep the ledger's prior stamps instead of asserting an invention.
    #[tokio::test]
    async fn attach_resume_parks_no_provenance_on_the_reconstructed_session() {
        let (state, _rx) = state_with_durable_serve_session().await;
        state.handle_attach(attach_msg(DURABLE_ID)).await;

        let sessions = state.sessions.lock().await;
        let s = sessions
            .get(DURABLE_ID)
            .expect("the attach-resume registered the session")
            .lock()
            .await;
        assert_eq!(
            s.provenance, None,
            "a conn-less resume invents no provenance (None stays parked)"
        );
    }

    /// Focused-ep1-r4 Finding 2 (the parking invariant's durable half): the
    /// CONN-LESS cold attach (`freshAgent.attach` — no tab identity on the
    /// wire) of a session the local map has never heard of must seed the
    /// parked provenance from the DURABLE row's stamps — the authoritative
    /// record of where this session last lived. A fork of the attached
    /// session (before any snapshot) then produces an ATTRIBUTED child row on
    /// its NEW ledger key, where keep-when-None cannot rescue a `None` park.
    #[tokio::test]
    async fn attach_resume_seeds_the_durable_rows_provenance_and_fork_inherits_it() {
        let (state, _rx) = state_with_durable_serve_session().await;
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        // The durable row from the pre-restart connection: settings + stamps.
        fake.record_binding(crate::identity_sink::FreshAgentBindingUpsert {
            provider: "opencode".into(),
            session_id: DURABLE_ID.into(),
            mode: "freshopencode".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: crate::identity_sink::ProvenanceUpdate::Replace(crate::BindProvenance {
                client_instance_id: Some("client-row".into()),
                device_id: Some("device-row".into()),
                tab_key: Some("device-row:tab-row".into()),
                asserted_at: 7_777,
            }),
            settings: crate::identity_sink::FreshAgentSettings {
                model: Some("big-model".into()),
                sandbox: None,
                permission_mode: None,
                effort: Some("high".into()),
                cwd: Some("/real/project".into()),
            },
        })
        .await
        .expect("seed binding write ok");
        state.set_identity_sink(fake.clone());

        state.handle_attach(attach_msg(DURABLE_ID)).await;

        // The reconstructed session parks the ROW's stamps…
        {
            let sessions = state.sessions.lock().await;
            let s = sessions
                .get(DURABLE_ID)
                .expect("the attach-resume registered the session")
                .lock()
                .await;
            let p = s
                .provenance
                .clone()
                .expect("the conn-less cold attach seeds the parked provenance from the durable row");
            assert_eq!(p.client_instance_id.as_deref(), Some("client-row"));
            assert_eq!(p.device_id.as_deref(), Some("device-row"));
            assert_eq!(p.tab_key.as_deref(), Some("device-row:tab-row"));
        }

        // …so a fork of the attached session (the D8 consumer the finding
        // names: the fork child has a NEW ledger key where keep-when-None
        // cannot rescue a None park) writes an attributed child row.
        let (sink, captured) = capturing_sink();
        state
            .handle_fork(fork_msg(DURABLE_ID, "fork-req-row-seed", None), None, sink)
            .await;
        let frames = captured.lock().expect("captured mutex").clone();
        let child_id = match frames.as_slice() {
            [ServerMessage::FreshAgentForked(FreshAgentForked { session_id, .. })] => {
                session_id.clone()
            }
            other => panic!("exactly one forked reply on the requesting sink: {other:?}"),
        };
        {
            let sessions = state.sessions.lock().await;
            let c = sessions
                .get(&child_id)
                .expect("the fork child is registered")
                .lock()
                .await;
            let p = c
                .provenance
                .clone()
                .expect("the fork child parks the row-seeded provenance");
            assert_eq!(p.client_instance_id.as_deref(), Some("client-row"));
            assert_eq!(p.device_id.as_deref(), Some("device-row"));
            assert_eq!(p.tab_key.as_deref(), Some("device-row:tab-row"));
        }
        let bindings = fake.bindings.lock().unwrap();
        let b = bindings
            .iter()
            .find(|b| b.session_id == child_id)
            .expect("a binding row for the forked child");
        assert_eq!(
            b.asserted_stamps().client_instance_id.as_deref(),
            Some("client-row"),
            "the child row inherits the row-seeded provenance, not a fork-time None"
        );
        assert_eq!(b.asserted_stamps().device_id.as_deref(), Some("device-row"));
        assert_eq!(b.asserted_stamps().tab_key.as_deref(), Some("device-row:tab-row"));
    }

    /// The paired never-invent pin (Finding 2's second arm): a conn-less cold
    /// attach of a session whose durable row is GENUINELY UNATTRIBUTED (all
    /// stamps None) parks NOTHING — never invented — and the conn-less refresh
    /// write keeps its None stamps so the ledger merge preserves exactly what
    /// the row had (nothing).
    #[tokio::test]
    async fn attach_resume_with_a_genuinely_unattributed_row_parks_none() {
        let (state, _rx) = state_with_durable_serve_session().await;
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        // A settings-bearing row with NO stamps (an explicit upsert, not the
        // seed helper, so the row unambiguously has them unset).
        fake.record_binding(crate::identity_sink::FreshAgentBindingUpsert {
            provider: "opencode".into(),
            session_id: DURABLE_ID.into(),
            mode: "freshopencode".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: crate::identity_sink::ProvenanceUpdate::Inherit,
            settings: crate::identity_sink::FreshAgentSettings {
                model: Some("big-model".into()),
                sandbox: None,
                permission_mode: None,
                effort: Some("high".into()),
                cwd: Some("/real/project".into()),
            },
        })
        .await
        .expect("seed binding write ok");
        state.set_identity_sink(fake.clone());

        state.handle_attach(attach_msg(DURABLE_ID)).await;

        {
            let sessions = state.sessions.lock().await;
            let s = sessions
                .get(DURABLE_ID)
                .expect("the attach-resume registered the session")
                .lock()
                .await;
            assert_eq!(
                s.provenance, None,
                "a genuinely unattributed row seeds nothing — never invented"
            );
        }
        let bindings = fake.bindings.lock().unwrap();
        let b = bindings
            .iter()
            .rev()
            .find(|b| b.session_id == DURABLE_ID)
            .expect("the attach-resume refresh write (settings recovered)");
        assert_eq!(b.asserted_stamps().client_instance_id, None, "never write invented stamps");
        assert_eq!(b.asserted_stamps().device_id, None);
        assert_eq!(b.asserted_stamps().tab_key, None);
    }

    /// Focused-ep1-r5 Finding 1 (Major — fork stamps from the FORKING
    /// connection): parked provenance is shared across the globally-shared
    /// session, so under forceNew multi-tab a fork from tab B must stamp the
    /// child with TAB B's identity — never the parent's parked (tab A's
    /// most-recent) attribution. A fork is always connection-initiated, so
    /// the forking connection's provenance wins over the parked value and
    /// the durable row alike.
    #[tokio::test]
    async fn fork_stamps_the_child_from_the_forking_connection_over_the_stale_park() {
        let (state, _rx) = state_with_durable_serve_session().await;
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        state.set_identity_sink(fake.clone());

        // Tab A's connection cold-resumes the session (parks + rows A).
        let mut create = create_msg("req-stale-park-a");
        create.session_ref = Some(freshell_protocol::SessionLocator {
            provider: "opencode".to_string(),
            session_id: DURABLE_ID.to_string(),
        });
        state
            .handle_create(
                create,
                Some(crate::BindProvenance::for_create(
                    Some("client-a"),
                    Some("device-a"),
                    Some("tab-a"),
                    7_777,
                )),
            )
            .await;

        // The fork is issued over TAB B's connection.
        let (sink, captured) = capturing_sink();
        state
            .handle_fork(
                fork_msg(DURABLE_ID, "fork-req-b", None),
                Some(crate::BindProvenance::for_create(
                    Some("client-b"),
                    Some("device-b"),
                    Some("tab-b"),
                    7_777,
                )),
                sink,
            )
            .await;
        let frames = captured.lock().expect("captured mutex").clone();
        let child_id = match frames.as_slice() {
            [ServerMessage::FreshAgentForked(FreshAgentForked { session_id, .. })] => {
                session_id.clone()
            }
            other => panic!("exactly one forked reply on the requesting sink: {other:?}"),
        };

        // The child SESSION parks the forking connection's stamps…
        {
            let sessions = state.sessions.lock().await;
            let c = sessions
                .get(&child_id)
                .expect("the fork child is registered")
                .lock()
                .await;
            let p = c
                .provenance
                .clone()
                .expect("the child parks the FORKING connection's provenance, not the stale park");
            assert_eq!(p.client_instance_id.as_deref(), Some("client-b"));
            assert_eq!(p.device_id.as_deref(), Some("device-b"));
            assert_eq!(p.tab_key.as_deref(), Some("device-b:tab-b"));
        }

        // …and the child ROW asserts the same.
        let bindings = fake.bindings.lock().unwrap();
        let b = bindings
            .iter()
            .find(|b| b.session_id == child_id)
            .expect("a binding row for the forked child");
        assert_eq!(
            b.asserted_stamps().client_instance_id.as_deref(),
            Some("client-b"),
            "the fork child row stamps the FORKING connection, not the parent's stale park"
        );
        assert_eq!(b.asserted_stamps().device_id.as_deref(), Some("device-b"));
        assert_eq!(b.asserted_stamps().tab_key.as_deref(), Some("device-b:tab-b"));
    }

    /// Focused-ep1-r5 Finding 1, precedence tail + Finding 2's fork arm in
    /// one: a fork whose connection provenance is HOLLOW (a partially
    /// initialized client's hello — all fields absent) behaves like None, and
    /// with a parent that parks nothing the child stamps fall back to the
    /// parent's DURABLE ROW (the last source that knows the attribution).
    #[tokio::test]
    async fn fork_falls_back_to_the_durable_row_when_the_fork_connection_is_hollow_and_the_park_is_empty()
     {
        let (state, _rx) = state_with_durable_serve_session().await;
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        // The parent's durable row knows the attribution (lineage-only
        // payload: no settings ride the seed).
        fake.record_binding(crate::identity_sink::FreshAgentBindingUpsert {
            provider: "opencode".into(),
            session_id: DURABLE_ID.into(),
            mode: "freshopencode".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: crate::identity_sink::ProvenanceUpdate::Replace(crate::BindProvenance {
                client_instance_id: Some("client-row".into()),
                device_id: Some("device-row".into()),
                tab_key: Some("device-row:tab-row".into()),
                asserted_at: 7_777,
            }),
            settings: crate::identity_sink::FreshAgentSettings::default(),
        })
        .await
        .expect("row stamp write ok");
        state.set_identity_sink(fake.clone());
        // …but the local session parks NOTHING (a conn-less construction the
        // row seeding never reached).
        insert_fork_parent(&state, DURABLE_ID, Some("/serve/dir"), None, None).await;

        let (sink, captured) = capturing_sink();
        state
            .handle_fork(
                fork_msg(DURABLE_ID, "fork-req-hollow", None),
                // HOLLOW: the forking connection's hello carried no
                // device/client fields — must NOT blank out the row's stamps.
                Some(crate::BindProvenance::default()),
                sink,
            )
            .await;
        let frames = captured.lock().expect("captured mutex").clone();
        let child_id = match frames.as_slice() {
            [ServerMessage::FreshAgentForked(FreshAgentForked { session_id, .. })] => {
                session_id.clone()
            }
            other => panic!("exactly one forked reply on the requesting sink: {other:?}"),
        };

        {
            let sessions = state.sessions.lock().await;
            let c = sessions
                .get(&child_id)
                .expect("the fork child is registered")
                .lock()
                .await;
            let p = c
                .provenance
                .clone()
                .expect("the child parks the durable row's stamps (hollow connection, empty park)");
            assert_eq!(p.client_instance_id.as_deref(), Some("client-row"));
            assert_eq!(p.device_id.as_deref(), Some("device-row"));
            assert_eq!(p.tab_key.as_deref(), Some("device-row:tab-row"));
        }
        let bindings = fake.bindings.lock().unwrap();
        let b = bindings
            .iter()
            .find(|b| b.session_id == child_id)
            .expect("a binding row for the forked child");
        assert_eq!(
            b.asserted_stamps().client_instance_id.as_deref(),
            Some("client-row"),
            "the child row falls back to the parent's durable row stamps, not a hollow None"
        );
        assert_eq!(b.asserted_stamps().device_id.as_deref(), Some("device-row"));
        assert_eq!(b.asserted_stamps().tab_key.as_deref(), Some("device-row:tab-row"));
    }

    /// Focused-ep1-r5 Finding 2 (the cold-resume park, `resume_durable_session`):
    /// a connection-scoped resume-create carrying a HOLLOW provenance behaves
    /// like None — the row seed (not the hollow value) is what gets parked,
    /// and the refresh gate does not fire on hollow alone (parked/row truth
    /// is never replaced with nothing).
    #[tokio::test]
    async fn hollow_cold_resume_falls_back_to_the_row_seed_and_writes_nothing() {
        let (state, _rx) = state_with_durable_serve_session().await;
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        // A stamped LINEAGE-ONLY row (blank settings): the only gate driver
        // here would be the provenance — exactly Finding 2's shape.
        fake.record_binding(crate::identity_sink::FreshAgentBindingUpsert {
            provider: "opencode".into(),
            session_id: DURABLE_ID.into(),
            mode: "freshopencode".into(),
            create_request_id: Some("cr-row".into()),
            resolves_pending: None,
            supersedes: None,
            provenance: crate::identity_sink::ProvenanceUpdate::Replace(crate::BindProvenance {
                client_instance_id: Some("client-row".into()),
                device_id: Some("device-row".into()),
                tab_key: Some("device-row:tab-row".into()),
                asserted_at: 7_777,
            }),
            settings: crate::identity_sink::FreshAgentSettings::default(),
        })
        .await
        .expect("seed binding write ok");
        state.set_identity_sink(fake.clone());

        let mut create = create_msg("req-hollow-cold");
        create.session_ref = Some(freshell_protocol::SessionLocator {
            provider: "opencode".to_string(),
            session_id: DURABLE_ID.to_string(),
        });
        state
            .handle_create(create, Some(crate::BindProvenance::default()))
            .await;

        {
            let sessions = state.sessions.lock().await;
            let s = sessions
                .get(DURABLE_ID)
                .expect("the cold resume registered the session")
                .lock()
                .await;
            let p = s
                .provenance
                .clone()
                .expect("a hollow resume parks the ROW seed, not the hollow value");
            assert_eq!(p.client_instance_id.as_deref(), Some("client-row"));
            assert_eq!(p.device_id.as_deref(), Some("device-row"));
            assert_eq!(p.tab_key.as_deref(), Some("device-row:tab-row"));
        }
        let bindings = fake.bindings.lock().unwrap();
        assert_eq!(
            bindings.iter().filter(|b| b.session_id == DURABLE_ID).count(),
            1,
            "a hollow provenance does not fire the refresh gate (only the seed row exists)"
        );
    }

    /// Focused-ep1-r5 Finding 2 (the named `opencode_ws.rs:677` gate): an
    /// in-memory resume-create hit carrying a HOLLOW provenance keeps the
    /// parked Some EXACTLY and writes nothing — hollow behaves like None.
    #[tokio::test]
    async fn hollow_in_memory_resume_keeps_the_parked_stamps_and_writes_nothing() {
        let (state, _rx) = state_with_durable_serve_session().await;
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        state.set_identity_sink(fake.clone());

        // First create: tab A's connection cold-resumes (parks + rows A).
        let mut first = create_msg("req-mem-a");
        first.session_ref = Some(freshell_protocol::SessionLocator {
            provider: "opencode".to_string(),
            session_id: DURABLE_ID.to_string(),
        });
        state
            .handle_create(
                first,
                Some(crate::BindProvenance::for_create(
                    Some("client-mem"),
                    Some("device-mem"),
                    Some("tab-mem"),
                    7_777,
                )),
            )
            .await;
        let rows_before = fake
            .bindings
            .lock()
            .unwrap()
            .iter()
            .filter(|b| b.session_id == DURABLE_ID)
            .count();

        // The partially-initialized client's resume hits the in-memory map:
        // hollow Some.
        let mut second = create_msg("req-mem-hollow");
        second.session_ref = Some(freshell_protocol::SessionLocator {
            provider: "opencode".to_string(),
            session_id: DURABLE_ID.to_string(),
        });
        state
            .handle_create(second, Some(crate::BindProvenance::default()))
            .await;

        {
            let sessions = state.sessions.lock().await;
            let s = sessions
                .get(DURABLE_ID)
                .expect("the session stays")
                .lock()
                .await;
            let p = s
                .provenance
                .clone()
                .expect("a hollow in-memory resume must NOT regress the parked Some");
            assert_eq!(p.client_instance_id.as_deref(), Some("client-mem"));
            assert_eq!(p.device_id.as_deref(), Some("device-mem"));
            assert_eq!(p.tab_key.as_deref(), Some("device-mem:tab-mem"));
        }
        let bindings = fake.bindings.lock().unwrap();
        assert_eq!(
            bindings.iter().filter(|b| b.session_id == DURABLE_ID).count(),
            rows_before,
            "a hollow in-memory resume writes nothing (like the conn-less resume)"
        );
    }

    /// Focused-ep1-r5 Finding 2 (the create-lane park): a create carrying a
    /// HOLLOW connection provenance parks NOTHING on the placeholder — never
    /// a hollow Some that downstream readers would treat as truth.
    #[tokio::test]
    async fn hollow_create_provenance_parks_nothing() {
        let http = Arc::new(ForkFakeHttp::child_ok());
        let st = fork_state(http).await;
        st.handle_create(
            create_msg("req-hollow-park"),
            Some(crate::BindProvenance::default()),
        )
        .await;

        let sessions = st.sessions.lock().await;
        let s = sessions
            .get("freshopencode-req-hollow-park")
            .expect("the placeholder session")
            .lock()
            .await;
        assert_eq!(
            s.provenance, None,
            "a hollow hello parks None — never a hollow Some"
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

        st.handle_create(create_msg("req-clean"), None).await;
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

        st.handle_create(create_msg("req-int"), None).await;
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

        st.handle_create(create_msg("req-err"), None).await;
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

    /// How the fake answers `POST /session/:id/summarize` (ep1-r3 F2's
    /// delivery-truth distinction).
    #[derive(Clone, Copy, PartialEq)]
    enum SummarizeOutcome {
        /// The POST is received (recorded + order-pinned), then answered 200.
        OkAnswered,
        /// The POST is received (recorded), then answered 500 — an
        /// error-after-send outcome: OpenCode ≥1.18.21's summarize runs
        /// `revertSvc.cleanup` FIRST, so this is a POSSIBLY-destroyed tail.
        Answered500,
        /// The POST never exists server-side: the refusal is answered WITHOUT
        /// recording the request — modeling a connect-phase refusal before a
        /// byte left (the provably-undelivered leg).
        Undelivered,
    }

    /// The compact-suite serve fake: records EVERY request, scripts `/config`, scripts
    /// summarize per [`SummarizeOutcome`], and re-arms a per-session busy budget (two
    /// polls) on every
    /// `prompt_async`/`summarize` POST so `await_idle`'s status-poll fallback resolves
    /// deterministically. `summarize` additionally pins the reviewed lifecycle ORDER:
    /// drained synchronously from its own bus probe, the LAST session snapshot before
    /// the POST must be the busy `running` one (the busy indicator is visible before
    /// the upstream request settles).
    struct CompactFakeHttp {
        next_session: AtomicUsize,
        requests: StdMutex<Vec<RecordedRequest>>,
        busy_budget: StdMutex<std::collections::HashMap<String, usize>>,
        summarize_outcome: SummarizeOutcome,
        config_body: Vec<u8>,
        bus_probe: StdMutex<tokio::sync::broadcast::Receiver<String>>,
        /// D1-F1: when set, the summarize POST parks on `notified()` AFTER
        /// recording itself + the order pin — a deterministic "compact in
        /// flight" window for the kill/interrupt lifecycle tests.
        summarize_gate: Option<Arc<tokio::sync::Notify>>,
        /// ep4-r5: when set, the `/global/health` GET parks on `notified()` —
        /// a deterministic "serve cold-start in progress" window (the compact
        /// drive's `ensure_started` waits INSIDE it, pre-POST).
        health_gate: Option<Arc<tokio::sync::Notify>>,
    }

    impl CompactFakeHttp {
        fn new(
            config_body: Vec<u8>,
            summarize_outcome: SummarizeOutcome,
            bus_probe: tokio::sync::broadcast::Receiver<String>,
            summarize_gate: Option<Arc<tokio::sync::Notify>>,
            health_gate: Option<Arc<tokio::sync::Notify>>,
        ) -> Self {
            Self {
                next_session: AtomicUsize::new(0),
                requests: StdMutex::new(Vec::new()),
                busy_budget: StdMutex::new(std::collections::HashMap::new()),
                summarize_outcome,
                config_body,
                bus_probe: StdMutex::new(bus_probe),
                summarize_gate,
                health_gate,
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
            Box<
                dyn std::future::Future<Output = Result<ServeHttpResponse, ServeHttpError>>
                    + Send
                    + 'a,
            >,
        > {
            let method = format!("{:?}", req.method).to_uppercase();
            let body_value = req
                .body
                .as_ref()
                .and_then(|b| serde_json::from_slice::<Value>(b).ok());
            // ep1-r3 F2: the provably-UNDELIVERED leg answers BEFORE any
            // recording — `requests` IS the "the POST was received" witness,
            // and this refusal models a connect-phase refusal where the bytes
            // never left the client.
            if method == "POST"
                && req.url.contains("/summarize")
                && self.summarize_outcome == SummarizeOutcome::Undelivered
            {
                return Box::pin(async {
                    Err(ServeHttpError::Undelivered(
                        "connect refused before a byte left".to_string(),
                    ))
                });
            }
            self.requests
                .lock()
                .expect("requests mutex")
                .push(RecordedRequest {
                    method: method.clone(),
                    url: req.url.clone(),
                    body: body_value,
                });

            if req.url.contains("/global/health") {
                let gate = self.health_gate.clone();
                return Box::pin(async move {
                    if let Some(gate) = gate {
                        gate.notified().await;
                    }
                    Ok(ServeHttpResponse::new(200, b"{}".to_vec()))
                });
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
                if self.summarize_outcome == SummarizeOutcome::Answered500 {
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
        summarize_outcome: SummarizeOutcome,
    ) -> (
        FreshOpencodeState,
        Arc<CompactFakeHttp>,
        tokio::sync::broadcast::Receiver<String>,
    ) {
        compact_state_gated(config_body, summarize_outcome, None).await
    }

    /// [`compact_state`] with an optional summarize gate (D1-F1: a deterministic
    /// in-flight-compact window for the kill/interrupt lifecycle tests).
    async fn compact_state_gated(
        config_body: &str,
        summarize_outcome: SummarizeOutcome,
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
            summarize_outcome,
            tx.subscribe(),
            summarize_gate,
            None,
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
        let (st, http, mut rx) =
            compact_state(r#"{"model":null}"#, SummarizeOutcome::OkAnswered).await;
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

    /// Seed a redo-capable rollback record for `session_id` (one user+assistant
    /// step undid at t2; redo live) and return the fake sink.
    async fn seed_redoable_record(
        st: &FreshOpencodeState,
        session_id: &str,
    ) -> std::sync::Arc<crate::identity_sink::FakeIdentitySink> {
        let sink = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(sink.clone());
        crate::identity_sink::PaneIdentitySink::record_rollback(
            sink.as_ref(),
            PROVIDER,
            session_id,
            {
                let mut record = RollbackRecord::empty(1);
                record.splice_undo_entry(
                    RollbackEntry {
                        removed_turns: vec![
                            RollbackFakeHttp::marker_turn("msg_u2", "user", "prompt two"),
                            RollbackFakeHttp::marker_turn("msg_a2", "assistant", "answer two"),
                        ],
                        prompt_text: "prompt two".to_string(),
                        at_ms: 1,
                        epoch: 0,
                    },
                    1,
                );
                record.set_can_redo(true, 1);
                record
            },
        )
        .await
        .expect("seed a redo-capable record (undo at t2)");
        sink
    }

    /// Focused-review ep1-r2 F4: the redo destroy runs PRE-DRIVE — once the
    /// preflight succeeded, before the summarize drive exists. While the
    /// summarize POST is ENGAGED but UNANSWERED (parked in an abortable task)
    /// the ledger ALREADY says redo is gone (markers survive, decision 6 —
    /// entries and per-entry epochs are untouched): a cancelled drive can never
    /// leave the record advertising redo over a tail the provider may have
    /// deleted. The snapshot's canRedo + redoableTurnIds reflect the retirement
    /// the whole way through.
    #[tokio::test]
    async fn compact_retires_redo_before_the_summarize_drive_and_the_snapshot_reflects_it() {
        let gate = Arc::new(tokio::sync::Notify::new());
        let (st, http, mut rx) = compact_state_gated(
            r#"{"model":null}"#,
            SummarizeOutcome::OkAnswered,
            Some(gate.clone()),
        )
        .await;
        insert_compact_session(&st, "ses_1", Some("prov-a/mdl-x")).await;
        let sink = seed_redoable_record(&st, "ses_1").await;

        st.handle_compact(compact_msg("ses_1")).await;

        // The summarize POST is ENGAGED (recorded) but the provider has NOT
        // answered yet — and F4's pre-drive destroy has ALREADY retired redo:
        // the destroy is durable-BEFORE-mutation (the parked, abortable drive
        // can never strand `canRedo: true` over a possibly-deleted tail).
        tokio::time::timeout(Duration::from_secs(5), async {
            while http.summarize_requests().is_empty() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the summarize POST is engaged");
        let record = sink.load_rollback(PROVIDER, "ses_1").expect("record");
        assert!(
            record.redo_destroyed && !record.can_redo(),
            "F4: redo is retired BEFORE the provider's answer — the drive is abortable: {record:?}"
        );

        // The 2xx lands: the compact's tail deletion is real; the retirement
        // (already durable) simply settles.
        gate.notify_one();
        frames_until(&mut rx, |f| is_event(f, "freshAgent.turn.complete", None)).await;
        let record = sink
            .load_rollback(PROVIDER, "ses_1")
            .expect("the record survives");
        assert!(
            record.redo_destroyed && !record.can_redo(),
            "the retired redo stays retired through the accepted compact: {record:?}"
        );
        assert_eq!(
            RollbackFakeHttp::turn_ids(&record.entries[0].removed_turns),
            vec!["msg_u2", "msg_a2"],
            "decision 6: the marker bucket survives a compact-driven destroy"
        );

        // The snapshot truth: no device keeps advertising a redo that can only fail.
        let snap = crate::build_opencode_snapshot_json(
            "ses_1",
            &json!({ "id": "ses_1", "time": { "updated": 5 } }),
            &json!([]),
            Some(&record),
        );
        assert_eq!(
            snap["rollback"],
            json!({ "canRedo": false, "undoneDepth": 1, "redoableTurnIds": [] }),
            "canRedo:false + no redoable marker rows after the compact"
        );
    }

    /// F2 (no-POST preflight failure): a compact with no resolvable model pair
    /// errors LOUDLY and NEVER posts — the provider tail survives, so redo
    /// stays valid.
    #[tokio::test]
    async fn compact_with_no_resolvable_model_never_destroys_redo() {
        let (st, http, mut rx) =
            compact_state(r#"{"model":null}"#, SummarizeOutcome::OkAnswered).await;
        // An unsplittable session model forces the /config fallback, which is null.
        insert_compact_session(&st, "ses_1", Some("noslash")).await;
        let sink = seed_redoable_record(&st, "ses_1").await;

        st.handle_compact(compact_msg("ses_1")).await;

        let frames = frames_until(&mut rx, |f| is_event(f, "freshAgent.error", None)).await;
        let error_frame = frames
            .iter()
            .find(|f| is_event(f, "freshAgent.error", None))
            .expect("the failure is LOUD");
        assert_eq!(error_frame["event"]["code"], "OPENCODE_COMPACT_FAILED");
        assert!(
            http.summarize_requests().is_empty(),
            "the preflight failure never posts"
        );
        let record = sink
            .load_rollback(PROVIDER, "ses_1")
            .expect("the record survives");
        assert!(
            !record.redo_destroyed && record.can_redo(),
            "no-POST ⇒ redo stays valid (the provider tail survives): {record:?}"
        );
    }

    /// ep1-r3 F2, the REAL provider ordering (OpenCode v1.18.21): summarize
    /// runs `revertSvc.cleanup` FIRST and its error-able stages AFTER — so a
    /// 5xx observed AFTER the serve received the POST is an error-AFTER-send,
    /// a possibly-destroyed tail, NEVER a proven-survived one. The pre-drive
    /// destroy is FINAL: the record reads redoDestroyed/canRedo:false, the
    /// refresh/cross-device snapshot advertises no redo, and the markers
    /// survive (decision 6). (The frozen/destroy classification of a LATER
    /// undo across this vanished tail is covered by the RollbackFakeHttp
    /// bundle below.)
    #[tokio::test]
    async fn compact_summarize_answered_500_after_receipt_destroys_redo_forever() {
        let (st, http, mut rx) =
            compact_state(r#"{"model":null}"#, SummarizeOutcome::Answered500).await;
        insert_compact_session(&st, "ses_1", Some("prov-a/mdl-x")).await;
        let sink = seed_redoable_record(&st, "ses_1").await;

        st.handle_compact(compact_msg("ses_1")).await;

        let frames = frames_until(&mut rx, |f| is_event(f, "freshAgent.error", None)).await;
        let error_frame = frames
            .iter()
            .find(|f| is_event(f, "freshAgent.error", None))
            .expect("the failure is LOUD");
        assert_eq!(error_frame["event"]["code"], "OPENCODE_COMPACT_FAILED");
        assert_eq!(
            http.summarize_requests().len(),
            1,
            "the summarize POST was genuinely RECEIVED, THEN answered 5xx (the real ordering)"
        );
        let record = sink
            .load_rollback(PROVIDER, "ses_1")
            .expect("the record survives");
        assert!(
            record.redo_destroyed && !record.can_redo(),
            "F2: error-after-send ⇒ redo destroyed FOREVER (the tail is possibly gone): {record:?}"
        );
        assert_eq!(
            RollbackFakeHttp::turn_ids(&record.entries[0].removed_turns),
            vec!["msg_u2", "msg_a2"],
            "decision 6: the marker bucket survives the destroy"
        );
        // The refresh/cross-device truth: no device keeps advertising a redo
        // the provider may be unable to perform.
        let snap = crate::build_opencode_snapshot_json(
            "ses_1",
            &json!({ "id": "ses_1", "time": { "updated": 5 } }),
            &json!([]),
            Some(&record),
        );
        assert_eq!(
            snap["rollback"],
            json!({ "canRedo": false, "undoneDepth": 1, "redoableTurnIds": [] }),
            "canRedo:false + no redoable marker rows after the answered-500 compact"
        );
    }

    /// ep1-r3 F2's OTHER leg — the provably-UNDELIVERED dispatch: the
    /// summarize POST's connect phase refused BEFORE a byte left the client
    /// (the fake reject models "no POST was ever received"), so the serve
    /// provably never ran cleanup — the reverted tail SURVIVED, the pre-drive
    /// destroy is compensated back, and redo stays valid.
    #[tokio::test]
    async fn compact_summarize_undelivered_dispatch_preserves_redo() {
        let (st, http, mut rx) =
            compact_state(r#"{"model":null}"#, SummarizeOutcome::Undelivered).await;
        insert_compact_session(&st, "ses_1", Some("prov-a/mdl-x")).await;
        let sink = seed_redoable_record(&st, "ses_1").await;

        st.handle_compact(compact_msg("ses_1")).await;

        let frames = frames_until(&mut rx, |f| is_event(f, "freshAgent.error", None)).await;
        let error_frame = frames
            .iter()
            .find(|f| is_event(f, "freshAgent.error", None))
            .expect("the failure is LOUD");
        assert_eq!(error_frame["event"]["code"], "OPENCODE_COMPACT_FAILED");
        assert!(
            error_frame["event"]["message"]
                .as_str()
                .unwrap_or("")
                .contains("connect refused"),
            "the undelivered diagnostic crosses the wire: {error_frame}"
        );
        assert!(
            http.summarize_requests().is_empty(),
            "the dispatch provably never reached the serve (no POST was ever received)"
        );
        // The settle tail still returns the pane to idle (adapter.ts:386-393
        // parity — idle precedes the error inside the settle tail).
        assert!(
            frames
                .iter()
                .any(|f| is_event(f, "freshAgent.session.snapshot", Some("idle"))),
            "the pane returns to idle even on a never-delivered compact: {frames:?}"
        );
        let record = sink
            .load_rollback(PROVIDER, "ses_1")
            .expect("the record survives");
        assert!(
            !record.redo_destroyed && record.can_redo(),
            "undelivered ⇒ the pre-drive destroy is compensated back — redo stays valid: {record:?}"
        );
        let snap = crate::build_opencode_snapshot_json(
            "ses_1",
            &json!({ "id": "ses_1", "time": { "updated": 5 } }),
            &json!([]),
            Some(&record),
        );
        assert_eq!(
            snap["rollback"]["canRedo"],
            json!(true),
            "the snapshot truth keeps advertising the still-valid redo"
        );
    }

    /// Focused-review ep2-r1 F3: startup-phase failures of the compact drive
    /// prove no POST ever left the process — `manager.compact()` runs
    /// `ensure_started()` BEFORE the summarize request is even constructed, so
    /// the startup-failure variants (`Spawn`/`StartupFailed`/`ProcessExited`/
    /// `PortAllocation`/`NotHealthy`, and the manager-level `ShuttingDown`/
    /// `StartupAborted`) carry the same no-side-effects truth as
    /// `ServeError::Undelivered` (connect-phase refusal). Compensating ONLY
    /// `Undelivered` persisted a destroyed redo over an untouched tail: a
    /// recoverable sidecar startup failure permanently discarded valid redo.
    /// Here the spawn REFUSES: zero summarize POSTs exist, the error is LOUD,
    /// and the pre-drive destroy is compensated back (redo stays valid).
    #[tokio::test]
    async fn compact_summarize_startup_failure_preserves_redo() {
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let fresh_agent = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx.clone()));
        let http = Arc::new(CompactFakeHttp::new(
            r#"{"model":null}"#.as_bytes().to_vec(),
            SummarizeOutcome::OkAnswered,
            tx.subscribe(),
            None,
            None,
        ));
        let deps = ServeDeps {
            spawner: Arc::new(FailSpawner),
            http: http.clone(),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        // The manager is NEVER started: the compact's ensure_started() must hit
        // the refusing spawner INSIDE the drive, pre-POST.
        let config = ServeConfig {
            idle_poll_interval: Duration::from_millis(15),
            ..ServeConfig::default()
        };
        let manager = OpencodeServeManager::new(deps, config);
        fresh_agent.set_manager_for_test(manager).await;
        let st = FreshOpencodeState::new(fresh_agent);
        insert_compact_session(&st, "ses_1", Some("prov-a/mdl-x")).await;
        let sink = seed_redoable_record(&st, "ses_1").await;

        st.handle_compact(compact_msg("ses_1")).await;

        let frames = frames_until(&mut rx, |f| is_event(f, "freshAgent.error", None)).await;
        let error_frame = frames
            .iter()
            .find(|f| is_event(f, "freshAgent.error", None))
            .expect("the failure is LOUD");
        assert_eq!(error_frame["event"]["code"], "OPENCODE_COMPACT_FAILED");
        assert!(
            error_frame["event"]["message"]
                .as_str()
                .unwrap_or("")
                .contains(FAILSPAWN_MARK),
            "the startup diagnostic crosses the wire: {error_frame}"
        );
        assert!(
            http.summarize_requests().is_empty(),
            "the startup failure proves the summarize POST never left the process"
        );
        let record = sink
            .load_rollback(PROVIDER, "ses_1")
            .expect("the record survives");
        assert!(
            !record.redo_destroyed && record.can_redo(),
            "ep2-r1 F3: no-POST startup failure ⇒ the pre-drive destroy is compensated back — redo stays valid: {record:?}"
        );
    }

    /// Focused-review ep4-r4 (major, opencode_ws.rs:1155): a compact drive
    /// aborted DURING COLD START (killed/interrupted while `ensure_started()`
    /// still waits on the health probe) drops the task before
    /// `manager.compact()` ever returns — pre-fix the never-POSTed ledger's
    /// destroy stood forever (no summarize POST existed, the reverted tail is
    /// intact, yet `canRedo:false` persisted). The drop-guard restore must
    /// compensate it back, exactly like the never-dispatched failure leg.
    #[tokio::test]
    async fn a_compact_aborted_during_cold_start_restores_the_durably_destroyed_redo() {
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
        let fresh_agent = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx.clone()));
        let health_gate = Arc::new(tokio::sync::Notify::new());
        let http = Arc::new(CompactFakeHttp::new(
            r#"{"model":null}"#.as_bytes().to_vec(),
            SummarizeOutcome::OkAnswered,
            tx.subscribe(),
            None,
            Some(health_gate.clone()),
        ));
        let deps = ServeDeps {
            spawner: Arc::new(TrackedSpawner {
                killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            }),
            http: http.clone(),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        // The manager is NEVER started: the compact drive's ensure_started()
        // parks INSIDE the health probe until the gate fires.
        let config = ServeConfig {
            idle_poll_interval: Duration::from_millis(15),
            ..ServeConfig::default()
        };
        let manager = OpencodeServeManager::new(deps, config);
        fresh_agent.set_manager_for_test(manager).await;
        let st = FreshOpencodeState::new(fresh_agent);
        insert_compact_session(&st, "ses_1", Some("prov-a/mdl-x")).await;
        let sink = seed_redoable_record(&st, "ses_1").await;

        st.handle_compact(compact_msg("ses_1")).await;
        // The pre-drive destroy lands durably (and synchronously relative to
        // the drive launch): poll for it.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let record = sink
                .load_rollback(PROVIDER, "ses_1")
                .expect("record visible");
            if record.redo_destroyed {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the pre-drive destroy never landed"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            http.summarize_requests().is_empty(),
            "no summarize POST exists — the serve is parked in cold start"
        );

        // Kill the drive mid-cold-start (the ep4-r5 window): the task is
        // aborted before compact() returns.
        st.handle_interrupt(FreshAgentInterrupt {
            provider: AgentProvider::Opencode,
            session_id: "ses_1".to_string(),
            session_type: SessionType::Freshopencode,
            cwd: None,
        })
        .await;

        // The drop-guard restore: the redo chain is durably valid again.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let record = sink
                .load_rollback(PROVIDER, "ses_1")
                .expect("record visible");
            if !record.redo_destroyed && record.can_redo() {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "ep4-r5: the aborted-before-dispatch compact never restored redo: {record:?}"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            http.summarize_requests().is_empty(),
            "still no POST — the restore rides the provably-undelivered premise"
        );
        // Release the parked health probe so no task lingers past the test.
        health_gate.notify_waiters();
    }

    /// Focused-review ep4-r5 (Major, opencode_ws.rs:216): with a drop-guard
    /// restore that settles ASYNCHRONOUSLY, a send landing between the compact
    /// task's abort and the restore sees `redoDestroyed:true` —
    /// `destroy_redo_on_submit` treats that as a no-op — and the late restore
    /// then resurrects `canRedo:true` behind a fresh submission. The abort
    /// paths therefore AWAIT the settle before answering; the window never
    /// exists.
    ///
    ///   Compact parked in cold start ⇒ pre-drive destroy landed ⇒ interrupt
    ///   (restore awaited) ⇒ send ⇒ the FINAL durable state is the new
    ///   submission's destroy (redo destroyed, never resurrected).
    #[tokio::test]
    async fn a_send_landing_after_a_coldstart_compact_abort_never_resurrects_redo() {
        // The restore beats the real disk by design flakiness in this rig: the
        // knob makes the compensation take 300ms, so a non-awaiting abort path
        // leaves the window standing deterministically.
        std::env::set_var("FRESHELL_TEST_OPENCODE_REDO_RESTORE_DELAY_MS", "300");
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
        let fresh_agent = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx.clone()));
        let health_gate = Arc::new(tokio::sync::Notify::new());
        let http = Arc::new(CompactFakeHttp::new(
            r#"{"model":null}"#.as_bytes().to_vec(),
            SummarizeOutcome::OkAnswered,
            tx.subscribe(),
            None,
            Some(health_gate.clone()),
        ));
        let deps = ServeDeps {
            spawner: Arc::new(SpawnOnceThenRefuse {
                spawned: Arc::new(std::sync::atomic::AtomicBool::new(false)),
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
        fresh_agent.set_manager_for_test(manager).await;
        let st = FreshOpencodeState::new(fresh_agent);
        insert_compact_session(&st, "ses_1", Some("prov-a/mdl-x")).await;
        let sink = seed_redoable_record(&st, "ses_1").await;

        st.handle_compact(compact_msg("ses_1")).await;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let record = sink
                .load_rollback(PROVIDER, "ses_1")
                .expect("record visible");
            if record.redo_destroyed {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the pre-drive destroy never landed"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        st.handle_interrupt(FreshAgentInterrupt {
            provider: AgentProvider::Opencode,
            session_id: "ses_1".to_string(),
            session_type: SessionType::Freshopencode,
            cwd: None,
        })
        .await;
        // The interrupt answer means the restore has LANDED (the settle was
        // awaited): redo reads valid again.
        let record = sink
            .load_rollback(PROVIDER, "ses_1")
            .expect("record visible");
        assert!(
            !record.redo_destroyed && record.can_redo(),
            "post-interrupt: cold-start restore visible before any later op: {record:?}"
        );

        // Now the fresh submission: it destroys redo (that's the ledger's own
        // rule for a submit) — and that state must be FINAL (no resurrection
        // can arrive past the settle boundary).
        st.handle_send(send_msg("ses_1", "fresh turn")).await;
        // A beat for the send's ledger consequence to land.
        tokio::time::sleep(Duration::from_millis(200)).await;
        let record = sink
            .load_rollback(PROVIDER, "ses_1")
            .expect("record visible");
        assert!(
            record.redo_destroyed && !record.can_redo(),
            "ep4-r5 F2: after a fresh submission the redo chain is durably destroyed — never resurrected: {record:?}"
        );
        std::env::remove_var("FRESHELL_TEST_OPENCODE_REDO_RESTORE_DELAY_MS");
        health_gate.notify_waiters();
    }

    /// Focused-review ep1-r2 F4's core repro: a compact whose drive is ABORTED
    /// mid-summarize (an interrupt landing while the accepted POST awaits its
    /// answer) can never strand the durable record advertising `canRedo` over a
    /// tail the provider may still have deleted — the destroy landed PRE-DRIVE
    /// (durable-BEFORE-mutation), so the record reads redoDestroyed/canRedo:false
    /// throughout the window, and the abort never regresses it. A LATER undo then
    /// classifies the old (deleted-or-not) markers through the frozen/destroy
    /// path: the destroyed bit at load opens a NEW epoch, the prior entries
    /// freeze, and the fresh undo's entry lands ABOVE them — never a
    /// misclassification of the old tail as current-epoch history.
    #[tokio::test]
    async fn compact_aborted_mid_drive_keeps_redo_destroyed_and_a_later_undo_freezes_the_old_markers(
    ) {
        // Seeded: a prior undo at msg_u2 (tail [u2,a2,u3,a3] is redoable) and the
        // revert pointer at msg_u2; the active prefix is [u1,a1].
        let (st, _rx, sink, http) = state_with_rollback_fake(Some("msg_u2")).await;
        // The compact preflight needs a resolvable model pair (the session's own
        // model wins without consulting /config).
        let session_arc = st
            .sessions
            .lock()
            .await
            .get("ses_real")
            .cloned()
            .expect("registered session");
        session_arc.lock().await.model = Some("prov-a/mdl-x".to_string());

        let gate = http.arm_summarize_gate();
        tokio::time::timeout(
            Duration::from_secs(2),
            st.handle_compact(compact_msg("ses_real")),
        )
        .await
        .expect("handle_compact returns after registering the driving task");
        // The summarize POST is ENGAGED (recorded) but UNANSWERED (parked).
        tokio::time::timeout(Duration::from_secs(5), async {
            while http.summarize_requests().is_empty() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the summarize POST is engaged");
        let record = sink
            .load_rollback(PROVIDER, "ses_real")
            .expect("the record survives");
        assert!(
            record.redo_destroyed && !record.can_redo(),
            "F4: canRedo was already false BEFORE the parked POST could answer: {record:?}"
        );

        // ABORT the drive mid-flight: from the drive's perspective the POST is
        // never answered — provider-side application is ambiguous, so the
        // destroy MUST stand (the interrupt/kill tests never seeded rollback
        // state; this window is F4's finding).
        st.handle_interrupt(FreshAgentInterrupt {
            provider: AgentProvider::Opencode,
            session_id: "ses_real".to_string(),
            session_type: SessionType::Freshopencode,
            cwd: None,
        })
        .await;
        gate.notify_waiters(); // the aborted drive never consumes the release
        tokio::time::sleep(Duration::from_millis(50)).await; // settle window
        let record = sink
            .load_rollback(PROVIDER, "ses_real")
            .expect("the record survives");
        assert!(
            record.redo_destroyed && !record.can_redo(),
            "the aborted drive never regressed durable state: {record:?}"
        );

        // A LATER undo classifies the old markers via the frozen/destroy path:
        // destroyed bit at load ⇒ a NEW epoch opens; the old tail freezes; the
        // fresh entry lands above it.
        let (reply_sink, captured) = capturing_sink();
        st.handle_rollback(undo_op("ses_real", "rb-abort"), reply_sink)
            .await;
        let frames = captured_frames(&captured);
        assert_eq!(
            frames[0]["event"]["type"],
            json!("freshAgent.rolledBack"),
            "the undo lands on the active prefix [u1,a1]: {frames:?}"
        );
        let record = sink
            .load_rollback(PROVIDER, "ses_real")
            .expect("the record survives");
        assert_eq!(
            record.current_epoch, 1,
            "the destroyed-at-load bit opened a fresh epoch: {record:?}"
        );
        assert_eq!(record.entries.len(), 2, "frozen + fresh: {record:?}");
        assert_eq!(
            record.entries[0].epoch, 0,
            "the pre-compact markers FROZE (never current-epoch history): {record:?}"
        );
        assert_eq!(
            RollbackFakeHttp::turn_ids(&record.entries[0].removed_turns),
            vec!["msg_u2", "msg_a2", "msg_u3", "msg_a3"],
            "the frozen union keeps the possibly-deleted tail"
        );
        assert_eq!(record.entries[1].epoch, 1);
        assert_eq!(
            RollbackFakeHttp::turn_ids(&record.entries[1].removed_turns),
            vec!["msg_u1", "msg_a1"],
            "the fresh undo's entry sits in the new epoch"
        );
        assert!(
            record.can_redo() && !record.redo_destroyed,
            "the NEW chain is redoable; the old chain's redo stays permanently dead"
        );
    }

    /// ep1-r3 F2's full bundle for the ANSWERED-error shape: the summarize POST
    /// was RECEIVED and THEN answered 500 (the real OpenCode v1.18.21
    /// cleanup-FIRST ordering — a possibly-vanished tail, never a
    /// proven-survived one). The pre-drive destroy stands FOREVER through the
    /// error; the refresh/cross-device snapshot advertises no redo; and a
    /// LATER undo classifies the vanished old tail via the frozen/destroy
    /// bookkeeping (the destroyed bit at load opens a NEW epoch, the old
    /// markers freeze, the fresh entry lands above them).
    #[tokio::test]
    async fn compact_summarize_answered_error_keeps_redo_destroyed_and_a_later_undo_freezes_the_old_markers(
    ) {
        // Seeded: a prior undo at msg_u2 (tail [u2,a2,u3,a3] is redoable) and the
        // revert pointer at msg_u2; the active prefix is [u1,a1].
        let (st, mut rx, sink, http) = state_with_rollback_fake(Some("msg_u2")).await;
        let session_arc = st
            .sessions
            .lock()
            .await
            .get("ses_real")
            .cloned()
            .expect("registered session");
        session_arc.lock().await.model = Some("prov-a/mdl-x".to_string());
        // The POST is RECEIVED, then answered 500 (cleanup first — the tail is
        // possibly gone even though the serve errored).
        *http.summarize_status.lock().expect("status mutex") = 500;

        st.handle_compact(compact_msg("ses_real")).await;

        // The answered error settles loudly; the pane returns to idle.
        frames_until(&mut rx, |f| is_event(f, "freshAgent.error", None)).await;
        assert_eq!(
            http.summarize_requests().len(),
            1,
            "the summarize POST was genuinely RECEIVED, THEN answered 5xx"
        );
        let record = sink
            .load_rollback(PROVIDER, "ses_real")
            .expect("the record survives");
        assert!(
            record.redo_destroyed && !record.can_redo(),
            "F2: error-after-send ⇒ the destroy stands forever: {record:?}"
        );
        let snap = crate::build_opencode_snapshot_json(
            "ses_real",
            &json!({ "id": "ses_real", "time": { "updated": 5 } }),
            &json!([]),
            Some(&record),
        );
        assert_eq!(
            snap["rollback"],
            json!({ "canRedo": false, "undoneDepth": 2, "redoableTurnIds": [] }),
            "the snapshot truth advertises NO redo across the possibly-vanished tail (2 frozen turn-pairs)"
        );

        // A LATER undo classifies the old markers via the frozen/destroy path:
        // the destroyed bit at load opens a NEW epoch; the old tail freezes;
        // the fresh undo's entry lands above it.
        let (reply_sink, captured) = capturing_sink();
        st.handle_rollback(undo_op("ses_real", "rb-500"), reply_sink)
            .await;
        let frames = captured_frames(&captured);
        assert_eq!(
            frames[0]["event"]["type"],
            json!("freshAgent.rolledBack"),
            "the undo lands on the active prefix [u1,a1]: {frames:?}"
        );
        let record = sink
            .load_rollback(PROVIDER, "ses_real")
            .expect("the record survives");
        assert_eq!(
            record.current_epoch, 1,
            "the destroyed-at-load bit opened a fresh epoch: {record:?}"
        );
        assert_eq!(record.entries.len(), 2, "frozen + fresh: {record:?}");
        assert_eq!(
            record.entries[0].epoch, 0,
            "the pre-compact markers FROZE (never current-epoch history): {record:?}"
        );
        assert_eq!(
            RollbackFakeHttp::turn_ids(&record.entries[0].removed_turns),
            vec!["msg_u2", "msg_a2", "msg_u3", "msg_a3"],
            "the frozen union keeps the possibly-vanished old tail"
        );
        assert_eq!(record.entries[1].epoch, 1);
        assert_eq!(
            RollbackFakeHttp::turn_ids(&record.entries[1].removed_turns),
            vec!["msg_u1", "msg_a1"],
            "the fresh undo's entry sits in the new epoch"
        );
        assert!(
            record.can_redo() && !record.redo_destroyed,
            "the NEW chain is redoable; the old chain's redo stays permanently dead"
        );
    }

    #[tokio::test]
    async fn compact_falls_back_to_the_serve_config_model_when_the_session_has_none() {
        let (st, http, mut rx) = compact_state(
            r#"{"model":"conf-prov/conf-mdl","theme":"dark"}"#,
            SummarizeOutcome::OkAnswered,
        )
        .await;
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
        let (st, http, mut rx) =
            compact_state(r#"{"model":null}"#, SummarizeOutcome::OkAnswered).await;
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

    /// Focused-review ep2-r1 F2: a compact whose pre-drive redo-destroy write
    /// FAILS is REFUSED with zero provider traffic — durable-BEFORE-mutation
    /// runs BOTH ways. Warn+continue would let OpenCode delete the reverted
    /// tail while the durable ledger still says `canRedo: true` /
    /// `redoDestroyed: false`, advertising redo across refreshes and other
    /// devices that the provider can no longer perform. Refusing keeps the row
    /// TRUE exactly because nothing ran (the tail provably survives).
    #[tokio::test]
    async fn compact_with_a_failed_redo_destroy_is_refused_and_never_posts() {
        let (st, http, mut rx) =
            compact_state(r#"{"model":null}"#, SummarizeOutcome::OkAnswered).await;
        insert_compact_session(&st, "ses_1", Some("prov-a/mdl-x")).await;
        let sink = seed_redoable_record(&st, "ses_1").await;
        sink.set_fail_writes(true);

        st.handle_compact(compact_msg("ses_1")).await;

        assert!(
            http.summarize_requests().is_empty(),
            "NO summarize POST when the pre-drive destroy cannot be persisted: {:?}",
            http.summarize_requests()
        );
        let frames = drain_frames(&mut rx);
        assert!(
            frames
                .iter()
                .any(|f| is_event(f, "freshAgent.session.snapshot", Some("idle"))),
            "the pane is never left busy on the refusal: {frames:?}"
        );
        assert!(
            !frames
                .iter()
                .any(|f| is_event(f, "freshAgent.turn.complete", None)),
            "no false completion: {frames:?}"
        );
        let error_frame = frames
            .iter()
            .find(|f| is_event(f, "freshAgent.error", None))
            .unwrap_or_else(|| panic!("the refusal is LOUD: {frames:?}"));
        assert_eq!(
            error_frame["event"]["code"], "OPENCODE_COMPACT_FAILED",
            "{error_frame}"
        );
        assert_eq!(
            error_frame["event"]["message"].as_str().unwrap_or_default(),
            LEDGER_WRITE_REFUSAL_COPY,
            "the refusal carries the pinned ledger-write copy: {error_frame}"
        );
        let record = sink.load_rollback(PROVIDER, "ses_1").expect("record");
        assert!(
            !record.redo_destroyed && record.can_redo(),
            "the row stands untouched — the write failed BEFORE anything ran: {record:?}"
        );
    }

    #[tokio::test]
    async fn compact_on_a_not_yet_materialized_session_is_a_silent_noop() {
        let (st, http, mut rx) =
            compact_state(r#"{"model":null}"#, SummarizeOutcome::OkAnswered).await;

        st.handle_create(create_msg("req-noop"), None).await;
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
        let (st, http, mut rx) =
            compact_state(r#"{"model":null}"#, SummarizeOutcome::OkAnswered).await;
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
        let (st, http, mut rx) =
            compact_state(r#"{"model":null}"#, SummarizeOutcome::Answered500).await;
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
        let (st, http, mut rx) =
            compact_state(r#"{"model":null}"#, SummarizeOutcome::OkAnswered).await;
        insert_compact_session(&st, "ses_1", Some("prov-a/mdl-x")).await;
        let session_arc = st.sessions.lock().await.get("ses_1").cloned().unwrap();
        // A genuinely in-flight turn (never resolves) parked as the session's
        // driving task — the exact state a queued-send busy pane leaves behind.
        session_arc.lock().await.turn_task = Some(TurnTask {
            kind: TurnTaskKind::Send,
            handle: tokio::spawn(std::future::pending::<()>()),
            compact_settled_rx: None,
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
        task.handle.abort();
    }

    /// D1-F1(b): the compact's driving task is the session's `turn_task`, so a
    /// `freshAgent.kill` mid-compact aborts it — dropped mid-await, it never
    /// reaches the settle tail: NO false `freshAgent.turn.complete` (and the
    /// released gate resurrects nothing).
    #[tokio::test]
    async fn kill_during_an_in_flight_compact_aborts_it_without_a_false_completion() {
        let gate = Arc::new(tokio::sync::Notify::new());
        let (st, http, mut rx) = compact_state_gated(
            r#"{"model":null}"#,
            SummarizeOutcome::OkAnswered,
            Some(gate.clone()),
        )
        .await;
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
        let (st, http, mut rx) = compact_state_gated(
            r#"{"model":null}"#,
            SummarizeOutcome::OkAnswered,
            Some(gate.clone()),
        )
        .await;
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
        let (st, http, mut rx) = compact_state_gated(
            r#"{"model":null}"#,
            SummarizeOutcome::OkAnswered,
            Some(gate.clone()),
        )
        .await;
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
            tab_id: None,
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
            Box<
                dyn std::future::Future<Output = Result<ServeHttpResponse, ServeHttpError>>
                    + Send
                    + 'a,
            >,
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
        st.handle_fork(fork_msg("ses_parent", "fork-req-1", None), None, sink)
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
        st.handle_fork(fork_msg("ses_parent", "fork-req-2", None), None, sink)
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
        st.handle_create(create_msg("req-fork"), None).await;
        let placeholder = "freshopencode-req-fork";

        let (sink, captured) = capturing_sink();
        st.handle_fork(fork_msg(placeholder, "fork-req-3", None), None, sink)
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
        st.handle_fork(fork_msg("ses_ghost", "fork-req-4", None), None, sink)
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
        st.handle_fork(fork_msg("ses_parent", "fork-req-5", None), None, sink)
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
                st.handle_fork(fork_msg("ses_parent", "fork-req-dup-1", None), None, sink1)
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
            st.handle_fork(fork_msg("ses_parent", "fork-req-dup-2", None), None, sink2),
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
        st.handle_fork(fork_msg("ses_parent", "fork-req-dup-3", None), None, sink3)
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
        st.handle_fork(fork_msg("ses_parent", "fork-req-f1", None), None, sink1)
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
        st.handle_fork(fork_msg("ses_parent", "fork-req-f2", None), None, sink2)
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
            st.handle_fork(fork_msg("ses_parent", "fork-req-8", None), None, sink)
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
        st.handle_fork(fork_msg("ses_parent", "fork-req-6", Some("msg_abc")), None, sink)
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
            None,
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

    // ── freshAgent.undo / freshAgent.redo (kata 1wxv Task 3) ────────────────

    use crate::rollback_record::{
        RollbackDirection, RollbackEntry, RollbackModeReq, RollbackRecord, RollbackRequest,
        LEDGER_WRITE_REFUSAL_COPY, OPENCODE_OLD_CLI_COPY, REDO_DESTROYED_MESSAGE,
        REDO_EMPTY_MESSAGE, ROLLBACK_BUSY_MESSAGE, UNDO_EMPTY_MESSAGE,
    };

    fn captured_frames(captured: &Arc<StdMutex<Vec<ServerMessage>>>) -> Vec<Value> {
        captured
            .lock()
            .expect("captured mutex")
            .iter()
            .map(|m| serde_json::to_value(m).expect("frame serializes"))
            .collect()
    }

    /// The rollback-suite serve fake: records EVERY request; scripts session info with a
    /// TOP-LEVEL `revert` pointer (the VERIFIED wire shape — never `info.revert`) and a
    /// message list that is returned IN FULL at all times (the real serve returns the
    /// reverted tail UNFLAGGED; freshell computes the active prefix strictly before
    /// `revert.messageID`). POST revert 200s and moves the pointer to the body's
    /// messageID (unless `revert_moves_pointer` is false — the verified silent-200
    /// no-op for an unknown/stale id); POST unrevert clears it; POST prompt_async
    /// natively DELETES the reverted tail and clears the pointer (decision 5), then
    /// appends the resent user/assistant pair.
    struct RollbackFakeHttp {
        requests: StdMutex<Vec<RecordedRequest>>,
        messages: StdMutex<Vec<Value>>,
        /// `session.revert.messageID` — TOP-LEVEL on the session body; omitted when None.
        revert_pointer: StdMutex<Option<String>>,
        /// 200 default; a 404 simulates a CLI predating the revert route.
        revert_status: StdMutex<u16>,
        /// false simulates the silent-200 no-op (unknown/stale messageID).
        revert_moves_pointer: StdMutex<bool>,
        /// ep3-r1 F2: when armed, the revert POST answers `Err(Undelivered)` —
        /// the connect-phase refusal shape (the request provably never left
        /// this process), exercising the rollback ledger's never-dispatched
        /// compensation leg.
        revert_undelivered: StdMutex<bool>,
        /// Fail exactly these (1-indexed) `GET /session/<id>` calls (post-verify
        /// read triad leg (c); a per-call set because the ep2-r3 retry repro
        /// fails op1's post-verify AND op2's post-verify while op2's initial
        /// read succeeds).
        get_session_fail_calls: StdMutex<std::collections::BTreeSet<usize>>,
        get_session_calls: StdMutex<usize>,
        /// When armed, the NEXT revert POST records itself then parks on `notified()` —
        /// the deterministic "rollback in flight" window (the fork-gate idiom).
        revert_gate: StdMutex<Option<Arc<tokio::sync::Notify>>>,
        /// F4: when armed, every summarize POST records itself then parks on
        /// `notified()` — the deterministic "compact drive in flight" window
        /// (the abort-mid-drive test's lever).
        summarize_gate: StdMutex<Option<Arc<tokio::sync::Notify>>>,
        /// ep1-r3 F2: the status every summarize POST answers (200 default) —
        /// a non-200 is the REAL v1.18.21 ordering: the POST was RECEIVED
        /// (recorded) and THEN answered with an error (cleanup already ran).
        summarize_status: StdMutex<u16>,
        /// `prompt_async` re-arms one busy status poll so `run_turn` resolves via the
        /// status-fallback path (observed activity → two absent polls → idle).
        busy_budget: StdMutex<u32>,
        /// Appended-turn counter (the resent turn mints msg_u4/msg_a4, then u5/a5, …).
        next_appended: AtomicUsize,
    }

    impl RollbackFakeHttp {
        fn new(pointer: Option<&str>) -> Self {
            Self {
                requests: StdMutex::new(Vec::new()),
                messages: StdMutex::new(Self::three_turn_json()),
                revert_pointer: StdMutex::new(pointer.map(str::to_string)),
                revert_status: StdMutex::new(200),
                revert_moves_pointer: StdMutex::new(true),
                revert_undelivered: StdMutex::new(false),
                get_session_fail_calls: StdMutex::new(std::collections::BTreeSet::new()),
                get_session_calls: StdMutex::new(0),
                revert_gate: StdMutex::new(None),
                summarize_gate: StdMutex::new(None),
                summarize_status: StdMutex::new(200),
                busy_budget: StdMutex::new(0),
                next_appended: AtomicUsize::new(3),
            }
        }

        fn three_turn_json() -> Vec<Value> {
            vec![
                json!({ "info": { "id": "msg_u1", "role": "user" }, "parts": [{ "type": "text", "text": "prompt one" }] }),
                json!({ "info": { "id": "msg_a1", "role": "assistant" }, "parts": [{ "type": "text", "text": "answer one" }] }),
                json!({ "info": { "id": "msg_u2", "role": "user" }, "parts": [{ "type": "text", "text": "prompt two" }] }),
                json!({ "info": { "id": "msg_a2", "role": "assistant" }, "parts": [{ "type": "text", "text": "answer two" }] }),
                json!({ "info": { "id": "msg_u3", "role": "user" }, "parts": [{ "type": "text", "text": "prompt three" }] }),
                json!({ "info": { "id": "msg_a3", "role": "assistant" }, "parts": [{ "type": "text", "text": "answer three" }] }),
            ]
        }

        fn recorded(&self) -> Vec<RecordedRequest> {
            self.requests.lock().expect("requests mutex").clone()
        }

        /// Forget the harness's own requests (the `ensure_started` health probe etc.)
        /// so tests assert on handler-driven traffic only.
        fn clear(&self) {
            self.requests.lock().expect("requests mutex").clear();
        }

        /// POST /session/<id>/revert records (parsed JSON bodies only).
        fn revert_posts(&self) -> Vec<RecordedRequest> {
            self.recorded()
                .into_iter()
                .filter(|r| r.method == "POST" && r.url.ends_with("/revert"))
                .collect()
        }

        /// Arm the slow-revert gate; the returned Notify releases the parked POST.
        fn arm_revert_gate(&self) -> Arc<tokio::sync::Notify> {
            let gate = Arc::new(tokio::sync::Notify::new());
            *self.revert_gate.lock().expect("gate mutex") = Some(gate.clone());
            gate
        }

        /// F4: arm the summarize gate; the returned Notify releases the parked POST.
        fn arm_summarize_gate(&self) -> Arc<tokio::sync::Notify> {
            let gate = Arc::new(tokio::sync::Notify::new());
            *self.summarize_gate.lock().expect("gate mutex") = Some(gate.clone());
            gate
        }

        /// POST /session/<id>/summarize requests (recorded, parsed JSON bodies only).
        fn summarize_requests(&self) -> Vec<RecordedRequest> {
            self.recorded()
                .into_iter()
                .filter(|r| r.method == "POST" && r.url.contains("/summarize"))
                .collect()
        }

        /// The current marker-bucket turn ids in the given sink's rollback record.
        fn turn_ids(turns: &[Value]) -> Vec<&str> {
            turns.iter().filter_map(|t| t["turnId"].as_str()).collect()
        }

        /// A minimal verbatim `FreshAgentTurn`-shaped row for the seeded record.
        fn marker_turn(id: &str, role: &str, text: &str) -> Value {
            json!({ "id": id, "turnId": id, "role": role, "summary": text, "items": [] })
        }
    }

    impl ServeHttp for RollbackFakeHttp {
        fn request<'a>(
            &'a self,
            req: ServeHttpRequest,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<Output = Result<ServeHttpResponse, ServeHttpError>>
                    + Send
                    + 'a,
            >,
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
                    body: body_value.clone(),
                });

            if req.url.contains("/global/health") {
                return Box::pin(async { Ok(ServeHttpResponse::new(200, b"{}".to_vec())) });
            }
            if method == "GET" && req.url.contains("/session/status") {
                let mut budget = self.busy_budget.lock().expect("budget mutex");
                let body = if *budget > 0 {
                    *budget -= 1;
                    serde_json::to_vec(&json!({ "ses_real": { "type": "busy" } })).unwrap()
                } else {
                    b"{}".to_vec()
                };
                return Box::pin(async move { Ok(ServeHttpResponse::new(200, body)) });
            }
            if method == "POST" && req.url.contains("/summarize") {
                // F4: the record-then-park gate mirrors the revert gate — the
                // abort-mid-drive test parks the compact's POST mid-flight.
                let gate = self.summarize_gate.lock().expect("gate mutex").clone();
                // ep1-r3 F2: the scripted status — ALWAYS answered AFTER the
                // POST was received (recorded above), the real v1.18.21
                // cleanup-first ordering.
                let status = *self.summarize_status.lock().expect("status mutex");
                return Box::pin(async move {
                    if let Some(gate) = gate {
                        gate.notified().await;
                    }
                    if status != 200 {
                        return Ok(ServeHttpResponse::new(
                            status,
                            b"summarize exploded".to_vec(),
                        ));
                    }
                    Ok(ServeHttpResponse::new(200, b"true".to_vec()))
                });
            }
            if method == "POST" && req.url.contains("/unrevert") {
                *self.revert_pointer.lock().expect("pointer mutex") = None;
                return Box::pin(async { Ok(ServeHttpResponse::new(200, b"true".to_vec())) });
            }
            if method == "POST" && req.url.contains("/revert") {
                let undelivered = *self.revert_undelivered.lock().expect("flag mutex");
                if undelivered {
                    return Box::pin(async {
                        Err(ServeHttpError::Undelivered(
                            "connect refused (fake)".to_string(),
                        ))
                    });
                }
                let status = *self.revert_status.lock().expect("status mutex");
                let moves = *self.revert_moves_pointer.lock().expect("flag mutex");
                let gate = self.revert_gate.lock().expect("gate mutex").take();
                return Box::pin(async move {
                    if let Some(gate) = gate {
                        gate.notified().await;
                    }
                    if status != 200 {
                        return Ok(ServeHttpResponse::new(
                            status,
                            br#"{"error":"unknown route"}"#.to_vec(),
                        ));
                    }
                    if moves {
                        *self.revert_pointer.lock().expect("pointer mutex") = body_value
                            .as_ref()
                            .and_then(|b| b.get("messageID"))
                            .and_then(Value::as_str)
                            .map(str::to_string);
                    }
                    Ok(ServeHttpResponse::new(200, b"true".to_vec()))
                });
            }
            if method == "POST" && req.url.contains("/prompt_async") {
                // Decision 5 native behavior: a subsequent send DELETES the reverted
                // tail rows and clears the pointer; the ledger (not opencode storage)
                // is the durable marker source.
                let text = body_value
                    .as_ref()
                    .and_then(|b| b.pointer("/parts/0/text"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let pointer = self.revert_pointer.lock().expect("pointer mutex").take();
                if let Some(pointer) = pointer {
                    let mut messages = self.messages.lock().expect("messages mutex");
                    if let Some(idx) = messages
                        .iter()
                        .position(|m| m["info"]["id"].as_str() == Some(pointer.as_str()))
                    {
                        messages.truncate(idx);
                    }
                }
                let n = self.next_appended.fetch_add(1, Ordering::SeqCst) + 1;
                {
                    let mut messages = self.messages.lock().expect("messages mutex");
                    messages.push(json!({ "info": { "id": format!("msg_u{n}"), "role": "user" }, "parts": [{ "type": "text", "text": text }] }));
                    messages.push(json!({ "info": { "id": format!("msg_a{n}"), "role": "assistant" }, "parts": [{ "type": "text", "text": format!("answer {n}") }] }));
                }
                *self.busy_budget.lock().expect("budget mutex") = 1;
                return Box::pin(async { Ok(ServeHttpResponse::new(200, b"true".to_vec())) });
            }
            if method == "GET" && req.url.contains("/message") {
                let body = serde_json::to_vec(&Value::Array(
                    self.messages.lock().expect("messages mutex").clone(),
                ))
                .unwrap();
                return Box::pin(async move { Ok(ServeHttpResponse::new(200, body)) });
            }
            if method == "GET" && req.url.contains("/session/") {
                let id = req
                    .url
                    .split("/session/")
                    .nth(1)
                    .and_then(|rest| rest.split(['/', '?']).next())
                    .unwrap_or("")
                    .to_string();
                let mut calls = self.get_session_calls.lock().expect("calls mutex");
                *calls += 1;
                let n_calls = *calls;
                let fail_calls = self.get_session_fail_calls.lock().expect("flag mutex");
                if fail_calls.contains(&n_calls) {
                    return Box::pin(async {
                        Ok(ServeHttpResponse::new(500, b"read exploded".to_vec()))
                    });
                }
                let pointer = self.revert_pointer.lock().expect("pointer mutex").clone();
                let mut info = json!({ "id": id, "time": { "updated": 10 } });
                if let Some(pointer) = pointer {
                    // VERIFIED shape: top-level session.revert = {messageID}, omitted when inactive.
                    info["revert"] = json!({ "messageID": pointer });
                }
                let body = serde_json::to_vec(&info).unwrap();
                return Box::pin(async move { Ok(ServeHttpResponse::new(200, body)) });
            }
            Box::pin(async { Ok(ServeHttpResponse::new(200, b"{}".to_vec())) })
        }
    }

    /// Build a [`FreshOpencodeState`] over a [`RollbackFakeHttp`]-backed serve manager
    /// with ONE already-materialized session registered (`ses_real`; the fork-tests
    /// register idiom) and a wired in-memory identity sink. When `pointer` is set, the
    /// record a matching undo would have written is seeded (the redo gate consults the
    /// stored write-time `can_redo` bit).
    async fn state_with_rollback_fake(
        pointer: Option<&str>,
    ) -> (
        FreshOpencodeState,
        tokio::sync::broadcast::Receiver<String>,
        std::sync::Arc<crate::identity_sink::FakeIdentitySink>,
        Arc<RollbackFakeHttp>,
    ) {
        let (tx, rx) = tokio::sync::broadcast::channel::<String>(64);
        let fresh_agent = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx));
        let http = Arc::new(RollbackFakeHttp::new(pointer));
        let deps = ServeDeps {
            spawner: Arc::new(TrackedSpawner {
                killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            }),
            http: http.clone(),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let manager = OpencodeServeManager::new(
            deps,
            ServeConfig {
                idle_poll_interval: std::time::Duration::from_millis(5),
                ..ServeConfig::default()
            },
        );
        manager
            .ensure_started()
            .await
            .expect("healthy fake serve starts");
        fresh_agent.set_manager_for_test(manager).await;
        let st = FreshOpencodeState::new(fresh_agent);
        let mut session = OpencodeSession::new("ses_real".to_string(), None, None, None);
        session.real_session_id = Some("ses_real".to_string());
        st.sessions
            .lock()
            .await
            .insert("ses_real".to_string(), Arc::new(TokioMutex::new(session)));
        let sink = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(sink.clone());
        if let Some(pointer) = pointer {
            // Seed exactly the record a prior undo at this pointer would have written.
            let messages = http.messages.lock().expect("messages mutex").clone();
            let boundary = messages
                .iter()
                .position(|m| m["info"]["id"].as_str() == Some(pointer))
                .expect("the seeded pointer exists in the served list");
            let tail_turns: Vec<Value> = messages[boundary..]
                .iter()
                .map(|m| {
                    RollbackFakeHttp::marker_turn(
                        m["info"]["id"].as_str().expect("id"),
                        m["info"]["role"].as_str().expect("role"),
                        m.pointer("/parts/0/text")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                    )
                })
                .collect();
            let prompt_text = messages[boundary..]
                .iter()
                .find(|m| m["info"]["role"].as_str() == Some("user"))
                .and_then(|m| m.pointer("/parts/0/text"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let mut record = RollbackRecord::empty(1);
            record.push_entry(
                RollbackEntry {
                    removed_turns: tail_turns,
                    prompt_text,
                    at_ms: 1,
                    epoch: 0,
                },
                1,
            );
            record.set_can_redo(true, 1);
            sink.record_rollback(PROVIDER, "ses_real", record)
                .await
                .expect("seed the rollback record");
        }
        http.clear();
        (st, rx, sink, http)
    }

    /// Same harness, then mark the session mid-turn (an unfinished send drive — the
    /// send-while-compact busy rig's shape).
    async fn state_with_rollback_fake_busy_turn() -> (
        FreshOpencodeState,
        tokio::sync::broadcast::Receiver<String>,
        std::sync::Arc<crate::identity_sink::FakeIdentitySink>,
        Arc<RollbackFakeHttp>,
    ) {
        let (st, rx, sink, http) = state_with_rollback_fake(None).await;
        let session_arc = st
            .sessions
            .lock()
            .await
            .get("ses_real")
            .cloned()
            .expect("registered session");
        session_arc.lock().await.turn_task = Some(TurnTask {
            kind: TurnTaskKind::Send,
            handle: tokio::spawn(async { std::future::pending::<()>().await }),
            compact_settled_rx: None,
        });
        (st, rx, sink, http)
    }

    fn undo_op(session_id: &str, request_id: &str) -> RollbackRequest {
        RollbackRequest {
            direction: RollbackDirection::Undo,
            mode: RollbackModeReq::Step,
            turn_id: None,
            session_id: session_id.into(),
            session_type: SessionType::Freshopencode,
            provider: AgentProvider::Opencode,
            request_id: request_id.into(),
            cwd: None,
        }
    }

    /// Wait until the session's registered turn task has finished (the send's detached
    /// drive has run the fake's prompt/delete-tail/settle through).
    async fn await_turn_settled(st: &FreshOpencodeState, session_id: &str) {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let done = {
                    let guard = st.sessions.lock().await;
                    let session_arc = guard.get(session_id).cloned().expect("session exists");
                    let s = session_arc.lock().await;
                    s.turn_task
                        .as_ref()
                        .map(|t| t.is_finished())
                        .unwrap_or(true)
                };
                if done {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the turn task finishes within the budget");
    }

    #[tokio::test]
    async fn handle_rollback_step_reverts_at_the_last_user_message_and_refills() {
        let (st, mut rx, st_sink, http) = state_with_rollback_fake(None).await;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(undo_op("ses_real", "rb-1"), sink).await;

        let frames = captured_frames(&captured);
        assert_eq!(frames.len(), 1, "one ack: {frames:?}");
        assert_eq!(frames[0]["event"]["type"], json!("freshAgent.rolledBack"));
        assert_eq!(frames[0]["event"]["requestId"], json!("rb-1"));
        assert_eq!(
            frames[0]["event"]["removedPromptText"],
            json!("prompt three")
        );
        assert_eq!(frames[0]["event"]["canRedo"], json!(true));
        let reverts = http.revert_posts();
        assert_eq!(reverts.len(), 1, "exactly one revert POST");
        assert_eq!(
            reverts[0].body,
            Some(json!({ "messageID": "msg_u3" })),
            "Step targets the last USER message of the active prefix"
        );
        // Broadcast: session.changed invalidation + session.rolledBack
        // (revokeAttention) — and a rollback NEVER chimes.
        let mut saw_changed = false;
        let mut saw_rolledback = false;
        while let Ok(raw) = rx.try_recv() {
            let v: Value = serde_json::from_str(&raw).expect("broadcast json");
            assert_ne!(
                v["event"]["type"],
                json!("freshAgent.turn.complete"),
                "rollback never chimes"
            );
            saw_changed |= v["event"]["type"] == json!("freshAgent.session.changed");
            if v["event"]["type"] == json!("freshAgent.session.rolledBack") {
                saw_rolledback = true;
                assert_eq!(v["event"]["revokeAttention"], json!(true));
                assert_eq!(v["event"]["canRedo"], json!(true));
            }
        }
        assert!(
            saw_changed && saw_rolledback,
            "invalidation + convergence broadcasts fired"
        );
        // The durable record is rebuilt to exactly the current revert tail.
        let record = st_sink.load_rollback(PROVIDER, "ses_real").expect("record");
        assert_eq!(record.entries.len(), 1);
        assert_eq!(record.entries[0].prompt_text, "prompt three");
        assert_eq!(
            record.entries[0].removed_turns.len(),
            2,
            "msg_u3 + msg_a3 marked"
        );
    }

    #[tokio::test]
    async fn handle_rollback_to_turn_removes_n_turns_in_one_revert_call() {
        let (st, _rx, _sink, http) = state_with_rollback_fake(None).await;
        let (sink, captured) = capturing_sink();
        let mut op = undo_op("ses_real", "rb-2");
        op.mode = RollbackModeReq::ToTurn;
        op.turn_id = Some("msg_u2".into());
        st.handle_rollback(op, sink).await;
        let reverts = http.revert_posts();
        assert_eq!(
            reverts.len(),
            1,
            "undo-to-here is ONE revert, never N round trips (decision 3)"
        );
        assert_eq!(reverts[0].body, Some(json!({ "messageID": "msg_u2" })));
        let frames = captured_frames(&captured);
        assert_eq!(frames[0]["event"]["removedPromptText"], json!("prompt two"));
        assert_eq!(
            frames[0]["event"]["removedTurnIds"]
                .as_array()
                .expect("ids")
                .len(),
            4,
            "two turns away: msg_u2..msg_a3"
        );
    }

    #[tokio::test]
    async fn handle_rollback_to_turn_targeting_an_assistant_message_is_refused_preflight() {
        // r3 pre-flight refusal (task-3 review Important-1): a hand-crafted toTurn frame
        // naming an ASSISTANT message passes the membership check, but the serve
        // normalizes the id to its parent USER message and GENUINELY applies the revert —
        // freshell's removed slice would exclude that parent turn, and the exact-pointer
        // post-verify would read a MOVED pointer at the parent id, tripping the (b)
        // silent-no-op compensation leg after an APPLIED mutation (the ledger would stop
        // describing a rollback the provider genuinely performed). Refuse
        // INVALID_ROLLBACK_TARGET BEFORE any ledger write or mutation: ZERO revert/
        // unrevert POSTs and the record untouched.
        let (st, _rx, st_sink, http) = state_with_rollback_fake(None).await;
        let (sink, captured) = capturing_sink();
        let mut op = undo_op("ses_real", "rb-2a");
        op.mode = RollbackModeReq::ToTurn;
        op.turn_id = Some("msg_a2".into());
        st.handle_rollback(op, sink).await;
        let frames = captured_frames(&captured);
        assert_eq!(frames.len(), 1, "exactly one refusal: {frames:?}");
        assert_eq!(frames[0]["event"]["code"], json!("INVALID_ROLLBACK_TARGET"));
        assert!(
            frames[0]["event"]["message"]
                .as_str()
                .unwrap_or_default()
                .contains("not a user message"),
            "the refusal names the role violation: {frames:?}"
        );
        assert!(
            http.recorded()
                .iter()
                .all(|r| !(r.method == "POST" && r.url.contains("revert"))),
            "a refused toTurn NEVER mutates provider history"
        );
        assert!(
            st_sink.load_rollback(PROVIDER, "ses_real").is_none(),
            "the ledger is never written on the pre-flight refusal"
        );
    }

    #[tokio::test]
    async fn handle_rollback_redo_step_moves_the_boundary_forward_by_one_user_step() {
        // Pointer at msg_u2 (msg_u2..msg_a3 rolled back); one redo step restores
        // msg_u2+msg_a2 and re-points the boundary at msg_u3.
        let (st, _rx, st_sink, http) = state_with_rollback_fake(Some("msg_u2")).await;
        let (sink, captured) = capturing_sink();
        let mut op = undo_op("ses_real", "rb-3");
        op.direction = RollbackDirection::Redo;
        st.handle_rollback(op, sink).await;
        let reverts = http.revert_posts();
        assert_eq!(reverts.len(), 1);
        assert_eq!(
            reverts[0].body,
            Some(json!({ "messageID": "msg_u3" })),
            "stepwise redo = re-revert to the NEXT user message (decision 5)"
        );
        let frames = captured_frames(&captured);
        assert_eq!(frames[0]["event"]["type"], json!("freshAgent.redone"));
        assert_eq!(frames[0]["event"]["restoredThroughTurnId"], json!("msg_a2"));
        assert_eq!(
            frames[0]["event"]["canRedo"],
            json!(true),
            "msg_u3+msg_a3 are still rolled back"
        );
        let record = st_sink.load_rollback(PROVIDER, "ses_real").expect("record");
        assert_eq!(record.entries.len(), 1);
        assert_eq!(
            record.entries[0].removed_turns.len(),
            2,
            "the marker bucket was rebased to the remaining tail"
        );
    }

    #[tokio::test]
    async fn handle_rollback_redo_full_restore_uses_unrevert() {
        // Pointer at msg_u3 — the only removed user step: full restore is the
        // all-or-nothing unrevert.
        let (st, _rx, st_sink, http) = state_with_rollback_fake(Some("msg_u3")).await;
        let (sink, captured) = capturing_sink();
        let mut op = undo_op("ses_real", "rb-4");
        op.direction = RollbackDirection::Redo;
        st.handle_rollback(op, sink).await;
        assert!(
            http.recorded()
                .iter()
                .any(|r| r.method == "POST" && r.url.contains("/unrevert")),
            "all-or-nothing redo = POST unrevert"
        );
        let frames = captured_frames(&captured);
        assert_eq!(frames[0]["event"]["canRedo"], json!(false));
        let record = st_sink.load_rollback(PROVIDER, "ses_real").expect("record");
        assert!(record.entries.is_empty(), "nothing rolled back remains");
    }

    #[tokio::test]
    async fn handle_rollback_redo_after_destroy_is_redo_unavailable_and_never_posts() {
        let (st, _rx, st_sink, http) = state_with_rollback_fake(Some("msg_u2")).await;
        st_sink
            .record_rollback(PROVIDER, "ses_real", {
                let mut r = RollbackRecord::empty(1);
                r.redo_destroyed = true;
                r.last_op_at_ms = 2;
                r
            })
            .await
            .expect("seed");
        let (sink, captured) = capturing_sink();
        let mut op = undo_op("ses_real", "rb-5");
        op.direction = RollbackDirection::Redo;
        st.handle_rollback(op, sink).await;
        let frames = captured_frames(&captured);
        assert_eq!(frames[0]["event"]["code"], json!("REDO_UNAVAILABLE"));
        assert_eq!(frames[0]["event"]["message"], json!(REDO_DESTROYED_MESSAGE));
        assert!(
            http.recorded()
                .iter()
                .all(|r| !(r.method == "POST" && r.url.contains("revert"))),
            "destroyed redo issues ZERO POSTs"
        );
    }

    #[tokio::test]
    async fn handle_rollback_redo_without_a_pointer_is_nothing_to_redo() {
        // No active revert + a well-formed record => REDO_EMPTY, no POSTs.
        let (st, _rx, _sink, http) = state_with_rollback_fake(None).await;
        let (sink, captured) = capturing_sink();
        let mut op = undo_op("ses_real", "rb-5e");
        op.direction = RollbackDirection::Redo;
        st.handle_rollback(op, sink).await;
        let frames = captured_frames(&captured);
        assert_eq!(frames[0]["event"]["code"], json!("REDO_UNAVAILABLE"));
        assert_eq!(frames[0]["event"]["message"], json!(REDO_EMPTY_MESSAGE));
        assert!(
            http.recorded().iter().all(|r| r.method == "GET"),
            "reads only — a refused redo never mutates"
        );
    }

    /// Focused-review ep1-r4 F2: seed the PRE-F8 STORED BYTES shape (no `epoch`
    /// on any entry, no `currentEpoch`, stale `canRedo:true` over TWO frozen
    /// steps) — the real pre-repair durable row. The load-time migration freezes
    /// the entries AND forces the stored bit OFF (an epochless row cannot prove
    /// which frozen steps remain redoable at the provider: undo → partial redo →
    /// stop reads identically to all-steps-outstanding). A /redo against it
    /// refuses typed-cleanly — `REDO_UNAVAILABLE` + `REDO_EMPTY_MESSAGE`, exactly
    /// one reply frame, ZERO mutation traffic (reads only) — and the frozen
    /// markers survive untouched (decision 6).
    #[tokio::test]
    async fn handle_rollback_redo_on_a_migrated_legacy_record_refuses_with_zero_mutation_traffic() {
        // Pointer at msg_u2: the provider provably exposes BOTH remaining steps
        // (msg_u2 and msg_u3 groups) — the truncate-after-one-step failure shape.
        let (st, _rx, st_sink, http) = state_with_rollback_fake(Some("msg_u2")).await;
        st_sink.seed_rollback_payload(
            PROVIDER,
            "ses_real",
            json!({
                "version": 1,
                "lastOpAtMs": 50,
                "redoDestroyed": false,
                "canRedo": true,
                "entries": [
                    { "removedTurns": [
                        RollbackFakeHttp::marker_turn("msg_u2", "user", "prompt two"),
                        RollbackFakeHttp::marker_turn("msg_a2", "assistant", "answer two"),
                    ], "promptText": "prompt two", "atMs": 40 },
                    { "removedTurns": [
                        RollbackFakeHttp::marker_turn("msg_u3", "user", "prompt three"),
                        RollbackFakeHttp::marker_turn("msg_a3", "assistant", "answer three"),
                    ], "promptText": "prompt three", "atMs": 50 },
                ],
            }),
        );
        let (sink, captured) = capturing_sink();
        let mut op = undo_op("ses_real", "rb-legacy-1");
        op.direction = RollbackDirection::Redo;
        st.handle_rollback(op, sink).await;
        let frames = captured_frames(&captured);
        assert_eq!(frames.len(), 1, "exactly one typed refusal: {frames:?}");
        assert_eq!(frames[0]["event"]["code"], json!("REDO_UNAVAILABLE"));
        assert_eq!(frames[0]["event"]["message"], json!(REDO_EMPTY_MESSAGE));
        assert!(
            http.recorded().iter().all(|r| r.method == "GET"),
            "reads only — a refused redo never mutates: {:?}",
            http.recorded()
        );
        let record = st_sink.load_rollback(PROVIDER, "ses_real").expect("record");
        assert_eq!(
            record.entries.len(),
            2,
            "the frozen legacy markers are preserved verbatim (decision 6): {record:?}"
        );
        assert!(record.entries.iter().all(|e| e.epoch == 0));
        assert_eq!(
            record.current_epoch, 1,
            "the migration froze the prefix below the bumped epoch"
        );
        assert!(
            !record.can_redo(),
            "the forced-off bit survives the refused op"
        );
    }

    /// F2 companion: after the refusal, a NEW undo over the migrated record
    /// records into the bumped epoch and redo is re-established truthfully for
    /// THAT tail only — the frozen prefix is preserved but never redoable.
    #[tokio::test]
    async fn handle_rollback_after_legacy_migration_a_new_undo_reestablishes_new_epoch_redo_only() {
        let (st, _rx, st_sink, http) = state_with_rollback_fake(Some("msg_u2")).await;
        st_sink.seed_rollback_payload(
            PROVIDER,
            "ses_real",
            json!({
                "version": 1,
                "lastOpAtMs": 50,
                "redoDestroyed": false,
                "canRedo": true,
                "entries": [
                    { "removedTurns": [
                        RollbackFakeHttp::marker_turn("msg_u2", "user", "prompt two"),
                        RollbackFakeHttp::marker_turn("msg_a2", "assistant", "answer two"),
                    ], "promptText": "prompt two", "atMs": 40 },
                    { "removedTurns": [
                        RollbackFakeHttp::marker_turn("msg_u3", "user", "prompt three"),
                        RollbackFakeHttp::marker_turn("msg_a3", "assistant", "answer three"),
                    ], "promptText": "prompt three", "atMs": 50 },
                ],
            }),
        );

        // A new undo steps the boundary DEEPER (msg_u2 → msg_u1).
        let (sink, _captured) = capturing_sink();
        st.handle_rollback(undo_op("ses_real", "rb-legacy-2"), sink)
            .await;
        let reverts = http.revert_posts();
        assert_eq!(reverts.len(), 1, "one boundary-moving revert");
        assert_eq!(
            reverts[0].body,
            Some(json!({ "messageID": "msg_u1" })),
            "the new undo steps into the active prefix's own history"
        );
        let record = st_sink.load_rollback(PROVIDER, "ses_real").expect("record");
        assert_eq!(
            record.entries.len(),
            3,
            "the frozen prefix PLUS the new-epoch entry: {record:?}"
        );
        assert!(record.entries[..2].iter().all(|e| e.epoch == 0));
        assert_eq!(
            record.entries[2].epoch, 1,
            "the new undo sits in the bumped epoch"
        );
        assert!(record.can_redo(), "the new epoch's tail is redoable");

        // One redo step restores the new epoch's group ONLY — the frozen prefix
        // stays in the ledger but never regains redo.
        let (sink, captured) = capturing_sink();
        let mut op = undo_op("ses_real", "rb-legacy-3");
        op.direction = RollbackDirection::Redo;
        st.handle_rollback(op, sink).await;
        let frames = captured_frames(&captured);
        assert_eq!(frames[0]["event"]["type"], json!("freshAgent.redone"));
        assert_eq!(frames[0]["event"]["restoredThroughTurnId"], json!("msg_a1"));
        assert_eq!(
            frames[0]["event"]["canRedo"],
            json!(false),
            "the restored new-epoch tail is spent; the frozen prefix is never redoable"
        );
        let record = st_sink.load_rollback(PROVIDER, "ses_real").expect("record");
        assert_eq!(
            record.entries.len(),
            2,
            "the spent new-epoch entry dropped; the frozen legacy prefix survives: {record:?}"
        );
        assert!(record.entries.iter().all(|e| e.epoch == 0));
        assert!(!record.can_redo());
    }

    #[tokio::test]
    async fn handle_rollback_mid_turn_is_busy() {
        let (st, _rx, _sink, http) = state_with_rollback_fake_busy_turn().await;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(undo_op("ses_real", "rb-6"), sink).await;
        let frames = captured_frames(&captured);
        assert_eq!(frames.len(), 1, "exactly one refusal: {frames:?}");
        assert_eq!(frames[0]["event"]["code"], json!("BUSY_TURN"));
        assert_eq!(frames[0]["event"]["message"], json!(ROLLBACK_BUSY_MESSAGE));
        assert!(
            http.recorded().is_empty(),
            "busy rollback issues ZERO HTTP calls"
        );
    }

    #[tokio::test]
    async fn handle_rollback_placeholder_session_is_lost_session_shape() {
        let (st, _rx, _sink, _http) = state_with_rollback_fake(None).await;
        // Register an UNMATERIALIZED placeholder (no durable ses_* id yet).
        st.sessions.lock().await.insert(
            "freshopencode-placeholder-1".to_string(),
            Arc::new(TokioMutex::new(OpencodeSession::new(
                "freshopencode-placeholder-1".to_string(),
                None,
                None,
                None,
            ))),
        );
        let (sink, captured) = capturing_sink();
        st.handle_rollback(undo_op("freshopencode-placeholder-1", "rb-7"), sink)
            .await;
        let frames = captured_frames(&captured);
        assert_eq!(frames.len(), 1, "exactly one refusal: {frames:?}");
        assert_eq!(frames[0]["event"]["code"], json!("INVALID_SESSION_ID"));
        assert!(frames[0]["event"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("has not materialized; cannot roll back."));
        let (sink2, captured2) = capturing_sink();
        st.handle_rollback(undo_op("never-seen", "rb-7b"), sink2)
            .await;
        let frames2 = captured_frames(&captured2);
        assert_eq!(frames2[0]["event"]["code"], json!("INVALID_SESSION_ID"));
    }

    #[tokio::test]
    async fn handle_rollback_twice_keeps_markers_in_conversation_order() {
        // Undo (removes the msg_u3 group), then undo again (removes the msg_u2
        // group): the marker bucket is the tail in its ORIGINAL CONVERSATION ORDER
        // [u2,a2,u3,a3] — never wire order [u3,a3,u2,a2] — as ONE rebuilt
        // current-epoch entry (the plan's opencode bullet: the current-epoch
        // portion is REBUILT to exactly the current serve-revert tail; focused
        // ep2-r3 — never one spliced entry per op).
        let (st, _rx, st_sink, _http) = state_with_rollback_fake(None).await;
        let (sink, _captured) = capturing_sink();
        st.handle_rollback(undo_op("ses_real", "rb-8a"), sink).await;
        let (sink2, _captured2) = capturing_sink();
        st.handle_rollback(undo_op("ses_real", "rb-8b"), sink2)
            .await;
        let record = st_sink.load_rollback(PROVIDER, "ses_real").expect("record");
        // Delta-r1 F8 + ep2-r3 F2: one REBUILT entry carries the whole current
        // epoch's tail, conversation-order ascending (the second same-epoch
        // undo's slice precedes the first's).
        assert_eq!(
            record.entries.len(),
            1,
            "one REBUILT entry for the whole current epoch: {record:?}"
        );
        assert_eq!(
            record.entries[0].epoch, record.current_epoch,
            "no epoch boundary without a destroy: {record:?}"
        );
        let ids: Vec<&str> = record
            .entries
            .iter()
            .flat_map(|e| RollbackFakeHttp::turn_ids(&e.removed_turns))
            .collect();
        assert_eq!(
            ids,
            vec!["msg_u2", "msg_a2", "msg_u3", "msg_a3"],
            "the rebuilt tail reads the tail's conversation order"
        );
    }

    #[tokio::test]
    async fn handle_rollback_step_on_an_empty_active_prefix_is_nothing_to_undo() {
        // Empty-prefix LEGALITY (r2/first-turn amendment): rolling back the FIRST
        // user message empties the conversation; ONE further step past that has
        // nothing left to undo.
        let (st, _rx, _sink, http) = state_with_rollback_fake(None).await;
        // Undo toTurn msg_u1 — legal empty prefix.
        let mut op = undo_op("ses_real", "rb-9a");
        op.mode = RollbackModeReq::ToTurn;
        op.turn_id = Some("msg_u1".into());
        st.handle_rollback(op, capturing_sink().0).await;
        assert_eq!(
            http.revert_posts().len(),
            1,
            "the empty-prefix revert issued"
        );
        // Now the active prefix is empty: one more step is NOTHING_TO_UNDO.
        let (sink, captured) = capturing_sink();
        st.handle_rollback(undo_op("ses_real", "rb-9b"), sink).await;
        let frames = captured_frames(&captured);
        assert_eq!(frames[0]["event"]["code"], json!("NOTHING_TO_UNDO"));
        assert_eq!(frames[0]["event"]["message"], json!(UNDO_EMPTY_MESSAGE));
        assert_eq!(
            http.revert_posts().len(),
            1,
            "the empty-prefix step issues no new revert"
        );
    }

    #[tokio::test]
    async fn handle_rollback_silent_noop_revert_is_invalid_target() {
        // Triad leg (b) (r3): revert 200s and the post-verify read SUCCEEDS but the
        // pointer provably did NOT move (unknown/stale messageID simulation — the
        // verified silent-200 rule is pointer-untouched-on-no-op, so the provider is
        // provably unmoved): INVALID_ROLLBACK_TARGET + the pre-written record is
        // compensated back (the ledger never describes a rollback the serve provably
        // rejected).
        let (st, _rx, st_sink, http) = state_with_rollback_fake(None).await;
        *http.revert_moves_pointer.lock().expect("flag") = false;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(undo_op("ses_real", "rb-10"), sink).await;
        let frames = captured_frames(&captured);
        assert_eq!(frames[0]["event"]["code"], json!("INVALID_ROLLBACK_TARGET"));
        assert!(
            st_sink
                .load_rollback(PROVIDER, "ses_real")
                .map(|r| r.entries.is_empty())
                .unwrap_or(true),
            "the pre-written record was compensated away"
        );
    }

    #[tokio::test]
    async fn handle_rollback_undo_post_verify_read_failure_keeps_the_ledger_and_reports_internal_error(
    ) {
        // Triad leg (c) (r3, undo leg): the revert POST 200s, but the post-verify
        // get_session READ FAILS (transport/5xx — the mutation may have applied).
        // Exactly one frame, INTERNAL_ERROR (never INVALID_ROLLBACK_TARGET); NO
        // compensating rewrite (a compensate after a possibly-applied mutation would
        // falsify the ledger — the pre-written post-op record is still in the sink
        // verbatim). Note in the handler: the next snapshot derives its prefix from
        // provider rows, so pane + record reconverge automatically on retry.
        let (st, _rx, st_sink, http) = state_with_rollback_fake(None).await;
        http.get_session_fail_calls.lock().expect("flag").insert(2);
        let (sink, captured) = capturing_sink();
        st.handle_rollback(undo_op("ses_real", "rb-11a"), sink)
            .await;
        let frames = captured_frames(&captured);
        assert_eq!(frames.len(), 1, "exactly one frame: {frames:?}");
        assert_eq!(frames[0]["event"]["code"], json!("INTERNAL_ERROR"));
        assert!(
            frames[0]["event"]["message"]
                .as_str()
                .unwrap_or_default()
                .contains("post-rollback verification read failed"),
            "the read-failure copy: {frames:?}"
        );
        let record = st_sink
            .load_rollback(PROVIDER, "ses_real")
            .expect("the ledger is KEPT, never compensated");
        assert_eq!(
            RollbackFakeHttp::turn_ids(&record.entries[0].removed_turns),
            vec!["msg_u3", "msg_a3"],
            "the post-op record is verbatim"
        );
        assert_eq!(
            *http.get_session_calls.lock().expect("calls"),
            2,
            "the initial read + the failed post-verify read — and nothing else"
        );
    }

    /// Focused-review ep2-r3 / plan wire-design opencode bullet: plan triad (c)
    /// deliberately keeps the speculative post-op record after an UNVERIFIABLE
    /// mutation; a RETRY over an UNMOVED provider re-derives the exact same
    /// removed slice. The current-epoch portion must be REBUILT to exactly the
    /// serve-revert tail (one entry, absorbed by turn id) — the prior per-op
    /// splice inserted the same slice TWICE; snapshot stamping then flattened
    /// BOTH entries into duplicated rolledBackTurns / inflated undoneDepth /
    /// duplicated redoableTurnIds. Rig: EVERY post-verify read fails (triad (c)
    /// keeps the ledger each time: call 2, call 4) while the provider's pointer
    /// provably never moves (the silent-200 no-op shape — the same turns stay
    /// live), so BOTH ops keep their speculative record legs.
    #[tokio::test]
    async fn repeated_ambiguous_undo_retries_rebuild_never_duplicate_the_marker_slice() {
        let (st, _rx, st_sink, http) = state_with_rollback_fake(None).await;
        http.get_session_fail_calls
            .lock()
            .expect("flag")
            .extend([2usize, 4usize]);
        *http.revert_moves_pointer.lock().expect("flag") = false;
        st.handle_rollback(undo_op("ses_real", "rb-qc-1"), capturing_sink().0)
            .await;
        st.handle_rollback(undo_op("ses_real", "rb-qc-2"), capturing_sink().0)
            .await;
        let record = st_sink
            .load_rollback(PROVIDER, "ses_real")
            .expect("the ledger is KEPT verbatim on both triad-(c) legs");
        assert_eq!(
            record.entries.len(),
            1,
            "ep2-r3: a same-slice ambiguous retry REBUILDS the current-epoch tail — never duplicates it: {record:?}"
        );
        assert_eq!(
            RollbackFakeHttp::turn_ids(&record.entries[0].removed_turns),
            vec!["msg_u3", "msg_a3"],
            "one entry, exactly the serve-revert slice: {record:?}"
        );
        // The snapshot truth flattens the bucket exactly once.
        let snap = crate::build_opencode_snapshot_json(
            "ses_real",
            &json!({ "id": "ses_real", "time": { "updated": 10 } }),
            &json!([]),
            Some(&record),
        );
        assert_eq!(
            snap["rollback"]["undoneDepth"],
            json!(1),
            "ONE undone user step — never the duplicated count: {snap}"
        );
        let bucket = snap["rolledBackTurns"].as_array().expect("bucket");
        assert_eq!(
            bucket.len(),
            2,
            "the marker slice flattens exactly once: {snap}"
        );
    }

    #[tokio::test]
    async fn handle_rollback_redo_post_verify_read_failure_keeps_the_ledger_and_reports_internal_error(
    ) {
        // Triad leg (c) (r3, redo leg): same rig over a seeded pointer + record; the
        // failed read after a re-revert yields the same INTERNAL_ERROR + ledger-kept
        // outcome.
        let (st, _rx, st_sink, http) = state_with_rollback_fake(Some("msg_u2")).await;
        http.get_session_fail_calls.lock().expect("flag").insert(2);
        let (sink, captured) = capturing_sink();
        let mut op = undo_op("ses_real", "rb-11b");
        op.direction = RollbackDirection::Redo;
        st.handle_rollback(op, sink).await;
        let frames = captured_frames(&captured);
        assert_eq!(frames.len(), 1, "exactly one frame: {frames:?}");
        assert_eq!(frames[0]["event"]["code"], json!("INTERNAL_ERROR"));
        let record = st_sink
            .load_rollback(PROVIDER, "ses_real")
            .expect("the ledger is KEPT");
        assert_eq!(
            RollbackFakeHttp::turn_ids(&record.entries[0].removed_turns),
            vec!["msg_u3", "msg_a3"],
            "the redo post-op record (the remaining tail) is verbatim"
        );
    }

    #[tokio::test]
    async fn handle_rollback_revert_404_is_unsupported_capability() {
        let (st, _rx, _sink, http) = state_with_rollback_fake(None).await;
        *http.revert_status.lock().expect("status") = 404; // CLI predates the revert route
        let (sink, captured) = capturing_sink();
        st.handle_rollback(undo_op("ses_real", "rb-12"), sink).await;
        let frames = captured_frames(&captured);
        assert_eq!(frames[0]["event"]["code"], json!("UNSUPPORTED_CAPABILITY"));
        assert_eq!(frames[0]["event"]["message"], json!(OPENCODE_OLD_CLI_COPY));
    }

    #[tokio::test]
    async fn handle_rollback_revert_http_500_is_internal_error() {
        // A non-404 5xx on revert: only unknown transport/other failures map to
        // INTERNAL_ERROR (never an uncontextualized 404, never an unclassified error
        // class).
        let (st, _rx, _sink, http) = state_with_rollback_fake(None).await;
        *http.revert_status.lock().expect("status") = 500;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(undo_op("ses_real", "rb-13"), sink).await;
        let frames = captured_frames(&captured);
        assert_eq!(frames[0]["event"]["code"], json!("INTERNAL_ERROR"));
        assert_ne!(frames[0]["event"]["message"], json!(OPENCODE_OLD_CLI_COPY));
    }

    /// Focused-review ep3-r1 F2 (never-dispatched compensation on rollback):
    /// an UNDELIVERED revert (the transport's connect-phase refusal — the POST
    /// provably never left this process) leaves the provider untouched, so the
    /// speculative pre-write MUST be compensated exactly like the answered-HTTP
    /// leg. Only [`ServeError::Http`] compensated before: the ledger kept the
    /// just-written post-undo entry here, describing a rollback the provider
    /// provably never performed (the same turns then read active AND rolled
    /// back in the durable history).
    #[tokio::test]
    async fn handle_rollback_compensates_the_record_when_the_mutation_never_left_the_process() {
        let (st, _rx, st_sink, http) = state_with_rollback_fake(None).await;
        *http.revert_undelivered.lock().expect("flag") = true;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(undo_op("ses_real", "rb-16"), sink).await;
        let frames = captured_frames(&captured);
        assert_eq!(frames.len(), 1, "exactly one frame: {frames:?}");
        assert_eq!(frames[0]["event"]["code"], json!("INTERNAL_ERROR"));
        assert!(
            frames[0]["event"]["message"]
                .as_str()
                .expect("message")
                .contains("never reached the server"),
            "the undelivered copy: {frames:?}"
        );
        let record = st_sink
            .load_rollback(PROVIDER, "ses_real")
            .expect("the compensated record is loadable");
        assert!(
            record.entries.is_empty(),
            "ep3-r1 F2: the compensated record carries NO rollback entry (provider provably untouched): {record:?}"
        );
        assert!(
            !record.can_redo,
            "redo availability restored to the pre-op state"
        );
    }

    #[tokio::test]
    async fn handle_rollback_record_write_failure_refuses_and_never_posts_revert() {
        // Durable-BEFORE-mutation: the record pre-write fails => INTERNAL_ERROR +
        // LEDGER_WRITE_REFUSAL_COPY and NO revert/unrevert POST is ever issued.
        let (st, _rx, st_sink, http) = state_with_rollback_fake(None).await;
        st_sink.set_fail_writes(true);
        let (sink, captured) = capturing_sink();
        st.handle_rollback(undo_op("ses_real", "rb-14"), sink).await;
        let frames = captured_frames(&captured);
        assert_eq!(frames[0]["event"]["code"], json!("INTERNAL_ERROR"));
        assert_eq!(
            frames[0]["event"]["message"],
            json!(LEDGER_WRITE_REFUSAL_COPY)
        );
        assert!(
            http.recorded()
                .iter()
                .all(|r| !(r.method == "POST" && r.url.contains("revert"))),
            "provider history is never mutated once the record cannot be saved"
        );
    }

    #[tokio::test]
    async fn handle_send_issued_mid_rollback_strictly_follows_it() {
        // Pinned semantic (send waits; rollback wins; then the send destroys redo)
        // under the r2 lock discipline: the per-session mutex is held across the
        // whole rollback handler, and handle_send NEVER acquires/consults
        // rollback_in_flight — its ONLY wait point is that same mutex, so a send
        // issued while a rollback is in flight blocks behind it with no circular
        // wait.
        let (st, _rx, st_sink, http) = state_with_rollback_fake(None).await;
        let gate = http.arm_revert_gate();
        let rollback = {
            let st = st.clone();
            tokio::spawn(async move {
                st.handle_rollback(undo_op("ses_real", "rb-15"), capturing_sink().0)
                    .await
            })
        };
        // Wait until the rollback is parked INSIDE the revert POST.
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if !http.revert_posts().is_empty() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the rollback reaches the revert POST");
        let send = {
            let st = st.clone();
            tokio::spawn(async move { st.handle_send(send_msg("ses_real", "again")).await })
        };
        // Give the send a moment to line up behind the session mutex.
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        assert!(
            http.recorded()
                .iter()
                .all(|r| !r.url.contains("/prompt_async")),
            "the send waits on the per-session mutex"
        );
        gate.notify_one();
        // Bounded completion == no deadlock between the two handlers' lock waits.
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let (r, s) = tokio::join!(rollback, send);
            r.expect("rollback task");
            s.expect("send task");
        })
        .await
        .expect("send+rollback must serialize, never deadlock");
        let recorded = http.recorded();
        let revert_pos = recorded
            .iter()
            .position(|r| r.method == "POST" && r.url.ends_with("/revert"))
            .expect("revert happened");
        let prompt_pos = recorded
            .iter()
            .position(|r| r.method == "POST" && r.url.contains("/prompt_async"))
            .expect("prompt happened");
        // The r3 post-verify GET /session/<id> (the fake records it) also sits strictly
        // between them: a send interleaving between the revert POST and its verification
        // read is a serialization violation too. The bare `/session/ses_real` GETs are
        // the rollback's initial read and its post-verify read (`/message` and
        // `/session/status` traffic is filtered out); the LAST such is the post-verify.
        let postverify_get_pos = recorded
            .iter()
            .rposition(|r| {
                r.method == "GET"
                    && r.url.contains("/session/ses_real")
                    && !r.url.contains("/message")
            })
            .expect("the post-verify read happened");
        assert!(
            revert_pos < postverify_get_pos && postverify_get_pos < prompt_pos,
            "the revert POST AND its post-verify read strictly precede the prompt POST — never concurrent"
        );
        assert!(
            st_sink
                .load_rollback(PROVIDER, "ses_real")
                .expect("record")
                .redo_destroyed,
            "the trailing send destroyed redo on the post-rollback record (decision 5)"
        );
    }

    #[tokio::test]
    async fn handle_rollback_after_a_resend_starts_a_new_epoch_and_redo_still_works() {
        // r3 epoch rule end-to-end on this lane: undo (removes the msg_u3 group) →
        // resend the edited prompt (the fake's /prompt_async arm natively DELETES the
        // reverted tail rows and clears the pointer, mirroring decision-5 native
        // behavior; destroy_redo_on_submit sets redo_destroyed) → undo AGAIN (removes
        // the resent turn) → redo. The marker bucket is the UNION: the old u3-group
        // markers PERSIST as frozen prior-epoch entries (their serve rows were
        // natively deleted; the ledger is their only home, decision 6) PRECEDING the
        // newest epoch's markers in conversation order; only the redo-capable chain
        // state reset (redo available again for the NEW chain); and one redo step
        // restores the newest epoch's removed tail (never the frozen rows).
        let (st, _rx, st_sink, _http) = state_with_rollback_fake(None).await;

        st.handle_rollback(undo_op("ses_real", "rb-16a"), capturing_sink().0)
            .await;
        st.handle_send(send_msg("ses_real", "prompt three (edited)"))
            .await;
        await_turn_settled(&st, "ses_real").await;

        // Undo AGAIN — this op lands while redo_destroyed is set: a NEW epoch.
        let (sink2, captured2) = capturing_sink();
        st.handle_rollback(undo_op("ses_real", "rb-16b"), sink2)
            .await;
        let frames2 = captured_frames(&captured2);
        assert_eq!(frames2[0]["event"]["type"], json!("freshAgent.rolledBack"));
        assert_eq!(
            frames2[0]["event"]["removedTurnIds"],
            json!(["msg_u4", "msg_a4"]),
            "the resent turn is the removed step"
        );
        assert_eq!(
            frames2[0]["event"]["removedPromptText"],
            json!("prompt three (edited)"),
            "the composer refill is the RESENT prompt"
        );
        let record = st_sink.load_rollback(PROVIDER, "ses_real").expect("record");
        let bucket: Vec<&str> = record
            .entries
            .iter()
            .flat_map(|e| RollbackFakeHttp::turn_ids(&e.removed_turns))
            .collect();
        assert_eq!(
            bucket,
            vec!["msg_u3", "msg_a3", "msg_u4", "msg_a4"],
            "UNION markers: frozen prior-epoch rows PRECEDE the new epoch's (conversation order)"
        );
        // Delta-r1 F8 case (a): the destroy at load opened epoch 1 — the frozen
        // prior-epoch entry KEEPS epoch 0; the new op records epoch 1.
        assert_eq!(record.current_epoch, 1);
        assert_eq!(
            record.entries.iter().map(|e| e.epoch).collect::<Vec<_>>(),
            vec![0, 1],
            "literal epoch marks, never timestamp reads"
        );
        assert!(
            record.can_redo() && !record.redo_destroyed,
            "only the redo-capable chain state reset; the NEW chain is redoable"
        );

        // One redo step restores EXACTLY the new epoch's tail — never the frozen rows.
        let (sink3, captured3) = capturing_sink();
        let mut op = undo_op("ses_real", "rb-16c");
        op.direction = RollbackDirection::Redo;
        st.handle_rollback(op, sink3).await;
        let frames3 = captured_frames(&captured3);
        assert_eq!(frames3[0]["event"]["type"], json!("freshAgent.redone"));
        assert_eq!(
            frames3[0]["event"]["restoredThroughTurnId"],
            json!("msg_a4"),
            "redo restores the NEWEST epoch's tail, never the frozen rows"
        );
        let record = st_sink.load_rollback(PROVIDER, "ses_real").expect("record");
        assert_eq!(
            RollbackFakeHttp::turn_ids(&record.entries[0].removed_turns),
            vec!["msg_u3", "msg_a3"],
            "the frozen prior-epoch markers survive the redo (decision 6)"
        );
        assert!(
            !record.can_redo(),
            "the new chain is fully restored; the frozen rows stay ledger-only"
        );
    }
}
